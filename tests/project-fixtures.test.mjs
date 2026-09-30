// Golden set: o contrato normalizado dos sete consumidores reais.
//
// Para que serve este arquivo, e o que ele não é:
//
// **É** o lock de semântica do contrato. Qualquer mudança em `release-config.mjs`
// que altere o que o Core entende de um config real aparece aqui como diff, e a
// pergunta a responder passa a ser "isso é pretendido?". Sem isso, cada refactor
// do normalizador é um salto no escuro para sete consumidores.
//
// **Não é** um teste de que o resultado está certo. O golden é gerado a partir
// da implementação; ele trava o comportamento, não o julga. Julgar é o trabalho
// dos asserts explícitos deste arquivo e dos testes por archetype.
//
// A causa-raiz do bug do Core v1.0.0 (caminhos do config resolvidos a partir do
// diretório do próprio config) passou na CI porque os fixtures eram
// co-localizados, que não é o layout de nenhum consumidor. Aqui todo fixture usa
// o layout real — `package.json` na raiz e config em `.github/` — e o primeiro
// teste deste arquivo existe para impedir que alguém volte ao layout errado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { load } from "../scripts/release-config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = join(ROOT, "tests", "fixtures", "projects");
const EXPECTED = join(PROJECTS, "expected");

const CONSUMERS = [
  "aurawall",
  "icon-core",
  "kaes-keide-inspector",
  "mark-lee",
  "personalnews",
  "push_",
  "spread",
];

for (const name of CONSUMERS) {
  test(`layout real do fixture: ${name}`, () => {
    const dir = join(PROJECTS, name);
    assert.ok(
      existsSync(join(dir, ".github/release.config.json")),
      `${name}: o config precisa estar em .github/, que é onde o consumidor real o põe`,
    );
    assert.ok(
      existsSync(join(dir, "package.json")),
      `${name}: precisa haver package.json na raiz do projeto, senão findRepoRoot sobe até o repo do Core`,
    );
  });

  test(`modelo normalizado bate com o golden: ${name}`, () => {
    const golden = JSON.parse(readFileSync(join(EXPECTED, `${name}.model.json`), "utf8"));
    const model = load(join(PROJECTS, name, ".github/release.config.json"));
    assert.deepEqual(model, golden);
  });
}

// --- asserts explícitos sobre o que o golden sozinho não diz ---

test("aurawall: `image.path` como diretório deriva dir/prefix/ext, e title_in_body é false", () => {
  const m = load(join(PROJECTS, "aurawall/.github/release.config.json"));
  assert.equal(m.release.imageDir, "docs/images/releases");
  assert.equal(m.release.imagePrefix, "release");
  assert.equal(m.release.imageExt, ".webp");
  assert.equal(m.release.imageTitleInBody, false);
  assert.deepEqual(m.distribution.artifacts, [], "release sem artefato próprio é uma configuração válida");
});

test("icon-core: monorepo com desktop em apps/desktop e cinco fontes de versão", () => {
  const m = load(join(PROJECTS, "icon-core/.github/release.config.json"));
  assert.equal(m.desktop.enabled, true);
  assert.equal(m.desktop.projectPath, "apps/desktop");
  assert.equal(m.build.workingDirectory, ".", "os gates rodam na raiz, não em apps/desktop");
  assert.equal(m.versions.files.length, 5);
  assert.deepEqual(m.distribution.artifacts, []);
});

test("kaes: o único com artefato, que o adapter reduz a UMA entrada", () => {
  const m = load(join(PROJECTS, "kaes-keide-inspector/.github/release.config.json"));
  assert.equal(m.distribution.artifacts.length, 1, "o bloco legado é um artefato só");
  const [a] = m.distribution.artifacts;
  assert.deepEqual(a.paths, ["kaes-keid-inspector.zip"]);
  assert.equal(a.releaseName, "kaes-keide-inspector-v{version}.zip");
  assert.deepEqual(a.validate, [
    'unzip -t "$1"',
    "unzip -l \"$1\" | grep -q 'manifest.json'",
    "! unzip -l \"$1\" | grep -q 'node_modules/'",
  ]);
  assert.deepEqual(a.os, ["*"]);
  assert.equal(a.required, true);
  assert.deepEqual(
    m.versions.files.map((f) => f.path),
    ["manifest.json"],
  );
});

test("mark-lee: `image.path` como diretório com prefix/ext explícitos, notas por minor", () => {
  const m = load(join(PROJECTS, "mark-lee/.github/release.config.json"));
  assert.equal(m.release.imageDir, "docs/images/releases");
  assert.equal(m.release.imagePrefix, "release");
  assert.equal(m.release.notesGranularity, "minor");
  assert.equal(m.release.imageChanges.length, 0, "nenhum consumidor tem era declarada ainda");
});

test("personalnews: bun + apt + pre, e o nome real do ZIP na seção de uso", () => {
  const m = load(join(PROJECTS, "personalnews/.github/release.config.json"));
  assert.equal(m.build.packageManager, "bun");
  assert.equal(m.build.bun, "1.x");
  assert.equal(m.build.apt.length, 4);
  assert.deepEqual(m.build.pre, ["node scripts/prepare-backend.mjs"]);
  assert.equal(m.desktop.projectPath, "apps/desktop");
});

test("push_ e spread: as duas pontas do contrato, uma com Rust e outra não", () => {
  const push = load(join(PROJECTS, "push_/.github/release.config.json"));
  assert.equal(push.desktop.enabled, true);
  assert.equal(push.build.rust, "stable");
  assert.equal(push.build.command, "", "com desktop, o build é do tauri-action");

  const spread = load(join(PROJECTS, "spread/.github/release.config.json"));
  assert.equal(spread.desktop.enabled, false);
  assert.equal(spread.build.packageManager, "bun");
  assert.equal(spread.build.command, "bun run build");
  assert.equal(spread.build.rust, "");
});

test("todo consumidor novo tem `reuse: forbid` e nenhuma era: o default é o comportamento de sempre", () => {
  for (const name of CONSUMERS) {
    const m = load(join(PROJECTS, name, ".github/release.config.json"));
    assert.equal(m.release.imageReuse, "forbid", name);
    assert.deepEqual(m.release.imageChanges, [], name);
  }
});
