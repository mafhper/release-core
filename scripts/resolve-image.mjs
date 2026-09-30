#!/usr/bin/env node
// Resolve a arte de release de um tag, do mais específico ao mais genérico.
//
// A arte é por versão para não sobrescrever a imagem das releases anteriores:
// cada tag procura o próprio arquivo e cai para a linha do minor e, por último,
// para o arquivo legado. Um sufixo de correção ("-new") lido do branch padrão
// vence tudo, porque é a única forma de corrigir a arte de uma tag já criada
// sem mover a tag.
//
// Quando o contrato declara `image.changes[]` (eras), essa lista passa a ser a
// autoridade: a arte da tag é a do maior `from` que não passa da tag, e nada
// mais é resolvido por nome. Sem `image.changes`, a cadeia por nome acima roda
// exatamente como antes - nenhum consumidor existente muda de comportamento.
//
// Uso:
//   node resolve-image.mjs <release.config.json> <tag> [--root <dir>] [--correction-dir <dir>] [--json]
//
// Sem --json, imprime linhas KEY=VALUE para $GITHUB_ENV.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "./release-config.mjs";
import { compareVersions, parseTag } from "./prev-tag.mjs";

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
 * Tag sem o qualifier: `v1.2.0-rc1` -> `v1.2.0`.
 * `parseTag` só entende `vX.Y.Z`, então qualquer comparação que envolva tag
 * precisa passar por aqui.
 */
export function baseTagOf(tag) {
  const withV = tag.startsWith("v") ? tag : `v${tag}`;
  return `v${withV.slice(1).split(/[-+]/)[0]}`;
}

/**
 * Ordem de resolução. Cada candidato é { name, canonical, from }.
 *  - `name`: o arquivo como o autor o nomeou (inclui o sufixo de correção).
 *  - `canonical`: o mesmo arquivo sem o sufixo de correção. É o nome do asset
 *    e o da URL no corpo: a release não expõe a terminologia de correção, e o
 *    link continua válido se a arte for corrigida de novo.
 *  - origem "tag": arquivo do checkout da tag (imutável).
 *  - origem "correction": arquivo de correção, do branch padrão ou da própria tag.
 */
export function candidatesFor(spec, tag) {
  const { prefix, ext, correctionSuffix, allowCorrection } = spec;
  const list = [];
  for (const stem of stemsFor(tag)) {
    const canonical = `${prefix}-${stem}${ext}`;
    if (allowCorrection) {
      list.push({ name: `${prefix}-${stem}${correctionSuffix}${ext}`, canonical, from: "correction" });
    }
    list.push({ name: canonical, canonical, from: "tag" });
  }
  // Legado: um arquivo único, sem versão. É o que existia antes da resolução
  // por tag e continua sendo o último recurso.
  const legacy = `${prefix}${ext}`;
  list.push({ name: legacy, canonical: legacy, from: "tag" });
  return list;
}

/**
 * A era que governa a tag: a de maior `from` que não passa dela.
 *
 * `v1.2.3` com eras em v1.0 e v1.2.3 -> a de v1.2.3. Uma tag anterior à
 * primeira era não tem era e cai na cadeia por nome - é o que permite declarar
 * a lista depois, sem reescrever o que já foi publicado.
 *
 * O qualifier é removido antes da comparação: `v1.2.0-rc1` é a arte da
 * v1.2.0, e uma era declarada em v1.2.0 precisa valer nela. Sem isso a
 * prerelease cairia na cadeia por nome e a lista declarada seria ignorada em
 * silêncio, que é o pior modo de falha possível para uma chave de contrato.
 *
 * @param {{changes?: {from: string, file: string}[]}} spec
 * @param {string} tag
 * @returns {{from: string, file: string} | null}
 */
export function eraFor(spec, tag) {
  const changes = spec.changes ?? [];
  if (changes.length === 0) return null;
  const current = parseTag(baseTagOf(tag));
  if (!current) return null;
  let best = null;
  for (const era of changes) {
    const from = parseTag(baseTagOf(era.from));
    if (!from) continue;
    if (compareVersions(from, current) > 0) continue;
    if (!best || compareVersions(from, best) > 0) best = from;
  }
  if (!best) return null;
  return changes.find((era) => parseTag(baseTagOf(era.from)).tag === best.tag);
}

/**
 * Monta a ordem de resolução para uma era declarada. Só o arquivo da era e a
 * sua correção entram: o que não foi declarado não serve, que é o ponto.
 *
 * A correção vai **antes** da extensão (`release-v1.2.3-new.webp`), que é a
 * convenção que o resto do Core e a convenção de correção usam. Sufixo depois da
 * extensão (`release-v1.2.3.webp-new`) seria um arquivo diferente, que ninguém
 * foi procurar — foi o que a primeira versão desta função fez, e o teste pegou.
 */
export function eraCandidatesFor(spec, era) {
  const { correctionSuffix, allowCorrection, ext } = spec;
  const list = [];
  if (allowCorrection) {
    const corrected = ext && era.file.endsWith(ext)
      ? `${era.file.slice(0, -ext.length)}${correctionSuffix}${ext}`
      : `${era.file}${correctionSuffix}`;
    list.push({ name: corrected, canonical: era.file, from: "correction" });
  }
  list.push({ name: era.file, canonical: era.file, from: "tag" });
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
  const era = eraFor(spec, tag);
  const tried = [];

  // Com era declarada, a cadeia é a da era. Sem ela (ou sem era aplicável à
  // tag), a cadeia por nome - inalterada.
  const chain = era
    ? eraCandidatesFor(spec, era)
    : candidatesFor(spec, tag);

  for (const candidate of chain) {
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
      // O asset é sempre o nome canônico: é o que a release publica e o que a
      // URL do corpo usa, sem a terminologia de correção.
      assetName: candidate.canonical,
      era,
      // Uma era declarada e ausente é erro de contrato, não "não há arte": a
      // lista diz qual arquivo deveria estar lá, e o motivo precisa dizer isso.
      reason: null,
      undeclared: undeclaredPerTagFiles(spec, tag, era, exists, root),
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
    era,
    reason: era ? "era-missing" : "not-found",
    undeclared: undeclaredPerTagFiles(spec, tag, era, exists, root),
    tried,
  };
}

/**
 * Arquivos com nome de tag que existem mas não foram declarados como era.
 *
 * A armadilha que este aviso fecha: um arquivo `release-vX.Y.Z.webp` na tag
 * serve **só** aquela tag, porque a tag seguinte cai no arquivo da linha. Quem
 * cria o arquivo com a intenção de "vale da vX.Y.Z em diante" obtém o oposto sem
 * nenhum aviso (registrado como RC-N14).
 *
 * Só os dois nomes específicos da tag contam. O da linha e o legado não são
 * armadilha: eles são justamente a propagação, e podem continuar valendo.
 */
export function undeclaredPerTagFiles(spec, tag, era, exists, root) {
  if ((spec.changes ?? []).length === 0) return [];
  const declared = new Set(spec.changes.map((entry) => entry.file));
  const perTagStems = stemsFor(tag).slice(0, 2);
  return perTagStems
    .map((stem) => `${spec.prefix}-${stem}${spec.ext}`)
    .filter(
      (name) =>
        !declared.has(name) &&
        name !== era?.file &&
        exists(join(root, spec.dir, name)),
    );
}

/**
 * Resolve a arte de uma tag **dentro de um ref do git**, sem tocar o disco.
 *
 * É o que permite perguntar "que arte estava em vigor na tag anterior?" depois
 * que a tag atual já foi montada. A existência é testada com
 * `git cat-file -e <ref>:<caminho>` — o object database, não a working tree —
 * porque a working tree normaliza fim de linha e o `RC-N23` pagou por isso.
 *
 * A correção (`-new`) não entra: ela é lida do branch padrão, ou seja, de "depois
 * da tag". A arte em vigor numa tag é a que está no commit dela.
 *
 * @param {object} spec
 * @param {string} tag
 * @param {function} existsAtRef  (relPath) => boolean
 */
export function resolveAtRef(spec, tag, existsAtRef) {
  const era = eraFor(spec, tag);
  const chain = era ? eraCandidatesFor(spec, era) : candidatesFor(spec, tag);
  for (const candidate of chain) {
    if (candidate.from === "correction") continue;
    const rel = `${spec.dir}/${candidate.name}`;
    if (existsAtRef(rel)) {
      return { found: true, name: candidate.name, relPath: rel, era };
    }
  }
  return { found: false, name: null, relPath: null, era };
}

function emitEnv(result) {
  const lines = [
    `IMAGE_RESOLVED_NAME=${result.name ?? ""}`,
    `IMAGE_RESOLVED_PATH=${result.path ?? ""}`,
    `IMAGE_RESOLVED_REL=${result.relPath ?? ""}`,
    `IMAGE_SOURCE=${result.source ?? ""}`,
    `IMAGE_IS_CORRECTION=${String(result.isCorrection)}`,
    `IMAGE_ASSET_NAME=${result.assetName ?? ""}`,
    `IMAGE_REASON=${result.reason ?? ""}`,
    `IMAGE_ERA_FROM=${result.era?.from ?? ""}`,
    `IMAGE_ERA_FILE=${result.era?.file ?? ""}`,
    `IMAGE_UNDECLARED=${(result.undeclared ?? []).join(" ")}`,
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
    changes: cfg.release.imageChanges,
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
