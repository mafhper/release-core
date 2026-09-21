import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "release-config.mjs");
const FIX = (...segments) => join(ROOT, "tests", "fixtures", ...segments);

function run(configPath, args = []) {
  return spawnSync(process.execPath, [SCRIPT, configPath, ...args], {
    encoding: "utf8",
  });
}

function assertOk(res) {
  assert.equal(res.status, 0, `esperado sucesso, stderr: ${res.stderr}`);
}

function tempConfig(content) {
  const dir = mkdtempSync(join(tmpdir(), "rwcfg-"));
  const file = join(dir, "release.config.json");
  writeFileSync(file, content, "utf8");
  return { dir, file };
}

test("fixture web: config válida e toolchain via --get", () => {
  const res = run(FIX("web", "release.config.json"), ["--get", "node"]);
  assertOk(res);
  assert.equal(res.stdout.trim(), "22");
  assert.match(res.stdout.trim(), /^22$/);
  const desktop = run(FIX("web/release.config.json"), ["--get", "desktop"]);
  assert.equal(desktop.stdout.trim(), "false");
});

test("fixture web: --env contém chaves essenciais", () => {
  const res = run(FIX("web", "release.config.json"), ["--env"]);
  assertOk(res);
  assert.match(res.stdout, /^RELEASE_TITLE=Spread$/m);
  assert.match(res.stdout, /^PKG_MANAGER=bun$/m);
  assert.match(res.stdout, /^BUILD_COMMAND=bun run build$/m);
  assert.match(res.stdout, /^GATES=\["bun run lint"/m);
});

test("fixture extension: artefato único com release_name e validação", () => {
  const enabled = run(FIX("extension/release.config.json"), ["--get", "artifact_enabled"]);
  assert.equal(enabled.stdout.trim(), "true");
  const name = run(FIX("extension/release.config.json"), ["--get", "artifact_release_name"]);
  assert.equal(name.stdout.trim(), "kaes-keide-inspector-{version}.zip");
  const epsFiles = run(FIX("extension/release.config.json"), ["--env"]);
  assert.match(epsFiles.stdout, /^VERSIONS_FILES=\[\{"path":"manifest.json"/m);
});

test("fixture tauri: desktop habilitado com Rust", () => {
  const desktop = run(FIX("tauri", "release.config.json"), ["--get", "desktop"]);
  assert.equal(desktop.stdout.trim(), "true");
  const rust = run(FIX("tauri/release.config.json"), ["--get", "rust"]);
  assert.equal(rust.stdout.trim(), "stable");
  const notes = run(FIX("tauri/release.config.json"), ["--get", "notes_granularity"]);
  assert.equal(notes.stdout.trim(), "minor");
});

test("fixture tauri-npm: desktop + npm, working_directory separado do project_path", () => {
  const cfg = FIX("tauri-npm", "release.config.json");
  assert.equal(run(cfg, ["--get", "desktop"]).stdout.trim(), "true");
  assert.equal(run(cfg, ["--get", "package_manager"]).stdout.trim(), "npm");
  assert.equal(run(cfg, ["--get", "working_directory"]).stdout.trim(), ".");
  assert.equal(run(cfg, ["--get", "desktop_project_path"]).stdout.trim(), "desktop");
  const env = run(cfg, ["--env"]);
  assertOk(env);
  assert.match(env.stdout, /^PKG_MANAGER=npm$/m);
  assert.match(env.stdout, /^NODE_VERSION=22$/m);
  assert.match(env.stdout, /^DESKTOP=true$/m);
  assert.match(env.stdout, /^PROJECT_WORKDIR=\.$/m);
  assert.match(env.stdout, /^DESKTOP_PROJECT_PATH=desktop$/m);
});

test("regressão: config em .github/ resolve paths na raiz do repositório", () => {
  const dir = mkdtempSync(join(tmpdir(), "rwcfg-"));
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(
    join(dir, ".github", "release.config.json"),
    JSON.stringify({
      release: { title: "Spread", language: "en" },
      build: { package_manager: "bun", bun: "1.3.13" },
    }),
    "utf8",
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "bun@1.3.13" }), "utf8");
  writeFileSync(join(dir, "bun.lock"), "", "utf8");
  const res = run(join(dir, ".github", "release.config.json"), ["--get", "package_manager"]);
  assertOk(res);
  assert.equal(res.stdout.trim(), "bun");
});

test("defaults aplicados quando omissos", () => {
  const { dir, file } = tempConfig(JSON.stringify({ release: { title: "X" } }));
  const res = run(file, ["--get", "image_path"]);
  assertOk(res);
  assert.equal(res.stdout.trim(), "docs/images/releases/release.webp");
  assert.equal(run(file, ["--get", "notes_granularity"]).stdout.trim(), "tag");
  assert.equal(run(file, ["--get", "language"]).stdout.trim(), "pt-BR");
  assert.equal(run(file, ["--get", "node"]).stdout.trim(), "");
  assert.equal(run(file, ["--get", "desktop"]).stdout.trim(), "false");
  assert.equal(run(file, ["--get", "working_directory"]).stdout.trim(), ".");
  assert.equal(run(file, ["--get", "image_required"]).stdout.trim(), "true");
  assert.equal(run(file, ["--env"]).stdout.includes("RELEASE_TITLE=X"), true);
});

const FAIL_CASES = [
  ["config ausente", () => join(tmpdir(), "nao-existe.json"), /não foi possível ler/],
  ["JSON inválido", () => { const { file } = tempConfig("{ invalido "); return file; }, /não foi possível ler/],
  ["título ausente", () => tempConfig(JSON.stringify({ release: {} })).file, /release\.title é obrigatório/],
  ["bloco release ausente", () => tempConfig("{}").file, /falta o bloco "release"/],
  ["title vazio", () => tempConfig(JSON.stringify({ release: { title: "  " } })).file, /release\.title é obrigatório/],
  ["language inválida", () => tempConfig(JSON.stringify({ release: { title: "X", language: "fr" } })).file, /release\.language deve ser "en" ou "pt-BR"/],
  ["notes.granularity inválida", () => tempConfig(JSON.stringify({ release: { title: "X", notes: { granularity: "patch" } } })).file, /notes\.granularity deve ser "tag" ou "minor"/],
  ["image.granularity inválida", () => tempConfig(JSON.stringify({ release: { title: "X", image: { granularity: "patch" } } })).file, /image\.granularity deve ser "tag" ou "minor"/],
  ["bun sem lockfile", () => { const { dir, file } = tempConfig(JSON.stringify({ release: { title: "X" }, build: { package_manager: "bun" } })); writeFileSync(join(dir, "package.json"), "{}", "utf8"); return file; }, /bun\.lock/],
  ["npm sem lockfile", () => { const { dir, file } = tempConfig(JSON.stringify({ release: { title: "X" }, build: { package_manager: "npm" } })); writeFileSync(join(dir, "package.json"), "{}", "utf8"); return file; }, /package-lock\.json/],
  ["packageManager divergente", () => { const { dir, file } = tempConfig(JSON.stringify({ release: { title: "X" }, build: { package_manager: "npm" } })); writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "bun@1.3.13" }), "utf8"); writeFileSync(join(dir, "package-lock.json"), "{}", "utf8"); return file; }, /package\.json#packageManager/],
  ["bun sem package_manager bun", () => { const { dir, file } = tempConfig(JSON.stringify({ release: { title: "X" }, build: { package_manager: "npm", bun: "1.3.13" } })); writeFileSync(join(dir, "package.json"), "{}", "utf8"); writeFileSync(join(dir, "package-lock.json"), "{}", "utf8"); return file; }, /build\.bun declarado/],
  ["npm sem node", () => { const { dir, file } = tempConfig(JSON.stringify({ release: { title: "X" }, build: { package_manager: "npm" } })); writeFileSync(join(dir, "package.json"), "{}", "utf8"); writeFileSync(join(dir, "package-lock.json"), "{}", "utf8"); return file; }, /build\.node/],
  ["artifact sem path/globs", () => tempConfig(JSON.stringify({ release: { title: "X" }, artifact: { enabled: true } })).file, /artif.*enabled está ativo/],
  ["globs não é glob", () => tempConfig(JSON.stringify({ release: { title: "X" }, artifact: { enabled: true, globs: ["dist/arquivo.txt"] } })).file, /glob/],
  ["desktop sem rust", () => tempConfig(JSON.stringify({ release: { title: "X" }, desktop: { enabled: true } })).file, /desktop\.enabled é true, mas build\.rust/],
  ["desktop com build.command", () => tempConfig(JSON.stringify({ release: { title: "X" }, desktop: { enabled: true }, build: { rust: "stable", command: "bun run x" } })).file, /não permite build\.command/],
  ["desktop com artifact", () => tempConfig(JSON.stringify({ release: { title: "X" }, desktop: { enabled: true }, build: { rust: "stable" }, artifact: { enabled: true, path: "a.zip" } })).file, /artifact\.enabled não pode ser true com desktop/],
  ["versions.files inválido (string)", () => tempConfig(JSON.stringify({ release: { title: "X" }, versions: { files: ["manifest.json"] } })).file, /deve ser \{ path, format, field \}/],
  ["versions.files campo ausente", () => tempConfig(JSON.stringify({ release: { title: "X" }, versions: { files: [{ path: "a.json", format: "json" }] } })).file, /versions\.files\[\]\.field/],
  ["versions.files format inválido", () => tempConfig(JSON.stringify({ release: { title: "X" }, versions: { files: [{ path: "a.yml", format: "yaml", field: "x" }] } })).file, /format deve ser "json" ou "toml"/],
  ["working_directory absoluto", () => tempConfig(JSON.stringify({ release: { title: "X" }, build: { working_directory: "/abs" } })).file, /relativo à raiz/],
  ["working_directory vazio", () => tempConfig(JSON.stringify({ release: { title: "X" }, build: { working_directory: "  " } })).file, /working_directory/],
  ["chave --get desconhecida", () => FIX("web/release.config.json"), /chave desconhecida em --get/],
];

for (const [label, make, pattern] of FAIL_CASES) {
  test(`falha: ${label}`, () => {
    const target = make();
    const args = label === "chave --get desconhecida" ? ["--get", "zzz"] : [];
    const res = run(target, args);
    assert.notEqual(res.status, 0, `deveria falhar: ${res.stderr}`);
    assert.match(res.stderr, pattern);
    assert.match(res.stderr, /\[release-config\]/);
  });
}