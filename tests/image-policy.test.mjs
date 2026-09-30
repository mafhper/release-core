// Política editorial da arte, com um repositório git de verdade.
//
// Por que git de verdade e não uma simulação: o gate compara o conteúdo da arte
// entre duas tags, e a única leitura honesta disso é o object database. Um teste
// que fabricasse os digests passaria mesmo com a comparação errada - foi
// exatamente o que aconteceu com a primeira versão do `step-boundary.test.mjs`,
// que rodava com o CWD errado e passava pelo motivo errado (RC-N11).
//
// Cada caso de falha tem o seu oposto que passa, e a simetria é o controle
// negativo: se a regra for removida, o caso que deve falhar passa e o teste
// acusa. Um gate sem controle negativo é um gate que ninguém sabe se falha.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOLVE = join(ROOT, "scripts", "resolve-image.mjs");
const POLICY = join(ROOT, "scripts", "image-policy.mjs");

const ART_DIR = "docs/images/releases";

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/**
 * Repositório com duas tags e a arte de cada uma.
 *
 * @param {object} plan
 *   tags: [{ tag, art: { file: "conteúdo" } | null }]  null = sem arte
 *   config: o release.config.json (string)
 */
function makeRepo(plan) {
  const dir = mkdtempSync(join(tmpdir(), "imgpol-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "teste@exemplo.invalid"]);
  git(dir, ["config", "user.name", "Teste"]);
  git(dir, ["config", "commit.gpgsign", "false"]);

  mkdirSync(join(dir, ".github"), { recursive: true });
  mkdirSync(join(dir, ART_DIR), { recursive: true });

  for (const { tag, art, config } of plan.tags) {
    writeFileSync(join(dir, ".github/release.config.json"), config ?? plan.config, "utf8");
    for (const [name, content] of Object.entries(art ?? {})) {
      writeFileSync(join(dir, ART_DIR, name), content, "utf8");
    }
    git(dir, ["add", "-A"]);
    // --allow-empty: um patch dentro da linha commita a mesma arte, e um commit
    // vazio é a situação normal - não um erro de teste.
    git(dir, ["commit", "-q", "--allow-empty", "-m", `release ${tag}`]);
    git(dir, ["tag", tag]);
  }
  return dir;
}

/** Roda o resolver e a política como o workflow faz, e devolve o resultado. */
function runPipeline(dir, { tag, prevTag, extraEnv = {} }) {
  const configFile = join(dir, ".github/release.config.json");
  const resolved = spawnSync(
    process.execPath,
    [RESOLVE, configFile, tag, "--root", dir],
    { encoding: "utf8" },
  );

  // O image-step.sh repassa cada linha KEY=VALUE do resolver para o ambiente.
  const env = {};
  for (const line of resolved.stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }

  const cfgEnv = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/release-config.mjs"), configFile, "--env"],
    { encoding: "utf8" },
  );
  for (const line of cfgEnv.stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && line.slice(at + 1) !== "") env[line.slice(0, at)] = line.slice(at + 1);
  }

  const policy = spawnSync(process.execPath, [POLICY], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      TAG: tag,
      PREV_TAG: prevTag ?? "",
      CONFIG_FILE: configFile,
      PROJECT_ROOT: dir,
      ...extraEnv,
    },
  });
  return {
    status: policy.status,
    stderr: policy.stderr,
    stdout: policy.stdout,
    resolvedEnv: env,
  };
}

const configOf = (image) =>
  JSON.stringify({
    release: {
      title: "Demo",
      image: { path: ART_DIR, required: true, granularity: "minor", ...image },
    },
  });

// ---------------------------------------------------------------------------

test("nova linha com bytes novos: troca aceita, sem aviso", () => {
  const dir = makeRepo({
    config: configOf({}),
    tags: [
      { tag: "v1.2.0", art: { "release-v1.2.webp": "arte da linha 1.2" } },
      { tag: "v1.3.0", art: { "release-v1.3.webp": "arte da linha 1.3" } },
    ],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.3.0", prevTag: "v1.2.0" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Arte de v1\.3\.0 trocada/);
    assert.doesNotMatch(r.stderr, /::warning::/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CONTROLE NEGATIVO: linha nova com os MESMOS bytes é apontada (o `cp` do aurawall)", () => {
  // Antes o gate comparava o nome do arquivo e um `cp` passava. O registro do
  // aurawall diz que a v1.1.0 abriu linha com os bytes da v1.0.0 e o Core
  // aceitou. Aqui ele tem de falar.
  const dir = makeRepo({
    config: configOf({}),
    tags: [
      { tag: "v1.2.0", art: { "release-v1.2.webp": "a mesma arte" } },
      { tag: "v1.3.0", art: { "release-v1.3.webp": "a mesma arte" } },
    ],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.3.0", prevTag: "v1.2.0" });
    assert.equal(r.status, 0, "conteúdo igual é aviso na v1.3, não erro");
    assert.match(r.stderr, /::warning::A arte de v1\.3\.0 NÃO mudou/);
    assert.match(r.stderr, /sha256:[0-9a-f]{8}/, "o aviso precisa trazer o digest, para ser verificável");
    assert.match(r.stderr, /image\.reuse: "allow"/, "o aviso precisa dizer a saída declarada");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mesma linha, bytes iguais: a política não exige troca e nada é dito", () => {
  const dir = makeRepo({
    config: configOf({}),
    tags: [
      { tag: "v1.2.0", art: { "release-v1.2.webp": "arte" } },
      { tag: "v1.2.1", art: { "release-v1.2.webp": "arte" } },
    ],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.2.1", prevTag: "v1.2.0" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /::warning::/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("correção vinda do branch padrão satisfaz a troca (o incidente do mark-lee)", () => {
  // MKL-N7: "o workflow morre no prepare em 13s e não cria release nem draft",
  // porque o gate media caminho de arquivo e a arte vinha do branch com -new.
  const dir = makeRepo({
    config: configOf({}),
    tags: [
      { tag: "v1.2.0", art: { "release-v1.2.webp": "arte antiga" } },
      { tag: "v1.3.0", art: { "release-v1.3.webp": "arte placeholder" } },
    ],
  });
  const correctionDir = mkdtempSync(join(tmpdir(), "imgcorr-"));
  mkdirSync(join(correctionDir, ART_DIR), { recursive: true });
  writeFileSync(join(correctionDir, ART_DIR, "release-v1.3.0-new.webp"), "arte corrigida", "utf8");
  try {
    const configFile = join(dir, ".github/release.config.json");
    const resolved = spawnSync(
      process.execPath,
      [RESOLVE, configFile, "v1.3.0", "--root", dir, "--correction-dir", correctionDir],
      { encoding: "utf8" },
    );
    const env = {};
    for (const line of resolved.stdout.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
    }
    assert.equal(env.IMAGE_SOURCE, "branch", "pré-condição: a arte veio do branch");

    const cfgEnv = spawnSync(
      process.execPath,
      [join(ROOT, "scripts/release-config.mjs"), configFile, "--env"],
      { encoding: "utf8" },
    );
    for (const line of cfgEnv.stdout.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0 && line.slice(at + 1) !== "") env[line.slice(0, at)] = line.slice(at + 1);
    }

    const r = spawnSync(process.execPath, [POLICY], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        TAG: "v1.3.0",
        PREV_TAG: "v1.2.0",
        CONFIG_FILE: configFile,
        PROJECT_ROOT: dir,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /troca declarada/);
    assert.doesNotMatch(r.stderr, /::warning::/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(correctionDir, { recursive: true, force: true });
  }
});

test("era declarada dentro da linha: a troca é exigida e conferida por conteúdo", () => {
  const config = configOf({
    changes: [
      { from: "v1.0.0", file: "release-v1.0.webp" },
      { from: "v1.2.3", file: "release-v1.2.3.webp" },
    ],
  });
  const dir = makeRepo({
    config,
    tags: [
      { tag: "v1.2.2", art: { "release-v1.0.webp": "arte antiga" } },
      { tag: "v1.2.3", art: { "release-v1.0.webp": "arte antiga", "release-v1.2.3.webp": "arte nova" } },
    ],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.2.3", prevTag: "v1.2.2" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /uma era de arte foi declarada em v1\.2\.3/);
    assert.match(r.stderr, /Arte de v1\.2\.3 trocada/);
    assert.doesNotMatch(r.stderr, /::warning::/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CONTROLE NEGATIVO: era declarada na linha, mas com os bytes da arte anterior", () => {
  const config = configOf({
    changes: [
      { from: "v1.0.0", file: "release-v1.0.webp" },
      { from: "v1.2.3", file: "release-v1.2.3.webp" },
    ],
  });
  const dir = makeRepo({
    config,
    tags: [
      { tag: "v1.2.2", art: { "release-v1.0.webp": "a mesma arte" } },
      { tag: "v1.2.3", art: { "release-v1.0.webp": "a mesma arte", "release-v1.2.3.webp": "a mesma arte" } },
    ],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.2.3", prevTag: "v1.2.2" });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /::warning::A arte de v1\.2\.3 NÃO mudou/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reuso declarado: `image.reuse: allow` transforma a cobrança em decisão visível", () => {
  const dir = makeRepo({
    config: configOf({ reuse: "allow" }),
    tags: [
      { tag: "v1.2.0", art: { "release-v1.2.webp": "a mesma arte" } },
      { tag: "v1.3.0", art: { "release-v1.3.webp": "a mesma arte" } },
    ],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.3.0", prevTag: "v1.2.0" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Reuso declarado por image\.reuse: "allow"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CONTROLE NEGATIVO: era declarada e ausente reprova nomeando o arquivo", () => {
  const config = configOf({ changes: [{ from: "v1.2.3", file: "release-v1.2.3.webp" }] });
  const dir = makeRepo({
    config,
    tags: [
      { tag: "v1.2.2", art: { "release-v1.0.webp": "arte" } },
      // A tag declara a era, mas o arquivo não foi adicionado.
      { tag: "v1.2.3", art: { "release-v1.0.webp": "arte" } },
    ],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.2.3", prevTag: "v1.2.2" });
    assert.equal(r.status, 1, "era declarada e ausente é erro de contrato");
    assert.match(r.stderr, /release-v1\.2\.3\.webp/);
    assert.match(r.stderr, /::error::/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arquivo por tag não declarado gera aviso com a receita (a armadilha do RC-N14)", () => {
  const config = configOf({ changes: [{ from: "v1.0.0", file: "release-v1.0.webp" }] });
  const dir = makeRepo({
    config,
    tags: [
      { tag: "v1.2.2", art: { "release-v1.0.webp": "arte antiga" } },
      // A intençãoTrap: "vale da v1.2.3 em diante", escrita só com o arquivo.
      { tag: "v1.2.3", art: { "release-v1.0.webp": "arte antiga", "release-v1.2.3.webp": "arte nova" } },
    ],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.2.3", prevTag: "v1.2.2" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /release-v1\.2\.3\.webp existe na tag, mas nenhuma era/);
    assert.match(r.stderr, /"from": "v1\.2\.3"/, "o aviso entrega a linha de config que faltou");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arte ausente com `required` desligado: a release sai sem imagem e sem drama", () => {
  const dir = makeRepo({
    config: configOf({ required: false }),
    tags: [{ tag: "v1.0.0", art: {} }],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.0.0", prevTag: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /image\.required está desligado/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arte ausente com `required` ligado: reprova (comportamento preservado)", () => {
  const dir = makeRepo({ config: configOf({}), tags: [{ tag: "v1.0.0", art: {} }] });
  try {
    const r = runPipeline(dir, { tag: "v1.0.0", prevTag: "" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Nenhuma arte de release encontrada/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("primeira release com `minor`: não há linha anterior, então nada é exigido", () => {
  const dir = makeRepo({
    config: configOf({}),
    tags: [{ tag: "v1.0.0", art: { "release.webp": "primeira arte" } }],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.0.0", prevTag: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /não exige troca nesta tag/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("primeira release com `tag`: a troca é exigida, e a ausência de comparação é dita", () => {
  const dir = makeRepo({
    config: configOf({ granularity: "tag" }),
    tags: [{ tag: "v1.0.0", art: { "release-v1.0.0.webp": "primeira arte" } }],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.0.0", prevTag: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Primeira release/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("o digest vem do object database, não da working tree", () => {
  // Se o gate lesse o arquivo em disco, uma cópia com CRLF no Windows daria um
  // digest diferente do blob e acusaria troca onde não houve - a classe do
  // RC-N23. Aqui a prova é direta: o conteúdo no commit é o mesmo, e o gate
  // tem de dizer que são os mesmos bytes.
  const dir = makeRepo({
    config: configOf({ reuse: "forbid" }),
    tags: [
      { tag: "v1.2.0", art: { "release-v1.2.webp": "linha1\nlinha2\n" } },
      { tag: "v1.3.0", art: { "release-v1.3.webp": "linha1\nlinha2\n" } },
    ],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.3.0", prevTag: "v1.2.0" });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /NÃO mudou/);
    const blobA = git(dir, ["cat-file", "blob", "v1.2.0:" + `${ART_DIR}/release-v1.2.webp`]);
    const blobB = git(dir, ["cat-file", "blob", "v1.3.0:" + `${ART_DIR}/release-v1.3.webp`]);
    assert.equal(blobA, blobB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contrato alterado entre as tags: o hindsight é avisado", () => {
  const dir = makeRepo({
    tags: [
      { tag: "v1.2.0", art: { "release-v1.2.webp": "arte" }, config: configOf({}) },
      {
        tag: "v1.3.0",
        art: { "release-v1.3.webp": "arte 2" },
        config: configOf({ reuse: "allow" }),
      },
    ],
  });
  try {
    const r = runPipeline(dir, { tag: "v1.3.0", prevTag: "v1.2.0" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /o contrato mudou entre v1\.2\.0 e v1\.3\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
