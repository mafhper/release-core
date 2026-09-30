// O workflow é código, e uma linha sem indentação dentro de um `run: |` é um
// defeito silencioso: o YAML para de fazer sentido naquele ponto, e nada no
// `node --test` acusa.
//
// A origem conhecida desta classe não é hipótese. Ao editar o `ci.yml` por
// substituição de texto, duas linhas dentro de blocos `run:` saíram com
// indentação zero. O YAML continuava legível aos olhos, o shell do runner
// receberia o bloco truncado, e o step passaria a testar menos do que se
// pensa — sem falhar. Só apareceu porque os steps de smoke foram **executados**
// depois de extraídos do próprio arquivo.
//
// A verificação aqui é estática e barata; a execução dos steps é o smoke do
// próprio CI. As duas se completam: esta pega a classe estrutural, aquela pega
// o comportamento.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github/workflows");

function workflowFiles() {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(WORKFLOWS, name));
}

/**
 * Percorre um bloco `run: |` e exige que toda linha dentro dele esteja mais
 * indentada que a chave, com folga. A folga de 2 é o que separa "corpo do
 * bloco" de "chave do documento" — sem ela, `indent <= blockIndent` já bastaria
 * e a linha quebrada passaria.
 */
function checkBlockIndent(file, text) {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const match = /^(\s*)run: \|\s*$/.exec(line);
    if (!match) return;
    const indent = match[1].length;
    for (let i = index + 1; i < lines.length; i += 1) {
      const next = lines[i];
      if (next.trim() === "") continue;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) break;
      assert.ok(
        nextIndent >= indent + 2,
        `${file}:${i + 1} está com indentação ${nextIndent}, quase igual à do bloco (${indent}): ` +
          `"${next.trim()}" parece ter perdido a indentação do run:`,
      );
    }
  });
}

test("todo bloco `run: |` tem linhas mais indentadas que a sua chave", () => {
  for (const file of workflowFiles()) {
    checkBlockIndent(file, readFileSync(file, "utf8"));
  }
});

test("nenhum workflow usa tab para indentar (YAML não aceita, e a falha é obscura)", () => {
  for (const file of workflowFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      assert.ok(!line.includes("\t"), `${file}:${index + 1} contém tab: "${line.trim()}"`);
    });
  }
});

test("o bloco de artefatos roda depois do tauri-action, para o perfil misto", () => {
  // A coexistência desktop + artifact só funciona nesta ordem: os instaladores
  // entram pelo tauri-action e o artefato próprio pelo coletor. Invertido, o
  // coletor rodaria antes de o build do desktop produzir nada.
  const text = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
  const tauri = text.indexOf("tauri-apps/tauri-action");
  const collect = text.indexOf("Coletar e validar artefatos desta célula");
  const expect = text.indexOf("Conferir o que esta célula prometeu produzir");
  assert.ok(tauri > 0 && collect > 0 && expect > 0, "os três passos precisam existir");
  assert.ok(tauri < collect, "o tauri-action publica os instaladores antes do coletor");
  assert.ok(collect < expect, "a conferência da célula vem depois da coleta");
});

test("a conferência da release vem antes de montar o corpo, e antes de publicar", () => {
  // A tabela de downloads vem do que a release tem, então a conferência tem de
  // rodar antes do corpo. E se ela reprovar, a release fica em rascunho: por
  // isso também precisa vir antes de "Publicar o release".
  const text = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
  const verify = text.indexOf("Conferir a distribuição da release");
  const body = text.indexOf("Montar o corpo do release");
  const publish = text.lastIndexOf("Publicar o release");
  assert.ok(verify > 0 && body > 0 && publish > 0, "os três passos precisam existir");
  assert.ok(verify < body, "a conferência precisa vir antes do corpo");
  assert.ok(verify < publish, "a conferência precisa vir antes de publicar");
});

test("o gate de arte roda depois de resolver a arte, e o publish depois do gate", () => {
  // A fronteira do AGENTS.md: `IMAGE_URL` só chega ao step seguinte, e por isso
  // o script de publicação e o de corpo não podem ser o mesmo passo.
  const text = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
  const resolve = text.indexOf("Resolver a arte de release");
  const policy = text.indexOf("Validar política da imagem de release");
  const publishArt = text.indexOf("Publicar a arte de release");
  const body = text.indexOf("Montar o corpo do release");
  assert.ok(resolve < policy, "a política lê a arte já resolvida");
  assert.ok(policy < publishArt, "a política roda antes de publicar a arte");
  assert.ok(publishArt < body, "a arte é publicada no step anterior ao corpo — a fronteira do $GITHUB_ENV");
});
