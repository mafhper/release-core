// Reprove mojibake nos arquivos de texto do proprio repo.
//
// Por que existe: em 17-20/09/2026 varios commits passaram por uma reescrita
// de arquivo via PowerShell, que leu UTF-8 como latin1 e reescreveu o texto
// corrompido. O preco foi silencioso - o arquivo continua sendo JSON valido, o
// workflow continua valendo, e ninguem ve o defeito no diff do console. O
// package.json do Core ficou com o acento de "reutilizavel" convertido nos dois
// bytes C3 A1 por causa disso (ver RC-N8 e o commit de bump da v1.2.0).
//
// Criterio: um arquivo UTF-8 bem formado nao contem U+FFFD, nem sequencias
// C2xx/C3xx/E3xx, que so surgem quando um byte UTF-8 foi interpretado como
// latin1. CJK e cirilico entram porque nenhum dos dois deveria aparecer aqui -
// se um dia aparecer de proposito, e um caso conscious, nao um acidente.
//
// Nao reproduza aqui a sequencia corrompida como exemplo: este arquivo se
// varre junto com os outros e o teste reprovaria a si mesmo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

// O que o repositório versiona e o que o .dev/ carrega. .dev e local-only, mas
// e onde mora a documentacao: um mojibake la tambem corrompe o que o proximo
// agente le.
const ROOTS = ['.github', 'scripts', 'tests', 'docs', '.dev'];
const ROOT_FILES = ['package.json', 'README.md', 'LICENSE', 'release.yml'];
const EXTS = ['.md', '.mjs', '.js', '.yml', '.yaml', '.json', '.sh'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp', 'archive']);

//artefato gerado: 372 KB em uma linha so, e o dashboard e derived de outros
//arquivos - o dashboard nao guarda texto authored.
const SKIP_FILES = new Set(['dashboard.html']);

const SUSPECTS = [
  { re: /\uFFFD/, label: 'U+FFFD (caractere de substituicao)' },
  { re: /\u00C2[\u0080-\u00BF]/, label: 'latin1: C2xx' },
  { re: /\u00C3[\u0080-\u00BF]/, label: 'latin1: C3xx' },
  { re: /\u00E3[\u0080-\u00BF]/, label: 'latin1: E3xx' },
  { re: /[\u0400-\u04FF]/, label: 'cirilico' },
  { re: /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/, label: 'CJK' },
];

function collect(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(join(dir, entry.name), acc);
    } else if (EXTS.some((ext) => entry.name.endsWith(ext))) {
      if (SKIP_FILES.has(entry.name)) continue;
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

function repoFiles() {
  const files = ROOT_FILES.filter((f) => {
    try {
      return statSync(join(ROOT, f)).isFile();
    } catch {
      return false;
    }
  });
  for (const dir of ROOTS) files.push(...collect(join(ROOT, dir)));
  return files;
}

test('nenhum arquivo de texto do repo tem mojibake', () => {
  const files = repoFiles();
  assert.ok(files.length > 20, `a varredura achou só ${files.length} arquivo(s); ela parou de funcionar`);

  const found = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const { re, label } of SUSPECTS) {
        if (!re.test(line)) continue;
        const at = line.search(re);
        const snippet = [...line.slice(Math.max(0, at - 10), at + 10)]
          .map((ch) => (ch.codePointAt(0) > 126 ? `<U+${ch.codePointAt(0).toString(16).toUpperCase()}>` : ch))
          .join('');
        found.push(`${file.slice(ROOT.length + 1)}:${i + 1} [${label}] ...${snippet}...`);
      }
    });
  }

  assert.deepEqual(
    found,
    [],
    `mojibake em ${found.length} lugar(es). O texto foi lido como latin1 e reescrito; ` +
      'leia o arquivo e grave de novo, sem passar por shell.',
  );
});

test('a descricao do package.json nao esta corrompida', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.description, 'O protocolo de release reutilizável para GitHub Actions.');
});
