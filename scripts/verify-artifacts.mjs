#!/usr/bin/env node
// Conferência da release: os artefatos obrigatórios chegaram?
//
// O problema que este script existe para fechar, dito por um consumidor:
//
//   "Não basta o comando de build terminar com sucesso se o workflow não
//    encontrar os arquivos esperados."  (icon-core)
//
// `build` verde é uma afirmação sobre **células**, e cada célula só enxerga a
// si mesma. A afirmação que importa é sobre a **release**, e só o `finalize` a
// enxerga inteira. Sem esta conferência, um artefato obrigatório que nenhuma
// célula produziu sai com a release publicada e ninguém percebe — foi assim que
// um projeto ficou só com `aarch64` no macOS sem ninguém notar.
//
// A conferência é por **nome**, e por isso só vale para o artefato que declara
// `release_name`: é o único cujo nome de asset é determinístico. O que o Tauri
// gera tem nome próprio (e muda entre versões), então esse é conferido pelo
// piso por célula, `matrix[].min_assets`, no `build`. Os dois mecanismos juntos
// cobrem "produziu o que prometeu" sem o Core precisar conhecer o gerador.
//
// E, como bônus, monta a tabela de downloads a partir do que está **realmente**
// publicado. Uma tabela escrita à mão em `sections.usage` já divergiu do nome
// real uma vez e virou link 404 sem ninguém ver (push_, o `.rpm` do Tauri).
//
// Uso (no finalize, antes de montar o corpo):
//   DIST_ARTIFACTS=... REPO=... TAG=... node verify-artifacts.mjs
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const warn = (m) => process.stderr.write(`::warning::${m}\n`);
const note = (m) => process.stderr.write(`${m}\n`);
const fail = (m) => {
  process.stderr.write(`::error::${m}\n`);
  process.exit(1);
};

/**
 * Assets da release. Lista por página porque rascunho não responde por tag.
 *
 * `RELEASES_JSON` existe para o teste e para uso offline: sem ele, este script só
 * funciona com `gh` no PATH e token, o que tornaria a regra de convergência
 * impossível de exercitar fora do runner — e um portão que só o runner pode
 * exercitar é um portão cujo modo de falha ninguém conhece.
 */
export function listAssets(repo, tag, env = process.env) {
  const raw = env.RELEASES_JSON;
  let releases;
  if (raw) {
    try {
      releases = JSON.parse(raw);
    } catch (error) {
      fail(`RELEASES_JSON não é JSON válido: ${error.message}`);
    }
  } else {
    releases = JSON.parse(
      execFileSync("gh", ["api", `repos/${repo}/releases?per_page=100`], { encoding: "utf8" }),
    );
  }
  const release = releases.find((r) => r.tag_name === tag);
  if (!release) fail(`Release não encontrada para a tag ${tag}.`);
  return { draft: release.draft, assets: release.assets ?? [] };
}

/** Nome de asset esperado para um artefato, ou null se não é determinístico. */
export function expectedAssetName(artifact, tag) {
  if (!artifact.releaseName) return null;
  const version = String(tag).replace(/^v/, "").split(/[-+]/)[0];
  return artifact.releaseName.replace(/\{version\}/g, version).split("/").pop();
}

/**
 * Tabela de downloads em markdown, montada dos assets reais.
 *
 * Só entra o que foi publicado. Um artefato opcional que não apareceu não vira
 * linha apontando para arquivo inexistente — a tabela descreve o que existe.
 */
export function downloadsTable(artifacts, assets, tag) {
  const rows = assets.map((asset) => {
    const match = artifacts.find(
      (a) => a.releaseName && expectedAssetName(a, tag) === asset.name,
    );
    return {
      label: match?.label || asset.name.replace(/\.[^.]+$/, ""),
      platform: [match?.platform, match?.architecture].filter(Boolean).join(" · "),
      kind: match?.kind ?? "",
      file: asset.name,
    };
  });
  if (rows.length === 0) return "";

  const hasPlatform = rows.some((r) => r.platform);
  const hasKind = rows.some((r) => r.kind);
  const columns = [
    { head: "Item", get: (r) => r.label },
    ...(hasPlatform ? [{ head: "Plataforma", get: (r) => r.platform || "—" }] : []),
    ...(hasKind ? [{ head: "Tipo", get: (r) => r.kind || "—" }] : []),
    { head: "Arquivo", get: (r) => `\`${r.file}\`` },
  ];

  const line = (cells) => `| ${cells.join(" | ")} |`;
  const head = line(columns.map((c) => c.head));
  const sep = line(columns.map(() => "---"));
  const body = rows
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((r) => line(columns.map((c) => c.get(r))));

  return `## Downloads\n\n${head}\n${sep}\n${body.join("\n")}\n`;
}

export function runVerify(env = process.env) {
  if (!(env.DIST_ARTIFACTS || "").trim()) {
    fail(
      "DIST_ARTIFACTS não chegou ao ambiente. A conferência rodaria sobre uma lista vazia e aprovaria uma release " +
        "sem artefato nenhum — degradação silenciosa. O guard `DIST_HAS_ARTIFACTS` decide se este passo roda.",
    );
  }
  let artifacts;
  try {
    artifacts = JSON.parse(env.DIST_ARTIFACTS);
  } catch (error) {
    fail(`DIST_ARTIFACTS não é JSON válido: ${error.message}`);
  }
  if (artifacts.length === 0) {
    note("Nenhum artefato declarado: nada a conferir.");
    return { checked: 0 };
  }

  const { assets } = listAssets(env.REPO, env.TAG, env);
  const present = new Set(assets.map((a) => a.name));

  const missing = [];
  const unverifiable = [];
  for (const artifact of artifacts) {
    if (!artifact.required) continue;
    const expected = expectedAssetName(artifact, env.TAG);
    if (!expected) {
      // O nome vem do gerador (Tauri). Quem confere esse é o piso por célula.
      unverifiable.push(artifact.id);
      continue;
    }
    if (!present.has(expected)) missing.push({ id: artifact.id, expected });
  }

  if (unverifiable.length > 0) {
    note(
      `Artefatos obrigatórios sem nome de asset determinístico (conferidos por min_assets na célula): ` +
        unverifiable.join(", "),
    );
  }

  if (missing.length > 0) {
    for (const { id, expected } of missing) {
      fail(
        `Artefato obrigatório '${id}' não está na release: nenhum asset chamado '${expected}' foi publicado. ` +
          "Ou a célula que o produz não rodou, ou a matriz precisa declarar essa célula, ou o nome de asset mudou.",
      );
    }
  }

  // "Confirmado por nome" só vale para o que tem nome determinístico. Contar os
  // outros como confirmados seria um número maior e mais bonito que a verdade —
  // e a primeira versão deste resumo fazia exatamente isso.
  const confirmed = artifacts.filter((a) => {
    const expected = expectedAssetName(a, env.TAG);
    return expected !== null && present.has(expected);
  }).length;
  note(
    `Conferência de distribuição: ${assets.length} asset(s) na release, ` +
      `${artifacts.length} artefato(s) declarado(s), ${missing.length} obrigatório(s) ausente(s), ` +
      `${confirmed} confirmado(s) por nome, ${unverifiable.length} sem nome determinístico.`,
  );

  if (env.DIST_DOWNLOADS_TABLE === "true") {
    const table = downloadsTable(artifacts, assets, env.TAG);
    if (table && env.GITHUB_ENV) {
      writeFileSync(env.GITHUB_ENV, `DOWNLOADS_TABLE<<DOWNLOADS_TABLE_EOF\n${table}DOWNLOADS_TABLE_EOF\n`, {
        encoding: "utf8",
        flag: "a",
      });
      note("Tabela de downloads montada a partir dos assets publicados.");
    } else if (!table) {
      warn("downloads_table ligado, mas a release não tem asset correspondente: nenhuma tabela foi montada.");
    }
  }

  return { checked: artifacts.length, missing, unverifiable, confirmed };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runVerify();
