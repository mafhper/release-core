// Eras de arte: `image.changes[]` no contrato.
//
// A pergunta que estes testes respondem: quando o projeto declara em que versão
// a arte muda, a arte que a tag resolve é a declarada? E o que acontece com um
// arquivo por tag que ninguém declarou, que é a armadilha do RC-N14 - aquele
// arquivo serve só a própria tag, e o patch seguinte volta à arte anterior sem
// avisar nada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { eraFor, resolveAtRef, resolveImage } from "../scripts/resolve-image.mjs";

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

const D = "docs/images/releases";
const ROOT_DIR = "root";

/**
 * Existências como função, a partir de caminhos relativos à raiz do checkout.
 * Os caminhos entram sem a raiz e saem prefixados, como o resolver monta.
 */
function tree(files) {
  const present = new Set(files.map((f) => `${ROOT_DIR}/${f}`));
  return (path) => present.has(path.split("\\").join("/"));
}

const withEras = (changes) => ({ ...SPEC, changes });

test("eraFor: a era de maior `from` que não passa da tag", () => {
  const spec = withEras([
    { from: "v1.0.0", file: "release-v1.0.webp" },
    { from: "v1.2.3", file: "release-v1.2.3.webp" },
    { from: "v2.0.0", file: "release-v2.0.0.webp" },
  ]);
  assert.equal(eraFor(spec, "v1.0.0").from, "v1.0.0");
  assert.equal(eraFor(spec, "v1.2.2").from, "v1.0.0", "antes da segunda era, a primeira ainda vale");
  assert.equal(eraFor(spec, "v1.2.3").from, "v1.2.3", "a era começa exatamente na tag");
  assert.equal(eraFor(spec, "v1.9.9").from, "v1.2.3", "a segunda era vale até a próxima");
  assert.equal(eraFor(spec, "v2.0.0").from, "v2.0.0");
});

test("eraFor: sem `changes` não há era, e a cadeia por nome continua", () => {
  assert.equal(eraFor(SPEC, "v1.2.0"), null);
  assert.equal(eraFor(withEras([]), "v1.2.0"), null);
});

test("eraFor: tag anterior à primeira era não tem era e cai na cadeia por nome", () => {
  // É o que permite declarar a lista depois, sem reescrever o que já foi
  // publicado: uma tag antiga continua resolvendo como sempre.
  const spec = withEras([{ from: "v1.3.0", file: "release-v1.3.webp" }]);
  assert.equal(eraFor(spec, "v1.2.0"), null);
});

test("troca dentro da linha: a era declarada vence o arquivo da linha", () => {
  const spec = withEras([
    { from: "v1.0.0", file: "release-v1.0.webp" },
    { from: "v1.2.3", file: "release-v1.2.3.webp" },
  ]);
  // A tag tem a arte da linha (a antiga) e a da era (a nova). A declarada vence.
  const exists = tree([`${D}/release-v1.2.webp`, `${D}/release-v1.2.3.webp`]);
  const r = resolveImage(spec, "v1.2.3", { root: ROOT_DIR }, exists);
  assert.equal(r.found, true);
  assert.equal(r.name, "release-v1.2.3.webp");
  assert.equal(r.era.from, "v1.2.3");

  // O patch seguinte recebe a MESMA arte nova, que é o ponto do mecanismo.
  const r2 = resolveImage(spec, "v1.2.4", { root: ROOT_DIR }, exists);
  assert.equal(r2.name, "release-v1.2.3.webp", "a era propaga para o resto da linha");
  assert.equal(r2.era.from, "v1.2.3");
});

test("sem `changes`, a era não existe e o arquivo por tag serve só a própria tag (RC-N14)", () => {
  // Este é o comportamento atual, preservado: o arquivo por tag NÃO propaga. O
  // aviso correspondente vem de `undeclared`, e só quando há lista de eras.
  const exists = tree([`${D}/release-v1.2.webp`, `${D}/release-v1.2.3.webp`]);
  const r3 = resolveImage(SPEC, "v1.2.3", { root: ROOT_DIR }, exists);
  assert.equal(r3.name, "release-v1.2.3.webp");
  const r4 = resolveImage(SPEC, "v1.2.4", { root: ROOT_DIR }, exists);
  assert.equal(
    r4.name,
    "release-v1.2.webp",
    "sem lista de eras, o patch seguinte volta à arte da linha - a armadilha do RC-N14",
  );
  assert.deepEqual(r4.undeclared, [], "e o aviso de arquivo não declarado não se aplica sem lista de eras");
});

test("arquivo por tag não declarado é apontado, com a era que está em vigor", () => {
  const spec = withEras([{ from: "v1.0.0", file: "release-v1.0.webp" }]);
  // A tag traz um arquivo por tag que ninguém declarou, e a arte da era.
  const exists = tree([`${D}/release-v1.0.webp`, `${D}/release-v1.2.3.webp`]);
  const r = resolveImage(spec, "v1.2.3", { root: ROOT_DIR }, exists);
  assert.equal(r.name, "release-v1.0.webp", "a era declarada governa; o arquivo solto é ignorado");
  assert.deepEqual(r.undeclared, ["release-v1.2.3.webp"]);
});

test("o arquivo declarado como era não é apontado como não declarado", () => {
  const spec = withEras([{ from: "v1.2.3", file: "release-v1.2.3.webp" }]);
  const exists = tree([`${D}/release-v1.2.3.webp`]);
  const r = resolveImage(spec, "v1.2.3", { root: ROOT_DIR }, exists);
  assert.deepEqual(r.undeclared, []);
});

test("correção pós-tag continua vencendo a era vinda do branch padrão", () => {
  const spec = withEras([{ from: "v1.2.3", file: "release-v1.2.3.webp" }]);
  const exists = (path) =>
    path.split("\\").join("/") === "corr/docs/images/releases/release-v1.2.3-new.webp";
  const r = resolveImage(spec, "v1.2.3", { root: ROOT_DIR, correctionDir: "corr" }, exists);
  assert.equal(r.found, true);
  assert.equal(r.name, "release-v1.2.3-new.webp");
  assert.equal(r.source, "branch");
  assert.equal(r.assetName, "release-v1.2.3.webp", "o asset continua com o nome canônico");
  assert.equal(r.era.from, "v1.2.3");
});

test("era declarada e ausente: found=false com o motivo que nomeia o arquivo", () => {
  const spec = withEras([{ from: "v1.2.3", file: "release-v1.2.3.webp" }]);
  const r = resolveImage(spec, "v1.2.3", { root: ROOT_DIR }, tree([]));
  assert.equal(r.found, false);
  assert.equal(r.reason, "era-missing");
  assert.equal(r.era.file, "release-v1.2.3.webp", "o motivo precisa dizer qual arquivo falta");
});

test("tag de prerelease resolve a era da versão base, e o arquivo da rc é apontado", () => {
  const spec = withEras([{ from: "v1.2.0", file: "release-v1.2.0.webp" }]);
  const exists = tree([`${D}/release-v1.2.0.webp`, `${D}/release-v1.2.0-rc1.webp`]);
  const r = resolveImage(spec, "v1.2.0-rc1", { root: ROOT_DIR }, exists);
  assert.equal(r.name, "release-v1.2.0.webp");
  assert.deepEqual(r.undeclared, ["release-v1.2.0-rc1.webp"]);
});

test("resolveAtRef: acha a arte que estava na tag, no object database", () => {
  const present = new Set(["docs/images/releases/release-v1.2.webp"]);
  const r = resolveAtRef(SPEC, "v1.2.2", (rel) => present.has(rel));
  assert.equal(r.found, true);
  assert.equal(r.relPath, "docs/images/releases/release-v1.2.webp");
  assert.equal(resolveAtRef(SPEC, "v1.2.2", () => false).found, false);
});

test("resolveAtRef ignora a correção: a arte em vigor numa tag é a do commit dela", () => {
  // A correção vive no branch padrão, ou seja, depois da tag. Comparar com ela
  // daria como resultado que a arte nunca mudou. O predicado aqui responde
  // "existe" para tudo, então se a correção fosse consultada, ela venceria.
  const r = resolveAtRef(SPEC, "v1.2.2", () => true);
  assert.equal(
    r.name,
    "release-v1.2.2.webp",
    "a correção é a primeira candidata na cadeia e foi pulada; a primeira real é a da tag",
  );
});

test("CLI: config com `changes` resolve pela era e exporta o novo contrato", () => {
  const dir = mkdtempSync(join(tmpdir(), "eras-"));
  mkdirSync(join(dir, ".github"), { recursive: true });
  mkdirSync(join(dir, "docs/images/releases"), { recursive: true });
  writeFileSync(
    join(dir, ".github/release.config.json"),
    JSON.stringify({
      release: {
        title: "Demo",
        image: {
          path: "docs/images/releases",
          changes: [
            { from: "v1.0.0", file: "release-v1.0.webp" },
            { from: "v1.2.3", file: "release-v1.2.3.webp" },
          ],
        },
      },
    }),
    "utf8",
  );
  writeFileSync(join(dir, "docs/images/releases/release-v1.0.webp"), "velha", "utf8");
  writeFileSync(join(dir, "docs/images/releases/release-v1.2.3.webp"), "nova", "utf8");

  const res = spawnSync(
    process.execPath,
    [SCRIPT, join(dir, ".github/release.config.json"), "v1.2.4", "--root", dir],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^IMAGE_RESOLVED_NAME=release-v1\.2\.3\.webp$/m);
  assert.match(res.stdout, /^IMAGE_ERA_FROM=v1\.2\.3$/m);
  assert.match(res.stdout, /^IMAGE_ERA_FILE=release-v1\.2\.3\.webp$/m);
});

test("CLI: config sem `changes` não emite era nenhuma (compatibilidade)", () => {
  const dir = mkdtempSync(join(tmpdir(), "eras-off-"));
  mkdirSync(join(dir, "docs/images/releases"), { recursive: true });
  writeFileSync(
    join(dir, "release.config.json"),
    JSON.stringify({ release: { title: "Demo", image: { path: "docs/images/releases" } } }),
    "utf8",
  );
  writeFileSync(join(dir, "docs/images/releases/release.webp"), "x", "utf8");

  const res = spawnSync(
    process.execPath,
    [SCRIPT, join(dir, "release.config.json"), "v1.2.4", "--root", dir],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^IMAGE_RESOLVED_NAME=release\.webp$/m);
  assert.match(res.stdout, /^IMAGE_ERA_FROM=$/m);
  assert.match(res.stdout, /^IMAGE_UNDECLARED=$/m);
});
