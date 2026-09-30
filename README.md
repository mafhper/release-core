<p align="center">
  <img src="docs/images/assets/banner.webp" alt="Release Core" width="100%">
</p>

[![CI](https://github.com/mafhper/release-core/actions/workflows/ci.yml/badge.svg)](https://github.com/mafhper/release-core/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/tag/mafhper/release-core?sort=semver&label=release)](https://github.com/mafhper/release-core/releases)
[![Licença](https://img.shields.io/github/license/mafhper/release-core)](LICENSE)

É um protocolo de release reutilizável para GitHub Actions. Um único workflow — consumido como reusable workflow — entrega releases verificadas, idempotentes e publicadas de forma consistente para aplicações **web**, **extensões de navegador** e **aplicações desktop (Tauri)**, sem duplicar lógica entre repositórios.

> O projeto descreve sua distribuição. O Core executa o protocolo de release.

## Problema

Cada projeto do portfólio pode implementar seu próprio workflow de release: validação de versão ad-hoc, body de release duplicado, ausência de idempotência e de política de imagem. Conhecer o que diferencia os projetos significa padronizar o que é comum e declarar o que é específico.

## Garantias

- **Validação antes do build** — a tag `vX.Y.Z` é conferida contra `package.json` e `versions.files` (JSON/TOML); qualquer divergência falha antes de iniciar o build.
- **Coerência do package manager** — `bun`/`npm` exigem evidência de lockfile e declaração consistente em `package.json#packageManager`.
- **Instalação desacoplada do desktop** — dependências são instaladas sempre que `package_manager` é declarado, inclusive com `desktop.enabled: true` (o `beforeBuildCommand` do Tauri depende do workspace). A instalação usa `build.working_directory` (default `.`), separado do `desktop.project_path` entregue ao `tauri-action`.
- **Build declarativo** — toolchain (node/bun/rust/apt), gates, pre-build e comando de build vêm do contrato; o Core não assume framework nem gerente de pacotes.
- **Artefatos por célula e perfil misto** — `distribution.artifacts[]` declara o que cada célula da matriz produz, com `os`, `required` e metadados. Site público **e** instaladores convivem na mesma release (`desktop.enabled` não proíbe `build.command` nem artefato). `matrix[].expect` diz o que a célula promete entregar, `matrix[].optional` tolera a célula instável, e o `finalize` confere que todo artefato obrigatório chegou de fato à release.
- **Política de imagem** — a arte é por versão: `release-vX.Y.Z.webp`, com fallback para a linha do minor e para o arquivo legado. O gate compara **conteúdo**, não nome de arquivo: uma arte copiada byte a byte não passa como "arte nova". A troca dentro da mesma linha `major.minor` é declarada em `image.changes[]`, e o reuso intencional em `image.reuse`. Para corrigir a arte depois da tag, comite `<arquivo>-new.webp` no branch padrão e re-rode o workflow: ela sobe como asset e o corpo passa a apontar para ele, sem mover a tag.
- **Release idempotente** — rascunho → publicação, com retry; rerun seguro, nunca um `create` cego.
- **Prerelease automático** — detectado pelo semver da tag (`v1.2.0-beta.1`), sem configuração.
- **Permissões mínimas** — o Core mantém `contents: write` como teto e nunca eleva o token do caller.

## Começando

**1. Adicione o caller** em `.github/workflows/release.yml` no projeto consumidor:

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
    uses: mafhper/release-core/.github/workflows/release.yml@v1.2.5
    with:
      matrix: '[{"os":"ubuntu-latest"}]'
```

**2. Declare as diferenças** em `.github/release.config.json` — [contrato completo](docs/config-schema.md).

**3. Forneça os insumos** — a arte em `docs/images/releases/` (o arquivo único `release.webp` continua aceito como último recurso) e as notas editoriais em `.github/release-notes/` (granularidade declarada no contrato).

A forma mais direta de publicá-la é nomeá-la pela
tag (`release-v1.2.3.webp`) ou pela linha (`release-v1.2.webp`), e usar
`image.changes[]` quando quiser que a troca de arte dentro da linha seja uma
decisão declarada e não um efeito colateral. Ver
[config-schema.md](docs/config-schema.md#trocar-a-arte-dentro-da-linha-e-de-propósito).

## Tipos de projeto suportados

| Tipo | Artefatos | Perfil |
|---|---|---|
| Web | 0 (opcionalmente 1 ZIP) | [arquétipo web](docs/archetypes/web.md) |
| Extensão | 1 ZIP, renomeado na release | [arquétipo extensão](docs/archetypes/extension.md) |
| Desktop (Tauri) | 0..N, matrix por plataforma | [arquétipo Tauri](docs/archetypes/tauri.md) |
| **Misto (site + instaladores)** | artefato próprio **e** instaladores, na mesma release | `distribution.artifacts` com `os` por célula |

## Como funciona

```text
prepare ──► build (matrix, fail-fast: false) ──► finalize
```

- **prepare** resolve e valida tag e configuração, calcula `prev_tag`, detecta prerelease, resolve e confere a política editorial da arte, e cria o release como rascunho (idempotente).
- **build** instala a toolchain declarada e executa gates → pre → build (ou `tauri-action`), coleta e valida os artefatos **desta célula** segundo o `os` declarado, confere o que a célula prometeu entregar (`matrix[].expect`) e envia com `--clobber` e retry.
- **finalize** confere que todo artefato obrigatório **chegou à release** — `build` verde afirma sobre células, não sobre a release —, publica a arte, remonta o corpo (imagem, downloads, título, tagline, notas, seções, changelog automático em `<details>`) e publica. Só roda se `prepare` passou e `build` passou ou foi pulado.

O `release.config.json` é a fonte única da verdade do runtime — toolchain, gates, artefatos, imagem e notas. Os únicos inputs do workflow são `matrix`, `config-file` e `tag`. Lógica específica de projeto no Core é proibida: se for necessária, o contrato está incompleto.

## Versionamento

É tratado como uma API de automação. Consumidores fixam versões imutáveis (`@v1.2.5`); `@main` nunca é dependência permanente. Mudança incompatível no contrato gera `v2.0.0`. Tags publicadas não devem ser movidas.

## Estrutura

```text
.github/
├── workflows/
│   ├── release.yml          # Release Core (workflow_call)
│   ├── release-dogfood.yml  # este repositório consome o próprio Core
│   └── ci.yml               # actionlint + testes + shellcheck
├── release.config.json      # contrato do dogfood
└── release-notes/           # notas editoriais (vX.Y.Z.md)
docs/
├── release-workflow.md
├── config-schema.md
├── archetypes/{web,extension,tauri}.md
├── images/releases/release.webp
└── images/logo/icon-{256,512,1024}.png
scripts/
├── release-config.mjs
├── check-release-version.mjs
└── release-body.sh
tests/
└── fixtures/{web,extension,tauri}
```

## Documentação

| Documento | Conteúdo |
|---|---|
| [release-workflow.md](docs/release-workflow.md) | Arquitetura, fases, idempotência, permissões |
| [config-schema.md](docs/config-schema.md) | Contrato completo, defaults, regras de validação |
| [archetypes/](docs/archetypes/) | Perfis web, extensão e Tauri |

## Roadmap

- Milestones do portfólio: regras de proteção de `main` e tags, Dependabot (Actions/npm), CodeQL, deploy separado, matrix multiplataforma, health checks.
- Próximos itens do Core: política de identidade e substituição de artefatos (a guarda de `digest` hoje protege só a arte; binários são reenviados com `--clobber`), artefatos required/opcionais por plataforma, diagnósticos aprimorados.

## Licença

MIT — veja [LICENSE](LICENSE).
