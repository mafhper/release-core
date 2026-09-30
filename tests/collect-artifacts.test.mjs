// O coletor de artefatos por célula, e a conferência da release.
//
// O ponto que estes testes defendem, e que nenhuma das duas metades sozinha
// defende:
//
//   "Não basta o comando de build terminar com sucesso se o workflow não
//    encontrar os arquivos esperados."  (icon-core)
//
// `build` verde afirma algo sobre **células**; a afirmação que importa é sobre a
// **release**. A metade que falta é o `verify-artifacts.mjs`, e ela roda no
// `finalize`, que é o único lugar que enxerga a release inteira.
//
// Cada caso de reprovação tem o seu oposto que passa. É o controle negativo: se
// a regra for removida, o caso que deve reprovar passa, e o teste acusa.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { collect, globToRegExp, expandGlobs } from "../scripts/collect-artifacts.mjs";
import { downloadsTable, expectedAssetName } from "../scripts/verify-artifacts.mjs";
import { checkExpect } from "../scripts/check-cell-expect.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COLLECT = join(ROOT, "scripts", "collect-artifacts.mjs");
const EXPECT = join(ROOT, "scripts", "check-cell-expect.mjs");

const art = (over = {}) => ({
  id: "a",
  paths: [],
  globs: [],
  os: ["*"],
  required: true,
  kind: "",
  label: "",
  platform: "",
  architecture: "",
  releaseName: "",
  validate: [],
  ...over,
});

function sandbox(files) {
  const dir = mkdtempSync(join(tmpdir(), "artcol-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

// `validate` roda em bash por contrato, e o bash não está no PATH do Node no
// Windows. Mesmo tratamento que o `step-boundary.test.mjs`: pular, e dizer que
// pulou — um teste que passa por ausência de bash é pior que nenhum.
const hasBash = spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
const skipBash = hasBash
  ? false
  : "bash não está disponível neste ambiente (o CI roda em ubuntu, onde está)";

// --- glob: a semântica que o shell tinha ------------------------------------

test("glob: `*` e `?` não cruzam `/`, `**` cruza", () => {
  assert.ok(globToRegExp("dist/*.zip").test("dist/a.zip"));
  assert.ok(!globToRegExp("dist/*.zip").test("dist/sub/a.zip"), "igual ao pathname expansion do bash");
  assert.ok(globToRegExp("dist/**/a.zip").test("dist/x/y/a.zip"));
  assert.ok(globToRegExp("a?c.txt").test("abc.txt"));
  assert.ok(!globToRegExp("a?c.txt").test("ac.txt"));
  assert.ok(globToRegExp("out/(1).zip").test("out/(1).zip"), "parênteses são literais");
});

test("expandGlobs acha em subdiretório quando o padrão diz **", () => {
  const dir = sandbox({ "apps/desktop/src-tauri/target/release/bundle/msi/App_1.0.0_x64.msi": "x" });
  assert.equal(expandGlobs(["apps/**/App_*.msi"], dir).length, 1);
  assert.equal(expandGlobs(["apps/desktop/**/*.msi"], dir).length, 1);
  assert.equal(expandGlobs(["apps/*.msi"], dir).length, 0);
});

// --- a célula coleta o que é dela, e só isso --------------------------------

test("a célula coleta o artefato cujo `os` é o dela", () => {
  const dir = sandbox({ "dist/site.zip": "web", "dist/app.msi": "win" });
  const { files, selected, skipped } = collect(
    [
      art({ id: "web", paths: ["dist/site.zip"], os: ["ubuntu-latest"] }),
      art({ id: "win", paths: ["dist/app.msi"], os: ["windows-latest"] }),
    ],
    { cellOs: "ubuntu-latest", tag: "v1.0.0", cwd: dir },
  );
  assert.deepEqual(selected, ["web"]);
  assert.deepEqual(skipped, ["win"]);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith("site.zip"));
});

test("`os: *` vale para qualquer célula — é o que o bloco legado fazia", () => {
  const dir = sandbox({ "a.zip": "x" });
  const { files } = collect([art({ paths: ["a.zip"] })], { cellOs: "macos-latest", tag: "v1.0.0", cwd: dir });
  assert.equal(files.length, 1);
});

test("perfil misto: a célula do Windows publica o artefato do site E o do Windows", () => {
  const dir = sandbox({ "dist/site.zip": "web", "dist/app.msi": "win" });
  const { files } = collect(
    [
      art({ id: "web", paths: ["dist/site.zip"], os: ["*"], required: false }),
      art({ id: "win", paths: ["dist/app.msi"], os: ["*"], required: true }),
    ],
    { cellOs: "windows-latest", tag: "v1.0.0", cwd: dir },
  );
  assert.equal(files.length, 2, "o artefato do site e o instalador convivem");
});

// --- obrigatório contra opcional --------------------------------------------

test("CONTROLE NEGATIVO: artefato obrigatório ausente reprova a célula", () => {
  const dir = sandbox({});
  const res = spawnSync(
    process.execPath,
    [COLLECT],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TAG: "v1.0.0",
        ARTIFACT_CELL_OS: "ubuntu-latest",
        ARTIFACT_OUT: join(dir, "out.txt"),
        ARTIFACT_WORKDIR: dir,
        DIST_ARTIFACTS: JSON.stringify([art({ id: "web", paths: ["dist/site.zip"] })]),
      },
    },
  );
  assert.equal(res.status, 1);
  // A mensagem nomeia o caminho declarado, e não "nada encontrado": com `path`
  // explícito, saber *qual* arquivo faltou é a diferença entre um conserto de um
  // segundo e uma caça ao tesouro.
  assert.match(res.stderr, /::error::Artefato 'web': caminho declarado ausente: dist\/site\.zip/);
});

test("artefato opcional ausente avisa e a célula segue", () => {
  const dir = sandbox({});
  const out = join(dir, "out.txt");
  const res = spawnSync(
    process.execPath,
    [COLLECT],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TAG: "v1.0.0",
        ARTIFACT_CELL_OS: "ubuntu-latest",
        ARTIFACT_OUT: out,
        ARTIFACT_WORKDIR: dir,
        DIST_ARTIFACTS: JSON.stringify([
          art({ id: "web", paths: ["dist/site.zip"], required: false }),
        ]),
      },
    },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /::warning::/);
  assert.equal(readFileSync(out, "utf8"), "", "a lista sai vazia, e o upload não acontece");
});

test("arquivo vazio é erro mesmo quando o artefato é opcional", () => {
  // Ausente é "não produzido agora"; vazio é "produzido quebrado". São estados
  // diferentes, e o Core não deve tratar os dois do mesmo jeito.
  const dir = sandbox({ "dist/site.zip": "" });
  const res = spawnSync(
    process.execPath,
    [COLLECT],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TAG: "v1.0.0",
        ARTIFACT_CELL_OS: "ubuntu-latest",
        ARTIFACT_OUT: join(dir, "out.txt"),
        ARTIFACT_WORKDIR: dir,
        DIST_ARTIFACTS: JSON.stringify([
          art({ id: "web", paths: ["dist/site.zip"], required: false }),
        ]),
      },
    },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /está vazio/);
});

// --- validação, release_name -------------------------------------------------

test("validação roda com o arquivo em $1 e reprova quando falha", (t) => {
  if (skipBash) t.skip(skipBash);
  const dir = sandbox({ "a.zip": "conteudo" });
  const passa = collect(
    [art({ paths: ["a.zip"], validate: ['test -s "$1"'] })],
    { cellOs: "u", tag: "v1.0.0", cwd: dir },
  );
  assert.equal(passa.files.length, 1);
  assert.throws(
    () => collect([art({ paths: ["a.zip"], validate: ["false"] })], { cellOs: "u", tag: "v1.0.0", cwd: dir }),
    /reprovou/,
  );
});

test("validação que sai sem código diferente de zero também é reprovação", (t) => {
  if (skipBash) t.skip(skipBash);
  const dir = sandbox({ "a.zip": "x" });
  assert.throws(
    () =>
      collect(
        [art({ paths: ["a.zip"], validate: ["grep -q isso-nao-existe \"$1\""] })],
        { cellOs: "u", tag: "v1.0.0", cwd: dir },
      ),
    /reprovou/,
  );
});

test("release_name substitui {version} e move o arquivo", () => {
  const dir = sandbox({ "kaes-keid-inspector.zip": "x" });
  const { files } = collect(
    [art({ paths: ["kaes-keid-inspector.zip"], releaseName: "kaes-keide-inspector-v{version}.zip" })],
    { cellOs: "u", tag: "v1.1.0", cwd: dir },
  );
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith("kaes-keide-inspector-v1.1.0.zip"));
  assert.ok(readFileSync(files[0], "utf8") === "x");
});

test("release_name com mais de um arquivo é erro", () => {
  const dir = sandbox({ "a.zip": "x", "b.zip": "y" });
  assert.throws(
    () =>
      collect(
        [art({ globs: ["*.zip"], releaseName: "x-{version}.zip" })],
        { cellOs: "u", tag: "v1.0.0", cwd: dir },
      ),
    /exatamente um arquivo/,
  );
});

// --- a conferência da release ------------------------------------------------

const assets = (...names) => names.map((name) => ({ name, size: 10 }));

test("nome de asset esperado: {version} vira a versão, e só o basename importa", () => {
  assert.equal(expectedAssetName(art({ releaseName: "x-{version}.zip" }), "v1.2.3"), "x-1.2.3.zip");
  assert.equal(
    expectedAssetName(art({ releaseName: "dist/x-{version}.zip" }), "v1.2.3"),
    "x-1.2.3.zip",
    "o asset é o basename; um diretório no release_name seria um asset aninhado, que o GitHub não tem",
  );
  assert.equal(expectedAssetName(art(), "v1.0.0"), null, "sem release_name, o nome não é determinístico");
});

test("a tabela de downloads sai dos assets REAIS, com os rótulos declarados", () => {
  const md = downloadsTable(
    [
      art({ id: "web", releaseName: "site-{version}.zip", label: "Web", platform: "web", kind: "archive" }),
      art({ id: "win", releaseName: "App.msi", label: "Windows", platform: "windows", architecture: "x64" }),
    ],
    assets("site-1.0.0.zip", "App.msi"),
    "v1.0.0",
  );
  assert.match(md, /^## Downloads/);
  assert.match(md, /\| Item \| Plataforma \| Tipo \| Arquivo \|/);
  assert.match(md, /\| Web \| web \| archive \| `site-1\.0\.0\.zip` \|/);
  // A coluna Tipo só entra se algum artefato declara `kind`; o que não declara
  // aparece como "—" em vez de coluna ausente, para a tabela não mudar de
  // forma entre linhas.
  assert.match(md, /\| Windows \| windows · x64 \| — \| `App\.msi` \|/);
});

test("um artefato opcional que não foi publicado não vira linha quebrada", () => {
  const md = downloadsTable(
    [art({ id: "web", releaseName: "site-{version}.zip", label: "Web" })],
    assets(),
    "v1.0.0",
  );
  assert.equal(md, "", "a tabela descreve o que existe");
});

// --- a conferência da release, rodada de verdade ----------------------------

const VERIFY = join(ROOT, "scripts", "verify-artifacts.mjs");

function verify(artifacts, releaseAssets, extra = {}) {
  const envFile = join(mkdtempSync(join(tmpdir(), "ver-")), "env");
  writeFileSync(envFile, "", "utf8");
  const res = spawnSync(process.execPath, [VERIFY], {
    encoding: "utf8",
    env: {
      ...process.env,
      TAG: "v1.0.0",
      REPO: "mafhper/demo",
      RELEASES_JSON: JSON.stringify([{ tag_name: "v1.0.0", draft: true, assets: releaseAssets }]),
      DIST_ARTIFACTS: JSON.stringify(artifacts),
      GITHUB_ENV: envFile,
      ...extra,
    },
  });
  return { ...res, envOut: readFileSync(envFile, "utf8") };
}

test("CONTROLE NEGATIVO: artefato obrigatório ausente reprova a release, com o nome", () => {
  // O defeito que este passo existe para pegar: o build verde, a release
  // publicada, e o artefato que ninguém produziu em lugar nenhum.
  const r = verify(
    [art({ id: "web", releaseName: "site-{version}.zip", required: true })],
    assets("OutroArquivo.zip"),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /::error::/);
  assert.match(r.stderr, /web/);
  assert.match(r.stderr, /site-1\.0\.0\.zip/, "a mensagem diz qual asset era esperado");
});

test("artefato obrigatório presente passa, e a conferência diz o que olhou", () => {
  const r = verify(
    [art({ id: "web", releaseName: "site-{version}.zip", required: true })],
    assets("site-1.0.0.zip", "App.msi"),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Conferência de distribuição: 2 asset\(s\)/);
  assert.match(r.stderr, /0 obrigatório\(s\) ausente\(s\)/);
});

test("obrigatório sem nome determinístico é conferido pela célula, e isso é dito", () => {
  // O nome do instalador do Tauri carrega a versão; quem confere esse é o
  // `matrix[].expect` da célula. A ausência de conferência por nome aqui não
  // pode passar em silêncio.
  const r = verify([art({ id: "win", globs: ["dist/*.msi"], required: true })], assets("App_1.0.0_x64.msi"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /win/);
  assert.match(r.stderr, /min_assets na célula/);
});

test("opcional ausente não reprova a release", () => {
  const r = verify(
    [art({ id: "mac", releaseName: "App-{version}.dmg", required: false })],
    assets(),
  );
  assert.equal(r.status, 0, r.stderr);
});

test("DIST_ARTIFACTS ausente reprova em vez de aprovar uma release vazia", () => {
  const r = spawnSync(process.execPath, [VERIFY], {
    encoding: "utf8",
    env: { ...process.env, TAG: "v1.0.0", REPO: "mafhper/demo", DIST_ARTIFACTS: "" },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DIST_ARTIFACTS não chegou/);
  assert.match(r.stderr, /degradação silenciosa/);
});

test("downloads_table escreve a tabela no GITHUB_ENV, a partir dos assets reais", () => {
  const r = verify(
    [
      art({ id: "web", releaseName: "site-{version}.zip", label: "Web", platform: "web", kind: "archive" }),
      art({ id: "mac", releaseName: "App-{version}.dmg", label: "macOS", required: false }),
    ],
    assets("site-1.0.0.zip"),
    { DIST_DOWNLOADS_TABLE: "true" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.envOut, /DOWNLOADS_TABLE<<DOWNLOADS_TABLE_EOF/);
  assert.match(r.envOut, /## Downloads/);
  assert.match(r.envOut, /site-1\.0\.0\.zip/);
  assert.ok(!r.envOut.includes("App-1.0.0.dmg"), "o que não foi publicado não vira linha");
});

test("downloads_table desligado não escreve nada", () => {
  const r = verify([art({ id: "web", releaseName: "site-{version}.zip" })], assets("site-1.0.0.zip"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.envOut, "");
});

// --- matrix[].expect: o que a célula prometeu -------------------------------

test("CONTROLE NEGATIVO: célula que não gerou o instalador reprova, mesmo com build verde", () => {
  const dir = sandbox({ "src-tauri/target/release/app": "binario" });
  const res = spawnSync(process.execPath, [EXPECT], {
    encoding: "utf8",
    env: { ...process.env, MATRIX_EXPECT: '["**/*.msi", "**/*.exe"]', ARTIFACT_WORKDIR: dir },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /::error::matrix.expect/);
  assert.match(res.stderr, /O build pode ter terminado com sucesso/);
});

test("a célula que gerou o que prometeu passa", () => {
  const dir = sandbox({ "src-tauri/target/release/bundle/msi/App_1.0.0_x64.msi": "x" });
  const res = spawnSync(process.execPath, [EXPECT], {
    encoding: "utf8",
    env: { ...process.env, MATRIX_EXPECT: '["**/*.msi"]', ARTIFACT_WORKDIR: dir },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /entregou tudo o que a matriz prometeu/);
});

test("expect ausente é no-op: a célula não prometeu nada", () => {
  assert.deepEqual(checkExpect([], process.cwd()), []);
});

test("expect com globs que casam é informativo, com a contagem", () => {
  const dir = sandbox({ "a/x.msi": "1", "a/y.msi": "2" });
  const res = spawnSync(process.execPath, [EXPECT], {
    encoding: "utf8",
    env: { ...process.env, MATRIX_EXPECT: '["a/*.msi"]', ARTIFACT_WORKDIR: dir },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /a\/\*\.msi -> 2 arquivo\(s\)/);
});
