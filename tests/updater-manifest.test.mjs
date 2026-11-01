// Manifesto por canal e gate de promoção — o lado do feed.
//
// O que estes testes têm de provar:
//
// 1. **Feed incompleto não promove.** Uma plataforma declarada sem assinatura
//    não entra no manifesto, e um manifesto parcial é pior do que nenhum: o
//    cliente cujo par não está lá fica preso na versão velha sem que ninguém
//    veja. A release pode até existir (à mão), mas o canal não avança.
// 2. **Feed completo publica com payload imutável.** A URL de cada plataforma
//    nomeia a tag (`/releases/download/<tag>/<arquivo>`), nunca
//    `releases/latest`: um ponteiro móvel serviria a versão errada sob uma URL
//    estável, que é a pior forma de errar.
// 3. **Downgrade é recusado.** O canal nunca anda para trás: se uma versão
//    maior já foi servida, a menor não entra no feed (a release pode ser um
//    hotfix legítimo de linha antiga, e publicá-la não é o problema).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFeed,
  channelManifestName,
  compareSemver,
  notesPath,
  parseSemver,
  servedChannelReleases,
  signatureAssetFor,
} from "../scripts/updater-manifest.mjs";

// --- o nome do asset é o do canal -------------------------------------------

test("o manifesto do stable é o latest.json; os outros canais ganham sufixo próprio", () => {
  assert.equal(channelManifestName("stable"), "latest.json");
  assert.equal(channelManifestName("beta"), "latest-beta.json");
});

test("canal desconhecido não vira nome de asset: só stable e beta existem", () => {
  assert.throws(() => channelManifestName("nightly"), /canal/i);
});

// --- SemVer -----------------------------------------------------------------

test("parseSemver aceita a forma completa e recusa o que o plugin não compara", () => {
  assert.deepEqual(parseSemver("1.5.0"), { major: 1, minor: 5, patch: 0, prerelease: [], build: "" });
  assert.deepEqual(parseSemver("1.5.0-beta.2"), {
    major: 1,
    minor: 5,
    patch: 0,
    prerelease: ["beta", "2"],
    build: "",
  });
  assert.equal(parseSemver("1.5"), null, "dois componentes não são SemVer");
  assert.equal(parseSemver("1.5.0.1"), null);
  assert.equal(parseSemver("v1.5.0"), null, "a tag é normalizada antes; aqui é versão pura");
  assert.equal(parseSemver("01.5.0"), null, "zero à esquerda não é SemVer");
  assert.equal(parseSemver(""), null);
});

test("compareSemver segue a precedência do SemVer, não a ordem alfabética", () => {
  const at = (a, b) => compareSemver(parseSemver(a), parseSemver(b));
  assert.equal(at("1.5.0", "1.5.0"), 0);
  assert.equal(at("1.5.0", "1.5.1"), -1);
  assert.equal(at("1.10.0", "1.9.0"), 1, "10 > 9 numa comparação numérica");
  assert.equal(at("2.0.0", "1.99.99"), 1);
  // prerelease é sempre menor que a versão final, e a numérica vence a alfanumérica
  assert.equal(at("1.5.0-beta.1", "1.5.0"), -1);
  assert.equal(at("1.5.0-beta.2", "1.5.0-beta.10"), -1);
  assert.equal(at("1.5.0-alpha", "1.5.0-beta"), -1);
  assert.equal(at("1.5.0-beta.1", "1.5.0-beta.1"), 0);
});

// --- qual assinatura serve o feed -------------------------------------------

const WINDOWS = {
  id: "windows-x86_64",
  os: ["windows-latest"],
  sig: ["bundle/nsis/*x64-setup.exe.sig", "bundle/msi/*x64*.msi.sig"],
};

const asset = (name) => ({ name, id: name.length });

test("a plataforma escolhe a primeira assinatura declarada que existe na release", () => {
  // A ordem de `sig` é a preferência do feed: o plugin recebe UMA URL por
  // plataforma, e quem declara decide qual dos bundles é o alvo da atualização.
  const onlyMsi = signatureAssetFor(WINDOWS, [
    asset("App_1.5.0_x64-setup.exe"),
    asset("App_1.5.0_x64_en-US.msi.sig"),
  ]);
  assert.equal(onlyMsi.ok, true);
  assert.equal(onlyMsi.asset.name, "App_1.5.0_x64_en-US.msi.sig");
  assert.equal(onlyMsi.artifactName, "App_1.5.0_x64_en-US.msi");

  const both = signatureAssetFor(WINDOWS, [
    asset("App_1.5.0_x64_en-US.msi.sig"),
    asset("App_1.5.0_x64-setup.exe.sig"),
  ]);
  assert.equal(both.asset.name, "App_1.5.0_x64-setup.exe.sig", "a primeira forma declarada vence");
});

test("CONTROLE NEGATIVO: plataforma sem assinatura na release não tem entrada no feed", () => {
  const missing = signatureAssetFor(WINDOWS, [asset("App_1.5.0_x64-setup.exe")]);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing");
  assert.deepEqual(missing.patterns, ["*x64-setup.exe.sig", "*x64*.msi.sig"]);
});

test("CONTROLE NEGATIVO: duas assinaturas para a mesma forma reprovam em vez de escolher uma", () => {
  // O caso real: uma re-execução deixou o `.sig` da versão anterior na release.
  // Escolher em silêncio entregaria a uns a atualização certa e a outros uma
  // URL de outra versão.
  const ambiguous = signatureAssetFor(WINDOWS, [
    asset("App_1.5.0_x64-setup.exe.sig"),
    asset("App_1.6.0_x64-setup.exe.sig"),
  ]);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, "ambiguous");
  assert.deepEqual(ambiguous.matches, [
    "App_1.5.0_x64-setup.exe.sig",
    "App_1.6.0_x64-setup.exe.sig",
  ]);
});

// --- o gate de promoção ------------------------------------------------------

const MAC = {
  id: "darwin-aarch64",
  os: ["macos-latest"],
  sig: ["bundle/macos/*.app.tar.gz.sig"],
};
const DECLARED = [WINDOWS, MAC];

const COMPLETE_ASSETS = [
  "App_1.5.0_x64-setup.exe",
  "App_1.5.0_x64-setup.exe.sig",
  "App_1.5.0_aarch64.app.tar.gz",
  "App_1.5.0_aarch64.app.tar.gz.sig",
];

const COMPLETE_SIGNATURES = {
  "App_1.5.0_x64-setup.exe.sig": "assinatura-win\n",
  "App_1.5.0_aarch64.app.tar.gz.sig": "assinatura-mac\n",
};

const asAssets = (names) => names.map((name) => ({ name, id: name.length }));

/** Estado do `finalize` de uma release completa, sobrescrevível por caso. */
function feed(over = {}) {
  return {
    repo: "mafhper/demo",
    tag: "v1.5.0",
    channel: "stable",
    platforms: DECLARED,
    assets: asAssets(COMPLETE_ASSETS),
    signatures: COMPLETE_SIGNATURES,
    notes: "Notas da 1.5.0.",
    pubDate: "2026-11-01T12:00:00.000Z",
    // tags publicadas que já têm o manifesto deste canal
    served: [],
    ...over,
  };
}

const codes = (result) => result.blockers.map((blocker) => [blocker.code, blocker.tier]);

test("feed completo publica o manifesto: conteúdo do .sig e URL por tag", () => {
  const { promote, blockers, manifest } = buildFeed(feed());
  assert.deepEqual(blockers, []);
  assert.equal(promote, true);
  assert.deepEqual(manifest, {
    version: "1.5.0",
    notes: "Notas da 1.5.0.",
    pub_date: "2026-11-01T12:00:00.000Z",
    platforms: {
      "darwin-aarch64": {
        signature: "assinatura-mac",
        url: "https://github.com/mafhper/demo/releases/download/v1.5.0/App_1.5.0_aarch64.app.tar.gz",
      },
      "windows-x86_64": {
        signature: "assinatura-win",
        url: "https://github.com/mafhper/demo/releases/download/v1.5.0/App_1.5.0_x64-setup.exe",
      },
    },
  });
  // determinismo: a ordem das chaves não depende da ordem em que as células
  // subiram os assets, então reexecutar a mesma tag gera os mesmos bytes.
  assert.deepEqual(Object.keys(manifest.platforms), ["darwin-aarch64", "windows-x86_64"]);
});

test("nenhuma URL do manifesto é ponteiro móvel", () => {
  const { manifest } = buildFeed(feed());
  const urls = Object.values(manifest.platforms).map((entry) => entry.url);
  assert.equal(urls.length, DECLARED.length);
  for (const url of urls) {
    assert.match(url, /^https:\/\/github\.com\/mafhper\/demo\/releases\/download\/v1\.5\.0\//);
    assert.equal(url.includes("/releases/latest"), false, url);
  }
  assert.equal(JSON.stringify(manifest).includes("latest/download"), false);
});

test("CONTROLE NEGATIVO: plataforma declarada sem assinatura não promove o canal", () => {
  const { promote, blockers, manifest } = buildFeed(
    feed({
      assets: asAssets(["App_1.5.0_x64-setup.exe", "App_1.5.0_x64-setup.exe.sig"]),
    }),
  );
  assert.equal(promote, false);
  assert.equal(manifest, null, "manifesto parcial não existe: o feed é tudo ou nada");
  assert.deepEqual(codes({ blockers }), [["missing-signature", "release"]]);
  assert.match(blockers[0].message, /darwin-aarch64/);
});

test("CONTROLE NEGATIVO: downgrade não move o canal", () => {
  const { promote, blockers, manifest } = buildFeed(feed({ served: ["v1.6.0"] }));
  assert.equal(promote, false);
  assert.equal(manifest, null);
  assert.deepEqual(codes({ blockers }), [["downgrade", "feed"]]);
  assert.match(blockers[0].message, /v1\.6\.0/);
});

test("reexecução da mesma versão não é downgrade, e versão anterior não bloqueia", () => {
  assert.equal(buildFeed(feed({ served: ["v1.5.0"] })).promote, true);
  assert.equal(buildFeed(feed({ served: ["v1.4.0", "v1.3.0"] })).promote, true);
});

test("prerelease não entra no canal stable, e entra no beta", () => {
  const stable = buildFeed(feed({ tag: "v1.5.0-beta.1" }));
  assert.equal(stable.promote, false);
  assert.deepEqual(codes(stable), [["prerelease-on-stable", "feed"]]);

  const beta = buildFeed(
    feed({ tag: "v1.5.0-beta.1", channel: "beta", served: ["v1.5.0-alpha.1"] }),
  );
  assert.equal(beta.promote, true);
  assert.equal(beta.manifest.version, "1.5.0-beta.1");
  assert.equal(
    beta.manifest.platforms["windows-x86_64"].url.includes("/v1.5.0-beta.1/"),
    true,
    "a URL carrega a tag inteira, prerelease inclusive",
  );
});

test("CONTROLE NEGATIVO: assinatura sem o artefato que ela assina reprova: a URL não resolveria", () => {
  const { promote, blockers } = buildFeed(
    feed({ assets: asAssets(COMPLETE_ASSETS.filter((name) => name !== "App_1.5.0_aarch64.app.tar.gz")) }),
  );
  assert.equal(promote, false);
  assert.deepEqual(codes({ blockers }), [["orphan-artifact", "release"]]);
  assert.match(blockers[0].message, /App_1\.5\.0_aarch64\.app\.tar\.gz/);
});

test("CONTROLE NEGATIVO: assinatura de outra versão não entra no feed", () => {
  // O caso real: reexecução deixou o `.sig` da versão anterior na release. A
  // forma do nome casa, e sem esta conferência o feed apontaria para artefato
  // de outro build.
  const { promote, blockers } = buildFeed(
    feed({
      assets: asAssets([
        "App_1.5.0_x64-setup.exe",
        "App_1.4.0_x64-setup.exe.sig",
        "App_1.5.0_aarch64.app.tar.gz",
        "App_1.5.0_aarch64.app.tar.gz.sig",
      ]),
    }),
  );
  assert.equal(promote, false);
  assert.deepEqual(codes({ blockers }), [["version-mismatch", "release"]]);
  assert.match(blockers[0].message, /1\.4\.0/);
  assert.match(blockers[0].message, /1\.5\.0/);
});

test("CONTROLE NEGATIVO: assinatura vazia ou sem conteúdo não promove", () => {
  const empty = buildFeed(
    feed({ signatures: { ...COMPLETE_SIGNATURES, "App_1.5.0_x64-setup.exe.sig": "  \n\t" } }),
  );
  assert.equal(empty.promote, false);
  assert.deepEqual(empty.blockers.map((b) => b.code), ["missing-signature-content"]);

  const absent = buildFeed(
    feed({ signatures: { "App_1.5.0_aarch64.app.tar.gz.sig": "assinatura-mac" } }),
  );
  assert.equal(absent.promote, false);
  assert.deepEqual(absent.blockers.map((b) => b.code), ["missing-signature-content"]);
});

test("CONTROLE NEGATIVO: tag sem SemVer válido não vira feed", () => {
  for (const tag of ["v1.5", "v1.5.0.1", "release-1.5.0"]) {
    const { promote, blockers, manifest } = buildFeed(feed({ tag }));
    assert.equal(promote, false, tag);
    assert.equal(manifest, null);
    assert.deepEqual(codes({ blockers }), [["invalid-version", "release"]], tag);
  }
});

test("a versão servida pelo canal sai da release publicada que tem o asset do canal", () => {
  const releases = [
    { tag_name: "v1.6.0", draft: false, assets: [{ name: "latest.json" }] },
    { tag_name: "v1.7.0", draft: false, assets: [{ name: "latest-beta.json" }] },
    { tag_name: "v1.8.0", draft: true, assets: [{ name: "latest.json" }] },
    { tag_name: "v1.9.0", draft: false, assets: [] },
  ];
  assert.deepEqual(servedChannelReleases(releases, "stable", "v1.5.0"), ["v1.6.0"]);
  assert.deepEqual(servedChannelReleases(releases, "beta", "v1.5.0"), ["v1.7.0"]);
  assert.deepEqual(
    servedChannelReleases(releases, "stable", "v1.6.0"),
    [],
    "a própria tag em reexecução não conta como versão já servida",
  );
});

// --- as notas vêm do mesmo arquivo que o corpo usa ---------------------------

test("as notas do manifesto são resolvidas como no corpo do release", () => {
  assert.equal(notesPath("v1.5.0", "tag", ".github/release-notes"), ".github/release-notes/v1.5.0.md");
  assert.equal(notesPath("v1.5.0", "minor", ".github/release-notes"), ".github/release-notes/v1.5.md");
  // granularity minor numa prerelease segue a mesma derivação do corpo
  assert.equal(notesPath("v1.5.0-beta.1", "minor", "notes"), "notes/v1.5.0-beta.md");
  // o caminho não depende de plataforma: o contrato usa POSIX nos três sistemas
  assert.equal(notesPath("v1.5.0", "tag", "docs\\notas\\"), "docs/notas/v1.5.0.md");
});

// --- o CLI, como o workflow o chama -----------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "updater-manifest.mjs");

const currentRelease = (tag, names) =>
  JSON.stringify([
    { tag_name: tag, draft: true, assets: names.map((name) => ({ name, id: name.length })) },
  ]);

/** Executa o CLI com o ambiente do `finalize`, sobrescrevendo o que o caso pede. */
function runCli(over = {}) {
  return spawnSync(process.execPath, [SCRIPT, "build"], {
    encoding: "utf8",
    env: {
      ...process.env,
      REPO: "mafhper/demo",
      TAG: "v1.5.0",
      UPDATER_CHANNEL: "stable",
      UPDATER_PLATFORMS: JSON.stringify(DECLARED),
      UPDATER_SIG_JSON: JSON.stringify(COMPLETE_SIGNATURES),
      UPDATER_PUB_DATE: "2026-11-01T12:00:00.000Z",
      RELEASES_JSON: currentRelease("v1.5.0", COMPLETE_ASSETS),
      ...over,
    },
  });
}

const outDir = () => mkdtempSync(join(tmpdir(), "manifest-"));

const jsonFiles = (dir) => readdirSync(dir).filter((name) => name.endsWith(".json"));

test("CLI: feed completo grava o manifesto e imprime o caminho do asset", () => {
  const dir = outDir();
  const res = runCli({ UPDATER_MANIFEST_OUT: dir, NOTES_DIR: join(dir, "sem-notas") });
  assert.equal(res.status, 0, res.stderr);
  const file = res.stdout.trim();
  assert.equal(resolve(file), resolve(dir, "latest.json"));
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(manifest.version, "1.5.0");
  assert.equal(manifest.notes, "", "sem arquivo de notas, o campo é vazio — e não ausente");
  assert.deepEqual(Object.keys(manifest.platforms), ["darwin-aarch64", "windows-x86_64"]);
});

test("CLI: o canal decide o nome do asset, e o beta não encosta no latest.json", () => {
  const dir = outDir();
  const res = runCli({
    UPDATER_MANIFEST_OUT: dir,
    UPDATER_CHANNEL: "beta",
    TAG: "v1.5.0-beta.1",
    RELEASES_JSON: currentRelease("v1.5.0-beta.1", COMPLETE_ASSETS),
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(resolve(res.stdout.trim()), resolve(dir, "latest-beta.json"));
});

test("CLI: as notas do arquivo entram no manifesto", () => {
  const dir = outDir();
  const notes = join(dir, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "v1.5.0.md"), "Notas da 1.5.0.\n", "utf8");
  const res = runCli({ UPDATER_MANIFEST_OUT: join(dir, "out"), NOTES_DIR: notes });
  assert.equal(res.status, 0, res.stderr);
  const manifest = JSON.parse(readFileSync(res.stdout.trim(), "utf8"));
  assert.equal(manifest.notes, "Notas da 1.5.0.");
});

test("CLI: feed incompleto reprova o passo e não grava manifesto", () => {
  const dir = outDir();
  const res = runCli({
    UPDATER_MANIFEST_OUT: dir,
    RELEASES_JSON: currentRelease("v1.5.0", [
      "App_1.5.0_x64-setup.exe",
      "App_1.5.0_x64-setup.exe.sig",
    ]),
  });
  assert.equal(res.status, 1, "o manifesto errado tem que deixar o release em rascunho");
  assert.match(res.stderr, /::error::/);
  assert.match(res.stderr, /missing-signature/);
  assert.deepEqual(jsonFiles(dir), [], "nada é gravado quando o gate reprova");
  assert.equal(res.stdout.trim(), "");
});

test("CLI: downgrade não reprova o release, e não publica o canal", () => {
  const dir = outDir();
  const res = runCli({
    UPDATER_MANIFEST_OUT: dir,
    RELEASES_JSON: JSON.stringify([
      { tag_name: "v1.6.0", draft: false, assets: [{ name: "latest.json", id: 1 }] },
      { tag_name: "v1.5.0", draft: true, assets: COMPLETE_ASSETS.map((name) => ({ name, id: name.length })) },
    ]),
  });
  assert.equal(res.status, 0, "o release pode ser um hotfix legítimo de linha antiga");
  assert.match(res.stderr, /::warning::/);
  assert.match(res.stderr, /downgrade/);
  assert.deepEqual(jsonFiles(dir), [], "o canal não anda para trás");
  assert.equal(res.stdout.trim(), "", "sem caminho na saída, o passo não envia asset nenhum");
});

test("CLI: sem a lista de plataformas não passa vazio", () => {
  const res = runCli({ UPDATER_MANIFEST_OUT: outDir(), UPDATER_PLATFORMS: "" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /UPDATER_PLATFORMS/);
});

test("CLI recusa modo desconhecido em vez de não fazer nada", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "publish"], { encoding: "utf8", env: process.env });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /modo desconhecido/);
});

// --- o passo do workflow -----------------------------------------------------

const WORKFLOW = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");

/** Blocos de passo do workflow, cortados pelo próximo `- name:`. */
function stepBlocks() {
  return WORKFLOW.split("\n      - name: ")
    .slice(1)
    .map((chunk) => `- name: ${chunk}`);
}

const manifestStep = () =>
  stepBlocks().find((block) => block.includes("updater-manifest.mjs"));

test("o passo do manifesto existe, com a guarda do updater e depois da conferência", () => {
  const block = manifestStep();
  assert.ok(block, "o passo que gera o manifesto precisa existir no finalize");
  assert.match(block, /\n\s+if: env\.UPDATER_ENABLED == 'true'/, "sem a guarda, quem não usa ganha passo novo");
  assert.match(block, /updater-manifest\.mjs" build/);

  const verify = WORKFLOW.indexOf("Conferir as assinaturas do updater na release");
  const manifest = WORKFLOW.indexOf("updater-manifest.mjs");
  const publish = WORKFLOW.lastIndexOf("Publicar o release");
  assert.ok(verify > 0 && manifest > verify, "o manifesto lê as assinaturas que a conferência aprovou");
  assert.ok(manifest < publish, "o manifesto sobe antes do release virar público");
});

test("o manifesto só sobe quando o gate devolve um caminho", () => {
  // A saída do script é o discriminador: vazia é "o canal não anda", e o passo
  // não pode confundir isso com falha nem enviar arquivo nenhum.
  const block = manifestStep();
  assert.match(block, /\$\(node [^)]*updater-manifest\.mjs" build\)/, "o caminho vem do stdout");
  assert.match(block, /if \[ -z "\$manifest" \]/, "saída vazia tem de ser tratada antes do upload");
  assert.match(block, /gh release upload "\$TAG" --repo "\$REPO" --clobber "\$manifest"/);
  assert.equal(
    /updater-manifest\.mjs[\s\S]*?releases\/latest/.test(block),
    false,
    "o passo não pode publicar em releases/latest",
  );
});
