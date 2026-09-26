#!/usr/bin/env bash
# Resolve a arte de release e publica o resultado no ambiente.
#
#   image-step.sh resolve   -> busca a correção no branch padrão, resolve e
#                             escreve IMAGE_* no ambiente
#   image-step.sh publish   -> resolve, sobe a arte como asset da release e
#                             escreve IMAGE_URL
#
# Variáveis vindas de release-config.mjs --env:
#   IMAGE_DIR, IMAGE_PREFIX, IMAGE_EXT, IMAGE_CORRECTION_SUFFIX,
#   IMAGE_ALLOW_CORRECTION, IMAGE_UPLOAD
# Variáveis de contexto:
#   REPO, TAG, TOOLS_DIR, CONFIG_FILE, DEFAULT_BRANCH, PROJECT_ROOT
#   PROJECT_ROOT = raiz do repositório consumidor (o checkout da tag)
set -euo pipefail

mode="${1:-resolve}"
: "${REPO:?REPO obrigatório}"
: "${TAG:?TAG obrigatória}"
: "${IMAGE_DIR:?IMAGE_DIR obrigatório}"
: "${IMAGE_PREFIX:?IMAGE_PREFIX obrigatório}"
: "${IMAGE_EXT:?IMAGE_EXT obrigatório}"
: "${IMAGE_CORRECTION_SUFFIX:?IMAGE_CORRECTION_SUFFIX obrigatório}"
: "${IMAGE_ALLOW_CORRECTION:?IMAGE_ALLOW_CORRECTION obrigatório}"
: "${IMAGE_UPLOAD:?IMAGE_UPLOAD obrigatório}"
: "${TOOLS_DIR:?TOOLS_DIR obrigatório}"
: "${CONFIG_FILE:?CONFIG_FILE obrigatório}"
: "${PROJECT_ROOT:?PROJECT_ROOT obrigatório}"
: "${RUNNER_TEMP:?RUNNER_TEMP obrigatório}"

# A tag pode ser de prerelease (v1.2.0-rc1); a correção vale tanto para o rc
# quanto para a versão base.
version="${TAG#v}"
version="${version%%[-+]*}"
minor_line="${version%.*}"

correction_dir="$RUNNER_TEMP/image-correction"
resolved_env="$RUNNER_TEMP/image-resolved.env"
mkdir -p "$correction_dir"

# O arquivo de correção vive no branch padrão, não na tag: é isso que permite
# corrigir a arte de uma release já publicada sem mover a tag.
fetch_correction() {
  local name="$1"
  local rel="$IMAGE_DIR/$name"
  local out="$correction_dir/$rel"
  local encoded
  mkdir -p "$(dirname "$out")"
  if encoded="$(gh api "repos/$REPO/contents/$rel?ref=$DEFAULT_BRANCH" --jq '.content' 2>/dev/null)" \
    && [ -n "$encoded" ]; then
    printf '%s' "$encoded" | base64 -d > "$out"
    echo "Arte de correção encontrada no branch padrão: $rel" >&2
  fi
}

if [ "$IMAGE_ALLOW_CORRECTION" = "true" ] && [ -n "${DEFAULT_BRANCH:-}" ]; then
  fetch_correction "$IMAGE_PREFIX-v$version$IMAGE_CORRECTION_SUFFIX$IMAGE_EXT"
  if [ "$minor_line" != "$version" ]; then
    fetch_correction "$IMAGE_PREFIX-v$minor_line$IMAGE_CORRECTION_SUFFIX$IMAGE_EXT"
  fi
fi

resolve_args=("$CONFIG_FILE" "$TAG" --root "$PROJECT_ROOT")
if [ "$IMAGE_ALLOW_CORRECTION" = "true" ]; then
  resolve_args+=(--correction-dir "$correction_dir")
fi

# Sai com 1 quando não acha. Vira variável de ambiente; a decisão de falhar é de
# quem chama (IMAGE_REQUIRED).
set +e
node "$TOOLS_DIR/scripts/resolve-image.mjs" "${resolve_args[@]}" > "$resolved_env"
set -e

while IFS='=' read -r key value; do
  export "$key=$value"
  printf '%s=%s\n' "$key" "$value" >> "$GITHUB_ENV"
done < "$resolved_env"

if [ -z "${IMAGE_RESOLVED_PATH:-}" ]; then
  echo "::warning::Nenhuma arte de release encontrada para $TAG em $IMAGE_DIR."
  exit 0
fi

echo "Arte de release: $IMAGE_RESOLVED_NAME (origem: $IMAGE_SOURCE)"

[ "$mode" = "publish" ] || exit 0

if [ "$IMAGE_UPLOAD" != "true" ]; then
  # Sem asset, só dá para servir o que está na própria tag.
  if [ "$IMAGE_SOURCE" = "tag" ]; then
    echo "IMAGE_URL=https://raw.githubusercontent.com/$REPO/$TAG/$IMAGE_RESOLVED_REL" >> "$GITHUB_ENV"
  fi
  exit 0
fi

asset="$correction_dir/$IMAGE_DIR/$IMAGE_ASSET_NAME"
[ -f "$asset" ] || asset="$PROJECT_ROOT/$IMAGE_DIR/$IMAGE_ASSET_NAME"
if [ ! -f "$asset" ]; then
  echo "::error::A arte resolvida sumiu do disco antes do upload: $asset"
  exit 1
fi

attempt=1
until gh release upload "$TAG" --repo "$REPO" --clobber "$asset"; do
  if [ "$attempt" -ge 3 ]; then
    echo "::error::Falha ao enviar a arte de release após $attempt tentativas."
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 5
done

# URL do asset: própria da release e reenviável com --clobber, que é o caminho
# de correção depois da tag.
echo "IMAGE_URL=https://github.com/$REPO/releases/download/$TAG/$IMAGE_ASSET_NAME" >> "$GITHUB_ENV"
echo "Arte publicada como asset: $IMAGE_ASSET_NAME"
