# Arquétipo Tauri (desktop, N artefatos)

Referências: **PersonalNews** (web + desktop), **push_** (multiplataforma), **Mark-Lee** (híbrido).

## Quando usar

Projeto com app desktop Tauri que publica instaladores (deb/rpm/AppImage, nsis/msi, dmg) na Release.

## Caller com matriz multiplataforma

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
    uses: mafhper/release-core/.github/workflows/release.yml@v1.1.5
    with:
      matrix: |-
        [
          { "os": "ubuntu-latest",  "args": "--bundles appimage,deb" },
          { "os": "windows-latest", "args": "--bundles nsis,msi" },
          { "os": "macos-latest",   "args": "--bundles dmg" }
        ]
```

Cada célula é um job de build (fail-fast desativado). `args` é repassado ao `tauri-action`; campos extras (ex.: `arch`) podem ser adicionados à célula.

## `release.config.json`

```jsonc
{
  "release": {
    "title": "PersonalNews",
    "tagline": "Boletim pessoal com aplicativo desktop.",
    "image": { "required": true, "granularity": "minor", "upload": true },
    "notes": { "granularity": "minor" } // desktop documenta por minor (vX.Y.md)
  },
  "build": {
    "package_manager": "bun",
    "node": "24",
    "bun": "1.x",
    "rust": "stable",
    "apt": ["libwebkit2gtk-4.1-dev", "build-essential", "libxdo-dev"]
  },
  "desktop": {
    "enabled": true,
    "project_path": "."
  },
  "versions": {
    "files": [
      { "path": "desktop/src-tauri/tauri.conf.json", "format": "json", "field": "version" },
      { "path": "desktop/src-tauri/Cargo.toml", "format": "toml", "field": "package.version" }
    ]
  }
}
```

## Regras ativas

- `desktop.enabled: true` exige `build.rust`, proíbe `build.command` e `artifact` (o `tauri-action` publica os instaladores no release rascunho).
- As dependências são instaladas na `build.working_directory` (default `.`) **mesmo com `desktop.enabled: true`**.
- `apt` é instalado apenas em runners Linux.
- Pelo menos `package.json` + `tauri.conf.json` + `Cargo.toml` devem bater com a tag.

## Monorepo npm (raiz ≠ project_path)

Quando o projeto é um monorepo com npm, instale a partir da raiz e aponte `desktop.project_path` para a pasta do app Tauri:

```jsonc
{
  "build": {
    "package_manager": "npm",
    "node": "22",
    "rust": "stable",
    "working_directory": ".",
    "apt": ["libwebkit2gtk-4.1-dev", "build-essential", "libxdo-dev"]
  },
  "desktop": { "enabled": true, "project_path": "apps/desktop" },
  "versions": {
    "files": [
      { "path": "apps/desktop/package.json", "format": "json", "field": "version" },
      { "path": "apps/desktop/src-tauri/tauri.conf.json", "format": "json", "field": "version" },
      { "path": "apps/desktop/src-tauri/Cargo.toml", "format": "toml", "field": "package.version" }
    ]
  }
}
```

O `beforeBuildCommand` do app Tauri continua sendo responsável por compilar o frontend a partir da raiz do monorepo.

## Updater do Tauri (opt-in)

Para o app se atualizar sozinho, o bundler precisa **assinar** cada bundle de
updater e a release precisa levar o `.sig` de cada plataforma. Ligue o bloco
`updater` no `release.config.json`:

```jsonc
"updater": {
  "channel": "stable",
  "platforms": [
    { "id": "windows-x86_64", "os": ["windows-latest"],
      "sig": ["bundle/nsis/*x64-setup.exe.sig", "bundle/msi/*x64*.msi.sig"] },
    { "id": "darwin-aarch64", "os": ["macos-latest"],
      "sig": ["bundle/macos/*.app.tar.gz.sig"] }
  ]
}
```

Três coisas do lado do consumidor, e uma do lado do caller:

1. **`createUpdaterArtifacts`** ligado no `tauri.conf.json` (e o
   `tauri-plugin-updater` no app). Sem isso o bundler não emite `.sig` e a célula
   reprova — que é o comportamento desejado, porque a release prometeria
   atualização que o cliente não consegue verificar.
2. **Chave de assinatura.** Gere o par uma vez (`tauri signer generate`), guarde a
   pública no app e a **privada nos segredos do repositório** como
   `TAURI_SIGNING_PRIVATE_KEY` (conteúdo do arquivo, ou o caminho dele) e, se você
   usou senha, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Nunca no repositório, nunca
   no log. Chave perdida significa uma base instalada que não recebe mais
   atualização: a rotação é decisão de produto, não do workflow.
3. **Callback do caller.** Os dois segredos são declarados como **opcionais** no
   Core, então um caller que não usa updater continua válido sem mudar nada. Quem
   usa passa os segredos do repositório:

```yaml
jobs:
  release:
    uses: mafhper/release-core/.github/workflows/release.yml@v1.3.0
    permissions:
      contents: write
    secrets: inherit          # ou o mapa explícito: TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.X }}
    with:
      matrix: |-
        [
          { "os": "windows-latest", "args": "--bundles nsis,msi" },
          { "os": "macos-latest",   "args": "--bundles dmg" }
        ]
```

O que o Core faz com isso: repassa as duas variáveis ao bundler no passo do
`tauri-action`, publica os `.sig` que a célula produziu (com `--clobber`, como os
artefatos declarados) e, no `finalize`, exige **uma assinatura por plataforma**
declarada entre os assets. Faltando alguma, a release **fica em rascunho**.

O nome real do bundle (`App_1.5.0_x64-setup.exe`, `App_1.5.0_aarch64.dmg`) muda a
cada versão, então `sig` declara a **forma** (globs), não o nome. Na conferência, o
Core compara o nome do asset com o último segmento do glob: o token que distingue
as plataformas (`x64`, `aarch64`) tem de estar no **nome do arquivo**.

Ainda **fora** deste bloco: o `latest.json` (manifesto por canal) e o gate de
promoção. Enquanto eles não existem, o app precisa de uma fonte de manifesto
própria — o Core entrega o `.sig` publicado, e nada além.

## Observações

- O Release Core **não conhece** PersonalNews vs push_ vs Mark-Lee; a topologia é definida por célula da matrix (consome o rascunho do release de forma idempotente).
- Modelo 0..N: uma plataforma pode produzir vários instaladores (setup.exe + setup.msi), todos enviados.
- CI e deploy (Pages) ficam no consumidor. Projetos híbridos (web + desktop) usam o caller acima só para release; o Pages continua em workflow separado.
- Validações extras de conteúdo podem ser declaradas nos jobs ou via `gates` (ex.: `rustup` targets, testes).