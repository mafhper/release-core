#!/usr/bin/env bash
# Confere o contrato desta execução contra o que o prepare registrou.
#
#   check-contract.sh <digest esperado>
#
# O $GITHUB_ENV não atravessa job, então `release-config.mjs --env` roda nos três
# jobs e a consistência entre eles é um invariante, não uma coincidência. Este
# script é a rede debaixo desse invariante: se a config ou as ferramentas
# divergirem do que o prepare viu, a execução para no primeiro job que discorda,
# em vez de produzir uma release plausível e errada três passos depois.
#
# Falha ruidosa e cedo é o objetivo. Uma divergência aqui é sempre bug de
# infraestrutura do workflow — nunca algo que o consumidor possa ter feito.
set -euo pipefail

expected="${1:-}"
: "${CONFIG_FILE:?CONFIG_FILE obrigatório}"
: "${TOOLS_DIR:?TOOLS_DIR obrigatório}"

if [ -z "$expected" ]; then
  # Sem digest esperado (prepare muito antigo, ou output não propagado), o
  # Core não pode afirmar que o contrato confere. Falhar é a leitura correta:
  # o padrão é não assumir.
  echo "::error::O prepare não registrou contract_digest; não dá para afirmar que o contrato confere."
  echo "::error::Esperado no job prepare: outputs.contract_digest, lido de scripts/contract-digest.sh."
  exit 1
fi

actual="$(bash "$TOOLS_DIR/scripts/contract-digest.sh")"

if [ "$actual" != "$expected" ]; then
  echo "::error::O contrato mudou entre o prepare e este job."
  echo "::error::prepare: $expected"
  echo "::error::aqui   : $actual"
  echo "::error::O config-file e as ferramentas (action_ref) precisam ser os mesmos nos três jobs."
  exit 1
fi

echo "Contrato conferido: $actual"
