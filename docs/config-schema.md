# Contrato `release.config.json`

O contrato é pequeno, declarativo e validado pelo helper `scripts/release-config.mjs` (parse, defaults, enums, tipos, coerência — erros claros e identificáveis). Caminhos são relativos à raiz do repositório consumidor.

```jsonc
{
  "release": {
    "title": "Nome da Release",            // obrigatório
    "tagline": "Descrição curta.",          // opcional
    "language": "pt-BR",                    // "pt-BR" | "en"
    "image": {
      "path": "docs/images/releases/release.webp",
      "required": true,
      "granularity": "minor"               // "minor" | "tag"
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
| `release.notes.granularity` | `tag` |
| `build.node` | `22` se `package_manager` for `npm`; senão vazio |
| `build.working_directory` | `.` (raiz do repositório) |
| `desktop.project_path` | `.` |
| `artifact.path` / `globs` / `validate` | `[]` |
| `versions.files` | `[]` |

## Regras de validação (falham antes do build)

- `release.title` é obrigatório (não vazio).
- `language`, `notes.granularity`, `image.granularity` são enums.
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

A imagem representa a linha `major.minor`:

```
v1.0.0 → obrigatória (primeira)
v1.0.1 → pode reutilizar
v1.1.0 → deve mudar (hard gate)
```

Com `granularity: "tag"`, a mudança é exigida a cada versão. O Core compara a imagem atual com a da `prev_tag` (maior semver < atual), nunca com release histórica qualquer.