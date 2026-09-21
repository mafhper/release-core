# Workflow de Release (Release Core)

Este repositório fornece o **Release Core**: um protocolo reutilizável de release para o portfólio `mafhper`, consumido como reusable workflow.

Princípio arquitetural:

> O projeto descreve sua distribuição. O Core executa o protocolo de release.

- O consumidor declara **o que construir / como / em quais plataformas / quais artefatos / quais arquivos possuem versão** em `.github/release.config.json`.
- O Core executa **validação, preparação, gates, build, artefatos, política de imagem, corpo da release, idempotência e publicação**.

É proibido adicionar lógica por projeto ao Core (ex.: `if repository == "mafhper/push_"`). Se isso for necessário, o contrato de configuração está incompleto.

## Consumo

```yaml
jobs:
  release:
    uses: mafhper/release-core/.github/workflows/release.yml@v1.1.5
    permissions:
      contents: write
    with:
      matrix: '[{ "os": "ubuntu-latest" }]'
```

Sempre fixe a versão imutável (`@v1.1.5`), nunca `@main`. O Core é tratado como uma API de automação: uma mudança que quebra o contrato deve gerar `v2.0.0`.

## Inputs do workflow

| Input | Default | Descrição |
|---|---|---|
| `matrix` | `[{"os":"ubuntu-latest"}]` | Células `{ os, ... }` do build. Propriedade do consumidor (ex.: testes multiplataforma, `args` por plataforma). |
| `config-file` | `.github/release.config.json` | Caminho do contrato de configuração. |
| `tag` | vazio | Tag a publicar; usado em `workflow_dispatch`. No push de tag, usa `github.ref_name`. A tag deve já existir no repositório. |

Tudo que é conteúdo/construção (ferramentas, versões de toolchain, gates, build, artefatos, imagem, notas, seções) vive no `release.config.json` — o contrato é a fonte única. O único conteúdo executável que não pode estar no arquivo é a matrix (necessária no momento do roteamento do job).

## Topologia interna

```text
prepare ──► build (matrix, fail-fast: false) ──► finalize
```

- **prepare** (ubuntu): resolve/valida a tag, exporta a configuração, valida coerência, versão (`package.json` + `versions.files`), política de imagem, calcula `prev_tag`, detecta prerelease e cria/recupera o release **como rascunho** (idempotente, com retry). Se não há build declarado, marca `build_enabled=false`.
- **build** (1 job por célula da matrix): instala só o necessário (apt/node/bun/rust conforme o contrato), instala as dependências do projeto pelo package manager declarado (`bun install --frozen-lockfile`/`npm ci`) na `build.working_directory` — **sempre que `package_manager` é declarado, inclusive em projetos desktop** —, executa gates → pre → build (ou `tauri-action` em projetos desktop), valida e envia artefatos com `--clobber` e retry.
- **finalize**: remonta o corpo (imagem + título/tagline + notas + seções + changelog em `<details>`), publica o release (`draft=false` e `prerelease` conforme semver) e atesta. Só roda se `prepare` passou e `build` passou ou foi pulado (nunca publica release parcial em caso de falha).

## Fases operacionais

1. **Preparação** — checkout do consumidor (histórico completo) + bootstrap dos scripts do Core (referenciados pela mesma versão consumida, `github.action_ref`) em `$RUNNER_TEMP/.release-tools`, **fora do checkout do consumidor** para não contaminar lint/gates/testes do projeto; o bootstrap usa `git fetch` em `run:`, pois um `actions/checkout` auto-referencial (o próprio repositório do Core) quebra a materialização das actions do arquivo ("not our ref").
2. **Validação** — barata e determinística, antes de qualquer build: config válida → tag válida → versão válida → versões consistentes → package manager coerente.
3. **Toolchain** — somente o necessário declarado no contrato (`node`, `bun`, `rust`, `apt`), seguido da instalação das dependências do projeto (`bun install --frozen-lockfile`/`npm ci`) em `build.working_directory` (default: raiz do repositório).
4. **Gates / pre / build** — comandos declarativos; o Core não assume Vite, Next, Tauri, npm ou Bun.
5. **Artefatos** — modelo 0..N: existir → não vazio → validação executavel → rename opcional → upload idempotente.
6. **Imagem** — hard gate por `major.minor` (configurável por `tag`).
7. **Corpo da release** — imagem, título, tagline, notas editoriais, seções, changelog automático.
8. **Publicação** — idempotente e com retry.

## Idempotência e reexecução

- Resolve o release existente pela listagem (`releases?per_page=100`, filtrando `tag_name`) e o reusa; senão cria rascunho. Nunca `create` cego. (Detalhes de implementação: `GET /releases/tags/{tag}` devolve 404 enquanto o draft está em estado "untagged-…", e `gh release view --json id` retorna o **GraphQL id**, que o PATCH REST rejeita — por isso o id numérico vem da REST.)
- Artefatos reenviados com `--clobber`.
- O corpo é reaplicado no final via PATCH.
- Reexecutar o workflow (rerun) não gera `Release already exists`; a partir de `workflow_dispatch` também é possível.
- `concurrency` com `cancel-in-progress: false` — release não é job descartável.

## Permissões

O GITHUB_TOKEN passado do caller ao workflow chamado só pode ser **rebaixado** (nunca elevado). Portanto o caller precisa declarar `permissions: contents: write` e o Core declara `contents: write` como teto (mínimo necessário para criar/publicar a release). `secrets: inherit` não é necessário (o Core não usa secrets). Nada de `write-all`.

## Prerelease

Decisão vem do parser de semver: `v1.2.0` → normal; `v1.2.0-beta.1`, `v2.0.0-rc.1` → prerelease.

## CI (fork deste repositório)

- `actionlint` (versão fixa) sobre os workflows.
- Testes dos helpers (`node --test`) com fixtures web/extension/tauri.
- Validação do config do próprio dogfood e `shellcheck` do `release-body.sh`.

## Fora do escopo (por projeto)

- CI completo (lint/typecheck/test) continua no consumidor — o Release **adiciona** as verificações específicas de distribuição, não repete o CI.
- Deploy (GitHub Pages) é responsabilidade distinta; o Core nunca faz deploy.