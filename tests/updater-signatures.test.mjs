// Assinaturas do updater — coleta por célula, conferência na release e os
// passos do workflow que as executam.
//
// O que estes testes têm de provar:
//
// 1. **A célula reprova quando não assinou o que declarou.** Um bundler sem a
//    chave, ou com `createUpdaterArtifacts` desligado, termina verde e não emite
//    `.sig` — e a release sairia com instalador que todo cliente instalado
//    recusa. É o defeito que o passo existe para pegar.
// 2. **A release inteira é conferida no `finalize`, por forma de nome.** O nome
//    do bundle carrega versão e arch e muda a cada release; o que é estável é a
//    forma. Plataforma sem assinatura é nomeada na mensagem.
// 3. **Os passos novos são guardados.** Um passo sem `UPDATER_ENABLED == 'true'`
//    mudaria o comportamento de quem não usa updater — e é exatamente a classe
//    de defeito que este arquivo vigia no próprio workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  UpdaterError,
  collectSignatures,
  missingPlatforms,
  parsePlatforms,
  platformsForCell,
  runVerify,
  signaturePatterns,
} from "../scripts/updater-signatures.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIGNATURES = join(ROOT, "scripts", "updater-signatures.mjs");
const WORKFLOW = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");

const PLATFORMS = [
  {
    id: "windows-x86_64",
    os: ["windows-latest"],
    sig: ["bundle/nsis/*x64-setup.exe.sig", "bundle/msi/*x64*.msi.sig"],
  },
  { id: "darwin-aarch64", os: ["macos-latest"], sig: ["bundle/**/*.app.tar.gz.sig"] },
];

function consumerTree(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "updater-tree-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

function windowsTree() {
  return consumerTree({
    "bundle/nsis/App_1.5.0_x64-setup.exe": "binario",
    "bundle/nsis/App_1.5.0_x64-setup.exe.sig": "assinatura-nsis",
    "bundle/msi/App_1.5.0_x64_en-US.msi.sig": "assinatura-msi",
  });
}

/** Ambiente do CLI, com `RELEASES_JSON` no lugar do `gh` (a fresta do teste). */
function releaseEnv(names, platforms = PLATFORMS) {
  return {
    UPDATER_PLATFORMS: JSON.stringify(platforms),
    REPO: "mafhper/demo",
    TAG: "v1.5.0",
    RELEASES_JSON: JSON.stringify([
      { tag_name: "v1.5.0", draft: true, assets: names.map((name) => ({ name })) },
    ]),
  };
}

// --- coleta, por célula -----------------------------------------------------

test("a célula coleta só as plataformas dela, e diz quais deixou para as outras", () => {
  const { files, selected, skipped } = collectSignatures(PLATFORMS, {
    cellOs: "windows-latest",
    cwd: windowsTree(),
  });
  assert.deepEqual(selected, ["windows-x86_64"]);
  assert.deepEqual(skipped, ["darwin-aarch64"]);
  assert.deepEqual(
    files.map((f) => f.split(/[\\/]/).pop()).sort(),
    ["App_1.5.0_x64-setup.exe.sig", "App_1.5.0_x64_en-US.msi.sig"].sort(),
  );
});

test("célula sem nenhuma plataforma declarada não reprova: ela não deve assinatura nenhuma", () => {
  const { files, selected } = collectSignatures(PLATFORMS, {
    cellOs: "ubuntu-latest",
    cwd: windowsTree(),
  });
  assert.deepEqual(files, []);
  assert.deepEqual(selected, []);
});

test("CONTROLE NEGATIVO: plataforma desta célula sem .sig reprova, com o id e os globs", () => {
  const cwd = consumerTree({ "bundle/dmg/App_1.5.0_aarch64.dmg": "binario" });
  assert.throws(
    () => collectSignatures(PLATFORMS, { cellOs: "macos-latest", cwd }),
    (error) => {
      assert.ok(error instanceof UpdaterError);
      assert.match(error.message, /darwin-aarch64/);
      assert.match(error.message, /nenhuma assinatura encontrada/);
      assert.match(error.message, /\.app\.tar\.gz\.sig/);
      return true;
    },
  );
});

test("CONTROLE NEGATIVO: assinatura vazia reprova (arquivo criado, conteúdo nenhum)", () => {
  const cwd = consumerTree({ "bundle/nsis/App_1.5.0_x64-setup.exe.sig": "" });
  assert.throws(() => collectSignatures(PLATFORMS, { cellOs: "windows-latest", cwd }), /assinatura vazia/);
});

test("a plataforma `*` pertence a qualquer célula", () => {
  const { mine } = platformsForCell([{ id: "linux-x86_64", os: ["*"], sig: ["*.sig"] }], "windows-latest");
  assert.equal(mine.length, 1);
});

// --- conferência da release -------------------------------------------------

test("a conferência lê o nome do asset pela forma do glob: o diretório não viaja no asset", () => {
  assert.deepEqual(signaturePatterns(PLATFORMS[0]), ["*x64-setup.exe.sig", "*x64*.msi.sig"]);
  const assets = ["App_1.5.0_x64-setup.exe", "App_1.5.0_x64-setup.exe.sig"];
  assert.deepEqual(missingPlatforms([PLATFORMS[0]], assets), [], "o .sig do Windows está lá");
});

test("CONTROLE NEGATIVO: a plataforma ausente é nomeada, e só ela", () => {
  const assets = ["App_1.5.0_x64-setup.exe.sig"];
  assert.deepEqual(missingPlatforms(PLATFORMS, assets), [
    { id: "darwin-aarch64", patterns: ["*.app.tar.gz.sig"] },
  ]);
});

test("o `.sig` é conferido por forma, não por versão: o nome do bundle muda a cada release", () => {
  assert.deepEqual(missingPlatforms([PLATFORMS[0]], ["App_2.0.0_x64-setup.exe.sig"]), []);
});

test("a conferência reprova quando falta assinatura, e passa quando todas estão lá", () => {
  assert.throws(
    () => runVerify(releaseEnv(["App_1.5.0_x64-setup.exe.sig"])),
    /Updater: a release v1\.5\.0 não tem assinatura para 1 plataforma/,
  );
  assert.deepEqual(
    runVerify(releaseEnv(["App_1.5.0_x64-setup.exe.sig", "App_1.5.0_aarch64.app.tar.gz.sig"])).missing,
    [],
  );
});

test("a conferência não passa vazia quando a lista de plataformas não chegou ao ambiente", () => {
  // O passo só roda por causa de `UPDATER_ENABLED`; se ele rodou sem a lista,
  // algo quebrou antes, e a leitura segura é reprovar — não aprovar o nada.
  assert.throws(() => runVerify({ REPO: "mafhper/demo", TAG: "v1.5.0" }), /UPDATER_PLATFORMS não chegou/);
  assert.throws(() => parsePlatforms("nao-json"), /não é JSON válido/);
});

test("parsePlatforms não aceita plataforma sem id, sem os ou sem sig", () => {
  assert.throws(() => parsePlatforms(JSON.stringify([{ os: ["*"], sig: ["*.sig"] }])), /sem id/);
  assert.throws(() => parsePlatforms(JSON.stringify([{ id: "linux-x86_64", sig: ["*.sig"] }])), /não tem os/);
  assert.throws(() => parsePlatforms(JSON.stringify([{ id: "linux-x86_64", os: ["*"] }])), /não tem sig/);
});

// --- o CLI, como o workflow o chama -----------------------------------------

test("CLI collect escreve uma assinatura por linha; CLI verify confere a release", () => {
  const dir = windowsTree();
  const out = join(dir, "sigs.txt");
  const collect = spawnSync(process.execPath, [SIGNATURES, "collect"], {
    encoding: "utf8",
    env: {
      ...process.env,
      UPDATER_PLATFORMS: JSON.stringify([PLATFORMS[0]]),
      UPDATER_CELL_OS: "windows-latest",
      UPDATER_SIG_OUT: out,
      UPDATER_WORKDIR: dir,
    },
  });
  assert.equal(collect.status, 0, collect.stderr);
  const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.endsWith(".sig")), "só assinatura é publicada por este passo");

  const runVerifyCli = (names) =>
    spawnSync(process.execPath, [SIGNATURES, "verify"], {
      encoding: "utf8",
      env: { ...process.env, ...releaseEnv(names, [PLATFORMS[0]]) },
    });

  assert.equal(runVerifyCli(["App_1.5.0_x64-setup.exe.sig"]).status, 0);

  const semSig = runVerifyCli([]);
  assert.equal(semSig.status, 1, "assinatura ausente tem que reprovar o passo");
  assert.match(semSig.stderr, /::error::Updater: a release v1\.5\.0 não tem assinatura/);
});

test("CLI recusa modo desconhecido em vez de não fazer nada", () => {
  const res = spawnSync(process.execPath, [SIGNATURES, "publish"], { encoding: "utf8", env: process.env });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /modo desconhecido/);
});

// --- os passos do workflow --------------------------------------------------

/** Blocos de passo de `build`/`finalize`, cortados pelo próximo `- name:`. */
function stepBlocks() {
  return WORKFLOW.split("\n      - name: ")
    .slice(1)
    .map((chunk) => `- name: ${chunk}`);
}

test("todo passo que toca o updater tem a guarda UPDATER_ENABLED", () => {
  const tocados = stepBlocks().filter(
    (block) =>
      block.includes("updater-signatures.mjs") ||
      block.includes("updater-manifest.mjs") ||
      block.includes("TAURI_SIGNING_"),
  );
  assert.ok(tocados.length >= 4, "esperava o preparo da chave, a coleta, a conferência e o manifesto");
  for (const block of tocados) {
    const name = block.split("\n")[0];
    assert.match(block, /\n\s+if: env\.UPDATER_ENABLED == 'true'/, `${name} sem guarda do updater`);
  }
});

test("o passo do tauri-action não ganha env novo: quem não assina não muda", () => {
  const tauri = stepBlocks().find((block) => block.includes("tauri-apps/tauri-action"));
  assert.ok(tauri, "o passo do tauri-action precisa existir");
  assert.equal(
    tauri.includes("TAURI_SIGNING_"),
    false,
    "a chave chega pelo ambiente do job, não por env do passo",
  );
});

test("os segredos do updater são declarados como opcionais: caller antigo não quebra", () => {
  assert.match(WORKFLOW, /secrets:\n\s+TAURI_SIGNING_PRIVATE_KEY:\n\s+required: false/);
  assert.match(WORKFLOW, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\n\s+required: false/);
  assert.equal(/required:\s*true/.test(WORKFLOW), false, "nenhum segredo obrigatório: o bloco é opt-in");
});

test("a coleta das assinaturas vem depois do tauri-action, e a conferência antes de publicar", () => {
  const tauri = WORKFLOW.indexOf("tauri-apps/tauri-action");
  const collect = WORKFLOW.indexOf("Coletar e publicar as assinaturas do updater");
  const verify = WORKFLOW.indexOf("Conferir as assinaturas do updater na release");
  const publish = WORKFLOW.lastIndexOf("Publicar o release");
  assert.ok(tauri > 0 && collect > 0 && verify > 0 && publish > 0);
  assert.ok(tauri < collect, "a assinatura só existe depois do build que a produz");
  assert.ok(verify < publish, "assinatura ausente tem que deixar a release em rascunho");
});
