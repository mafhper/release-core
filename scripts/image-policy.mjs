#!/usr/bin/env node
// Política editorial da arte de release: o que precisa mudar, e como isso é medido.
//
// Por que um script e não o YAML inline que ele substitui (release.yml, step
// "Validar política da imagem de release"):
//
// 1. **A pergunta mudou de alvo.** O gate perguntava "o nome do arquivo mudou
//    entre as duas tags?". Isso passa com `cp` dos mesmos bytes: o aurawall abriu
//    a linha 1.1 assim, e o custo ficou registrado no STATUS dele. A pergunta que
//    existe de verdade é "os bytes mudaram?".
// 2. **A medição tem que vir do object database.** `git diff --name-only` e
//    `sha256sum` do arquivo em disco medem a working tree, que o `actions/checkout`
//    normaliza de LF para CRLF no Windows. O `RC-N23` pagou uma release inteira
//    por causa disso. Aqui o digest sai de `git cat-file blob`, que é o mesmo
//    objeto nos três sistemas.
// 3. **Lógica inline em YAML não tem teste.** A regra de não juntar os scripts
//    de imagem e corpo num step só (ver AGENTS.md) vale também para a política:
//    um gate que ninguém exercita é um gate que ninguém sabe se falha.
//
// Três regras, nesta ordem, e as três são non-blocking exceto a última:
//
//   `era-missing`  a lista de eras declara um arquivo que não está na tag.
//   `undeclared`   existe `release-vX.Y.Z.webp` na tag sem era que o declare.
//
//                  O arquivo serve só aquela tag, porque a próxima cai no da
//                  linha. É a armadilha do RC-N14, e ela é silenciosa.
//
//   `branch`       a arte veio do branch padrão (correção pós-tag). O conteúdo
//                  mudou por construção, então a troca está declarada. Antes
//                  isso reprovava a release em 13s e sem deixar draft (mark-lee
//                  MKL-N7), porque o gate media caminho de arquivo.
//
//   `reuso`        a política exige troca e os bytes são idênticos aos da tag
//                  anterior. `image.reuse: "allow"` declara a decisão e passa;
//                  sem ela, é aviso. No v2.0.0 vira erro.
//
// Uso (o workflow passa o que o image-step.sh já exportou):
//   IMAGE_REQUIRED=true IMAGE_GRANULARITY=minor IMAGE_REUSE=forbid \
//   TAG=v1.2.3 PREV_TAG=v1.2.2 CONFIG_FILE=.github/release.config.json \
//   PROJECT_ROOT="$GITHUB_WORKSPACE" node scripts/image-policy.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { relative, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "./release-config.mjs";
import { resolveAtRef } from "./resolve-image.mjs";

const warn = (message) => process.stderr.write(`::warning::${message}\n`);
const note = (message) => process.stderr.write(`${message}\n`);
const fail = (message) => {
  process.stderr.write(`::error::${message}\n`);
  process.exit(1);
};

function git(args, cwd, encoding = "utf8") {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

/**
 * Digest do blob de `ref:<caminho>`, ou null se o caminho não existe no ref.
 * Lê do object database: a lição do `RC-N23` é que a working tree mente sobre
 * igualdade de bytes entre runners.
 */
function blobDigest(root, ref, rel) {
  const blob = git(["cat-file", "blob", `${ref}:${rel}`], root, "buffer");
  if (blob === null) return null;
  return createHash("sha256").update(blob).digest("hex");
}

function specFrom(cfg) {
  return {
    dir: cfg.release.imageDir,
    prefix: cfg.release.imagePrefix,
    ext: cfg.release.imageExt,
    correctionSuffix: cfg.release.imageCorrectionSuffix,
    allowCorrection: cfg.release.imageAllowCorrection,
    changes: cfg.release.imageChanges,
  };
}

function lineOf(version) {
  return String(version).split(".").slice(0, 2).join(".");
}

/**
 * O que a política exige nesta tag.
 *
 * `granularity` continua sendo o que decide *quando* a troca é obrigatória, e
 * não some: quem tem config publicado depende desse valor. O que mudou é que ele
 * deixou de ser a única forma de trocar a arte.
 *
 * Uma era que **começa** nesta tag é uma troca declarada, e vale mesmo dentro da
 * linha: essa é a forma de trocar a arte no meio de uma linha `major.minor` sem
 * reescrever o arquivo da linha no lugar.
 */
function changePolicy({ tag, version, prevTag, granularity, eraFrom }) {
  if (granularity === "tag") return { required: true, why: "granularity \"tag\" exige arte nova a cada versão" };
  if (eraFrom && eraFrom === tag) {
    return { required: true, why: `uma era de arte foi declarada em ${eraFrom}` };
  }
  if (prevTag && granularity === "minor") {
    const prevLine = lineOf(String(prevTag).replace(/^v/, ""));
    if (lineOf(version) !== prevLine) {
      return { required: true, why: `a linha major.minor mudou (${prevLine} → ${lineOf(version)})` };
    }
  }
  return { required: false, why: `a política "${granularity}" não exige troca nesta tag` };
}

/**
 * Caminho do config relativo à raiz do checkout, para o diff entre tags.
 *
 * O workflow passa `.github/release.config.json` (relativo à raiz) e os testes
 * passam o caminho absoluto; os dois precisam funcionar, então a normalização é
 * "está dentro da raiz?" em vez de "é literal ou não". Fora da raiz não há
 * caminho relativo para o git, e a checagem é pulada.
 */
function configRelPath(configFile, root) {
  if (!configFile) return null;
  const abs = resolvePath(root, configFile);
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return null;
  return rel;
}

export function runPolicy(env = process.env) {
  const tag = env.TAG;
  if (!tag) fail("TAG é obrigatória.");
  const root = env.PROJECT_ROOT || process.cwd();
  const prevTag = env.PREV_TAG || "";
  const version = tag.replace(/^v/, "").split(/[-+]/)[0];
  const required = env.IMAGE_REQUIRED !== "false";
  const granularity = env.IMAGE_GRANULARITY || "minor";
  const reuse = env.IMAGE_REUSE || "forbid";
  const source = env.IMAGE_SOURCE || "";
  const rel = env.IMAGE_RESOLVED_REL || "";
  const reason = env.IMAGE_REASON || "";
  const eraFrom = env.IMAGE_ERA_FROM || "";
  const eraFile = env.IMAGE_ERA_FILE || "";

  // --- avisos, sempre, e nunca fatais ---

  const undeclared = (env.IMAGE_UNDECLARED || "").split(" ").filter(Boolean);
  for (const name of undeclared) {
    warn(
      `${env.IMAGE_DIR}/${name} existe na tag, mas nenhuma era em image.changes[] declara esse arquivo. ` +
        `Ele serve SÓ a ${tag}: a próxima tag da linha ${lineOf(version)} volta a procurar a arte anterior. ` +
        `Para valer de ${tag} em diante, declare em image.changes[]: { "from": "${tag}", "file": "${name}" }.`,
    );
  }

  const configRel = configRelPath(env.CONFIG_FILE, root);
  if (prevTag && configRel) {
    const changed = (git(["diff", "--name-only", `${prevTag}..HEAD`, "--", configRel], root) ?? "").trim();
    if (changed) {
      warn(
        `o contrato mudou entre ${prevTag} e ${tag} (${changed}). A comparação de arte usa o contrato atual ` +
          `aplicado às duas tags: se a mudança foi no bloco "image", o resultado reflete o hindsight, não o do momento.`,
      );
    }
  }

  // --- erro 1: era declarada e ausente ---

  if (reason === "era-missing") {
    if (!eraFile) fail(`a lista de eras declara uma arte para ${tag}, mas o motivo da ausência ficou vazio.`);
    fail(
      `image.changes[] declara "${eraFile}" a partir de ${eraFrom || "uma era"}, mas esse arquivo não está em ${tag} ` +
        `(${env.IMAGE_DIR || "?"}/${eraFile}). Ou o arquivo foi adicionado depois da tag, ou a entrada aponta para o nome errado.`,
    );
  }

  // --- erro 2: arte obrigatória ausente ---

  if (required && !env.IMAGE_RESOLVED_PATH) {
    fail(`Nenhuma arte de release encontrada para ${tag} em ${env.IMAGE_DIR || "?"}.`);
  }
  if (!env.IMAGE_RESOLVED_PATH) {
    note(`Nenhuma arte de release para ${tag}, e image.required está desligado: a release sai sem imagem.`);
    return { outcome: "absent-optional" };
  }

  // --- a política exige troca? ---

  const policy = changePolicy({ tag, version, prevTag, granularity, eraFrom });
  if (!policy.required) {
    note(`Arte de ${tag}: ${env.IMAGE_RESOLVED_NAME} (${policy.why}).`);
    return { outcome: "no-change-required" };
  }

  // --- a arte veio do branch padrão: a troca está declarada por construção ---

  if (source === "branch") {
    note(
      `Arte de ${tag} vinda do branch padrão (${env.IMAGE_RESOLVED_NAME}): troca declarada, ` +
        `o conteúdo mudou por construção (${policy.why}).`,
    );
    return { outcome: "declared-correction" };
  }

  // --- comparação de conteúdo: o que a política realmente quer saber ---

  if (!prevTag) {
    note(`Arte de ${tag}: ${env.IMAGE_RESOLVED_NAME} (${policy.why}). Primeira release: não há com o que comparar.`);
    return { outcome: "first-release" };
  }
  if (!rel) {
    warn(`a arte de ${tag} não tem caminho relativo à raiz; a comparação de conteúdo foi pulada.`);
    return { outcome: "no-rel" };
  }

  const spec = specFrom(load(env.CONFIG_FILE || resolvePath(root, ".github/release.config.json")));

  const prev = resolveAtRef(spec, prevTag, (prevRel) => {
    try {
      execFileSync("git", ["-C", root, "cat-file", "-e", `${prevTag}:${prevRel}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });

  if (!prev.found) {
    note(
      `Arte de ${tag}: ${env.IMAGE_RESOLVED_NAME} (${policy.why}). ` +
        `${prevTag} não tinha arte, então não há reuso a coibir.`,
    );
    return { outcome: "no-previous-art" };
  }

  const nowDigest = blobDigest(root, "HEAD", rel);
  const prevDigest = blobDigest(root, prevTag, prev.relPath);
  if (!nowDigest || !prevDigest) {
    warn(
      `não consegui ler o conteúdo de ${rel} (HEAD) nem de ${prev.relPath} (${prevTag}) do object database; ` +
        `a comparação de conteúdo foi pulada.`,
    );
    return { outcome: "digest-unavailable" };
  }

  if (nowDigest !== prevDigest) {
    note(
      `Arte de ${tag} trocada: ${rel} sha256:${nowDigest.slice(0, 8)} contra ${prev.relPath} ` +
        `sha256:${prevDigest.slice(0, 8)} em ${prevTag} (${policy.why}).`,
    );
    return { outcome: "changed", nowDigest, prevDigest };
  }

  if (reuse === "allow") {
    warn(
      `A arte de ${tag} é byte a byte a de ${prevTag} (${rel}, sha256:${nowDigest.slice(0, 8)}), e a política ` +
        `exigia troca (${policy.why}). Reuso declarado por image.reuse: "allow".`,
    );
    return { outcome: "reuse-declared", nowDigest, prevDigest };
  }

  warn(
    `A arte de ${tag} NÃO mudou: ${rel} é byte a byte igual à de ${prevTag} (sha256:${nowDigest.slice(0, 8)}), ` +
      `e a política exige troca (${policy.why}). Se a intenção era uma arte nova, os bytes precisam ser diferentes - ` +
      `o gate compara conteúdo, não nome de arquivo. Se a intenção era reusar de propósito, declare ` +
      `image.reuse: "allow" no release.config.json para que a decisão fique registrada.`,
  );
  return { outcome: "unchanged", nowDigest, prevDigest };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runPolicy();
