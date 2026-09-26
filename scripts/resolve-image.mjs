#!/usr/bin/env node
// Resolve a arte de release de um tag, do mais específico ao mais genérico.
//
// A arte é por versão para não sobrescrever a imagem das releases anteriores:
// cada tag procura o próprio arquivo e cai para a linha do minor e, por último,
// para o arquivo legado. Um sufixo de correção ("-new") lido do branch padrão
// vence tudo, porque é a única forma de corrigir a arte de uma tag já criada
// sem mover a tag.
//
// Uso:
//   node resolve-image.mjs <release.config.json> <tag> [--root <dir>] [--correction-dir <dir>] [--json]
//
// Sem --json, imprime linhas KEY=VALUE para $GITHUB_ENV.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "./release-config.mjs";

/**
 * Stems candidatos para a tag, do mais específico ao mais genérico.
 * `v1.2.0-rc1` -> ["v1.2.0-rc1", "v1.2.0", "v1.2"]
 */
export function stemsFor(tag) {
  const withV = tag.startsWith("v") ? tag : `v${tag}`;
  const version = withV.slice(1);
  const base = version.split(/[-+]/)[0];
  const parts = base.split(".");
  const minorLine = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : base;
  return [...new Set([withV, `v${base}`, `v${minorLine}`])];
}

/**
 * Ordem de resolução. Cada candidato é [nome, base de busca, origem].
 *  - origem "tag": arquivo do checkout da tag (imutável).
 *  - origem "branch": arquivo baixado do branch padrão (correção).
 */
export function candidatesFor(spec, tag) {
  const { prefix, ext, correctionSuffix, allowCorrection } = spec;
  const list = [];
  for (const stem of stemsFor(tag)) {
    if (allowCorrection) {
      list.push({ name: `${prefix}-${stem}${correctionSuffix}${ext}`, from: "correction" });
    }
    list.push({ name: `${prefix}-${stem}${ext}`, from: "tag" });
  }
  // Legado: um arquivo único, sem versão. É o que existia antes da resolução
  // por tag e continua sendo o último recurso.
  list.push({ name: `${prefix}${ext}`, from: "tag" });
  return list;
}

/**
 * @param {object} spec    contrato normalizado (dir/prefix/ext/correction…)
 * @param {string} tag     tag alvo, ex.: v1.2.0
 * @param {object} paths   { root, correctionDir } — root é a raiz do checkout
 * @param {function} exists injetável para teste
 */
export function resolveImage(spec, tag, paths = {}, exists = existsSync) {
  const { root = process.cwd(), correctionDir = null } = paths;
  const tried = [];
  for (const candidate of candidatesFor(spec, tag)) {
    // A correção vale de onde vier: o branch padrão (copia baixada, que é a
    // revisão de agora) tem precedência sobre a própria tag.
    const bases =
      candidate.from === "correction"
        ? [correctionDir, root].filter(Boolean)
        : [root];
    let hit = null;
    for (const base of bases) {
      const full = join(base, spec.dir, candidate.name);
      tried.push({ ...candidate, path: full });
      if (exists(full)) {
        hit = { full, inTag: base === root };
        break;
      }
    }
    if (!hit) continue;
    return {
      found: true,
      name: candidate.name,
      path: hit.full,
      // Relativo à raiz do repositório quando o arquivo está no checkout: é o
      // que permite montar a URL raw. Se veio só do branch padrão, precisa do
      // asset.
      relPath: hit.inTag ? `${spec.dir}/${candidate.name}` : null,
      // Onde o arquivo foi encontrado: na tag (URL raw funciona) ou apenas na
      // cópia baixada do branch padrão (precisa do asset).
      source: hit.inTag ? "tag" : "branch",
      isCorrection: candidate.from === "correction",
      // O asset é sempre o nome do arquivo resolvido: é ele que permite
      // reenviar a arte depois, sem mover a tag.
      assetName: candidate.name,
      tried,
    };
  }
  return {
    found: false,
    name: null,
    path: null,
    relPath: null,
    source: null,
    isCorrection: false,
    assetName: null,
    tried,
  };
}

function emitEnv(result) {
  const lines = [
    `IMAGE_RESOLVED_NAME=${result.name ?? ""}`,
    `IMAGE_RESOLVED_PATH=${result.path ?? ""}`,
    `IMAGE_RESOLVED_REL=${result.relPath ?? ""}`,
    `IMAGE_SOURCE=${result.source ?? ""}`,
    `IMAGE_IS_CORRECTION=${String(result.isCorrection)}`,
    `IMAGE_ASSET_NAME=${result.assetName ?? ""}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const configPath = argv[0];
  const tag = argv[1];
  const asJson = argv.includes("--json");
  const rootIdx = argv.indexOf("--root");
  const corrIdx = argv.indexOf("--correction-dir");
  const root = rootIdx >= 0 ? resolve(argv[rootIdx + 1]) : process.cwd();
  const correctionDir = corrIdx >= 0 ? resolve(argv[corrIdx + 1]) : null;

  if (!configPath || !tag) {
    console.error("Uso: resolve-image.mjs <release.config.json> <tag> [--root <dir>] [--correction-dir <dir>] [--json]");
    process.exit(1);
  }

  const cfg = load(configPath);
  const spec = {
    dir: cfg.release.imageDir,
    prefix: cfg.release.imagePrefix,
    ext: cfg.release.imageExt,
    correctionSuffix: cfg.release.imageCorrectionSuffix,
    allowCorrection: cfg.release.imageAllowCorrection,
    upload: cfg.release.imageUpload,
  };
  const result = resolveImage(spec, tag, { root, correctionDir });

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ tag, spec, ...result }, null, 2)}\n`);
  } else {
    emitEnv(result);
  }
  // Sai com 1 quando não achou: o chamador decide se isso é erro (required).
  process.exit(result.found ? 0 : 1);
}
