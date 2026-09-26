#!/usr/bin/env node
// Maior tag vX.Y.Z estritamente anterior à versão atual.
//
// A comparação precisa ser por componente. Coercionar para float (o que o awk
// fazia com `$1 + 0 < cur + 0`) trata 1.2.0 e 1.2.1 como o mesmo número, então
// um patch dentro da linha caía na linha anterior: com granularity "minor" isso
// fazia um patch release exigir arte nova, e o gate de imagem reprovava.
//
// Uso: node prev-tag.mjs <versao-atual> [tag...]
// Ex.: node prev-tag.mjs 1.2.1 v1.0.6 v1.2.0 v1.1.5  ->  v1.2.0
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** @returns {{major:number,minor:number,patch:number,tag:string}|null} */
export function parseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    tag: `v${m[1]}.${m[2]}.${m[3]}`,
  };
}

/** Compara por componente: -1 menor, 0 igual, 1 maior. */
export function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

/** @returns {string} a tag anterior, ou "" se não houver */
export function prevTag(current, tags) {
  const cur = parseTag(current);
  if (!cur) return "";
  let best = null;
  for (const raw of tags) {
    const candidate = parseTag(raw);
    if (!candidate) continue;
    if (compareVersions(candidate, cur) >= 0) continue;
    if (!best || compareVersions(candidate, best) > 0) best = candidate;
  }
  return best ? best.tag : "";
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [current, ...tags] = process.argv.slice(2);
  if (!current) {
    console.error("Uso: prev-tag.mjs <versao-atual> [tag...]");
    process.exit(1);
  }
  // Sem tags na linha de comando, lê do repositório.
  const list = tags.length
    ? tags
    : execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
  process.stdout.write(`${prevTag(current, list)}\n`);
}
