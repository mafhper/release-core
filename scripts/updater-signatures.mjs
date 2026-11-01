#!/usr/bin/env node
// Assinaturas do updater: coleta na célula, conferência na release.
//
// O updater do Tauri não instala um binário que ele mesmo baixou sem verificar a
// assinatura: o `.sig` que o bundler emite ao lado de cada bundle é o que o
// cliente usa para recusar um pacote trocado no caminho. Duas consequências para
// o protocolo de release, e este script existe para as duas:
//
//   1. **A célula publica o que assinou.** O `tauri-action` publica os
//      instaladores; o `.sig` é publicado aqui, com `--clobber`, para que a
//      release seja o mesmo conjunto em qualquer re-execução. Uma release com
//      instalador e sem `.sig` é uma release que todo cliente instalado recusa —
//      e que passa verde em todo mundo, porque nada no build olha para isso.
//   2. **A release inteira é conferida no `finalize`.** `build` verde é uma
//      afirmação sobre células; "a plataforma X tem assinatura na release" é uma
//      afirmação sobre a release, e só o `finalize` a enxerga. Falhar aqui deixa
//      a release em rascunho — que é o estado certo para uma release que não
//      serve os clientes.
//
// O Core **não conhece** o nome que o Tauri dá ao bundle (ele carrega versão,
// arch e flavour, e muda entre versões). O que a plataforma declara é a **forma**
// das assinaturas que ela produz, em globs — a mesma semântica de
// `distribution.artifacts[].globs` e de `matrix[].expect`:
//
//   "updater": {
//     "platforms": [
//       { "id": "windows-x86_64", "os": ["windows-latest"],
//         "sig": ["bundle/nsis/*x64-setup.exe.sig", "bundle/msi/*x64*.msi.sig"] }
//     ]
//   }
//
// Na coleta, o glob é expandido a partir da raiz do repositório. Na conferência,
// o que se compara é o **nome do asset** com o último segmento do glob (o asset
// publicado é o arquivo, sem diretório) — por isso o glob deve carregar o token
// que distingue as plataformas (`x64`, `aarch64`) no próprio nome do arquivo,
// não só no diretório.
//
// Sem o bloco `updater` no contrato, `UPDATER_PLATFORMS` não existe no ambiente e
// nada disto roda: não há passo novo no workflow.
//
// Uso:
//   UPDATER_PLATFORMS=... UPDATER_CELL_OS=windows-latest UPDATER_SIG_OUT=... \
//     node updater-signatures.mjs collect
//   UPDATER_PLATFORMS=... REPO=... TAG=... node updater-signatures.mjs verify
import { execFileSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { expandGlobs, globToRegExp } from "./collect-artifacts.mjs";

const note = (m) => process.stderr.write(`${m}\n`);

/**
 * Erro de assinatura. É exceção, e não `process.exit`: a mesma razão do
 * `collect-artifacts.mjs` — a lógica tem que poder rodar dentro do runner de
 * teste, e um `process.exit` ali derrubaria a suíte inteira em vez do caso.
 */
export class UpdaterError extends Error {}

/** `UPDATER_PLATFORMS` é JSON emitido por `release-config.mjs --env`. */
export function parsePlatforms(raw, source = "UPDATER_PLATFORMS") {
  if (!raw || !String(raw).trim()) {
    throw new UpdaterError(
      `${source} não chegou ao ambiente. O bloco \`updater\` está habilitado no contrato e o passo só roda ` +
        "por causa dele; sem a lista de plataformas, esta célula publicaria zero assinaturas e ficaria verde — " +
        "que é a degradação silenciosa que este passo existe para impedir.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UpdaterError(`${source} não é JSON válido: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new UpdaterError(`${source} deve ser um array de plataformas.`);
  for (const platform of parsed) {
    if (typeof platform !== "object" || platform === null || Array.isArray(platform)) {
      throw new UpdaterError(`${source} tem uma entrada que não é objeto: ${JSON.stringify(platform)}`);
    }
    if (typeof platform.id !== "string" || platform.id === "") {
      throw new UpdaterError(`${source} tem uma plataforma sem id.`);
    }
    if (!Array.isArray(platform.os) || platform.os.length === 0) {
      throw new UpdaterError(`${source}: a plataforma '${platform.id}' não tem os.`);
    }
    if (!Array.isArray(platform.sig) || platform.sig.length === 0) {
      throw new UpdaterError(`${source}: a plataforma '${platform.id}' não tem sig (globs das assinaturas).`);
    }
  }
  return parsed;
}

/** As plataformas que **esta** célula produz, e as que são de outra. */
export function platformsForCell(platforms, cellOs) {
  const mine = [];
  const others = [];
  for (const platform of platforms) {
    if (platform.os.includes("*") || platform.os.includes(cellOs)) mine.push(platform);
    else others.push(platform);
  }
  return { mine, others };
}

/**
 * Último segmento de cada glob: é o que o asset publicado pode casar, porque o
 * `gh release upload` usa o nome do arquivo, sem o diretório de origem.
 */
export function signaturePatterns(platform) {
  return platform.sig.map((glob) => String(glob).split("/").pop());
}

/**
 * Arquivos `.sig` que esta célula tem de publicar.
 *
 * Plataforma atribuída a esta célula **sem nenhuma assinatura em disco** reprova:
 * é a diferença entre "o build passou" e "o cliente tem como verificar o que vai
 * receber". Plataforma de outra célula é ignorada com nota, não com erro.
 */
export function collectSignatures(platforms, { cellOs, cwd }) {
  const { mine, others } = platformsForCell(platforms, cellOs);
  for (const platform of others) {
    note(
      `Updater '${platform.id}': não é desta célula (${cellOs}); a assinatura é coletada na célula declarada em os.`,
    );
  }

  const files = [];
  const seen = new Set();
  for (const platform of mine) {
    const found = expandGlobs(platform.sig, cwd);
    if (found.length === 0) {
      throw new UpdaterError(
        `Updater '${platform.id}': nenhuma assinatura encontrada nesta célula (globs: ${platform.sig.join(", ")}). ` +
          "Sem o .sig, o cliente do updater recusa o pacote — e o build passaria verde com a release publicada.",
      );
    }
    for (const file of found) {
      if (!statSync(file).size) {
        throw new UpdaterError(`Updater '${platform.id}': assinatura vazia: ${relative(cwd, file)}`);
      }
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
    note(`Updater '${platform.id}': ${found.length} assinatura(s).`);
  }

  return { files, selected: mine.map((p) => p.id), skipped: others.map((p) => p.id) };
}

/**
 * Plataformas declaradas que **não** têm assinatura na release.
 *
 * A comparação é por forma: o nome do asset contra o último segmento do glob. Um
 * `.sig` de outra versão casa — e é o que se quer, porque o nome carrega a versão
 * e a conferência é sobre "existe assinatura desta plataforma nesta release".
 */
export function missingPlatforms(platforms, assetNames) {
  const missing = [];
  for (const platform of platforms) {
    const patterns = signaturePatterns(platform);
    const regexes = patterns.map(globToRegExp);
    const present = assetNames.some((name) => regexes.some((re) => re.test(name)));
    if (!present) missing.push({ id: platform.id, patterns });
  }
  return missing;
}

/**
 * Assets da release. `RELEASES_JSON` é a fresta para o teste e para uso offline,
 * pela mesma razão do `verify-artifacts.mjs`: um portão que só o runner consegue
 * exercitar é um portão cujo modo de falha ninguém conhece.
 */
export function listAssets(repo, tag, env = process.env) {
  const raw = env.RELEASES_JSON;
  let releases;
  if (raw) {
    try {
      releases = JSON.parse(raw);
    } catch (error) {
      throw new UpdaterError(`RELEASES_JSON não é JSON válido: ${error.message}`);
    }
  } else {
    releases = JSON.parse(
      execFileSync("gh", ["api", `repos/${repo}/releases?per_page=100`], { encoding: "utf8" }),
    );
  }
  const release = releases.find((r) => r.tag_name === tag);
  if (!release) throw new UpdaterError(`Release não encontrada para a tag ${tag}.`);
  return { draft: release.draft, assets: release.assets ?? [] };
}

export function runCollect(env = process.env) {
  const cwd = env.UPDATER_WORKDIR || process.cwd();
  const cellOs = env.UPDATER_CELL_OS || "";
  const out = env.UPDATER_SIG_OUT || "";
  if (!cellOs) {
    throw new UpdaterError(
      "UPDATER_CELL_OS é obrigatório: sem saber a célula, não dá para decidir quais plataformas são desta.",
    );
  }
  if (!out) throw new UpdaterError("UPDATER_SIG_OUT é obrigatório (caminho do arquivo de saída).");

  const platforms = parsePlatforms(env.UPDATER_PLATFORMS);
  const { files, selected, skipped } = collectSignatures(platforms, { cellOs, cwd });
  writeFileSync(out, files.length ? `${files.join("\n")}\n` : "", "utf8");

  if (files.length === 0) {
    note(`Célula ${cellOs}: nenhuma assinatura a publicar (${selected.length} plataforma(s) desta célula).`);
  } else {
    note(
      `Célula ${cellOs}: ${files.length} assinatura(s) para publicar — ` +
        `${files.map((f) => relative(cwd, f)).join(", ")}`,
    );
  }
  return { files, selected, skipped };
}

export function runVerify(env = process.env) {
  const platforms = parsePlatforms(env.UPDATER_PLATFORMS);
  if (platforms.length === 0) {
    note("Updater desligado (nenhuma plataforma declarada): nada a conferir.");
    return { missing: [] };
  }
  if (!env.TAG) throw new UpdaterError("TAG é obrigatório para conferir a release.");

  const { assets } = listAssets(env.REPO, env.TAG, env);
  const names = assets.map((asset) => asset.name);
  const missing = missingPlatforms(platforms, names);
  if (missing.length > 0) {
    // Uma mensagem só, e não uma por plataforma: o `::error::` é o que GitHub
    // mostra como anotação, e uma release sem três assinaturas é um problema, não
    // três. O texto diz o que fazer em cada causa plausível, porque o log é a
    // única coisa que quem re-roda a release vai ler.
    throw new UpdaterError(
      `Updater: a release ${env.TAG} não tem assinatura para ${missing.length} plataforma(s) — ` +
        missing
          .map(({ id, patterns }) => `'${id}' (nenhum asset casou com ${patterns.map((p) => `'${p}'`).join(" ou ")})`)
          .join("; ") +
        ". Ou a célula que produz a plataforma não rodou, ou `updater.platforms[].os` não aponta para ela, " +
        "ou o bundler não emitiu o .sig (createUpdaterArtifacts e a chave de assinatura no build). " +
        "A release fica em rascunho.",
    );
  }

  const sigCount = names.filter((name) => /\.sig$/.test(name)).length;
  note(`Updater: ${platforms.length} plataforma(s) com assinatura na release (${sigCount} asset(s) .sig).`);
  return { missing: [] };
}

export function run(mode, env = process.env) {
  try {
    if (mode === "collect") return runCollect(env);
    if (mode === "verify") return runVerify(env);
    throw new UpdaterError(`modo desconhecido: "${mode}" (use collect ou verify).`);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) run(process.argv[2]);
