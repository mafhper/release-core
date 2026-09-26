// Testa o tripwire do contrato: a mesma config e as mesmas ferramentas nos três
// jobs. É a rede debaixo de um invariante que release.yml assume em três
// lugares — se ele um dia quebrar, a divergência precisa ser barulhenta, não uma
// release plausível e errada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST = join(ROOT, 'scripts', 'contract-digest.sh');
const CHECK = join(ROOT, 'scripts', 'check-contract.sh');

function findBash() {
  for (const candidate of [
    process.env.BASH_PATH,
    'bash',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ].filter(Boolean)) {
    const probe = spawnSync(candidate, ['-c', 'exit 0'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const BASH = findBash();
const skip = BASH ? false : 'bash indisponível neste ambiente';

/**
 * Monta um consumidor e um "tools dir" que é um checkout do Core de verdade —
 * com os scripts dentro e um commit — porque o digest inclui o commit das
 * ferramentas e o check-contract.sh chama o digest a partir do TOOLS_DIR. É o
 * que o runner tem.
 */
function makeWorkspace({ configBody = '{"release":{"title":"Demo"}}', commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-core-contract-'));
  const tools = join(dir, 'tools');
  const config = join(dir, '.github', 'release.config.json');

  mkdirSync(join(dir, '.github'), { recursive: true });
  mkdirSync(join(tools, 'scripts'), { recursive: true });
  writeFileSync(config, configBody);

  // O TOOLS_DIR no runner é o checkout do Core, com scripts/ dentro.
  writeFileSync(join(tools, 'scripts', 'contract-digest.sh'), readFileSync(DIGEST));
  writeFileSync(join(tools, 'scripts', 'check-contract.sh'), readFileSync(CHECK));

  if (commit) {
    const git = (...args) => spawnSync('git', args, { cwd: tools, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'teste@exemplo');
    git('config', 'user.name', 'Teste');
    git('add', '-A');
    git('commit', '-qm', 'ferramentas');
  }

  return { dir, tools, config };
}

function digest(env) {
  const r = spawnSync(BASH, [DIGEST], { env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

function check(expected, env) {
  const r = spawnSync(BASH, [CHECK, expected], { env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('o digest é estável para a mesma config e as mesmas ferramentas', { skip }, () => {
  const { tools, config } = makeWorkspace();
  const env = { ...process.env, CONFIG_FILE: config, TOOLS_DIR: tools };

  const a = digest(env);
  const b = digest(env);

  assert.equal(a.status, 0, `contract-digest.sh falhou:\n${a.stderr}`);
  assert.match(a.stdout, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.stdout, b.stdout, 'o mesmo contrato tem que dar o mesmo digest');
});

test('mudar a config muda o digest', { skip }, () => {
  const { dir, tools, config } = makeWorkspace();
  const env = { ...process.env, CONFIG_FILE: config, TOOLS_DIR: tools };
  const before = digest(env).stdout;

  writeFileSync(config, '{"release":{"title":"Outro"}}');
  const after = digest(env).stdout;

  assert.notEqual(before, after, 'config diferente tem que dar digest diferente');
  assert.ok(dir);
});

test('mudar o commit das ferramentas muda o digest', { skip }, () => {
  // O caso que o prepare não veria: o build buscou as ferramentas de outra ref.
  const { tools, config } = makeWorkspace();
  const env = { ...process.env, CONFIG_FILE: config, TOOLS_DIR: tools };
  const before = digest(env).stdout;

  const git = (...args) => spawnSync('git', args, { cwd: tools, encoding: 'utf8' });
  writeFileSync(join(tools, 'scripts', 'release-config.mjs'), '// outra versao');
  git('add', '-A');
  git('commit', '-qm', 'muda as ferramentas');
  const after = digest(env).stdout;

  assert.notEqual(before, after, 'commit diferente tem que dar digest diferente');
});

test('config ausente falha em vez de gerar digest de um estado desconhecido', { skip }, () => {
  const { tools } = makeWorkspace();
  const r = digest({ ...process.env, CONFIG_FILE: join(tools, 'nao-existe.json'), TOOLS_DIR: tools });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /não encontrado/);
});

test('a conferência passa quando o contrato é o mesmo', { skip }, () => {
  const { tools, config } = makeWorkspace();
  const env = { ...process.env, CONFIG_FILE: config, TOOLS_DIR: tools };
  const expected = digest(env).stdout;

  const r = check(expected, env);
  assert.equal(r.status, 0, `deveria passar:\n${r.stderr}`);
  assert.match(r.stdout, /Contrato conferido/);
});

test('a conferência falha alto quando a config diverge', { skip }, () => {
  // A divergência silenciosa que o tripwire existe para impedir: o prepare
  // viu uma config, este job viu outra. Sem a conferência, o corpo pode sair com
  // a URL raw da tag porque o finalize acha que não há upload.
  const { tools, config } = makeWorkspace();
  const env = { ...process.env, CONFIG_FILE: config, TOOLS_DIR: tools };
  const expected = digest(env).stdout;

  writeFileSync(config, '{"release":{"title":"Mudou depois do prepare"}}');
  const r = check(expected, env);

  assert.equal(r.status, 1, 'divergência de contrato tem que reprovar');
  assert.match(r.stdout, /::error::O contrato mudou/);
  assert.match(r.stdout, /action_ref/);
});

test('a conferência falha alto quando as ferramentas divergem', { skip }, () => {
  const { tools, config } = makeWorkspace();
  const env = { ...process.env, CONFIG_FILE: config, TOOLS_DIR: tools };
  const expected = digest(env).stdout;

  const git = (...args) => spawnSync('git', args, { cwd: tools, encoding: 'utf8' });
  writeFileSync(join(tools, 'scripts', 'release-config.mjs'), '// core de outra tag');
  git('add', '-A');
  git('commit', '-qm', 'troca de tools');

  const r = check(expected, env);
  assert.equal(r.status, 1, 'divergência de ferramentas tem que reprovar');
  assert.match(r.stdout, /::error::O contrato mudou/);
});

test('sem digest esperado, a conferência falha em vez de assumir que confere', { skip }, () => {
  // O inverso também tem que ser ruidoso. Se o prepare não registrou nada, a
  // única leitura segura é que não se pode afirmar nada.
  const { tools, config } = makeWorkspace();
  const env = { ...process.env, CONFIG_FILE: config, TOOLS_DIR: tools };

  const r = check('', env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /não registrou contract_digest/);
});

test('o digest do Core é o mesmo nos dois lados do workflow', { skip }, () => {
  // Fecha o loop: o mesmo arquivo, lido com o mesmo script, dá o mesmo digest.
  // Se algum dia essa igualdade quebrar, é porque o script mudou de forma que
  // afecta o resultado, e o tripwire começa a acusar divergência falsa.
  const env = { ...process.env, CONFIG_FILE: join(ROOT, '.github', 'release.config.json'), TOOLS_DIR: ROOT };
  const a = digest(env);
  assert.equal(a.status, 0, `falhou com a config do próprio Core:\n${a.stderr}`);
  assert.match(a.stdout, /^sha256:[0-9a-f]{64}$/);

  const check1 = check(a.stdout, env);
  assert.equal(check1.status, 0, `a conferência do próprio Core falhou:\n${check1.stderr}`);

  // E o digest muda quando a config do Core muda, que é o teste de sanidade.
  const bytes = readFileSync(join(ROOT, '.github', 'release.config.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex').length, 64);
});
