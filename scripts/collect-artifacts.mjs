#!/usr/bin/env node
// Coleta os artefatos que ESTA célula da matriz produz.
//
// Por que um script e não o bloco de shell que ele substitui em `release.yml`:
// a lógica cresceu além do que cabe (e do que tem teste) em YAML inline. A regra
// do projeto já diz que `IMAGE_URL` no mesmo step do corpo é um problema de
// fronteira; a mesma atenção vale para o gate de artefato.
//
// O que a célula faz aqui:
//   1. escolhe os artefatos cujo `os` inclui esta célula (ou `*`);
//   2. expande globs e confere os caminhos explícitos;
//   3. reprova arquivo vazio;
//   4. roda as validações declaradas;
//   5. aplica `release_name`, que exige exatamente um arquivo;
//   6. escreve a lista final em ARTIFACT_OUT, um caminho por linha.
//
// `required: false` é a diferença que torna o perfil misto possível: o artefato
// opcional que não apareceu avisa e a célula segue. O `required: true` que não
// apareceu reprova a célula — e o `verify-artifacts.mjs`, no `finalize`, fecha
// o outro lado: que algum artefato obrigatório realmente chegou à release.
//
// Uso (o workflow já tem DIST_ARTIFACTS no ambiente):
//   ARTIFACT_CELL_OS=ubuntu-latest ARTIFACT_OUT=... node collect-artifacts.mjs
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, existsSync, renameSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const warn = (m) => process.stderr.write(`::warning::${m}\n`);
const note = (m) => process.stderr.write(`${m}\n`);

/**
 * Erro de coleta. É uma exceção, e não `process.exit`: a função é testável em
 * processo e quem decide como sair é o CLI. Um `process.exit` no meio da lógica
 * derrubaria o runner de teste inteiro — que foi o que aconteceu na primeira
 * versão deste arquivo.
 */
export class CollectError extends Error {}

/** `validate` roda como hoje: bash -eu -c, com o arquivo em $1. */
export function runValidators(validate, file, cwd) {
  for (const cmd of validate) {
    note(`» validando ${file}: ${cmd}`);
    const res = spawnSync("bash", ["-eu", "-c", cmd, "_", file], { cwd, encoding: "utf8" });
    if (res.stdout) process.stderr.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.status !== 0) {
      if (res.error?.code === "ENOENT") {
        throw new CollectError(
          `bash não encontrado ao rodar a validação "${cmd}". ` +
            "As validações de artefato rodam em bash por contrato (é o que o `artifact.validate` sempre usou); " +
            "o runner precisa ter bash no PATH.",
        );
      }
      const how = res.status === null ? `sinal/erro: ${res.error?.message ?? "desconhecido"}` : `código ${res.status}`;
      throw new CollectError(`validação de artefato reprovou (${how}): ${cmd} — ${file}`);
    }
  }
}

/**
 * Glob → RegExp, com a semântica de pathname expansion: `*` e `?` não cruzam
 * `/`, e `**` cruza. Deliberadamente próprio em vez de `fs.globSync`: a API é
 * experimental numa versão mínima do Node que este protocolo precisa suportar, e
 * um portado de release compartilhado por sete consumidores não deve depender do
 * comportamento de uma API experimental.
 */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Arquivos sob `root` cujo caminho relativo casa com algum dos globs. */
export function expandGlobs(globs, root) {
  const regexes = globs.map(globToRegExp);
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(root, full).split(sep).join("/");
      if (regexes.some((re) => re.test(rel))) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

function versionOf(tag) {
  return String(tag || "").replace(/^v/, "").split(/[-+]/)[0];
}

/**
 * Seleciona, confere e prepara os artefatos de uma célula.
 * Devolve os caminhos finais, na ordem de declaração.
 */
export function collect(artifacts, { cellOs, tag, cwd }) {
  const version = versionOf(tag);
  const selected = [];
  const skipped = [];

  for (const artifact of artifacts) {
    const mine = artifact.os.includes("*") || artifact.os.includes(cellOs);
    if (!mine) {
      skipped.push(artifact.id);
      continue;
    }
    selected.push(artifact);
  }
  for (const id of skipped) {
    note(`Artefato '${id}': não é desta célula (${cellOs}); não coletado aqui.`);
  }

  const finalFiles = [];
  for (const artifact of selected) {
    const files = expandGlobs(artifact.globs, cwd);
    for (const p of artifact.paths) {
      const full = resolve(cwd, p);
      if (!existsSync(full)) {
        const msg = `Artefato '${artifact.id}': caminho declarado ausente: ${p}`;
        if (artifact.required) throw new CollectError(msg);
        warn(`${msg} — declarado opcional, seguindo sem ele.`);
        continue;
      }
      if (!files.includes(full)) files.push(full);
    }

    if (files.length === 0) {
      const msg = `Artefato '${artifact.id}': nada encontrado (path/globs: ${[...artifact.paths, ...artifact.globs].join(", ") || "—"})`;
      if (artifact.required) throw new CollectError(msg);
      warn(`${msg} — declarado opcional, seguindo sem ele.`);
      continue;
    }

    for (const f of files) {
      if (!statSync(f).size) throw new CollectError(`Artefato '${artifact.id}' está vazio: ${f}`);
    }
    for (const f of files) runValidators(artifact.validate, f, cwd);

    if (artifact.releaseName) {
      if (files.length !== 1) {
        throw new CollectError(
          `Artefato '${artifact.id}': release_name exige exatamente um arquivo, e foram encontrados ${files.length}.`,
        );
      }
      const target = resolve(cwd, artifact.releaseName.replace(/\{version\}/g, version));
      mkdirSync(resolve(target, ".."), { recursive: true });
      renameSync(files[0], target);
      note(`Artefato '${artifact.id}' renomeado para ${artifact.releaseName.replace(/\{version\}/g, version)}`);
      finalFiles.push(target);
      continue;
    }
    finalFiles.push(...files);
  }

  return { files: finalFiles, selected: selected.map((a) => a.id), skipped };
}

/**
 * Ponto de entrada do CLI: converte a exceção em `::error::` e sai com 1.
 * A separação existe para que `collect()` possa ser testada em processo — um
 * `process.exit` dentro dela derrubaria o runner inteiro, não só o teste.
 */
export function runCollect(env = process.env) {
  const cwd = env.ARTIFACT_WORKDIR || process.cwd();
  const cellOs = env.ARTIFACT_CELL_OS || "";
  const out = env.ARTIFACT_OUT || "";
  try {
    if (!cellOs) {
      throw new CollectError(
        "ARTIFACT_CELL_OS é obrigatório: sem saber a célula, não dá para escolher o que ela produz.",
      );
    }
    if (!out) throw new CollectError("ARTIFACT_OUT é obrigatório (caminho do arquivo de saída).");

    let artifacts;
    if (!(env.DIST_ARTIFACTS || "").trim()) {
      throw new CollectError(
        "DIST_ARTIFACTS não chegou ao ambiente. Sem a lista de artefatos, esta célula publicaria zero arquivos " +
          "e o build ficaria verde — degradação silenciosa, que é a classe de defeito que o Core existe para evitar. " +
          "O guard `DIST_HAS_ARTIFACTS` decide se este passo roda; se ele rodou sem a lista, algo quebrou antes.",
      );
    }
    try {
      artifacts = JSON.parse(env.DIST_ARTIFACTS);
    } catch (error) {
      throw new CollectError(`DIST_ARTIFACTS não é JSON válido: ${error.message}`);
    }

    const { files, selected, skipped } = collect(artifacts, { cellOs, tag: env.TAG, cwd });
    writeFileSync(out, files.length ? `${files.join("\n")}\n` : "", "utf8");

    if (files.length === 0) {
      note(`Célula ${cellOs}: nenhum artefato publicado (${selected.length} declarado(s) para esta célula).`);
    } else {
      note(
        `Célula ${cellOs}: ${files.length} artefato(s) para publicar — ${files.map((f) => relative(cwd, f)).join(", ")}`,
      );
    }
    return { files, selected, skipped };
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runCollect();
