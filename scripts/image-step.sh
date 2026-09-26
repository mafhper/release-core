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

# IMAGE_URL vai para o $GITHUB_ENV porque o corpo é montado no step SEGUINTE
# (o $GITHUB_ENV só vale para steps seguintes, e um export daqui não voltaria
# para o shell que chama este script). Por isso image-step.sh e release-body.sh
# não podem roda no mesmo step: o corpo cairia no fallback legado e serviria a
# arte antiga da tag em vez do asset.
set_image_url() {
  echo "IMAGE_URL=$1" >> "$GITHUB_ENV"
}

if [ "$IMAGE_UPLOAD" != "true" ]; then
  # Sem asset, só dá para servir o que está na própria tag.
  if [ "$IMAGE_SOURCE" = "tag" ]; then
    set_image_url "https://raw.githubusercontent.com/$REPO/$TAG/$IMAGE_RESOLVED_REL"
  fi
  exit 0
fi

# O caminho vem do resolver, que já o resolveu: reconstruir aqui por nome
# confundiria o arquivo em disco (que tem o sufixo de correção) com o nome
# canônico do asset.
asset_src="$IMAGE_RESOLVED_PATH"
if [ ! -f "$asset_src" ]; then
  echo "::error::A arte resolvida sumiu do disco antes do upload: $asset_src"
  exit 1
fi

# O asset é sempre o nome canônico (sem o sufixo de correção): o corpo aponta
# para /releases/download/<tag>/<canônico>, que continua válido se a arte for
# corrigida outra vez, e a release não expõe a terminologia de correção.
# `gh release upload` usa o basename do arquivo e o "#" só define label, então
# a renomeação é feita no disco.
staged_asset="$RUNNER_TEMP/release-art/$IMAGE_ASSET_NAME"
mkdir -p "$(dirname "$staged_asset")"
cp "$asset_src" "$staged_asset"

asset_url="https://github.com/$REPO/releases/download/$TAG/$IMAGE_ASSET_NAME"
local_digest="sha256:$(sha256sum "$staged_asset" | cut -d' ' -f1)"
local_size="$(wc -c < "$staged_asset" | tr -d ' ')"
is_draft="true"
published_digest=""
published_size=""

# Estado do asset na release: rascunho, digest e tamanho. A API lista por
# página em vez de por tag porque release em rascunho não responde por tag.
if release_json="$(gh api "repos/$REPO/releases?per_page=100" 2>/dev/null)"; then
  if state="$(printf '%s' "$release_json" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const [name, tag] = process.argv.slice(1);
      const rel = JSON.parse(s).find((r) => r.tag_name === tag);
      if (!rel) return;
      const asset = (rel.assets || []).find((a) => a.name === name);
      process.stdout.write(
        [rel.draft ? "draft" : "published", asset ? asset.digest || "-" : "-", asset ? asset.size : "-"].join("|"),
      );
    });
  ' "$IMAGE_ASSET_NAME" "$TAG")" && [ -n "$state" ]; then
    is_draft="$(printf '%s' "$state" | cut -d'|' -f1)"
    published_digest="$(printf '%s' "$state" | cut -d'|' -f2)"
    published_size="$(printf '%s' "$state" | cut -d'|' -f3)"
  fi
fi

# "Já publicado" precisa de duas condições: existe asset com esse nome e o
# conteúdo bate. Sem digest (asset antigo), o tamanho é o proxy disponível.
same_artifact() {
  if [ "$published_digest" = "$local_digest" ]; then return 0; fi
  if [ "$published_digest" = "-" ] && [ -n "$published_size" ] && [ "$published_size" = "$local_size" ]; then
    return 0
  fi
  return 1
}

if same_artifact; then
  echo "A arte já está publicada com o mesmo conteúdo ($IMAGE_ASSET_NAME); nada a reenviar."
  set_image_url "$asset_url"
  exit 0
fi

# --clobber apaga antes de enviar: se a release já está pública, trocar a arte
# por conta própria reescreveria uma release que alguém já consumiu.
if [ "$is_draft" = "published" ]; then
  if [ "$published_digest" != "-" ] || [ "$published_size" != "-" ]; then
    echo "::error::A release $TAG já está publicada e o asset $IMAGE_ASSET_NAME tem outro conteúdo."
    echo "::error::Trocar a arte de uma release publicada é deliberado: remova o asset antes de re-rodar."
    echo "::error::gh release delete-asset $TAG $IMAGE_ASSET_NAME --repo $REPO --yes"
    exit 1
  fi
fi

attempt=1
until gh release upload "$TAG" --repo "$REPO" --clobber "$staged_asset"; do
  if [ "$attempt" -ge 3 ]; then
    echo "::error::Falha ao enviar a arte de release após $attempt tentativas."
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 5
done

# URL do asset: própria da release e reenviável com --clobber, que é o caminho
# de correção depois da tag.
set_image_url "$asset_url"
echo "Arte publicada como asset: $IMAGE_ASSET_NAME"
