#!/usr/bin/env bash
# Imprime o digest do contrato de uma execução: o arquivo de configuração do
# consumidor e o commit das ferramentas do Core.
#
# Por que existe: `release-config.mjs --env` roda nos três jobs (prepare, build,
# finalize) e o $GITHUB_ENV não atravessa job. A consistência entre os três é um
# invariante, não uma coincidência: os três leem o mesmo `config-file` no mesmo
# commit e copiam as ferramentas do mesmo `action_ref`. Se esse invariante um dia
# quebrar - alguém troca um `uses:` por `main` em um job só, ou o checkout passa
# a usar outra ref - a divergência é silenciosa e plausível: o corpo pode sair com
# a URL raw da tag porque o `finalize` acha que não há upload, enquanto o
# `prepare` achou que havia.
#
# A verificação é barata e põe o erro no primeiro job que discorda, em vez de
# depois de um build inteiro. Não substitui o invariante: torna-o checável.
#
#   CONFIG_FILE=<caminho do release.config.json> TOOLS_DIR=<checkout do Core>
set -euo pipefail

: "${CONFIG_FILE:?CONFIG_FILE obrigatório}"
: "${TOOLS_DIR:?TOOLS_DIR obrigatório}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "::error::Arquivo de configuração não encontrado: $CONFIG_FILE" >&2
  exit 1
fi

config_sha="$(sha256sum "$CONFIG_FILE" | cut -d' ' -f1)"
# O tools dir é um git init + fetch + checkout, então HEAD é o commit do
# action_ref. Se não for um repositório, o digest ainda é válido: o que muda é
# apenas a segunda metade da entrada.
tools_sha="$(git -C "$TOOLS_DIR" rev-parse HEAD 2>/dev/null || echo "sem-git")"

printf 'sha256:%s\n' "$(printf '%s %s' "$config_sha" "$tools_sha" | sha256sum | cut -d' ' -f1)"
