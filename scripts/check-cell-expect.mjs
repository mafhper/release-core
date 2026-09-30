#!/usr/bin/env node
// Confere que a célula produziu o que a matriz prometeu.
//
// O pedido, literal, de um consumidor:
//
//   "O Release Core deve verificar que os artefatos esperados realmente foram
//    produzidos. Não basta o comando de build terminar com sucesso se o workflow
//    não encontrar os arquivos esperados."
//
// `build` verde é uma afirmação sobre **células**, e a afirmação que importa é
// sobre o que a célula **entregou**. `matrix[].expect` é a declaração disso:
//
//   matrix:
//     - os: windows-latest
//       expect: '["**/*.msi", "**/*.exe"]'
//
// Globs, não nomes exatos, porque o nome do instalador carrega a versão
// (`IconCore_1.5.0_x64_en-US.msi`) e muda a cada release. O que a célula promete
// é a **forma** do que ela gera, e essa é a afirmação estável.
//
// É o par do `verify-artifacts.mjs`: aquele confere, na release inteira, os
// artefatos cujo nome é determinístico; este confere, na célula, os que dependem
// do gerador. Juntos fecham "produziu o que prometeu" sem o Core precisar saber
// o que o Tauri gera.
//
// Uso: MATRIX_EXPECT='["**/*.msi"]' node check-cell-expect.mjs
import { pathToFileURL } from "node:url";
import { expandGlobs } from "./collect-artifacts.mjs";

export function checkExpect(patterns, cwd) {
  if (!Array.isArray(patterns)) {
    throw new Error("matrix.expect precisa ser um array de padrões glob (JSON).");
  }
  const missing = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.trim() === "") {
      throw new Error(`matrix.expect tem um item que não é string não vazia: ${JSON.stringify(pattern)}`);
    }
    const found = expandGlobs([pattern], cwd);
    if (found.length === 0) missing.push(pattern);
    else process.stderr.write(`» ${pattern} -> ${found.length} arquivo(s)\n`);
  }
  return missing;
}

export function runCheck(env = process.env) {
  const raw = env.MATRIX_EXPECT || "";
  if (!raw.trim()) return { missing: [] };
  let patterns;
  try {
    patterns = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`::error::matrix.expect não é JSON válido: ${error.message}\n`);
    process.exit(1);
  }
  let missing;
  try {
    // Mesma raiz que o coletor: os globs são relativos ao diretório de trabalho
    // do job, e um teste tem que poder apontar para outro diretório.
    missing = checkExpect(patterns, env.ARTIFACT_WORKDIR || process.cwd());
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
  for (const pattern of missing) {
    process.stderr.write(
      `::error::matrix.expect: nenhum arquivo casou com '${pattern}' nesta célula. ` +
        "O build pode ter terminado com sucesso e mesmo assim não ter gerado o instalador — " +
        "que é exatamente a diferença entre 'o build passou' e 'o artefato existe'.\n",
    );
  }
  if (missing.length > 0) process.exit(1);
  process.stderr.write("Célula entregou tudo o que a matriz prometeu.\n");
  return { missing: [] };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runCheck();
