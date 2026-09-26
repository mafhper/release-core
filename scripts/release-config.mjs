#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, posix as posixPath, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Caminhos do config são sempre POSIX (o contrato é o mesmo nos três sistemas),
// então a manipulação de diretório/nome de arquivo da arte não pode depender de
// node:path da plataforma.
const posixDirname = (p) => posixPath.dirname(p.replace(/\\/g, "/"));
const posixBasename = (p) => posixPath.basename(p.replace(/\\/g, "/"));

const VALID_LANGUAGES = new Set(["en", "pt-BR"]);
const VALID_PACKAGE_MANAGERS = new Set(["bun", "npm"]);
const VALID_NOTES_GRANULARITY = new Set(["tag", "minor"]);
const VALID_IMAGE_GRANULARITY = new Set(["tag", "minor"]);

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
    if (build.command) {
      fail('desktop.enabled é true e não permite build.command (use tauri-action).');
    }
    if ((build.apt ?? []).length === 0) {
      console.error("[release-config] aviso: desktop sem build.apt (dependências de sistema) declaradas.");
    }
  }

  const artifact = config.artifact ?? {};
  const artifactEnabled = artifact.enabled ?? false;
  const artifactPaths = arrayify(artifact.path, "artifact", "path");
  const artifactGlobs = arrayify(artifact.globs, "artifact", "globs");
  const artifactValidate = requireStringArray(artifact.validate, "artifact", "validate");
  const artifactReleaseName =
    typeof artifact.release_name === "string" && artifact.release_name.trim() !== ""
      ? artifact.release_name
      : null;

  if (desktopEnabled && artifactEnabled) {
    fail("artifact.enabled não pode ser true com desktop.enabled (tauri-action publica).");
  }
  if (artifactEnabled) {
    if (artifactPaths.length === 0 && artifactGlobs.length === 0) {
      fail(
        "artifact.enabled está ativo, mas artifact.path e artifact.globs estão vazios (nada para publicar).",
      );
    }
    for (const glob of artifactGlobs) {
      if (!glob.includes("*") && !glob.includes("?")) {
        fail(`artifact.globs deve conter padrões glob ("${glob}" não parece um padrão).`);
      }
    }
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
    artifact: {
      enabled: artifactEnabled,
      paths: artifactPaths,
      globs: artifactGlobs,
      validate: artifactValidate,
      releaseName: artifactReleaseName,
    },
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
    artifact_enabled: cfg.artifact.enabled,
    artifact_paths: cfg.artifact.paths,
    artifact_globs: cfg.artifact.globs,
    artifact_validate: cfg.artifact.validate,
    artifact_release_name: cfg.artifact.releaseName ?? "",
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
  emitEnvLine(lines, "ARTIFACT_ENABLED", String(cfg.artifact.enabled));
  emitEnvLine(lines, "ARTIFACT_PATHS", JSON.stringify(cfg.artifact.paths));
  emitEnvLine(lines, "ARTIFACT_GLOBS", JSON.stringify(cfg.artifact.globs));
  emitEnvLine(lines, "ARTIFACT_VALIDATE", JSON.stringify(cfg.artifact.validate));
  emitEnvLine(lines, "ARTIFACT_RELEASE_NAME", cfg.artifact.releaseName ?? "");
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
