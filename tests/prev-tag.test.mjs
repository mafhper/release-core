import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { compareVersions, parseTag, prevTag } from "../scripts/prev-tag.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "prev-tag.mjs");

test("parseTag: extrai componentes e normaliza o prefixo v", () => {
  assert.deepEqual(parseTag("v1.2.3"), { major: 1, minor: 2, patch: 3, tag: "v1.2.3" });
  assert.deepEqual(parseTag("1.2.3").tag, "v1.2.3");
});

test("parseTag: recusa o que não é uma tag de release", () => {
  for (const bad of ["v1.2", "v1.2.3-rc1", "release", "v1.2.3.4", ""]) {
    assert.equal(parseTag(bad), null, `esperava null para ${bad}`);
  }
});

test("compareVersions: patch decide, float não pode", () => {
  // 1.2.0 e 1.2.1 são o mesmo float em JS; por componente não são.
  assert.equal(compareVersions(parseTag("v1.2.0"), parseTag("v1.2.1")), -1);
  assert.equal(compareVersions(parseTag("v1.2.1"), parseTag("v1.2.0")), 1);
  assert.equal(compareVersions(parseTag("v1.2.1"), parseTag("v1.2.1")), 0);
  assert.equal(compareVersions(parseTag("v1.10.0"), parseTag("v1.9.0")), 1);
  assert.equal(compareVersions(parseTag("v2.0.0"), parseTag("v1.99.99")), 1);
});

test("prevTag: patch dentro da linha acha a tag da mesma linha", () => {
  // Regressão: o awk tratava 1.2.0 e 1.2.1 como iguais e caía para 1.1.5.
  const tags = ["v1.0.6", "v1.1.5", "v1.2.0", "v1.2.1"];
  assert.equal(prevTag("1.2.2", tags), "v1.2.1");
  assert.equal(prevTag("1.2.1", tags), "v1.2.0");
});

test("prevTag: minor pula para a última tag da linha anterior", () => {
  const tags = ["v1.0.6", "v1.1.3", "v1.1.4", "v1.1.5"];
  assert.equal(prevTag("1.2.0", tags), "v1.1.5");
});

test("prevTag: ignora a própria tag, tags maiores e não-semver", () => {
  const tags = ["v1.2.0", "v1.3.0", "v2.0.0-rc1", "release-9"];
  assert.equal(prevTag("1.3.0", tags), "v1.2.0");
});

test("prevTag: sem anterior devolve vazio (primeira release)", () => {
  assert.equal(prevTag("1.0.0", ["v1.0.0"]), "");
  assert.equal(prevTag("1.0.0", []), "");
});

test("CLI: imprime a tag anterior e sai com 0 mesmo sem anterior", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "1.2.1", "v1.1.5", "v1.2.0"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "v1.2.0\n");
});
