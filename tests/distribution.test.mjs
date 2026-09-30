// `distribution.artifacts[]`: o contrato e o adapter do bloco legado.
//
// O que estes testes têm que provar, além da forma:
//
// 1. **O adapter é fiel.** O bloco `artifact` de um consumidor real tem que
//    produzir exatamente o mesmo resultado de sempre, porque é o único caminho
//    que alguém já usou em produção.
// 2. **`desktop` deixou de ser exclusivo.** A proibição de `desktop` com
//    `artifact` (e com `build.command`) é o que tornava o perfil misto
//    site + instalador inexpressável. Um consumidor que nunca tentou nunca
//    teria registrado a dor — a regra só aparece lendo o código.
// 3. **`os` e `required` são o que diferencia matriz de job único.** Sem eles,
//    todo artefato é exigido em toda célula, e projeto com matriz não declara
//    nada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { load } from "../scripts/release-config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "release-config.mjs");

function withConfig(extra) {
  const dir = mkdtempSync(join(tmpdir(), "dist-"));
  writeFileSync(join(dir, "package.json"), '{"name":"t","version":"0.0.0"}', "utf8");
  // O helper exige evidência de lockfile quando `package_manager` é declarado, e
  // `fail()` chama process.exit: sem o lockfile, um teste que espera sucesso
  // derrubaria o processo inteiro em vez de falhar sozinho.
  writeFileSync(join(dir, "package-lock.json"), "{}", "utf8");
  const file = join(dir, "release.config.json");
  writeFileSync(file, JSON.stringify(extra), "utf8");
  return file;
}

const base = (rest) => ({ release: { title: "Demo" }, ...rest });

function run(file) {
  return spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
}

// --- a forma nova -----------------------------------------------------------

test("um artefato declarado vira uma entrada com escopo explícito", () => {
  const file = withConfig(
    base({
      distribution: {
        artifacts: [
          {
            id: "web",
            path: "dist/site.zip",
            kind: "archive",
            os: ["ubuntu-latest"],
            required: false,
            label: "Web (portátil)",
            platform: "web",
          },
        ],
      },
    }),
  );
  const m = load(file);
  assert.equal(m.distribution.artifacts.length, 1);
  const [a] = m.distribution.artifacts;
  assert.equal(a.id, "web");
  assert.deepEqual(a.paths, ["dist/site.zip"]);
  assert.deepEqual(a.os, ["ubuntu-latest"]);
  assert.equal(a.required, false);
  assert.equal(a.kind, "archive");
  assert.equal(a.platform, "web");
  assert.equal(a.label, "Web (portátil)");
});

test("padrões: os = qualquer célula, required = obrigatório", () => {
  const file = withConfig(
    base({ distribution: { artifacts: [{ id: "a", path: "dist/a.zip" }] } }),
  );
  const [a] = load(file).distribution.artifacts;
  assert.deepEqual(a.os, ["*"], "sem `os`, o artefato vale para qualquer célula — é o que o legado fazia");
  assert.equal(a.required, true, "ausente e obrigatório é o default: mais rígido e mais seguro");
});

test("perfil misto: artefato do site e instaladores convivem", () => {
  // É o pedido que hoje é inexpressável: site público **e** instaladores, na
  // mesma release. `desktop.enabled` proibia `artifact.enabled`.
  const file = withConfig(
    base({
      build: { package_manager: "npm", node: "22", rust: "stable", command: "npm run build:web" },
      desktop: { enabled: true, project_path: "apps/desktop" },
      distribution: {
        artifacts: [
          { id: "web", path: "dist/site.zip", kind: "archive", os: ["ubuntu-latest"], required: false },
          { id: "win-x64", globs: ["dist/*.msi"], kind: "installer", platform: "windows", architecture: "x64" },
        ],
      },
    }),
  );
  const m = load(file);
  assert.equal(m.desktop.enabled, true);
  assert.equal(m.build.command, "npm run build:web", "o build do site roda junto do Tauri");
  assert.equal(m.distribution.artifacts.length, 2, "os dois artefatos coexistem com o desktop");
});

test("vários artefatos por plataforma, cada um com a sua célula", () => {
  const file = withConfig(
    base({
      distribution: {
        artifacts: [
          { id: "win", globs: ["dist/*.msi"], os: ["windows-latest"], platform: "windows" },
          { id: "lin", globs: ["dist/*.deb"], os: ["ubuntu-latest"], platform: "linux" },
          { id: "mac", globs: ["dist/*.dmg"], os: ["macos-latest"], platform: "macos" },
          { id: "web", path: "dist/site.zip", os: ["ubuntu-latest"], required: false },
        ],
      },
    }),
  );
  const ids = load(file).distribution.artifacts.map((a) => a.id);
  assert.deepEqual(ids, ["win", "lin", "mac", "web"]);
});

test("release sem artefato é uma configuração válida", () => {
  const file = withConfig(base({ distribution: { artifacts: [] } }));
  assert.deepEqual(load(file).distribution.artifacts, []);
  const semBloco = withConfig(base({}));
  assert.deepEqual(load(semBloco).distribution.artifacts, []);
});

// --- o adapter do legado ----------------------------------------------------

test("adapter: `artifact` legado vira UMA entrada, com o mesmo comportamento", () => {
  // Este é o consumidor real: um ZIP único, renomeado na release, com
  // validação por conteúdo. O resultado tem que ser o que ele produzia.
  const file = withConfig(
    base({
      artifact: {
        enabled: true,
        path: "kaes-keid-inspector.zip",
        release_name: "kaes-keide-inspector-v{version}.zip",
        validate: ['unzip -t "$1"'],
      },
    }),
  );
  const m = load(file);
  const [a] = m.distribution.artifacts;
  assert.equal(m.distribution.artifacts.length, 1, "o legado é um artefato só");
  assert.deepEqual(a.paths, ["kaes-keid-inspector.zip"]);
  assert.deepEqual(a.globs, []);
  assert.equal(a.releaseName, "kaes-keide-inspector-v{version}.zip");
  assert.deepEqual(a.validate, ['unzip -t "$1"']);
  assert.deepEqual(a.os, ["*"]);
  assert.equal(a.required, true);
});

test("adapter: globs e paths juntos viram os mesmos arquivos de sempre", () => {
  const file = withConfig(
    base({ artifact: { enabled: true, path: ["a.zip", "b.zip"], globs: ["out/*.txt"] } }),
  );
  const [a] = load(file).distribution.artifacts;
  assert.deepEqual(a.paths, ["a.zip", "b.zip"]);
  assert.deepEqual(a.globs, ["out/*.txt"]);
});

test("adapter: `artifact.enabled: false` e a ausência dão lista vazia", () => {
  const disabled = withConfig(base({ artifact: { enabled: false } }));
  assert.deepEqual(load(disabled).distribution.artifacts, []);
});

test("as duas formas juntas é erro que diz a migração", () => {
  const file = withConfig(
    base({
      artifact: { enabled: true, path: "a.zip" },
      distribution: { artifacts: [{ id: "a", path: "a.zip" }] },
    }),
  );
  const res = run(file);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /não podem ser declarados juntos/);
  assert.match(res.stderr, /distribution\.artifacts/, "a mensagem entrega a forma nova");
});

// --- validação --------------------------------------------------------------

test("artefato sem path e sem globs é erro", () => {
  const file = withConfig(base({ distribution: { artifacts: [{ id: "a" }] } }));
  const res = run(file);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /precisa de path ou globs/);
});

test("id inválido ou repetido é erro, com o motivo", () => {
  const ruim = withConfig(base({ distribution: { artifacts: [{ id: "Web Build", path: "a.zip" }] } }));
  assert.match(run(ruim).stderr, /identificador em minúsculas/);
  const repetido = withConfig(
    base({
      distribution: {
        artifacts: [
          { id: "a", path: "a.zip" },
          { id: "a", path: "b.zip" },
        ],
      },
    }),
  );
  assert.match(run(repetido).stderr, /repete/);
});

test("release_name com mais de um path explícito é erro, dizendo o que fazer", () => {
  // O legado reprovava, mas a mensagem não dizia o caminho novo.
  const file = withConfig(
    base({
      artifact: {
        enabled: true,
        path: ["a.zip", "b.zip"],
        release_name: "x-{version}.zip",
      },
    }),
  );
  const res = run(file);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /distribution\.artifacts/);
  assert.match(res.stderr, /o seu próprio path/);
});

// --- a superfície que os outros jobs usam ------------------------------------

test("--env publica a lista inteira em DIST_ARTIFACTS", () => {
  const file = withConfig(
    base({
      distribution: {
        artifacts: [
          { id: "web", path: "dist/site.zip", os: ["ubuntu-latest"], required: false },
        ],
      },
    }),
  );
  const res = spawnSync(process.execPath, [SCRIPT, file, "--env"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const line = res.stdout.split("\n").find((l) => l.startsWith("DIST_ARTIFACTS="));
  const parsed = JSON.parse(line.slice("DIST_ARTIFACTS=".length));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "web");
  assert.equal(parsed[0].required, false, "o default não pode se perder na translation layer");
  assert.match(res.stdout, /^DIST_HAS_ARTIFACTS=true$/m);
});

test("--get mantém as chaves legadas do artefato", () => {
  const file = withConfig(
    base({ artifact: { enabled: true, path: "a.zip", release_name: "b-{version}.zip" } }),
  );
  const get = (key) =>
    spawnSync(process.execPath, [SCRIPT, file, "--get", key], { encoding: "utf8" }).stdout.trim();
  assert.equal(get("artifact_enabled"), "true");
  assert.equal(get("artifact_paths"), '["a.zip"]');
  assert.equal(get("artifact_release_name"), "b-{version}.zip");
});
