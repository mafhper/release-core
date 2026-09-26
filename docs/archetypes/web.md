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
    "image": { "required": true, "granularity": "minor", "upload": true },
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

## Imagem de release

A arte é resolvida por tag, do mais específico ao mais genérico:

`	ext
docs/images/releases/release-v1.2.0-new.webp   correção (branch padrão)
docs/images/releases/release-v1.2.0.webp       a tag
docs/images/releases/release-v1.2.webp         a linha do minor
docs/images/releases/release.webp              arquivo único (legado)
`

- **granularity: "minor"** exige arte nova só em nova linha major.minor; com
  "tag", a cada versão. O gate compara a arte **que está na tag** com a da
  tag anterior.
- **upload: true** (default) anexa a arte como asset da release e faz o corpo
  apontar para /releases/download/<tag>/<arquivo>, que pode ser corrigido sem
  mover a tag. Use alse para manter a URL raw da tag.
- **Corrigir depois da tag**: commite elease-v1.2.0-new.webp no branch padrão
  e re-rode o workflow da tag. O sufixo -new é convenção de autoria: a
  release não o expõe, e sobrescrever o arquivo da versão no branch padrão tem o
  mesmo efeito.

Detalhes em [../config-schema.md](../config-schema.md).