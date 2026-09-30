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
      "correction_suffix": "-new",         // opcional
      "title_in_body": true,               // opcional: H1 com o nome no corpo (ver abaixo)
      "reuse": "forbid",                   // opcional: "forbid" | "allow" (ver "Trocar a arte")
      "changes": [                         // opcional: eras de arte (ver "Trocar a arte")
        { "from": "v1.0.0", "file": "release-v1.0.webp" },
        { "from": "v1.2.3", "file": "release-v1.2.3.webp" }
      ]
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
  "distribution": {
    "downloads_table": false,              // gera a seção "## Downloads" no corpo
    "artifacts": [
      {
        "id": "web",                       // obrigatório, único, slug
        "path": "dist/site.zip",           // ou "globs": ["bundle/**/*.msi"]
        "kind": "archive",                 // rótulo livre (aparece na tabela)
        "os": ["ubuntu-latest"],           // células que o produzem; "*" = todas
        "required": false,                 // ausente e obrigatório reprova
        "label": "Web (portátil)",         // rótulo na tabela de downloads
        "platform": "web",                 // metadado para a tabela
        "architecture": "x64",             // metadado para a tabela
        "release_name": "app-{version}.zip",// opcional; exige exatamente 1 arquivo
        "validate": ["unzip -t \"$1\""]    // opcional; roda em bash, arquivo em $1
      }
    ]
  },
  "artifact": {                            // forma antiga; não misturar com a de cima
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
| `release.image.title_in_body` | `true` |
| `release.image.reuse` | `forbid` |
| `release.image.changes` | `[]` |
| `release.notes.granularity` | `tag` |
| `build.node` | `22` se `package_manager` for `npm`; senão vazio |
| `build.working_directory` | `.` (raiz do repositório) |
| `desktop.project_path` | `.` |
| `distribution.artifacts` | `[]` (o bloco `artifact` legado é normalizado para uma entrada) |
| `distribution.downloads_table` | `false` |
| `artifact.path` / `globs` / `validate` | `[]` |
| `versions.files` | `[]` |

## Regras de validação (falham antes do build)

- `release.title` é obrigatório (não vazio).
- `language`, `notes.granularity`, `image.granularity`, `image.reuse` são enums.
- `image.path` é um arquivo (formato legado) ou um diretório; com diretório, `image.ext` precisa começar com ponto.
- `image.upload`, `image.allow_correction`, `image.title_in_body` são booleanos; `image.correction_suffix` é string não vazia.
- `image.changes` é um array de `{ from, file }`: `from` é uma tag **completa** `vX.Y.Z` e único na lista; `file` é um nome de arquivo dentro de `image.path` (sem barra, sem ponto inicial).
- `package_manager` exige evidência: `bun` → `bun.lock`/`bun.lockb`; `npm` → `package-lock.json`. O valor de `package.json#packageManager` deve ser coerente.
- `bun` declarado exige `package_manager: "bun"`; `npm` exige `node` com versão.
- `build.working_directory` deve ser um caminho relativo à raiz do repositório.
- `desktop: true` exige `build.rust`. **Não** restringe `build.command` nem `distribution.artifacts` — o perfil misto (site **e** instaladores) é declarado, não proibido.
- `distribution.artifacts` é um array de `{ id, path|globs, os, required, kind, label, platform, architecture, release_name, validate }`. `id` é slug único; `path` e `globs` não podem ser ambos vazios; `os` padrão é `["*"]`; `required` padrão é `true`.
- `distribution.artifacts` e o bloco `artifact` **não podem ser declarados juntos** — a mensagem de erro entrega a migração.
- `release_name` exige exatamente um arquivo por artefato.
- `versions.files` requer `{ path, format: json|toml, field }`.

## Distribuição

O que o projeto entrega é uma **lista de artefatos**, e cada um declara a que
célula da matriz o produz. O bloco `artifact` legado é a mesma coisa sem
escopo: ele é normalizado para uma entrada com `os: ["*"]` e `required: true`,
que é exatamente o comportamento de sempre.

### `os`: a célula da matriz

Sem `os`, um artefato é exigido em **toda** célula — e com matriz isso é
impossível de declarar, porque cada artefato é produzido por uma só. `os` casa
com o `os` da célula do `matrix`:

```yaml
matrix: '[{"os":"ubuntu-latest"},{"os":"windows-latest"}]'
```

```jsonc
"os": ["windows-latest"]   // só a célula do Windows coleta e publica
"os": ["*"]                // qualquer célula
```

### `required`: obrigatório de verdade

Ausente e `required: true` **reprova a célula**. Ausente e `required: false`
avisa e segue. Arquivo vazio é erro nos dois casos: ausente é "não produzido
agora", vazio é "produzido quebrado", e são estados diferentes.

### O perfil misto: site **e** instaladores

`desktop.enabled` convive com `build.command` e com
`distribution.artifacts`. A ordem no `build` é: dependências → `gates` →
`pre` → `build.command` → `tauri-action` → artefatos declarados.

```jsonc
"build": { "command": "npm run build:web" },
"desktop": { "enabled": true, "project_path": "apps/desktop" },
"distribution": {
  "artifacts": [
    { "id": "web", "path": "dist/site.zip", "kind": "archive",
      "os": ["ubuntu-latest"], "required": false, "label": "Web", "platform": "web" }
  ]
}
```

O `tauri-action` publica os instaladores; o Core publica o artefato próprio do
projeto. Uma release pode ter os dois.

### O que a célula promete: `matrix[].expect`

`build` verde afirma algo sobre **células**. O que a célula entregou é outra
pergunta, e ela é respondida por `expect`:

```yaml
matrix: '[{"os":"windows-latest","expect":"[\"**/*.msi\",\"**/*.exe\"]"}]'
```

Globs, não nomes exatos, porque o nome do instalador carrega a versão
(`App_1.5.0_x64_en-US.msi`) e muda a cada release. O que a célula promete é a
**forma** do que ela gera, e essa é a afirmação estável. Se nenhum arquivo casar
depois do build, a célula reprova — que é a diferença entre "o build passou" e
"o artefato existe".

### Célula opcional: `matrix[].optional`

```yaml
matrix: '[{"os":"macos-latest","optional":true}]'
```

A célula passa a ter `continue-on-error`. Use quando a plataforma é instável e o
produto é melhor sem ela do que atrasado por causa dela. Os artefatos
**obrigatórios** que só ela produz precisam de `required: false`, senão a
célula reprova antes de a optionalidade valer.

### A conferência da release: no `finalize`

Todo artefato com `required: true` **e** `release_name` precisa aparecer na
release. A conferência roda no `finalize`, que é o único lugar que enxerga a
release inteira: `build` verde não afirma nada sobre a release, só sobre
células. Quem reprova aqui deixa o release em **rascunho**, sem publicar.

O que não tem nome determinístico — o que o `tauri-action` gera — é conferido
pelo `expect` da célula, e a conferência diz isso no log em vez de fingir que
confirmou.

### Tabela de downloads

`distribution.downloads_table: true` acrescenta uma seção `## Downloads` ao
corpo, montada a partir dos assets **publicados** — nunca do que foi apenas
declarado. Um artefato opcional que não apareceu não vira linha apontando para
arquivo inexistente.

A alternativa era escrever a tabela à mão em `sections.usage`, e ela já
divergiu do nome real gerado pelo Tauri uma vez: o link do `.rpm` deu 404 e
ninguém viu.

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

Com `granularity: "tag"`, a mudança é exigida a cada versão. Uma era declarada
que começa na tag também conta como troca exigida (ver abaixo).

### Trocar a arte: dentro da linha, e de propósito

A política acima responde *quando* a arte muda. Duas chaves respondem *como* você
declara a troca, porque "quando" e "como" são decisões diferentes.

**`image.changes[]` — as eras da arte.** A lista de pontos em que a arte muda de
propósito:

```jsonc
"image": {
  "path": "docs/images/releases",
  "changes": [
    { "from": "v1.0.0", "file": "release-v1.0.webp" },
    { "from": "v1.2.3", "file": "release-v1.2.3.webp" }
  ]
}
```

Para a tag `v1.2.3` e todas as seguintes até a próxima entrada, a arte é
`release-v1.2.3.webp`. Sem a chave, a resolução é a da tabela acima, por nome de
arquivo — **e nada muda para quem já tem config publicado**.

Isso resolve um problema que o modelo por nome não tinha como resolver. Um
arquivo `release-v1.2.3.webp` serve **só** a `v1.2.3`: a `v1.2.4` volta ao
arquivo da linha e mostra a arte anterior, sem aviso. Com a lista, a intenção
"vale da v1.2.3 em diante" vira uma linha de diff revisável, versionada junto
com a tag. E o arquivo da linha volta a significar a linha.

Quando existe a lista, ela é a autoridade: um arquivo por tag que **não** está
declarado é ignorado na resolução, e o Core avisa:

```
::warning::docs/images/releases/release-v1.2.3.webp existe na tag, mas nenhuma
era em image.changes[] declara esse arquivo. Ele serve SÓ a v1.2.3: a próxima tag
da linha 1.2 volta a procurar a arte anterior.
```

`from` precisa ser uma tag completa `vX.Y.Z` porque a era precisa de um ponto de
partida inequívoco. Tag de prerelease (`v1.2.0-rc1`) usa a era da versão base.

**`image.reuse` — reusar de propósito.** Entrar numa linha nova sem arte nova é
uma decisão legítima de quem produz a arte, e não uma falha do Core. Com
`"reuse": "allow"`, o Core não cobra a troca: ele registra no log que a arte é
byte a byte a da tag anterior e que isso foi declarado. O padrão `"forbid"`
mantém a cobrança.

### O que o gate da arte realmente compara

O gate pergunta **se os bytes mudaram**, e não se o nome do arquivo mudou. A
comparação é feita entre o blob da arte em `HEAD` e o blob da arte na `prev_tag`,
lidos do object database do git — nunca do arquivo em disco, porque o checkout
normaliza fim de linha e isso já custou uma release inteira uma vez.

O que segue é o que a política exige nesta tag:

| Situação | Comportamento |
|---|---|
| arte ausente, `required: true` | **falha**, com o motivo (inclusive quando uma era declara um arquivo ausente) |
| arte ausente, `required: false` | segue sem imagem, e diz que seguiu |
| mesma linha `major.minor` | não exige nada |
| linha nova, bytes diferentes | troca aceita, com os dois digests no log |
| linha nova, bytes **iguais** | `reuse: "forbid"` → **aviso** com os digests; `reuse: "allow"` → aviso de reuso declarado |
| `granularity: "tag"` | exige troca em toda tag |
| arte vinda do branch padrão (correção `-new`) | troca declarada por construção; **não** reprova |
| era declarada que começa nesta tag | exige troca, conferida por conteúdo |

A regra de conteúdo é **aviso** na série `1.x` e vira **erro** na `2.0.0` quando
`reuse: "forbid"`. Assim ninguém tem uma release publicada pelo gate antigo
reprovando de repente, e a política anunciada para o `2.0` é a mesma que vale
hoje.

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

### O nome no corpo: `image.title_in_body`

O corpo começa com a arte e, logo abaixo, com um H1 com `release.title`. Se a
arte já carrega o wordmark — o caso do próprio Core — o leitor vê o nome duas
vezes, em dois pixels de distância. `image.title_in_body: false` desliga o H1
e deixa a imagem ser o título.

O padrão é `true` porque nem toda arte carrega o nome, e um corpo **sem**
imagem ficaria sem título nenhum. Quem desliga precisa ter a arte com o
wordmark; quem não tem, deixa o padrão.

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

### Asset antigo quando o nome do asset muda

O asset publicado usa o nome canônico do arquivo resolvido. Quando a resolução
vem do arquivo de uma **correção** feita numa tag cuja arte vinha da linha, esse
nome muda (`release-v1.2.webp` → `release-v1.2.3.webp`) e o asset anterior fica
ao lado do novo. A guarda por `digest` compara com o asset de mesmo nome, então
não enxerga o anterior: por isso o Core avisa, com o comando de remoção, em vez
de deixar o asset órfão passar em silêncio.
