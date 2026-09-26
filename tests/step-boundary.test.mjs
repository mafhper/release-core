// Testa a fronteira entre steps do runner de verdade: dois processos
// distintos, um $GITHUB_ENV compartilhado, aplicado como o GitHub aplica.
//
// Por que este arquivo existe: o bug da v1.2.0 foi coberto por um teste que
// lia o $GITHUB_ENV à mão, no mesmo shell que rodou o image-step.sh. Essa
// simulação passa quando o runner propagaria e falha quando o runner não
// propaga — exatamente o inverso do que um teste deve fazer. Aqui os dois
// scripts são executados em processos separados e o ambiente do segundo passo
// é montado lendo o arquivo, como o runner faz.
//
// Cobre a classe, não o caso: um valor que precisa atravessar a fronteira e não
// atravessa precisa virar erro, nunca uma release plausível e errada.
//
// Os testes pulam quando não há bash (dev em Windows sem Git Bash). No CI, que
// é ubuntu, eles rodam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE_STEP = join(ROOT, 'scripts', 'image-step.sh');
const RELEASE_BODY = join(ROOT, 'scripts', 'release-body.sh');

// O CI roda em ubuntu com bash no PATH. Em dev no Windows o Git Bash costuma
// estar num caminho fixo; sem nenhum dos dois, o teste pula em vez de reprovar
// por um motivo que não é do código.
function findBash() {
  const candidates = [
    process.env.BASH_PATH,
    'bash',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'exit 0'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const BASH = findBash();
const skip = BASH ? false : 'bash indisponível neste ambiente';

// gh é usado pelo image-step.sh para baixar a correção do branch padrão, ler o
// estado do asset e enviar o upload. O stub responde `contents` com base64 de
// um arquivo de verdade — sem isso a correção não chega e o cenário some. O
// resto basta devolver uma lista vazia: a release ainda não existe, e o que
// está em teste aqui é a fronteira, não a API.
const GH_STUB = `#!/usr/bin/env bash
case "$1" in
  api)
    case "$2" in
      *contents/*) base64 < "$GH_STUB_ART" | tr -d '\\n' ;;
      *) echo '[]' ;;
    esac
    ;;
  release) exit 0 ;;
esac
exit 0
`;

/**
 * Monta um consumidor mínimo no formato do incidente: arte por versão na tag,
 * correção no branch padrão, como o push_ da v1.3.0.
 *
 * `correctionInCheckout: false` reproduz o caso real da correção pós-tag: a tag
 * foi cortada antes de o arquivo -new existir, então ele só existe no branch
 * padrão e chega ao runner por download.
 */
function makeConsumer({ correctionInCheckout = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-core-boundary-'));
  const runnerTemp = join(dir, 'runner-temp');
  const stubDir = join(dir, 'stub');
  const artDir = join(dir, 'img', 'releases');

  mkdirSync(artDir, { recursive: true });
  mkdirSync(join(dir, '.github', 'release-notes'), { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(stubDir, { recursive: true });

  // A tag carrega a arte antiga; a correção é o arquivo -new. É o par que faz a
  // diferença entre "serve a arte antiga" e "serve a arte nova". O release.webp
  // legado também existe, como em um projeto que só tem a imagem única.
  const tagArt = join(artDir, 'release-v1.2.0.webp');
  const correctionArt = join(artDir, 'release-v1.2.0-new.webp');
  writeFileSync(tagArt, 'arte-da-tag');
  writeFileSync(join(artDir, 'release.webp'), 'arte-legada');
  if (correctionInCheckout) writeFileSync(correctionArt, 'arte-corrigida');
  // O branch padrão tem a correção mesmo quando a tag não tem: é esse o arquivo
  // que o stub serve.
  const branchArt = join(dir, 'branch-default', 'release-v1.2.0-new.webp');
  mkdirSync(join(dir, 'branch-default'), { recursive: true });
  writeFileSync(branchArt, 'arte-corrigida');

  writeFileSync(join(dir, '.github', 'release-notes', 'v1.2.0.md'), 'Nota da 1.2.0.');
  writeFileSync(
    join(dir, '.github', 'release.config.json'),
    JSON.stringify({
      release: { title: 'Demo', image: { path: 'img/releases/release.webp' } },
    }),
  );

  const stub = join(stubDir, 'gh');
  writeFileSync(stub, GH_STUB);
  chmodSync(stub, 0o755);

  return {
    dir,
    runnerTemp,
    tagArt,
    // O mesmo ambiente para os dois passos, mais o que o runner tem.
    baseEnv: {
      PATH: [stubDir, process.env.PATH].filter(Boolean).join(delimiter),
      GH_STUB_ART: branchArt,
      REPO: 'mafhper/demo',
      TAG: 'v1.2.0',
      PROJECT_ROOT: dir,
      RUNNER_TEMP: runnerTemp,
      TOOLS_DIR: ROOT,
      CONFIG_FILE: join(dir, '.github', 'release.config.json'),
      GITHUB_ENV: join(runnerTemp, 'github-env'),
      IMAGE_PATH: 'img/releases/release.webp',
      IMAGE_DIR: 'img/releases',
      IMAGE_PREFIX: 'release',
      IMAGE_EXT: '.webp',
      IMAGE_CORRECTION_SUFFIX: '-new',
      IMAGE_ALLOW_CORRECTION: 'false',
      IMAGE_UPLOAD: 'true',
      RELEASE_TITLE: 'Demo',
      NOTES_DIR: '.github/release-notes',
      NOTES_GRANULARITY: 'tag',
      RELEASE_LANGUAGE: 'pt-BR',
    },
  };
}

function runStep(script, env, args = []) {
  return spawnSync(BASH, [script, ...args], {
    env,
    encoding: 'utf8',
    // O runner roda os steps com o CWD no workspace do consumidor, e é de lá
    // que IMAGE_PATH e NOTES_DIR são relativos. Um CWD diferente mudaria o
    // resultado sem mudar o código.
    cwd: env.PROJECT_ROOT,
  });
}

/**
 * Aplica o $GITHUB_ENV como o runner aplica: cada linha KEY=VALUE vira variável
 * de ambiente do step seguinte. Linha malformada é o apply-only silencioso — o
 * runner não reclama, a variável simplesmente nasce vazia.
 */
function applyGithubEnv(envFile) {
  const applied = {};
  let raw = '';
  try {
    raw = readFileSync(envFile, 'utf8');
  } catch {
    return applied;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    applied[line.slice(0, at)] = line.slice(at + 1);
  }
  return applied;
}

test('a URL da arte atravessa a fronteira entre steps', { skip }, () => {
  const { dir, runnerTemp, baseEnv } = makeConsumer();
  const envFile = baseEnv.GITHUB_ENV;
  writeFileSync(envFile, '');

  // Step 1: publica a arte. Processo próprio.
  const publish = runStep(IMAGE_STEP, { ...baseEnv }, ['publish']);
  assert.equal(publish.status, 0, `image-step.sh publish falhou:\n${publish.stderr}`);

  // O runner aplica o arquivo; só então o step 2 existe.
  const applied = applyGithubEnv(envFile);
  assert.equal(
    applied.IMAGE_URL,
    'https://github.com/mafhper/demo/releases/download/v1.2.0/release-v1.2.0.webp',
    'IMAGE_URL deveria ser a URL do asset canônico',
  );

  // Step 2: monta o corpo. Outro processo, com o ambiente do step 1 aplicado.
  const bodyFile = join(runnerTemp, 'body.md');
  const body = runStep(RELEASE_BODY, { ...baseEnv, ...applied }, [bodyFile]);
  assert.equal(body.status, 0, `release-body.sh falhou:\n${body.stderr}`);

  assert.match(
    readFileSync(bodyFile, 'utf8'),
    /!\[Demo\]\(https:\/\/github\.com\/mafhper\/demo\/releases\/download\/v1\.2\.0\/release-v1\.2\.0\.webp\)/,
    'o corpo deveria apontar para o asset',
  );
  // A nota manual entra no corpo: prova de que o step rodou com o CWD no
  // workspace, como o runner, e não em um diretório qualquer.
  assert.match(readFileSync(bodyFile, 'utf8'), /Nota da 1\.2\.0\./);
});

test('sem a URL da arte e com upload ligado, o corpo falha em vez de servir a arte antiga', { skip }, () => {
  // O defeito da v1.2.0 como classe: com image.upload ligado e IMAGE_URL
  // ausente, o corpo não pode cair na URL raw da tag. O caminho legado é válido
  // e errado ao mesmo tempo, e é por isso que precisa ser inalcançável aqui.
  //
  // O que distingue este caso de "o projeto não tem imagem" é o arquivo: ele
  // existe no disco, então o asset deveria ter sido publicado.
  const { runnerTemp, baseEnv } = makeConsumer();
  const bodyFile = join(runnerTemp, 'body.md');

  const body = runStep(
    RELEASE_BODY,
    { ...baseEnv, IMAGE_UPLOAD: 'true', IMAGE_REQUIRED: 'true' },
    [bodyFile],
  );

  assert.notEqual(body.status, 0, 'o corpo deveria falhar, não cair no fallback legado');
  assert.match(body.stderr, /não chegou a este step/);
  assert.equal(existsSync(bodyFile), false, 'não deveria haver corpo com a URL errada');
});

test('projeto sem imagem, com required desligado, monta o corpo sem arte', { skip }, () => {
  // O contra-teste do guard. Aqui o caminho configurado não existe no disco, o
  // que é intencional (image.required: false): reprovar seria trocar uma
  // release sem imagem por uma falha.
  const { runnerTemp, baseEnv } = makeConsumer();
  const bodyFile = join(runnerTemp, 'body.md');

  const body = runStep(
    RELEASE_BODY,
    {
      ...baseEnv,
      IMAGE_UPLOAD: 'true',
      IMAGE_PATH: 'img/releases/na-existe.webp',
      IMAGE_REQUIRED: 'false',
    },
    [bodyFile],
  );

  assert.equal(body.status, 0, `não deveria falhar:\n${body.stderr}`);
  const text = readFileSync(bodyFile, 'utf8');
  assert.doesNotMatch(text, /!\[Demo\]/, 'não deveria haver linha de imagem');
  assert.match(text, /^# Demo$/m, 'o resto do corpo continua igual');
});

test('os dois scripts no mesmo step não produzem uma release plausível e errada', { skip }, () => {
  // O caso original: image-step.sh e release-body.sh no mesmo run:. O
  // $GITHUB_ENV não vale dentro do próprio step, então o corpo não enxerga a
  // URL. Aqui os dois são filhos do MESMO shell, que é o que o runner faz quando
  // alguém junta os dois scripts num step só.
  const { runnerTemp, baseEnv } = makeConsumer();
  writeFileSync(baseEnv.GITHUB_ENV, '');
  const bodyFile = join(runnerTemp, 'body.md');

  const driver = ['set -e', `"${BASH}" "${IMAGE_STEP}" publish`, `"${BASH}" "${RELEASE_BODY}" "$1"`].join('\n');

  const sameStep = spawnSync(BASH, ['-c', driver, 'demo', bodyFile], {
    env: { ...baseEnv },
    encoding: 'utf8',
    cwd: baseEnv.PROJECT_ROOT,
  });

  // O primeiro script grava a URL no arquivo; o segundo, sem o apply do runner,
  // não a enxerga e precisa recusar montar o corpo.
  assert.notEqual(
    sameStep.status,
    0,
    'juntar os dois scripts num step só deve falhar, não publicar um corpo com a arte antiga',
  );
  assert.match(sameStep.stderr, /não chegou a este step/);
});

test('correção pós-tag com upload desligado falha, em vez de servir a arte da tag', { skip }, () => {
  // Segundo furo, ainda latente: com image.upload desligado e a arte vinda do
  // branch padrão, não há URL estável. O comportamento anterior era sair com 0 e
  // deixar o corpo cair na arte antiga — uma release plausível e errada.
  //
  // A tag não tem arte por versão: a única versão disponível é a correção, que o
  // image-step.sh baixa do branch padrão. É por isso que a fonte é "branch".
  const { runnerTemp, baseEnv } = makeConsumer({ correctionInCheckout: false });

  const publish = runStep(
    IMAGE_STEP,
    { ...baseEnv, IMAGE_UPLOAD: 'false', IMAGE_ALLOW_CORRECTION: 'true', DEFAULT_BRANCH: 'main' },
    ['publish'],
  );

  assert.equal(publish.status, 1, 'upload desligado com correção deveria falhar');
  // ::error:: vai para stdout por convenção do GitHub Actions.
  assert.match(publish.stdout, /image\.upload está desligado/);
  assert.equal(existsSync(join(runnerTemp, 'body.md')), false);
});
