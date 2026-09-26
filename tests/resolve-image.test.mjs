import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { candidatesFor, resolveImage, stemsFor } from "../scripts/resolve-image.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "resolve-image.mjs");

const SPEC = {
  dir: "docs/images/releases",
  prefix: "release",
  ext: ".webp",
  correctionSuffix: "-new",
  allowCorrection: true,
  upload: true,
};

/** Cria uma árvore e devolve as existências como função, para o resolver. */
function tree(files) {
  const present = new Set(files);
  return (path) => present.has(path.split("\\").join("/"));
}

test("stemsFor: tag, versão base e linha do minor, sem duplicar", () => {
  assert.deepEqual(stemsFor("v1.2.0"), ["v1.2.0", "v1.2"]);
  assert.deepEqual(stemsFor("v1.2.0-rc1"), ["v1.2.0-rc1", "v1.2.0", "v1.2"]);
  assert.deepEqual(stemsFor("v1.2"), ["v1.2"]);
  // tag sem "v" é normalizada
  assert.deepEqual(stemsFor("1.2.0"), ["v1.2.0", "v1.2"]);
});

test("ordem de candidatos: correção antes do arquivo da tag, legado por último", () => {
  const names = candidatesFor(SPEC, "v1.2.0").map((c) => `${c.from}:${c.name}`);
  assert.deepEqual(names, [
    "correction:release-v1.2.0-new.webp",
    "tag:release-v1.2.0.webp",
    "correction:release-v1.2-new.webp",
    "tag:release-v1.2.webp",
    "tag:release.webp",
  ]);
});

test("o nome canônico do asset nunca carrega o sufixo de correção", () => {
  const names = candidatesFor(SPEC, "v1.2.0").map((c) => `${c.name} -> ${c.canonical}`);
  assert.deepEqual(names, [
    "release-v1.2.0-new.webp -> release-v1.2.0.webp",
    "release-v1.2.0.webp -> release-v1.2.0.webp",
    "release-v1.2-new.webp -> release-v1.2.webp",
    "release-v1.2.webp -> release-v1.2.webp",
    "release.webp -> release.webp",
  ]);
});

test("sufixo de correção customizado também some do nome do asset", () => {
  const spec = { ...SPEC, correctionSuffix: "-corrigido" };
  const c = candidatesFor(spec, "v1.2.0")[0];
  assert.equal(c.name, "release-v1.2.0-corrigido.webp");
  assert.equal(c.canonical, "release-v1.2.0.webp");
});

test("A: arquivo por versão tem precedência sobre minor e legado", () => {
  const exists = tree([
    "root/docs/images/releases/release-v1.2.0.webp",
    "root/docs/images/releases/release-v1.2.webp",
    "root/docs/images/releases/release.webp",
  ]);
  const r = resolveImage(SPEC, "v1.2.0", { root: "root" }, exists);
  assert.equal(r.found, true);
  assert.equal(r.name, "release-v1.2.0.webp");
  assert.equal(r.source, "tag");
  assert.equal(r.isCorrection, false);
});

test("A: sem arquivo da tag, cai para a linha do minor", () => {
  const exists = tree([
    "root/docs/images/releases/release-v1.2.webp",
    "root/docs/images/releases/release.webp",
  ]);
  const r = resolveImage(SPEC, "v1.2.0", { root: "root" }, exists);
  assert.equal(r.name, "release-v1.2.webp");
  assert.equal(r.source, "tag");
});

test("A: sem nada por versão, cai para o arquivo legado (retrocompatível)", () => {
  const exists = tree(["root/docs/images/releases/release.webp"]);
  const r = resolveImage(SPEC, "v1.2.0", { root: "root" }, exists);
  assert.equal(r.name, "release.webp");
  assert.equal(r.source, "tag");
});

test("C: a correção do branch padrão vence o arquivo da tag", () => {
  const exists = tree([
    "corr/docs/images/releases/release-v1.2.0-new.webp",
    "root/docs/images/releases/release-v1.2.0.webp",
  ]);
  const r = resolveImage(SPEC, "v1.2.0", { root: "root", correctionDir: "corr" }, exists);
  assert.equal(r.name, "release-v1.2.0-new.webp");
  assert.equal(r.source, "branch");
  assert.equal(r.isCorrection, true);
  // A release não vê a terminologia de correção: o asset é o nome canônico.
  assert.equal(r.assetName, "release-v1.2.0.webp");
});

test("C: allow_correction=false ignora o sufixo -new", () => {
  const spec = { ...SPEC, allowCorrection: false };
  const exists = tree([
    "corr/docs/images/releases/release-v1.2.0-new.webp",
    "root/docs/images/releases/release-v1.2.0.webp",
  ]);
  const r = resolveImage(spec, "v1.2.0", { root: "root", correctionDir: "corr" }, exists);
  assert.equal(r.name, "release-v1.2.0.webp");
  assert.equal(r.isCorrection, false);
});

test("C: o -new commitado na própria tag também vence", () => {
  // Quem commita a correção antes de taguear não deve ver a arte antiga.
  const exists = tree([
    "root/docs/images/releases/release-v1.2.0-new.webp",
    "root/docs/images/releases/release-v1.2.0.webp",
  ]);
  const r = resolveImage(SPEC, "v1.2.0", { root: "root" }, exists);
  assert.equal(r.name, "release-v1.2.0-new.webp");
  assert.equal(r.isCorrection, true);
  // Está no checkout, então também tem URL raw da tag.
  assert.equal(r.relPath, "docs/images/releases/release-v1.2.0-new.webp");
  assert.equal(r.source, "tag");
});

test("C: a cópia do branch padrão tem precedência sobre a que está na tag", () => {
  const exists = tree([
    "corr/docs/images/releases/release-v1.2.0-new.webp",
    "root/docs/images/releases/release-v1.2.0-new.webp",
  ]);
  const r = resolveImage(SPEC, "v1.2.0", { root: "root", correctionDir: "corr" }, exists);
  assert.equal(r.path, join("corr", "docs/images/releases/release-v1.2.0-new.webp"));
  assert.equal(r.relPath, null, "correção baixada do branch não tem caminho na tag");
});

test("C: sem --correction-dir a correção é ignorada, não falha", () => {
  const exists = tree(["root/docs/images/releases/release-v1.2.0.webp"]);
  const r = resolveImage(SPEC, "v1.2.0", { root: "root" }, exists);
  assert.equal(r.found, true);
  assert.equal(r.isCorrection, false);
});

test("prerelease: a arte do rc tem precedência, e a da versão base serve de reserva", () => {
  const withRc = tree([
    "root/docs/images/releases/release-v1.2.0-rc1.webp",
    "root/docs/images/releases/release-v1.2.0.webp",
  ]);
  assert.equal(resolveImage(SPEC, "v1.2.0-rc1", { root: "root" }, withRc).name, "release-v1.2.0-rc1.webp");

  const withoutRc = tree(["root/docs/images/releases/release-v1.2.0.webp"]);
  assert.equal(resolveImage(SPEC, "v1.2.0-rc1", { root: "root" }, withoutRc).name, "release-v1.2.0.webp");
});

test("nada encontrado devolve found=false com a lista do que tentou", () => {
  const r = resolveImage(SPEC, "v1.2.0", { root: "root" }, tree([]));
  assert.equal(r.found, false);
  assert.equal(r.path, null);
  assert.equal(r.tried.length, 5);
});

test("CLI: --json resolve a partir do config e sai com 1 quando não acha", () => {
  const dir = mkdtempSync(join(tmpdir(), "rimg-"));
  const imgDir = join(dir, "docs", "images", "releases");
  mkdirSync(imgDir, { recursive: true });
  writeFileSync(join(imgDir, "release-v1.2.0.webp"), "x", "utf8");
  const config = join(dir, "release.config.json");
  // config legado: path apontando para arquivo
  writeFileSync(
    config,
    JSON.stringify({ release: { title: "Demo", image: { path: "docs/images/releases/release.webp" } } }),
    "utf8",
  );

  const ok = spawnSync(
    process.execPath,
    [SCRIPT, config, "v1.2.0", "--root", dir, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.equal(parsed.name, "release-v1.2.0.webp");
  assert.equal(parsed.source, "tag");
  assert.equal(parsed.spec.dir, "docs/images/releases");
  assert.equal(parsed.spec.prefix, "release");
  assert.equal(parsed.spec.ext, ".webp");

  const missing = spawnSync(
    process.execPath,
    [SCRIPT, config, "v9.9.9", "--root", dir, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).found, false);
});

test("CLI: sem --json imprime KEY=VALUE para $GITHUB_ENV", () => {
  const dir = mkdtempSync(join(tmpdir(), "rimg-"));
  const imgDir = join(dir, "docs", "images", "releases");
  mkdirSync(imgDir, { recursive: true });
  writeFileSync(join(imgDir, "release.webp"), "x", "utf8");
  const config = join(dir, "release.config.json");
  writeFileSync(
    config,
    JSON.stringify({ release: { title: "Demo", image: { path: "docs/images/releases" } } }),
    "utf8",
  );

  const res = spawnSync(process.execPath, [SCRIPT, config, "v1.2.0", "--root", dir], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  const env = Object.fromEntries(
    res.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  assert.equal(env.IMAGE_RESOLVED_NAME, "release.webp");
  assert.equal(env.IMAGE_SOURCE, "tag");
  assert.equal(env.IMAGE_IS_CORRECTION, "false");
  assert.equal(env.IMAGE_ASSET_NAME, "release.webp");
});

test("CLI: a correção sai no env com nome próprio e asset canônico", () => {
  const dir = mkdtempSync(join(tmpdir(), "rimg-"));
  const imgDir = join(dir, "docs", "images", "releases");
  mkdirSync(imgDir, { recursive: true });
  writeFileSync(join(imgDir, "release-v1.2.0-new.webp"), "corrigido", "utf8");
  const config = join(dir, "release.config.json");
  writeFileSync(
    config,
    JSON.stringify({ release: { title: "Demo", image: { path: "docs/images/releases" } } }),
    "utf8",
  );

  const res = spawnSync(process.execPath, [SCRIPT, config, "v1.2.0", "--root", dir], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  const env = Object.fromEntries(
    res.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  assert.equal(env.IMAGE_RESOLVED_NAME, "release-v1.2.0-new.webp");
  assert.equal(env.IMAGE_ASSET_NAME, "release-v1.2.0.webp");
  assert.equal(env.IMAGE_IS_CORRECTION, "true");
  assert.equal(env.IMAGE_SOURCE, "tag");
});
