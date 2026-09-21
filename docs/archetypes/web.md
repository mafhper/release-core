# Arquétipo Web (sem artefato)

Referência: **Spread**. Aplicação web publicada em GitHub Pages; a release não produz arquivo binário.

## Quando usar

Projeto web cujo build de distribuição não gera artefato a publicar na Release.

## Caller mínimo

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
      matrix: '[{"os":"ubuntu-latest"}]'
```

## `release.config.json`

```jsonc
{
  "release": {
    "title": "Spread",
    "tagline": "Aplicação web do portfólio.",
    "image": { "required": true, "granularity": "minor" },
    "notes": { "granularity": "tag" },
    "sections": {
      "usage": "## Uso\nAbra em https://mafhper.github.io/spread/"
    }
  },
  "build": {
    "package_manager": "bun",
    "node": "22",
    "bun": "1.3.13",
    "gates": ["bun run lint", "bun run typecheck", "bun test"],
    "command": "bun run build"
  },
  "versions": { "files": [] }
}
```

## Notas

- `versions.files` vazio → só `package.json` é fonte de versão.
- Deploy (GitHub Pages) fica em workflow próprio; o release não publica artefatos.
- CI (lint/typecheck/test) roda no consumidor; os `gates` do release podem reaproveitar os mesmos comandos como súmula da versão publicável.

## Limitações

- Não suporta deploy; para web com artefato estático (ex.: ZIP do dist), veja `extension.md`.