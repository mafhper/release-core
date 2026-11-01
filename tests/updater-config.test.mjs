// Bloco `updater` no contrato — a extensão **opt-in**, do lado do contrato.
//
// O que estes testes têm de provar:
//
// 1. **Quem não declara o bloco não muda.** Não é intenção: o `--env` de cada
//    um dos sete consumidores reais continua byte a byte o de antes, e o modelo
//    normalizado não ganha chave nenhuma. É o gate de compatibilidade
//    retroativa — a extensão existe para os apps que pedem atualização
//    automática, não para todos.
// 2. **Declarar é habilitar, e o que falta tem default.** `enabled: true` dentro
//    do bloco, `channel: "stable"`, `os: ["*"]`. Desligar sem apagar a
//    declaração é decisão legítima, e é o que `enabled: false` faz.
// 3. **O que se declara é conferível.** `id` é a chave `<os>-<arch>` que o
//    manifesto por canal vai usar; `sig` são os globs das assinaturas. Os dois
//    são o que a coleta e a conferência da release leem — um erro de digitação
//    aqui vira release que ninguém consegue verificar, então ele reprova antes
//    do build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load } from "../scripts/release-config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "release-config.mjs");
const PROJECTS = join(ROOT, "tests", "fixtures", "projects");

const CONSUMERS = [
  "aurawall",
  "icon-core",
  "kaes-keide-inspector",
  "mark-lee",
  "personalnews",
  "push_",
  "spread",
];

/** Consumidor mínimo válido, com desktop (é o perfil que pode ter updater). */
const DESKTOP = { enabled: true, project_path: "." };
const RUST = { rust: "stable", apt: ["libgtk-3-dev"] };

function configFile(body) {
  const dir = mkdtempSync(join(tmpdir(), "updater-"));
  const file = join(dir, "release.config.json");
  writeFileSync(file, JSON.stringify(body), "utf8");
  return file;
}

function updaterConfig(updater) {
  return configFile({ release: { title: "Demo" }, build: RUST, desktop: DESKTOP, updater });
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

// --- 1. o consumidor que não declara o bloco continua idêntico --------------

for (const name of CONSUMERS) {
  test(`sem o bloco, o contrato de ${name} não ganha a chave updater`, () => {
    const model = load(join(PROJECTS, name, ".github", "release.config.json"));
    assert.equal("updater" in model, false, "o bloco ausente é ausência de contrato, não default materializado");
  });
}

test("sem o bloco, nenhum consumidor real ganha linha UPDATER_* no ambiente do job", () => {
  // A prova de compatibilidade retroativa no nível em que ela importa: o que o
  // workflow lê. Uma chave nova aqui é um passo novo em potencial para todos.
  for (const name of CONSUMERS) {
    const res = runCli([join(PROJECTS, name, ".github", "release.config.json"), "--env"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(/^UPDATER_/m.test(res.stdout), false, `${name} ganhou chave UPDATER_*`);
  }
});

test("os fixtures de arquétipo também não mudam: web, extension, tauri, tauri-npm", () => {
  for (const fixture of ["web", "extension", "tauri", "tauri-npm"]) {
    const file = join(ROOT, "tests", "fixtures", fixture, "release.config.json");
    const res = runCli([file, "--env"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(/^UPDATER_/m.test(res.stdout), false, `${fixture} ganhou chave UPDATER_*`);
    assert.equal("updater" in load(file), false);
  }
});

test("--get das chaves do updater responde o desligado para quem não declarou", () => {
  const file = join(PROJECTS, "mark-lee", ".github", "release.config.json");
  assert.equal(runCli([file, "--get", "updater_enabled"]).stdout.trim(), "false");
  assert.equal(runCli([file, "--get", "updater_channel"]).stdout.trim(), "");
  assert.equal(runCli([file, "--get", "updater_platforms"]).stdout.trim(), "[]");
});

// --- 2. declarar é habilitar, e os defaults preenchem o resto ----------------

test("declarar o bloco já é habilitar: enabled absent é true, channel absent é stable", () => {
  const model = load(
    updaterConfig({ platforms: [{ id: "linux-x86_64", sig: ["bundle/*.AppImage.tar.gz.sig"] }] }),
  );
  assert.deepEqual(model.updater, {
    enabled: true,
    channel: "stable",
    platforms: [{ id: "linux-x86_64", os: ["*"], sig: ["bundle/*.AppImage.tar.gz.sig"] }],
  });
});

test("`enabled: false` desliga sem apagar a declaração, e nada de assinatura é prometido", () => {
  const file = updaterConfig({
    enabled: false,
    platforms: [{ id: "windows-x86_64", os: ["windows-latest"], sig: ["bundle/**/*x64-setup.exe.sig"] }],
  });
  const model = load(file);
  assert.equal(model.updater.enabled, false);
  assert.equal(model.updater.platforms.length, 1, "a declaração fica; só o efeito sai");
  const env = runCli([file, "--env"]);
  assert.equal(env.status, 0, env.stderr);
  assert.match(env.stdout, /^UPDATER_ENABLED=false$/m);
});

test("o bloco declarado vai para o ambiente do job, com a lista de plataformas em JSON", () => {
  const file = updaterConfig({
    channel: "beta",
    platforms: [{ id: "darwin-aarch64", os: ["macos-latest"], sig: ["bundle/**/*.app.tar.gz.sig"] }],
  });
  const res = runCli([file, "--env"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^UPDATER_ENABLED=true$/m);
  assert.match(res.stdout, /^UPDATER_CHANNEL=beta$/m);
  const line = res.stdout.split("\n").find((l) => l.startsWith("UPDATER_PLATFORMS="));
  assert.deepEqual(JSON.parse(line.slice("UPDATER_PLATFORMS=".length)), [
    { id: "darwin-aarch64", os: ["macos-latest"], sig: ["bundle/**/*.app.tar.gz.sig"] },
  ]);
});

test("o updater exige desktop: é o Tauri que empacota o que se assina", () => {
  const file = configFile({
    release: { title: "Demo" },
    updater: { platforms: [{ id: "linux-x86_64", sig: ["*.sig"] }] },
  });
  const res = runCli([file]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /desktop\.enabled/);
});

const FAIL_CASES = [
  ["updater não é objeto", { release: { title: "X" }, updater: [] }, /updater deve ser um objeto/],
  [
    "channel inválido",
    { release: { title: "X" }, build: RUST, desktop: DESKTOP, updater: { channel: "nightly", platforms: [{ id: "linux-x86_64", sig: ["*.sig"] }] } },
    /updater\.channel deve ser "stable" ou "beta"/,
  ],
  [
    "enabled não booleano",
    { release: { title: "X" }, build: RUST, desktop: DESKTOP, updater: { enabled: "sim", platforms: [{ id: "linux-x86_64", sig: ["*.sig"] }] } },
    /updater\.enabled deve ser booleano/,
  ],
  [
    "id fora do formato <os>-<arch>",
    { release: { title: "X" }, build: RUST, desktop: DESKTOP, updater: { platforms: [{ id: "win-x64", sig: ["*.sig"] }] } },
    /chave de plataforma do updater, no formato <os>-<arch>/,
  ],
  [
    "id repetido",
    { release: { title: "X" }, build: RUST, desktop: DESKTOP, updater: { platforms: [{ id: "linux-x86_64", sig: ["a*.sig"] }, { id: "linux-x86_64", sig: ["b*.sig"] }] } },
    /repete/,
  ],
  [
    "plataforma sem sig",
    { release: { title: "X" }, build: RUST, desktop: DESKTOP, updater: { platforms: [{ id: "linux-x86_64" }] } },
    /precisa de sig/,
  ],
  [
    "sig que não é glob",
    { release: { title: "X" }, build: RUST, desktop: DESKTOP, updater: { platforms: [{ id: "linux-x86_64", sig: ["bundle/app.tar.gz"] }] } },
    /não parece um padrão/,
  ],
  [
    "habilitado sem plataforma",
    { release: { title: "X" }, build: RUST, desktop: DESKTOP, updater: { platforms: [] } },
    /updater\.platforms está vazio/,
  ],
  [
    "platforms não é array",
    { release: { title: "X" }, build: RUST, desktop: DESKTOP, updater: { platforms: {} } },
    /deve ser um array de \{ id, os, sig \}/,
  ],
];

for (const [label, body, pattern] of FAIL_CASES) {
  test(`falha: ${label}`, () => {
    const res = runCli([configFile(body)]);
    assert.notEqual(res.status, 0, `deveria falhar: ${label}`);
    assert.match(res.stderr, pattern);
    assert.match(res.stderr, /\[release-config\]/);
  });
}
