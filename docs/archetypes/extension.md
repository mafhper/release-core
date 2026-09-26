# Arquétipo Extensão (um artefato ZIP)

Referência: **Kaes Keid Inspector**. A distribuição é um único archive com a extensão empacotada.

## Quando usar

Projeto de extensão (browser) que publica um ZIP no release, com validação do conteúdo.

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
    "title": "Kaes Keid Inspector",
    "tagline": "Extensão para inspeção de páginas.",
    "image": { "required": true, "granularity": "minor", "upload": true },
    "notes": { "granularity": "tag" }
  },
  "build": {
    "package_manager": "bun",
    "node": "22",
    "bun": "1.3.13",
    "gates": ["bun run lint", "bun run typecheck"],
    "command": "bun run build"
  },
  "artifact": {
    "enabled": true,
    "path": "dist/kaes-keid-inspector.zip",
    "release_name": "kaes-keide-inspector-{version}.zip",
    "validate": ["unzip -t \"$1\""]
  },
  "versions": {
    "files": [{ "path": "manifest.json", "format": "json", "field": "version" }]
  }
}
```

## Pontos de atenção

- **`version.files`**: `manifest.json` valida que o ZIP carrega a versão correta (a tag precisa bater com `package.json` e `manifest.json`).
- **`release_name`**: renomeia o ZIP na linha `major.minor` (`{version}` recebe `X.Y.Z`); o nome do conteúdo de build (`kaes-keid-inspector.zip`) difere do nome de release (`kaes-keide-inspector-v1.0.0.zip`).
- **`validate`**: cada comando recebe o arquivo via `$1`. Use `unzip -t "$1"` como integridade mínima; validações de conteúdo (manifest presente, ausência de `node_modules/`, `.git/`, source maps) podem ser adicionadas com comandos próprios (ex.: `unzip -l "$1" | ...`).

## Limitações

- `release_name` exige exatamente um artefato. Para múltiplos arquivos, remova `release_name` e use `path`/`globs` com vários itens.