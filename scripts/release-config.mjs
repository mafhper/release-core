#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, posix as posixPath, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareVersions, parseTag } from "./prev-tag.mjs";

// Caminhos do config são sempre POSIX (o contrato é o mesmo nos três sistemas),
// então a manipulação de diretório/nome de arquivo da arte não pode depender de
// node:path da plataforma.
const posixDirname = (p) => posixPath.dirname(p.replace(/\\/g, "/"));
const posixBasename = (p) => posixPath.basename(p.replace(/\\/g, "/"));

const VALID_LANGUAGES = new Set(["en", "pt-BR"]);
const VALID_PACKAGE_MANAGERS = new Set(["bun", "npm"]);
const VALID_NOTES_GRANULARITY = new Set(["tag", "minor"]);
const VALID_IMAGE_GRANULARITY = new Set(["tag", "minor"]);
const VALID_IMAGE_REUSE = new Set(["forbid", "allow"]);
const FULL_TAG_RE = /^v\d+\.\d+\.\d+$/;

function fail(message) {
  console.error(`[release-config] ${message}`);
  process.exit(1);
}

function readJson(path) {
  try {
    let text = readFileSync(path, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    fail(`não foi possível ler "${path}": ${error.message}`);
  }
}

let baseDir = process.cwd();

function resolveRoot(path) {
  return resolve(baseDir, path);
}

// Caminhos do contrato ("package.json", lockfiles) são relativos à raiz do
// repositório consumidor, mas o config vive em .github/. Sobe até o diretório
// que contém package.json; se não encontrar (ex.: fixtures mínimas), usa o
// próprio diretório do config.
function findRepoRoot(configDir) {
  let dir = configDir;
  for (;;) {
    try {
      readFileSync(resolve(dir, "package.json"), "utf8");
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return configDir;
      dir = parent;
    }
  }
}

function fileExists(path) {
  try {
    readFileSync(resolveRoot(path), "utf8");
    return true;
  } catch {
    return false;
  }
}

function resolvePackageManagerEvidence(packageManager) {
  if (packageManager === "bun") {
    if (!["bun.lock", "bun.lockb"].some((f) => fileExists(f))) {
      fail(
        'build.package_manager é "bun", mas não existe bun.lock nem bun.lockb no repositório.',
      );
    }
  } else if (!fileExists("package-lock.json")) {
    fail('build.package_manager é "npm", mas não existe package-lock.json no repositório.');
  }
}

function assertPackageManagerField(packageManager) {
  const pkg = readJson(resolveRoot("package.json"));
  if (!pkg.packageManager) return;
  const [declared] = String(pkg.packageManager).split("@");
  if (declared !== packageManager) {
    fail(
      `package.json#packageManager ("${pkg.packageManager}") é incompatível com build.package_manager ("${packageManager}").`,
    );
  }
}

function requireStringArray(value, path, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fail(`${path}.${name} deve ser um array de strings.`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      fail(`${path}.${name} deve conter somente strings.`);
    }
  }
  return value;
}

function arrayify(value, path, name) {
  if (value === undefined || value === null) return [];
  const out = Array.isArray(value) ? value : [value];
  for (const item of out) {
    if (typeof item !== "string" || item.trim() === "") {
      fail(`${path}.${name} deve conter caminhos (strings) não vazios.`);
    }
  }
  return out;
}

/** Slug estável: vira chave de ambiente e aparece em mensagem de log. */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

function optionalString(value, path, name) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") fail(`${path}.${name} deve ser string.`);
  return value;
}

/**
 * Normaliza a distribuição para uma lista de artefatos com escopo.
 *
 * Cada artefato diz: quais células da matriz o produzem (`os`), se é
 * obrigatório (`required`), o que ele é (`kind`), e como se apresenta
 * (`label`, `platform`, `architecture`). O `os` é o que torna o perfil misto
 * possível: sem ele, todo artefato é exigido em toda célula, e um projeto com
 * matriz não consegue declarar nada.
 *
 * `required` significa **exatamente** "este artefato tem de aparecer na
 * release". Ausente e obrigatório reprova; ausente e opcional avisa. A
 * conferência de que os obrigatórios realmente chegaram à release é do
 * `verify-artifacts.mjs`, no `finalize` — porque só lá se vê a release inteira.
 */
function normalizeArtifacts(distribution, legacy, desktopEnabled) {
  const hasNew = distribution.artifacts !== undefined && distribution.artifacts !== null;
  const hasLegacy =
    legacy.enabled !== undefined || legacy.path !== undefined || legacy.globs !== undefined;

  if (hasNew && hasLegacy) {
    fail(
      "distribution.artifacts e o bloco artifact não podem ser declarados juntos. " +
        "O bloco artifact é a forma antiga e já está coberto por distribution.artifacts: " +
        'a migração é { "id": "artifact", "path": <mesmo path>, "globs": <mesmos globs>, ' +
        '"release_name": <mesmo release_name>, "validate": <mesmas validações> }, ' +
        "com required e os os que forem os de verdade.",
    );
  }

  // --- forma nova ---
  if (hasNew) {
    if (!Array.isArray(distribution.artifacts)) {
      fail("distribution.artifacts deve ser um array.");
    }
    const seen = new Set();
    return distribution.artifacts.map((entry, index) => {
      const at = `distribution.artifacts[${index}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        fail(`${at} deve ser um objeto.`);
      }
      const id = entry.id;
      if (typeof id !== "string" || !SLUG_RE.test(id)) {
        fail(
          `${at}.id deve ser um identificador em minúsculas, começando por letra ou número, ` +
            `com ponto, hífen ou underscore (recebido: "${id}"). Ele vira chave de ambiente e aparece nas mensagens do log.`,
        );
      }
      if (seen.has(id)) {
        fail(`${at}.id ("${id}") repete. Duas entradas com o mesmo id não podem ser distinguidas no log nem na conferência da release.`);
      }
      seen.add(id);

      const paths = arrayify(entry.path, at, "path");
      const globs = arrayify(entry.globs, at, "globs");
      if (paths.length === 0 && globs.length === 0) {
        fail(`${at} (id "${id}") precisa de path ou globs: sem os dois, não há o que coletar.`);
      }
      for (const glob of globs) {
        if (!glob.includes("*") && !glob.includes("?")) {
          fail(`${at}.globs deve conter padrões glob ("${glob}" não parece um padrão).`);
        }
      }

      // `"*"` é "qualquer célula". É o default porque é o que o bloco legado
      // fazia, e o que um projeto de job único precisa.
      const os = arrayify(entry.os, at, "os");
      if (os.length === 0) os.push("*");

      const required = entry.required ?? true;
      if (typeof required !== "boolean") {
        fail(`${at}.required deve ser booleano.`);
      }

      return {
        id,
        paths,
        globs,
        os,
        required,
        kind: optionalString(entry.kind, at, "kind"),
        label: optionalString(entry.label, at, "label"),
        platform: optionalString(entry.platform, at, "platform"),
        architecture: optionalString(entry.architecture, at, "architecture"),
        releaseName: optionalString(entry.release_name, at, "release_name"),
        validate: requireStringArray(entry.validate, at, "validate"),
      };
    });
  }

  // --- forma antiga: uma entrada, mesmo comportamento ---
  if (!hasLegacy || legacy.enabled === false) {
    void desktopEnabled;
    return [];
  }
  const paths = arrayify(legacy.path, "artifact", "path");
  const globs = arrayify(legacy.globs, "artifact", "globs");
  if (paths.length === 0 && globs.length === 0) {
    fail(
      "artifact.enabled está ativo, mas artifact.path e artifact.globs estão vazios (nada para publicar).",
    );
  }
  for (const glob of globs) {
    if (!glob.includes("*") && !glob.includes("?")) {
      fail(`artifact.globs deve conter padrões glob ("${glob}" não parece um padrão).`);
    }
  }
  if (paths.length > 1 && optionalString(legacy.release_name, "artifact", "release_name") !== "") {
    fail(
      `artifact.release_name exige exatamente um arquivo, e artifact.path declara ${paths.length}. ` +
        "Em distribution.artifacts, cada artefato com release_name declara o seu próprio path.",
    );
  }
  return [
    {
      id: "artifact",
      paths,
      globs,
      os: ["*"],
      required: true,
      kind: "",
      label: "",
      platform: "",
      architecture: "",
      releaseName: optionalString(legacy.release_name, "artifact", "release_name"),
      validate: requireStringArray(legacy.validate, "artifact", "validate"),
    },
  ];
}

function load(configPath) {
  baseDir = findRepoRoot(dirname(resolve(configPath)));
  const config = readJson(configPath);

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    fail("a raiz do release.config.json deve ser um objeto.");
  }

  const release = config.release ?? fail('falta o bloco "release".');
  if (typeof release.title !== "string" || release.title.trim() === "") {
    fail("release.title é obrigatório (string não vazia).");
  }

  const language = release.language ?? "pt-BR";
  if (!VALID_LANGUAGES.has(language)) {
    fail(`release.language deve ser "en" ou "pt-BR" (recebido: "${language}").`);
  }

  const notes = release.notes ?? {};
  const notesGranularity = notes.granularity ?? "tag";
  if (!VALID_NOTES_GRANULARITY.has(notesGranularity)) {
    fail(
      `release.notes.granularity deve ser "tag" ou "minor" (recebido: "${notesGranularity}").`,
    );
  }

  const image = release.image ?? {};
  const imagePath = image.path ?? "docs/images/releases/release.webp";
  if (typeof imagePath !== "string" || imagePath.trim() === "") {
    fail("release.image.path deve ser um caminho de arquivo (string).");
  }
  const imageRequired = image.required ?? true;
  const imageGranularity = image.granularity ?? "minor";
  if (!VALID_IMAGE_GRANULARITY.has(imageGranularity)) {
    fail(
      `release.image.granularity deve ser "tag" ou "minor" (recebido: "${imageGranularity}").`,
    );
  }

  // A arte pode ser resolvida por versão (docs/archetypes). `path` aceita
  // arquivo (legado) ou diretório: com arquivo, o diretório, o prefixo e a
  // extensão vêm do próprio nome, então consumidores existentes passam a ter
  // resolução por tag sem mudar nada no config.
  const imageLooksLikeFile = /\.[A-Za-z0-9]+$/.test(imagePath);
  let imageDir;
  let imagePrefix;
  let imageExt;
  if (imageLooksLikeFile) {
    imageDir = posixDirname(imagePath);
    const base = posixBasename(imagePath);
    const dot = base.lastIndexOf(".");
    imagePrefix = dot > 0 ? base.slice(0, dot) : base;
    imageExt = dot > 0 ? base.slice(dot).toLowerCase() : "";
  } else {
    imageDir = imagePath.replace(/[/\\]+$/, "");
    imagePrefix = image.prefix ?? "release";
    imageExt = image.ext ?? ".webp";
  }
  if (imageDir.trim() === "") {
    fail("release.image.path não pode ser um caminho vazio.");
  }
  if (typeof imagePrefix !== "string" || imagePrefix.trim() === "") {
    fail('release.image.prefix deve ser um nome de arquivo sem extensão (string não vazia).');
  }
  if (typeof imageExt !== "string" || !/^\.[A-Za-z0-9]+$/.test(imageExt)) {
    fail(`release.image.ext deve ser uma extensão com ponto (ex.: ".webp"); recebido: "${imageExt}".`);
  }
  // Publicar a arte como asset da release é o que permite corrigir a imagem
  // depois da tag: o corpo passa a apontar /releases/download/<tag>/<arquivo>,
  // que pode ser reenviado sem mover a tag.
  const imageUpload = image.upload ?? true;
  if (typeof imageUpload !== "boolean") {
    fail("release.image.upload deve ser booleano.");
  }
  const imageAllowCorrection = image.allow_correction ?? true;
  if (typeof imageAllowCorrection !== "boolean") {
    fail("release.image.allow_correction deve ser booleano.");
  }
  const imageCorrectionSuffix = image.correction_suffix ?? "-new";
  if (typeof imageCorrectionSuffix !== "string" || imageCorrectionSuffix.trim() === "") {
    fail("release.image.correction_suffix deve ser um sufixo (string não vazia).");
  }
  // O H1 do corpo repete o nome que a arte já mostra. Quem desenha a arte com o
  // wordmark dentro (que é o caso do próprio Core) pode desligar o H1; o padrão
  // é ligado porque nem toda arte carrega o nome, e sem H1 um corpo sem imagem
  // fica sem título.
  const imageTitleInBody = image.title_in_body ?? true;
  if (typeof imageTitleInBody !== "boolean") {
    fail("release.image.title_in_body deve ser booleano.");
  }

  // Se a arte pode ser reusada de propósito entre releases. "forbid" (padrão)
  // é o comportamento de sempre: o gate cobra que a arte mude quando a política
  // diz que tem que mudar. "allow" transforma a cobrança em um aviso que declara
  // a decisão - que é o que faltava quando um release foi adiado por falta de
  // um insumo que a máquina não produz.
  const imageReuse = image.reuse ?? "forbid";
  if (!VALID_IMAGE_REUSE.has(imageReuse)) {
    fail(
      `release.image.reuse deve ser "forbid" ou "allow" (recebido: "${imageReuse}").`,
    );
  }

  // Eras de arte: pontos em que a arte muda de propósito, declarados no
  // contrato. Sem esta chave, a arte é resolvida por nome de arquivo
  // (comportamento atual, inalterado). Com ela, a lista é a autoridade e a
  // troca dentro da linha `major.minor` deixa de ser um efeito colateral de
  // reescrever o arquivo no lugar.
  const imageChanges = [];
  if (image.changes !== undefined && image.changes !== null) {
    if (!Array.isArray(image.changes)) {
      fail("release.image.changes deve ser um array de { from, file }.");
    }
    const seenFrom = new Set();
    image.changes.forEach((entry, index) => {
      const at = `release.image.changes[${index}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        fail(`${at} deve ser um objeto { from, file }.`);
      }
      if (typeof entry.from !== "string" || !FULL_TAG_RE.test(entry.from)) {
        fail(
          `${at}.from deve ser uma tag completa vX.Y.Z, porque a era precisa de um ponto de partida inequívoco (recebido: "${entry.from}").`,
        );
      }
      if (typeof entry.file !== "string" || entry.file.trim() === "") {
        fail(`${at}.file deve ser um nome de arquivo não vazio.`);
      }
      // Só nome de arquivo dentro de imageDir: um caminho com barra abriria a
      // porta para declarar arte fora do diretório de releases, que é o
      // contrato que o URL do corpo assume.
      if (/[/\\]/.test(entry.file) || entry.file === ".." || entry.file.startsWith(".")) {
        fail(
          `${at}.file deve ser um nome de arquivo dentro de ${imageDir}, sem barra nem ponto inicial (recebido: "${entry.file}").`,
        );
      }
      if (seenFrom.has(entry.from)) {
        fail(
          `${at}.from ("${entry.from}") repete uma era já declarada. Duas eras no mesmo ponto de partida são ambíguas: o Core não sabe qual delas vale.`,
        );
      }
      seenFrom.add(entry.from);
      imageChanges.push({ from: entry.from, file: entry.file });
    });
    // Ordenado por versão para que a resolução seja uma busca do maior `from`
    // aplicável, e não uma varredura na ordem em que alguém digitou. Aceita
    // qualquer ordem no arquivo: o que importa é que a comparação seja
    // determinística.
    imageChanges.sort((a, b) => compareVersions(parseTag(a.from), parseTag(b.from)));
  }

  const sections = release.sections ?? {};

  const build = config.build ?? {};
  const packageManager = build.package_manager;
  if (packageManager !== undefined && packageManager !== null) {
    if (!VALID_PACKAGE_MANAGERS.has(packageManager)) {
      fail(`build.package_manager deve ser "bun" ou "npm" (recebido: "${packageManager}").`);
    }
    resolvePackageManagerEvidence(packageManager);
    assertPackageManagerField(packageManager);
  }
  const node = build.node ?? "";
  const bun = build.bun ?? "";
  const rust = build.rust ?? "";

  // Diretório onde as dependências do projeto são instaladas e os gates/pre/build
  // rodam. É relativo à raiz do repositório consumidor e, por padrão, é a própria
  // raiz. Existe para separar "onde o projeto é construído" (ex.: raiz de um
  // monorepo) de `desktop.project_path` (o diretório que o tauri-action recebe).
  const workingDirectory = build.working_directory ?? ".";
  if (typeof workingDirectory !== "string" || workingDirectory.trim() === "") {
    fail("build.working_directory deve ser um caminho (string não vazia).");
  }
  if (workingDirectory.startsWith("/") || /^[A-Za-z]:[\\/]/.test(workingDirectory)) {
    fail(
      `build.working_directory deve ser relativo à raiz do repositório (recebido: "${workingDirectory}").`,
    );
  }

  if (bun && packageManager !== "bun") {
    fail('build.bun declarado, mas build.package_manager não é "bun".');
  }
  if (packageManager === "npm" && !node) {
    fail('build.package_manager é "npm", então build.node precisa ter uma versão.');
  }
  if (node && !/^[\dv][\d.A-Za-z-]*$/.test(node)) {
    fail(`build.node com valor inválido: "${node}".`);
  }

  const desktop = config.desktop ?? {};
  const desktopEnabled = desktop.enabled ?? false;
  const desktopProjectPath = desktop.project_path ?? ".";
  if (desktopEnabled) {
    if (!rust) {
      fail('desktop.enabled é true, mas build.rust está vazio (Tauri exige Rust).');
    }
    if ((build.apt ?? []).length === 0) {
      console.error("[release-config] aviso: desktop sem build.apt (dependências de sistema) declaradas.");
    }
  }

  // ---- distribuição -------------------------------------------------------
  //
  // O que o projeto entrega é uma lista de artefatos, e cada um declara a que
  // célula da matriz o produz, se é obrigatório, e o que ele é. O bloco
  // `artifact` legado (0..N arquivos, uma validação, um nome de release) é
  // normalizado para **uma** entrada dessa lista, com o mesmo comportamento.
  //
  // `desktop.enabled` NÃO é mais exclusivo com artefato nem com `build.command`:
  // um projeto com site público e instaladores é um perfil real, e ele é a
  // razão de o contrato ter esta seção.
  const distribution = config.distribution ?? {};
  const artifacts = normalizeArtifacts(distribution, config.artifact ?? {}, desktopEnabled);
  const downloadsTable = distribution.downloads_table ?? false;
  if (typeof downloadsTable !== "boolean") {
    fail("distribution.downloads_table deve ser booleano.");
  }

  const versions = config.versions ?? {};
  const versionFiles = [];
  if (versions.files !== undefined && versions.files !== null) {
    for (const file of versions.files) {
      if (typeof file !== "object" || file === null) {
        fail("cada item de versions.files deve ser { path, format, field }.");
      }
      if (typeof file.path !== "string" || file.path === "") {
        fail("versions.files[].path deve ser um caminho não vazio.");
      }
      if (!["json", "toml"].includes(file.format)) {
        fail(`versions.files[].format deve ser "json" ou "toml" (recebido: "${file.format}").`);
      }
      if (typeof file.field !== "string" || file.field === "") {
        fail("versions.files[].field deve ser um campo não vazio (ex.: package.version).");
      }
      versionFiles.push(file);
    }
  }

  return {
    release: {
      title: release.title,
      tagline: release.tagline ?? "",
      language,
      notesGranularity,
      imagePath,
      imageRequired,
      imageGranularity,
      imageDir,
      imagePrefix,
      imageExt,
      imageUpload,
      imageAllowCorrection,
      imageCorrectionSuffix,
      imageTitleInBody,
      imageReuse,
      imageChanges,
      usage: sections.usage ?? "",
      extra: sections.extra ?? "",
    },
    build: {
      packageManager: packageManager ?? "",
      node,
      bun,
      rust,
      workingDirectory,
      apt: requireStringArray(build.apt, "build", "apt"),
      gates: requireStringArray(build.gates, "build", "gates"),
      pre: requireStringArray(build.pre, "build", "pre"),
      command: typeof build.command === "string" ? build.command : "",
    },
    desktop: { enabled: desktopEnabled, projectPath: desktopProjectPath },
    distribution: { artifacts, downloadsTable },
    versions: { files: versionFiles },
  };
}

function flatValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

function getKey(cfg, key) {
  const map = {
    title: cfg.release.title,
    tagline: cfg.release.tagline,
    language: cfg.release.language,
    notes_granularity: cfg.release.notesGranularity,
    image_path: cfg.release.imagePath,
    image_required: cfg.release.imageRequired,
    image_granularity: cfg.release.imageGranularity,
    image_dir: cfg.release.imageDir,
    image_prefix: cfg.release.imagePrefix,
    image_ext: cfg.release.imageExt,
    image_upload: cfg.release.imageUpload,
    image_allow_correction: cfg.release.imageAllowCorrection,
    image_correction_suffix: cfg.release.imageCorrectionSuffix,
    image_title_in_body: cfg.release.imageTitleInBody,
    image_reuse: cfg.release.imageReuse,
    image_changes: cfg.release.imageChanges,
    section_usage: cfg.release.usage,
    section_extra: cfg.release.extra,
    package_manager: cfg.build.packageManager,
    node: cfg.build.node,
    bun: cfg.build.bun,
    rust: cfg.build.rust,
    working_directory: cfg.build.workingDirectory,
    apt: cfg.build.apt,
    gates: cfg.build.gates,
    pre: cfg.build.pre,
    command: cfg.build.command,
    desktop: cfg.desktop.enabled,
    desktop_project_path: cfg.desktop.projectPath,
    // `artifact_enabled` e `artifact_paths` continuam existindo porque são o
    // que o `--get` legado devolvia. Agora saem da lista de distribuição.
    artifact_enabled: String(cfg.distribution.artifacts.length > 0),
    artifact_paths: cfg.distribution.artifacts.flatMap((a) => a.paths),
    artifact_globs: cfg.distribution.artifacts.flatMap((a) => a.globs),
    artifact_validate: cfg.distribution.artifacts.flatMap((a) => a.validate),
    artifact_release_name: cfg.distribution.artifacts.find((a) => a.releaseName)?.releaseName ?? "",
    distribution_artifacts: cfg.distribution.artifacts,
    downloads_table: cfg.distribution.downloadsTable,
    version_files: cfg.versions.files,
  };
  if (!(key in map)) {
    fail(`chave desconhecida em --get: "${key}".`);
  }
  return flatValue(map[key]);
}

function emitEnvLine(lines, key, value) {
  lines.push(`${key}=${value}`);
}

function emitEnvMultiline(lines, key, value) {
  const marker = `${key}_EOF`;
  lines.push(`${key}<<${marker}`);
  lines.push(value);
  lines.push(marker);
}

function printEnv(cfg) {
  const lines = [];
  emitEnvLine(lines, "RELEASE_TITLE", cfg.release.title);
  emitEnvLine(lines, "RELEASE_LANGUAGE", cfg.release.language);
  emitEnvLine(lines, "NOTES_GRANULARITY", cfg.release.notesGranularity);
  emitEnvLine(lines, "IMAGE_PATH", cfg.release.imagePath);
  emitEnvLine(lines, "IMAGE_REQUIRED", String(cfg.release.imageRequired));
  emitEnvLine(lines, "IMAGE_GRANULARITY", cfg.release.imageGranularity);
  emitEnvLine(lines, "IMAGE_DIR", cfg.release.imageDir);
  emitEnvLine(lines, "IMAGE_PREFIX", cfg.release.imagePrefix);
  emitEnvLine(lines, "IMAGE_EXT", cfg.release.imageExt);
  emitEnvLine(lines, "IMAGE_UPLOAD", String(cfg.release.imageUpload));
  emitEnvLine(lines, "IMAGE_ALLOW_CORRECTION", String(cfg.release.imageAllowCorrection));
  emitEnvLine(lines, "IMAGE_CORRECTION_SUFFIX", cfg.release.imageCorrectionSuffix);
  emitEnvLine(lines, "IMAGE_TITLE_IN_BODY", String(cfg.release.imageTitleInBody));
  emitEnvLine(lines, "IMAGE_REUSE", cfg.release.imageReuse);
  emitEnvLine(lines, "IMAGE_CHANGES", JSON.stringify(cfg.release.imageChanges));
  emitEnvLine(lines, "PKG_MANAGER", cfg.build.packageManager);
  emitEnvLine(lines, "NODE_VERSION", cfg.build.node);
  emitEnvLine(lines, "BUN_VERSION", cfg.build.bun);
  emitEnvLine(lines, "RUST_TOOLCHAIN", cfg.build.rust);
  emitEnvLine(lines, "PROJECT_WORKDIR", cfg.build.workingDirectory);
  emitEnvLine(lines, "APT_DEPS", JSON.stringify(cfg.build.apt));
  emitEnvLine(lines, "GATES", JSON.stringify(cfg.build.gates));
  emitEnvLine(lines, "PRE_STEPS", JSON.stringify(cfg.build.pre));
  emitEnvLine(lines, "BUILD_COMMAND", cfg.build.command);
  emitEnvLine(lines, "DESKTOP", String(cfg.desktop.enabled));
  emitEnvLine(lines, "DESKTOP_PROJECT_PATH", cfg.desktop.projectPath);
  // A lista inteira vai num env só: o coletor é um script node, e serializar em
  // N variáveis seria uma translation layer sem ganho.
  emitEnvLine(lines, "DIST_ARTIFACTS", JSON.stringify(cfg.distribution.artifacts));
  emitEnvLine(
    lines,
    "DIST_HAS_ARTIFACTS",
    String(cfg.distribution.artifacts.length > 0),
  );
  emitEnvLine(lines, "DIST_DOWNLOADS_TABLE", String(cfg.distribution.downloadsTable));
  emitEnvLine(
    lines,
    "ARTIFACT_ENABLED",
    String(cfg.distribution.artifacts.length > 0),
  );
  emitEnvLine(
    lines,
    "ARTIFACT_PATHS",
    JSON.stringify(cfg.distribution.artifacts.flatMap((a) => a.paths)),
  );
  emitEnvLine(
    lines,
    "ARTIFACT_GLOBS",
    JSON.stringify(cfg.distribution.artifacts.flatMap((a) => a.globs)),
  );
  emitEnvLine(
    lines,
    "ARTIFACT_VALIDATE",
    JSON.stringify(cfg.distribution.artifacts.flatMap((a) => a.validate)),
  );
  emitEnvLine(
    lines,
    "ARTIFACT_RELEASE_NAME",
    cfg.distribution.artifacts.find((a) => a.releaseName)?.releaseName ?? "",
  );
  emitEnvLine(lines, "VERSIONS_FILES", JSON.stringify(cfg.versions.files));
  if (cfg.release.tagline) emitEnvMultiline(lines, "RELEASE_TAGLINE", cfg.release.tagline);
  if (cfg.release.usage) emitEnvMultiline(lines, "SECTION_USAGE", cfg.release.usage);
  if (cfg.release.extra) emitEnvMultiline(lines, "SECTION_EXTRA", cfg.release.extra);
  process.stdout.write(`${lines.join("\n")}\n`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [, , configPath, mode, key] = process.argv;

  if (!configPath) {
    console.error("Uso: release-config.mjs <arquivo> [--env | --get <chave>]");
    process.exit(1);
  }

  const cfg = load(configPath);

  if (mode === "--get") {
    if (!key) {
      console.error("--get exige uma chave.");
      process.exit(1);
    }
    process.stdout.write(`${getKey(cfg, key)}\n`);
  } else if (mode === "--env") {
    printEnv(cfg);
  } else {
    process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
  }
}

export { load };
