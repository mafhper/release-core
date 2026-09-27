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

# Normaliza o fim de linha ANTES do hash. `actions/checkout` converte LF em CRLF
# no Windows (core.autocrlf por omissão), e o checkout dos três jobs não produz os
# mesmos bytes para o mesmo arquivo. Sem normalizar, o tripwire acusava divergência
# de contrato no job do Windows que não existia — e, pior, deixava de distinguir
# divergência real de normalização, que é o que ele existe para medir.
#
# `tr -d '\r'` e não `sed 's/\r$//'` por portabilidade: BSD sed (macOS) nao
# interpreta `\r` como carriage return, e a diferenca entre as duas formas seria
# exatamente o bug outra vez. Remover todo CR e seguro porque JSON proibe CR cru
# dentro de string (tem de vir escapado), entao todo CR do arquivo e fim de linha.
config_sha="$(tr -d '\r' < "$CONFIG_FILE" | sha256sum | cut -d' ' -f1)"
# O tools dir é um git init + fetch + checkout, então HEAD é o commit do
# action_ref. Se não for um repositório, o digest ainda é válido: o que muda é
# apenas a segunda metade da entrada.
tools_sha="$(git -C "$TOOLS_DIR" rev-parse HEAD 2>/dev/null || echo "sem-git")"

printf 'sha256:%s\n' "$(printf '%s %s' "$config_sha" "$tools_sha" | sha256sum | cut -d' ' -f1)"
