#!/usr/bin/env node
// Manifesto por canal do updater — e o gate que decide se o canal avança.
//
// O Core já publica o `.sig` de cada plataforma; o que faltava é o arquivo que o
// `tauri-plugin-updater` de cada app consome: versão, notas, data e, por
// plataforma, a URL do artefato e o **conteúdo** da assinatura. Publicar esse
// arquivo é o que move o canal.
//
// Duas consequências de desenho, e o resto do arquivo existe para as duas:
//
//   1. **O manifesto é o feed.** Um release publicado sem manifesto continua
//      existindo — e o cliente que consulta o canal não o vê. É por isso que a
//      release parcial pode existir e o canal não anda: o estado perigoso é o
//      contrário (manifesto apontando para artefato que não serve).
//   2. **A URL nomeia a tag, sempre.** `releases/download/<tag>/<arquivo>` é uma
//      URL que não pode ser reapontada para outro release; `releases/latest`
//      serviria o que estiver mais novo sob o mesmo endereço, que é a forma mais
//      silenciosa de entregar a versão errada.
//
// O gate tem dois níveis, e o nível é a diferença entre "não publique" e "não
// promova":
//
//   - `release` — o manifesto que sairia daqui está errado ou quebrado (sem
//     assinatura para plataforma declarada, duas assinaturas ambíguas, artefato
//     assinado ausente, versão fora do SemVer, nome carregando outra versão).
//     Reprova o `finalize`, e o release fica em rascunho.
//   - `feed` — a release é legítima mas não é a próxima do canal (downgrade,
//     prerelease no canal stable). O release publica; o manifesto não é enviado.
//
// Sem o bloco `updater` no contrato, `UPDATER_ENABLED` não existe no ambiente e
// este script não roda: nenhum asset novo aparece na release de quem não usa.
//
// Uso (no `finalize`, depois da conferência das assinaturas):
//   UPDATER_PLATFORMS=... UPDATER_CHANNEL=stable TAG=v1.5.0 REPO=owner/repo \
//     UPDATER_MANIFEST_OUT=... node updater-manifest.mjs build
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { globToRegExp } from "./collect-artifacts.mjs";
import { parsePlatforms } from "./updater-signatures.mjs";

const note = (m) => process.stderr.write(`${m}\n`);

/**
 * Erro de manifesto. Exceção, e não `process.exit`: como no coletor e no
 * conferente, a lógica tem de poder rodar dentro do runner de teste.
 */
export class ManifestError extends Error {}

// ---------------------------------------------------------------------------
// Canal
// ---------------------------------------------------------------------------

const CHANNELS = new Set(["stable", "beta"]);

/**
 * Nome do asset do canal. O `stable` fica com o nome que o plugin espera por
 * convenção (`latest.json`); os demais canais ganham sufixo próprio, e é isso
 * que impede um beta de sobrescrever o feed de quem está no stable.
 */
export function channelManifestName(channel) {
  if (!CHANNELS.has(channel)) {
    throw new ManifestError(
      `canal desconhecido: "${channel}". O contrato só aceita ${[...CHANNELS].map((c) => `"${c}"`).join(" e ")}, ` +
        "e o nome do asset do canal sai daqui — inventar um nome novo criaria um feed que ninguém consulta.",
    );
  }
  return channel === "stable" ? "latest.json" : `latest-${channel}.json`;
}

// ---------------------------------------------------------------------------
// Notas
// ---------------------------------------------------------------------------

/**
 * Arquivo de notas manuais da tag — a **mesma** resolução do corpo do release
 * (`release-body.sh`), porque duas fontes de texto para a mesma versão divergem
 * na primeira edição. `granularity: "minor"` cai na nota da linha.
 *
 * O caminho é montado com `/` de propósito: o contrato usa caminhos POSIX nos
 * três sistemas, e o mesmo valor tem de servir de Windows a Linux.
 */
export function notesPath(tag, granularity, dir = ".github/release-notes") {
  const base = String(dir).replace(/\\/g, "/").replace(/\/+$/, "");
  const withV = `v${String(tag ?? "").replace(/^v/, "")}`;
  const name = granularity === "minor" ? withV.replace(/\.[^.]*$/, "") : withV;
  return `${base}/${name}.md`;
}

/** Conteúdo das notas, ou "" quando não há arquivo (notas são opcionais). */
export function readNotes(tag, env = process.env) {
  const dir = env.NOTES_DIR || ".github/release-notes";
  const granularity = env.NOTES_GRANULARITY || "tag";
  try {
    return readFileSync(notesPath(tag, granularity, dir), "utf8").trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// SemVer
// ---------------------------------------------------------------------------

// Forma do SemVer 2.0.0, com zero à esquerda proibido: `01.2.3` não é versão, e
// aceitá-la faria a comparação de downgrade mentir.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** @returns {{major:number,minor:number,patch:number,prerelease:string[],build:string}|null} */
export function parseSemver(text) {
  const match = SEMVER_RE.exec(String(text ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
    build: match[5] ?? "",
  };
}

const numeric = (id) => /^(0|[1-9]\d*)$/.test(id);

/**
 * Precedência do SemVer (§11): componentes numéricos, e prerelease com regra
 * própria — a versão final é maior que qualquer prerelease dela, o identificador
 * numérico compara como número e o alfanumérico compara em ASCII.
 */
export function compareSemver(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let i = 0; ; i += 1) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftIsNumber = numeric(left);
    const rightIsNumber = numeric(right);
    if (leftIsNumber && rightIsNumber) {
      const dl = Number(left);
      const dr = Number(right);
      if (dl !== dr) return dl < dr ? -1 : 1;
      continue;
    }
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    if (left !== right) return left < right ? -1 : 1;
  }
}

const core = (version) => `${version.major}.${version.minor}.${version.patch}`;

// ---------------------------------------------------------------------------
// Qual assinatura serve o feed
// ---------------------------------------------------------------------------

/**
 * Último segmento de cada glob. É o que um asset publicado pode casar: o asset
 * é o arquivo, sem o diretório de origem — a mesma regra da conferência das
 * assinaturas.
 */
export function signaturePatterns(platform) {
  return platform.sig.map((glob) => String(glob).split("/").pop());
}

/**
 * A assinatura que o feed desta plataforma vai usar.
 *
 * A **ordem de `sig`** é a preferência: o plugin recebe uma URL por plataforma,
 * e quem declara diz qual dos bundles é o alvo da atualização. Duas leituras
 * silenciosas ficam de fora de propósito:
 *
 *   - duas assinaturas casando a mesma forma é ambíguo (acontece quando uma
 *     re-execução deixa o `.sig` da versão anterior na release), e escolher uma
 *     seria decidir sem saber;
 *   - nenhuma assinatura é ausência de entrada, não escolha da segunda forma.
 */
export function signatureAssetFor(platform, assets) {
  for (const pattern of signaturePatterns(platform)) {
    const regex = globToRegExp(pattern);
    const matches = assets
      .map((entry) => entry.name)
      .filter((name) => regex.test(name))
      .sort();
    if (matches.length > 1) {
      return { ok: false, reason: "ambiguous", pattern, matches };
    }
    if (matches.length === 1) {
      const chosen = assets.find((entry) => entry.name === matches[0]);
      return {
        ok: true,
        asset: chosen,
        pattern,
        artifactName: chosen.name.replace(/\.sig$/, ""),
      };
    }
  }
  return { ok: false, reason: "missing", patterns: signaturePatterns(platform) };
}

// ---------------------------------------------------------------------------
// Versões servidas pelo canal
// ---------------------------------------------------------------------------

/**
 * Tags publicadas que já têm o manifesto deste canal.
 *
 * É a memória do feed, e ela vem do que está **publicado**: uma release em
 * rascunho não é servida a ninguém, e a própria tag desta execução não conta
 * (reexecutar a mesma tag é a operação normal, não um downgrade).
 */
export function servedChannelReleases(releases, channel, currentTag) {
  const asset = channelManifestName(channel);
  const served = [];
  for (const release of releases ?? []) {
    if (!release || release.draft) continue;
    if (release.tag_name === currentTag) continue;
    const names = (release.assets ?? []).map((entry) => entry.name);
    if (!names.includes(asset)) continue;
    served.push(release.tag_name);
  }
  return served;
}

// ---------------------------------------------------------------------------
// URL do artefato
// ---------------------------------------------------------------------------

/**
 * URL do artefato: nomeia a tag, sempre.
 *
 * `releases/download/<tag>/<arquivo>` é o endereço do asset daquele release;
 * `releases/latest` seria um ponteiro móvel — a mesma URL passaria a servir o
 * arquivo de outro release, e o cliente instalaria uma versão que não é a que o
 * feed anunciou. É a diferença entre um feed e um atalho.
 */
export function immutableAssetUrl(repo, tag, name) {
  if (!repo || !tag || !name) {
    throw new ManifestError(
      `URL do manifesto precisa de repo, tag e nome de arquivo (recebido: "${repo}", "${tag}", "${name}").`,
    );
  }
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

/** `X.Y.Z` embutido num nome de arquivo, ou "" quando não há versão no nome. */
export function versionToken(name) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(name ?? ""));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : "";
}

// ---------------------------------------------------------------------------
// Gate de promoção + manifesto
// ---------------------------------------------------------------------------

const blocker = (code, tier, message) => ({ code, tier, message });

/**
 * Decide se o canal avança e, se avançar, monta o manifesto.
 *
 * `tier` diz o que fazer com o bloqueio:
 *   - `release` — o manifesto está errado ou quebrado; o `finalize` reprova e a
 *     release fica em rascunho;
 *   - `feed` — a release é legítima mas não é a próxima do canal; publica, e o
 *     manifesto não é enviado.
 *
 * Nunca devolve manifesto parcial: com qualquer bloqueio, `manifest` é `null`.
 * Meio feed não é meio problema, é um cliente parado sem ninguém ver.
 */
export function buildFeed({
  repo,
  tag,
  channel,
  platforms,
  assets,
  signatures,
  notes = "",
  pubDate,
  served = [],
}) {
  // O canal é validado aqui também: o nome do asset sai daqui, e um canal
  // inventado criaria um feed que ninguém consulta.
  channelManifestName(channel);

  if (typeof pubDate !== "string" || pubDate.trim() === "") {
    throw new ManifestError(
      "pub_date é obrigatório: o plugin mostra a data da atualização, e um campo ausente vira atualização sem data.",
    );
  }

  const rawVersion = String(tag ?? "").replace(/^v/, "");
  const version = parseSemver(rawVersion);
  if (!version) {
    return {
      promote: false,
      manifest: null,
      blockers: [
        blocker(
          "invalid-version",
          "release",
          `a tag "${tag}" não produz versão SemVer (lida como "${rawVersion}"). O plugin compara versões por ` +
            "precedência SemVer: sem X.Y.Z não há como dizer que esta é mais nova que a instalada, e o feed " +
            "inteiro fica sem sentido.",
        ),
      ],
    };
  }

  const blockers = [];

  if (channel === "stable" && version.prerelease.length > 0) {
    blockers.push(
      blocker(
        "prerelease-on-stable",
        "feed",
        `"${tag}" é prerelease e o canal é stable. Um app no stable receberia uma versão de teste sem ter pedido: ` +
          'declare "channel": "beta" no bloco updater, ou publique esta tag como release estável de verdade.',
      ),
    );
  }

  const newer = served.filter((servedTag) => {
    const other = parseSemver(String(servedTag).replace(/^v/, ""));
    return other !== null && compareSemver(other, version) > 0;
  });
  if (newer.length > 0) {
    blockers.push(
      blocker(
        "downgrade",
        "feed",
        `o canal ${channel} já serve ${newer.map((t) => `"${t}"`).join(", ")}, que é maior que "${tag}". ` +
          "O feed não anda para trás: quem já atualizou não pode ser convidado a voltar. Se esta tag é um hotfix " +
          "de linha antiga, o release pode ser publicado à mão — o manifesto não é.",
      ),
    );
  }

  if (platforms.length === 0) {
    blockers.push(
      blocker(
        "no-platforms",
        "release",
        "nenhuma plataforma declarada: um manifesto com `platforms` vazio não atualiza cliente nenhum, e passaria " +
          "verde porque não há nada para conferir.",
      ),
    );
  }

  const entries = {};
  for (const platform of platforms) {
    const resolved = signatureAssetFor(platform, assets);

    if (!resolved.ok && resolved.reason === "missing") {
      blockers.push(
        blocker(
          "missing-signature",
          "release",
          `plataforma "${platform.id}" não tem assinatura na release: nenhum asset casou com ` +
            `${resolved.patterns.map((p) => `'${p}'`).join(" ou ")}. Sem entrada, o cliente desta plataforma ` +
            "fica preso na versão instalada — e o feed pareceria completo para todo o resto.",
        ),
      );
      continue;
    }
    if (!resolved.ok) {
      blockers.push(
        blocker(
          "ambiguous-signature",
          "release",
          `plataforma "${platform.id}": ${resolved.matches.length} assinaturas casam a forma '${resolved.pattern}' ` +
            `(${resolved.matches.join(", ")}). O feed anuncia UMA URL por plataforma, e escolher entre elas seria ` +
            "decidir sem saber — normalmente é o `.sig` de uma execução anterior que ficou na release. Estreite o " +
            "glob ou ordene `sig` por preferência: o primeiro que casa é o que o feed publica.",
        ),
      );
      continue;
    }

    const { asset, artifactName } = resolved;

    // Proveniência: o nome carrega a versão do build que gerou a assinatura. Se
    // ela não é a desta release, o artefato veio de outro build.
    const diverging = [asset.name, artifactName]
      .map(versionToken)
      .filter(Boolean)
      .find((token) => token !== core(version));
    if (diverging) {
      blockers.push(
        blocker(
          "version-mismatch",
          "release",
          `plataforma "${platform.id}": a assinatura "${asset.name}" carrega a versão ${diverging}, e esta ` +
            `release é ${core(version)}. O feed apontaria para um artefato de outro build — e o cliente o ` +
            "instalaria por achar que é a versão nova.",
        ),
      );
      continue;
    }

    if (!assets.some((entry) => entry.name === artifactName)) {
      blockers.push(
        blocker(
          "orphan-artifact",
          "release",
          `plataforma "${platform.id}": a assinatura "${asset.name}" está na release, mas "${artifactName}" não. ` +
            "A URL do manifesto responderia 404 (ou pior, outro release). Se o instalador foi renomeado por " +
            "`distribution.artifacts[].release_name`, a assinatura perdeu o par.",
        ),
      );
      continue;
    }

    const signature = String(signatures?.[asset.name] ?? "").trim();
    if (signature === "") {
      blockers.push(
        blocker(
          "missing-signature-content",
          "release",
          `plataforma "${platform.id}": o conteúdo de "${asset.name}" não chegou ao manifesto (vazio ou ` +
            "ausente). O `.sig` é o que o cliente verifica: publicar o manifesto sem ele serve um pacote que o " +
            "plugin recusa.",
        ),
      );
      continue;
    }

    entries[platform.id] = { signature, url: immutableAssetUrl(repo, tag, artifactName) };
  }

  if (blockers.length > 0) return { promote: false, blockers, manifest: null };

  // Chaves ordenadas: reexecutar a mesma tag tem de gerar os mesmos bytes.
  const sortedPlatforms = {};
  for (const id of Object.keys(entries).sort()) sortedPlatforms[id] = entries[id];

  return {
    promote: true,
    blockers: [],
    channel,
    assetName: channelManifestName(channel),
    manifest: {
      version: rawVersion,
      notes: String(notes ?? ""),
      pub_date: pubDate,
      platforms: sortedPlatforms,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Releases do repositório, como no resto do Core. `RELEASES_JSON` é a fresta do
 * teste e do uso offline: um portão que só o runner consegue exercitar é um
 * portão cujo modo de falha ninguém conhece.
 */
export function listReleases(repo, env = process.env) {
  const raw = env.RELEASES_JSON;
  if (raw && raw.trim() !== "") {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new ManifestError(`RELEASES_JSON não é JSON válido: ${error.message}`);
    }
  }
  return JSON.parse(
    execFileSync("gh", ["api", `repos/${repo}/releases?per_page=100`], { encoding: "utf8" }),
  );
}

/**
 * Conteúdo de cada `.sig` escolhido — é o que vai no manifesto, não o nome.
 *
 * `UPDATER_SIG_JSON` é a fresta do teste e do uso offline, pela mesma razão do
 * `RELEASES_JSON`. Fora dela, o conteúdo vem do asset da release (a API do asset
 * responde em rascunho; listar por tag, não), que é a fonte de verdade do que o
 * cliente vai baixar.
 */
export function readSignatureContents(chosen, env = process.env) {
  const raw = env.UPDATER_SIG_JSON;
  if (raw !== undefined && String(raw).trim() !== "") {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new ManifestError(`UPDATER_SIG_JSON não é JSON válido: ${error.message}`);
    }
  }
  const contents = {};
  for (const asset of chosen) {
    if (!asset.id) {
      throw new ManifestError(
        `asset "${asset.name}" veio sem id: sem ele não há como baixar o conteúdo da assinatura.`,
      );
    }
    contents[asset.name] = execFileSync(
      "gh",
      ["api", `repos/${env.REPO}/releases/assets/${asset.id}`, "-H", "Accept: application/octet-stream"],
      { encoding: "utf8" },
    );
  }
  return contents;
}

/**
 * Corpo do `finalize`: decide, e só grava quando o canal avança.
 *
 * A gravação e o upload são steps diferentes de propósito: o workflow usa o
 * caminho impresso em stdout como "existe manifesto para enviar". Saída vazia é
 * a resposta honesta para "o canal não anda" — e o passo não pode confundir
 * isso com falha.
 */
export function runBuild(env = process.env) {
  const repo = String(env.REPO ?? "");
  const tag = String(env.TAG ?? "");
  const out = String(env.UPDATER_MANIFEST_OUT ?? "");
  const channel = env.UPDATER_CHANNEL || "stable";

  if (!repo) throw new ManifestError("REPO é obrigatório (owner/repo) para montar a URL do artefato.");
  if (!tag) throw new ManifestError("TAG é obrigatória: é a versão do manifesto e a tag da URL.");
  if (!out) {
    throw new ManifestError("UPDATER_MANIFEST_OUT é obrigatório (diretório onde o manifesto é gravado).");
  }

  const platforms = parsePlatforms(env.UPDATER_PLATFORMS);
  const releases = listReleases(repo, env);
  const release = releases.find((entry) => entry.tag_name === tag);
  if (!release) {
    throw new ManifestError(
      `release não encontrada para a tag ${tag}. O manifesto fala de assets de um release que existe: ` +
        "se ele não está lá, o `prepare` não criou o rascunho e nada abaixo faz sentido.",
    );
  }

  const assets = release.assets ?? [];
  // A mesma resolução que o manifesto usa, para o conteúdo baixado ser
  // exatamente o do asset que o feed vai anunciar.
  const chosen = platforms
    .map((platform) => signatureAssetFor(platform, assets))
    .filter((resolved) => resolved.ok)
    .map((resolved) => resolved.asset);

  const result = buildFeed({
    repo,
    tag,
    channel,
    platforms,
    assets,
    signatures: readSignatureContents(chosen, env),
    notes: readNotes(tag, env),
    pubDate: env.UPDATER_PUB_DATE || new Date().toISOString(),
    served: servedChannelReleases(releases, channel, tag),
  });

  const feedBlocked = result.blockers.filter((blocker) => blocker.tier === "feed");
  for (const blocker of feedBlocked) note(`::warning::[updater:${blocker.code}] ${blocker.message}`);

  const releaseBlocked = result.blockers.filter((blocker) => blocker.tier === "release");
  if (releaseBlocked.length > 0) {
    throw new ManifestError(
      `${releaseBlocked.length} bloqueio(s) impedem o manifesto — a release fica em rascunho: ` +
        releaseBlocked.map((blocker) => `[${blocker.code}] ${blocker.message}`).join(" | "),
    );
  }

  if (!result.promote) {
    note(
      `Canal ${channel}: o feed não avança nesta release (${feedBlocked.map((b) => b.code).join(", ")}). ` +
        "O release segue o fluxo normal; o manifesto não é publicado.",
    );
    return null;
  }

  mkdirSync(out, { recursive: true });
  const file = resolve(out, result.assetName);
  writeFileSync(file, `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");
  note(
    `Canal ${channel}: manifesto ${result.assetName} pronto, ` +
      `${Object.keys(result.manifest.platforms).length} plataforma(s).`,
  );
  // Única coisa em stdout: o caminho do arquivo a enviar.
  process.stdout.write(`${file}\n`);
  return { file, assetName: result.assetName, manifest: result.manifest };
}

export function run(mode, env = process.env) {
  try {
    if (mode === "build") return runBuild(env);
    throw new ManifestError(`modo desconhecido: "${mode}" (use build).`);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) run(process.argv[2]);
