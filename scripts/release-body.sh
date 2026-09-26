#!/usr/bin/env bash
# Monta o corpo do Release (imagem + título/tagline + notas + seções + changelog automático).
# Uso: release-body.sh <arquivo-de-saida>
set -euo pipefail

body_file="${1:?Uso: release-body.sh <arquivo-de-saida>}"
: "${REPO:?REPO obrigatório (owner/repo)}"
: "${TAG:?TAG obrigatória (vX.Y.Z)}"
: "${RELEASE_TITLE:?RELEASE_TITLE obrigatório}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

out=""

# Imagem. IMAGE_URL vem do image-step.sh, no step anterior (asset da release, ou
# URL raw da tag quando não há upload); sem ela, cai no caminho legado, que é a
# URL raw da tag a partir de IMAGE_PATH.
if [ -n "${IMAGE_URL:-}" ]; then
  printf -v out '%s![%s](%s)\n' "$out" "$RELEASE_TITLE" "$IMAGE_URL"
elif [ -n "${IMAGE_PATH:-}" ] && [ -f "$IMAGE_PATH" ]; then
  image_url="https://raw.githubusercontent.com/$REPO/$TAG/$IMAGE_PATH"
  printf -v out '%s![%s](%s)\n' "$out" "$RELEASE_TITLE" "$image_url"
elif [ "${IMAGE_REQUIRED:-true}" = "true" ]; then
  echo "ERRO: imagem de release não resolvida (${IMAGE_PATH:-sem IMAGE_PATH})." >&2
  exit 1
fi

printf -v out '%s\n# %s\n' "$out" "$RELEASE_TITLE"

if [ -n "${RELEASE_TAGLINE:-}" ]; then
  printf -v out '%s\n> %s\n' "$out" "$RELEASE_TAGLINE"
fi

# Notas manuais (opcionais)
notes_granularity="${NOTES_GRANULARITY:-tag}"
notes_dir="${NOTES_DIR:-.github/release-notes}"
if [ "$notes_granularity" = "minor" ]; then
  notes_file="$notes_dir/v${TAG#v}"; notes_file="${notes_file%.*}.md"
else
  notes_file="$notes_dir/${TAG}.md"
fi

if [ -f "$notes_file" ]; then
  printf -v out '%s\n%s\n' "$out" "$(cat "$notes_file")"
fi

# Seções adicionais (verbo no config)
if [ -n "${SECTION_USAGE:-}" ]; then
  printf -v out '%s\n%s\n' "$out" "$SECTION_USAGE"
fi
if [ -n "${SECTION_EXTRA:-}" ]; then
  printf -v out '%s\n%s\n' "$out" "$SECTION_EXTRA"
fi

# Changelog automático dentro de <details>
if command -v gh >/dev/null 2>&1; then
  target="${TARGET_COMMITISH:-main}"
  if gh api --method POST "repos/$REPO/releases/generate-notes" \
      -f tag_name="$TAG" -f target_commitish="$target" \
      --jq '.body' > "$tmp_dir/changelog.md" 2>/dev/null; then
    if [ -s "$tmp_dir/changelog.md" ]; then
      summary="Changelog automático"
      if [ "${RELEASE_LANGUAGE:-pt-BR}" = "en" ]; then
        summary="Automated changelog"
      fi
      printf -v out '%s\n<details>\n<summary>%s</summary>\n\n%s\n\n</details>\n' "$out" "$summary" "$(cat "$tmp_dir/changelog.md")"
    fi
  else
    echo "AVISO: não foi possível gerar o changelog automático. Verifique o token e a branch alvo." >&2
  fi
fi

printf '%s' "$out" > "$body_file"
echo "Corpo do release gravado em $body_file ($(wc -c < "$body_file") bytes)."