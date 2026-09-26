# Contrato `release.config.json`

O contrato é pequeno, declarativo e validado pelo helper `scripts/release-config.mjs` (parse, defaults, enums, tipos, coerência — erros claros e identificáveis). Caminhos são relativos à raiz do repositório consumidor.

```jsonc
{
  "release": {
    "title": "Nome da Release",            // obrigatório
    "tagline": "Descrição curta.",          // opcional
    "language": "pt-BR",                    // "pt-BR" | "en"
    "image": {
      "path": "docs/images/releases/release.webp", // arquivo (legado) ou diretório
      "required": true,
      "granularity": "minor",              // "minor" | "tag"
      "prefix": "release",                 // opcional: só com path = diretório
      "ext": ".webp",                      // opcional: só com path = diretório
      "upload": true,                      // opcional: anexa a arte como asset da release
      "allow_correction": true,            // opcional: aceita <arquivo>-new do branch padrão
      "correction_suffix": "-new"          // opcional
    },
    "notes": { "granularity": "tag" },     // "tag" | "minor"
    "sections": {
      "usage": "## Uso\n...",              // opcional (multilinha)
      "extra": "## Extra\n..."             // opcional (multilinha)
    }
  },
  "build": {
    "package_manager": "bun",             // "bun" | "npm" | ausente
    "node": "22",                          // opcional
    "bun": "1.3.13",                       // opcional
    "rust": "stable",                      // opcional (desktop/Tauri)
    "working_directory": ".",              // opcional; onde instalar deps e rodar gates/pre/build
    "apt": ["libwebkit2gtk-4.1-dev"],      // opcional (somente runners Linux)
    "gates": ["bun run lint", "bun test"], // opcional
    "pre": ["bun run translations"],       // opcional
    "command": "bun run build"             // opcional (proibido com desktop)
  },
  "desktop": {
    "enabled": false,                      // ativa tauri-action
    "project_path": "."                    // raiz do projeto Tauri
  },
  "artifact": {
    "enabled": false,
    "path": "dist/app.zip",                // string ou array (0..N)
    "globs": ["dist/artifacts/*.zip"],     // opcional (padrões glob)
    "release_name": "app-{version}.zip",   // opcional; substitui {version}; exige 1 arquivo
    "validate": ["unzip -t \"$1\""]        // opcional; comando recebe o arquivo em $1
  },
  "versions": {
    "files": [
      { "path": "manifest.json", "format": "json", "field": "version" },
      { "path": "desktop/src-tauri/tauri.conf.json", "format": "json", "field": "version" },
      { "path": "desktop/src-tauri/Cargo.toml", "format": "toml", "field": "package.version" }
    ]
  }
}
```

## Defaults aplicados

| Campo | Default |
|---|---|
| `release.language` | `pt-BR` |
| `release.image.path` | `docs/images/releases/release.webp` |
| `release.image.required` | `true` |
| `release.image.granularity` | `minor` |
| `release.image.prefix` | `release` (só quando `path` é diretório) |
| `release.image.ext` | `.webp` (só quando `path` é diretório) |
| `release.image.upload` | `true` |
| `release.image.allow_correction` | `true` |
| `release.image.correction_suffix` | `-new` |
| `release.notes.granularity` | `tag` |
| `build.node` | `22` se `package_manager` for `npm`; senão vazio |
| `build.working_directory` | `.` (raiz do repositório) |
| `desktop.project_path` | `.` |
| `artifact.path` / `globs` / `validate` | `[]` |
| `versions.files` | `[]` |

## Regras de validação (falham antes do build)

- `release.title` é obrigatório (não vazio).
- `language`, `notes.granularity`, `image.granularity` são enums.
- `image.path` é um arquivo (formato legado) ou um diretório; com diretório, `image.ext` precisa começar com ponto.
- `image.upload`, `image.allow_correction` são booleanos; `image.correction_suffix` é string não vazia.
- `package_manager` exige evidência: `bun` → `bun.lock`/`bun.lockb`; `npm` → `package-lock.json`. O valor de `package.json#packageManager` deve ser coerente.
- `bun` declarado exige `package_manager: "bun"`; `npm` exige `node` com versão.
- `build.working_directory` deve ser um caminho relativo à raiz do repositório.
- `desktop: true` exige `build.rust`, proíbe `build.command` e `artifact.enabled`.
- `artifact.enabled` exige pelo menos um `path`/`globs`; `globs` deve ser um padrão glob.
- `version.files` requer `{ path, format: json|toml, field }`.

## Diretório de trabalho (`build.working_directory`)

As dependências do projeto são instaladas e os passos `gates → pre → build` rodam em `build.working_directory` (default `.`, a raiz do repositório). Em monorepos onde o app Tauri vive num subdiretório (ex.: `apps/desktop`), a instalação continua na **raiz** — onde está o `package-lock.json`/`bun.lock` — e só o `tauri-action` recebe `desktop.project_path`.

A instalação acontece **sempre que `package_manager` é declarado**, inclusive com `desktop.enabled: true`: o `beforeBuildCommand` do Tauri depende do workspace instalado.

## Versão
A cadeia é determinística: `vX.Y.Z` (tag) → `X.Y.Z`. O Core valida `package.json` (sempre canônico) e cada item de `versions.files` (json via campo aninhado com pontos; toml via seção `package.version`). Qualquer divergência falha antes do build.

## Prerelease

Tags `vX.Y.Z-<sufixo>` (ex.: `v1.2.0-beta.1`) são detectadas automaticamente e geram release como prerelease.

## Imagem

A imagem é **por versão**, com fallback para a linha do minor e para o arquivo
legado. O Core procura, para a tag alvo, nesta ordem:

| Ordem | Arquivo (com `prefix: "release"`, `ext: ".webp"`) | Origem |
|---|---|---|
| 1º | `docs/images/releases/release-v1.2.0-new.webp` | branch padrão (correção) ou a própria tag |
| 2º | `docs/images/releases/release-v1.2.0.webp` | a tag |
| 3º | `docs/images/releases/release-v1.2-new.webp` | branch padrão (correção) |
| 4º | `docs/images/releases/release-v1.2.webp` | a tag |
| 5º | `docs/images/releases/release.webp` | a tag (legado) |

Assim a arte da v1.2.0 continua existindo quando a v1.3.0 é publicada, e o
granularidade continua valendo:

```
v1.0.0 → obrigatória (primeira)
v1.0.1 → pode reutilizar a linha v1.0
v1.1.0 → deve mudar (hard gate)
```

Com `granularity: "tag"`, a mudança é exigida a cada versão. O Core compara a
arte resolvida com a da `prev_tag` (maior semver < atual), nunca com release
histórica qualquer. Uma correção (`-new`) não passa por esse gate: ela não
está no histórico entre as duas tags.

### `image.path`: arquivo (legado) ou diretório

`path` aceita as duas formas, e o formato antigo continua valendo sem
mudança de comportamento:

- **arquivo** (`docs/images/releases/release.webp`): o diretório, o prefixo e a
  extensão vêm do próprio nome. É o formato atual dos consumidores, que já
  passam a ter resolução por tag sem editar nada.
- **diretório** (`docs/images/releases`): usa `image.prefix` (default
  `release`) e `image.ext` (default `.webp`).

### Asset e correção depois da tag

Com `image.upload` (default `true`), a arte resolvida é anexada como **asset da
própria release** e o corpo passa a apontar
`https://github.com/<repo>/releases/download/<tag>/<arquivo>`. Isso é o que
permite corrigir a arte depois: corrige-se o arquivo, reenvia-se o asset e
re-roda-se o workflow da tag — **sem mover a tag** e sem perder os artefatos já
publicados.

O asset usa o **nome canônico**, sem o sufixo de correção: um arquivo
`release-v1.2.0-new.webp` publica como `release-v1.2.0.webp`. A release não
expõe a terminologia de correção, e a URL do corpo continua válida se a arte for
corrigida de novo.

Com `image.upload: false`, a correção volta a não ser servível (não há URL
estável fora da tag) e o corpo usa a URL raw da tag.

### Guarda contra troca acidental de arte já publicada

`--clobber` apaga o asset antes de enviar, e um re-run re-resolve a arte. Sem
proteção, apagar o arquivo de correção do branch padrão faria o re-run voltar a
publicar a arte antiga — reescrevendo uma release já consumida, em silêncio.

O Core compara o `digest` (`sha256`) do asset publicado com o do arquivo
resolvido:

| Situação | Comportamento |
|---|---|
| mesmo conteúdo | não reenvia (evita a janela de apagar-e-falhar) |
| release em **rascunho**, conteúdo diferente | substitui |
| release **publicada**, conteúdo diferente | **falha**, com o comando para remover o asset e re-rodar |
| asset antigo sem `digest` | compara por tamanho |

### O sufixo `-new` é convenção, não requisito

A arte do branch padrão **vence** a da tag com ou sem sufixo: o que o gate de
granularidade considera é a **origem** (`tag` ou `branch`), não o nome. Ou
seja, sobrescrever `release-v1.2.0.webp` no branch padrão tem o mesmo efeito de
publicar `release-v1.2.0-new.webp`.

O `-new` é a forma **recomendada** porque deixa a intenção explícita, mantém a
arte original e a corrigida lado a lado no repositório, e o padrão fica legível
por quem abre o repositório. Use `image.allow_correction: false` para desligar
as duas formas.
