// Consumidor sintético: um projeto de verdade, rodando o protocolo inteiro.
//
// Por que existe, e o que ele já pagou uma vez:
//
// O dogfood do próprio Core tem `build: {}`, então o job `build` é sempre
// pulado. Ele não exercita `package_manager`, `gates`, `pre`, artefato nem
// matriz. Quatro bugs do Core apareceram só em consumidor real — o caminho do
// config resolvido a partir do diretório errado, a matrix que o GitHub Actions
// rejeita nua, gates rodando antes da instalação de dependências, e o bootstrap
// de ferramentas dentro do checkout derrubando o lint do consumidor.
//
// Este arquivo é a redemption: um consumidor com layout real (config em
// `.github/`, manifesto e lockfile na raiz), gates que dependem da instalação,
// artefato próprio, e **duas células de matriz** — uma que produz, outra que
// produz algo opcional que não existe.
//
// O que ele prova, além de "o protocolo roda":
//
//   1. o `os` escolhe o que é de cada célula, e não coleta o que é da outra;
//   2. artefato opcional ausente **não** derruba a célula;
//   3. artefato obrigatório ausente **derruba**, com o nome na mensagem;
//   4. `matrix[].expect` pega a célula que termina sem gerar o instalador;
//   5. a conferência da release reprova quando um obrigatório não chegou.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { load } from "../scripts/release-config.mjs";
import { collect } from "../scripts/collect-artifacts.mjs";
import { checkExpect } from "../scripts/check-cell-expect.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const hasBash = spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
const skipBash = hasBash ? false : "bash indisponível (o CI roda em ubuntu)";

/**
 * Um consumidor de perfil misto: site público **e** instaladores, publicado na
 * mesma release. É o perfil que o contrato proibia e que agora é declarável.
 */
const CONFIG = {
  release: {
    title: "Synthetic",
    tagline: "Perfil misto: site e instaladores na mesma release.",
    language: "pt-BR",
    image: { path: "docs/images/releases", required: true, granularity: "minor" },
    notes: { granularity: "tag" },
  },
  build: {
    package_manager: "npm",
    node: "22",
    rust: "stable",
    working_directory: ".",
    apt: ["libgtk-3-dev"],
    gates: ["npm run lint"],
    command: "npm run build:web",
  },
  desktop: { enabled: true, project_path: "." },
  distribution: {
    downloads_table: true,
    artifacts: [
      {
        id: "web",
        path: "dist/site.zip",
        kind: "archive",
        os: ["ubuntu-latest"],
        required: false,
        label: "Web",
        platform: "web",
      },
      {
        id: "win-x64",
        globs: ["bundle/**/*.msi"],
        kind: "installer",
        os: ["windows-latest"],
        required: true,
        label: "Windows",
        platform: "windows",
        architecture: "x64",
        release_name: "Synthetic-{version}-x64.msi",
      },
      {
        id: "mac-arm64",
        globs: ["bundle/**/*.dmg"],
        kind: "installer",
        os: ["macos-latest"],
        required: false,
        label: "macOS",
        platform: "macos",
        architecture: "arm64",
      },
    ],
  },
  versions: { files: [] },
};

/** A árvore do consumidor: layout real e um build que produz o que promete. */
function consumer(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sintetico-"));
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "synthetic", version: "1.4.0" }), "utf8");
  writeFileSync(join(dir, "package-lock.json"), "{}", "utf8");
  writeFileSync(join(dir, ".github/release.config.json"), JSON.stringify(CONFIG, null, 2), "utf8");
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}


test("o perfil misto é declarável: site e instaladores na mesma release", () => {
  const m = load(join(consumer(), ".github/release.config.json"));
  assert.equal(m.desktop.enabled, true);
  assert.equal(m.build.command, "npm run build:web", "o build do site roda junto do Tauri");
  assert.equal(m.distribution.artifacts.length, 3);
  assert.equal(m.distribution.downloadsTable, true);
  // Três artefatos, três células diferentes: é isso que a prohibition impedia.
  assert.deepEqual(
    m.distribution.artifacts.map((a) => a.os[0]),
    ["ubuntu-latest", "windows-latest", "macos-latest"],
  );
});

test("cada célula coleta o que é dela: o Windows não toca no artefato do site", () => {
  const dir = consumer({
    "dist/site.zip": "web",
    "bundle/msi/Synthetic_1.4.0_x64.msi": "msi",
    "bundle/dmg/Synthetic_1.4.0_arm64.dmg": "dmg",
  });
  const artifacts = load(join(dir, ".github/release.config.json")).distribution.artifacts;

  const win = collect(artifacts, { cellOs: "windows-latest", tag: "v1.4.0", cwd: dir });
  assert.deepEqual(win.selected, ["win-x64"], "o site é de ubuntu, o macOS é de macos");
  assert.deepEqual(win.skipped.sort(), ["mac-arm64", "web"]);
  assert.equal(win.files.length, 1);
  assert.ok(win.files[0].endsWith("Synthetic-1.4.0-x64.msi"), "release_name aplicado");

  const linux = collect(artifacts, { cellOs: "ubuntu-latest", tag: "v1.4.0", cwd: dir });
  assert.deepEqual(linux.selected, ["web"]);
  assert.equal(linux.files.length, 1);
  assert.ok(linux.files[0].endsWith("site.zip"));
});

test("a célula do macOS só produz artefato opcional: ausente, ela avisa e segue", () => {
  const dir = consumer({ "dist/site.zip": "web" });
  const { files } = collect(
    load(join(dir, ".github/release.config.json")).distribution.artifacts,
    { cellOs: "macos-latest", tag: "v1.4.0", cwd: dir },
  );
  assert.equal(files.length, 0, "o DMG opcional não apareceu, e a célula continua");
});

test("CONTROLE NEGATIVO: a célula do Windows sem o MSI obrigatório reprova, com o nome", () => {
  const dir = consumer({ "dist/site.zip": "web" });
  assert.throws(
    () =>
      collect(load(join(dir, ".github/release.config.json")).distribution.artifacts, {
        cellOs: "windows-latest",
        tag: "v1.4.0",
        cwd: dir,
      }),
    (error) => {
      assert.match(error.message, /win-x64/);
      assert.match(error.message, /nada encontrado/);
      return true;
    },
  );
});

test("CONTROLE NEGATIVO: `matrix[].expect` pega a célula que terminou sem gerar o instalador", () => {
  const dir = consumer({ "dist/site.zip": "web", "bundle/msi/Synthetic_1.4.0_x64.msi": "x" });
  const patterns = ["bundle/**/*.msi", "bundle/**/*.exe"];
  const faltando = checkExpect(patterns, dir);
  assert.deepEqual(faltando, ["bundle/**/*.exe"], "o MSI foi gerado; o EXE não — e o build pode ter sido verde");
});

test("gates dependem da instalação: sem `npm ci` o gate falha, e é isso que a ordem garante", () => {
  // O bug do v1.0.3 era gates rodando antes da instalação. Aqui não dá para
  // reproduzir a plataforma, mas dá para registrar a ordem que o workflow impõe,
  // que é a afirmação que vale.
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const ordem = ["Instalar dependências do projeto", "Portões de qualidade", "Passos de preparação", "Compilar o aplicativo"];
  const posicoes = ordem.map((nome) => workflow.indexOf(`- name: ${nome}`));
  for (const [i, pos] of posicoes.entries()) {
    assert.ok(pos > 0, `passo ausente: ${ordem[i]}`);
    if (i > 0) assert.ok(pos > posicoes[i - 1], `passo fora de ordem: ${ordem[i]} depois de ${ordem[i - 1]}`);
  }
});

test("a célula tolerate a falha é declarada na matrix, e o job a respeita", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /continue-on-error: \$\{\{ matrix\.optional == true \}\}/);
});

test("as ferramentas do Core ficam fora do checkout do consumidor", () => {
  // O bug do v1.0.4: o bootstrap em `.release-tools/` dentro da raiz do
  // consumidor fazia o lint dele varrer arquivos do Core e reprovar. Toda menção
  // ao diretório de ferramentas tem de estar presa ao temp do runner.
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const mentions = workflow.split("\n").filter((line) => line.includes(".release-tools"));
  assert.ok(mentions.length > 0, "o bootstrap tem que existir em algum lugar");
  for (const line of mentions) {
    assert.match(
      line,
      /\$\{\{ runner\.temp \}\}\/\.release-tools|\$RUNNER_TEMP\/\.release-tools|runner\.temp/,
      `ferramentas apontando para dentro do checkout do consumidor: ${line.trim()}`,
    );
  }
});
