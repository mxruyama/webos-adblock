'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildRepo } = require('../scripts/build-repo.js');
const { setVersion } = require('../scripts/set-version.js');

const ICON_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const LITE_TEXT = 'ads.example.com\ntracker.example.net\n';
const IPK_BYTES = Buffer.from('conteudo-falso-do-ipk\x00\x01\x02\xff', 'latin1');

const DEFAULT_REPO = 'mxruyama/webos-adblock';
const PAGES_BASE = 'https://mxruyama.github.io/webos-adblock/';
const MANIFEST_NAME = 'org.community.webos.adblocker.manifest.json';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Raiz falsa com os arquivos que buildRepo le (icone e lista lite).
function makeRoot() {
  const root = tempDir('adblock-root-');
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'service', 'lists'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'icon.png'), ICON_BYTES);
  fs.writeFileSync(path.join(root, 'service', 'lists', 'lite.txt'), LITE_TEXT);
  return root;
}

function makeIpk() {
  const dir = tempDir('adblock-ipk-');
  const ipkPath = path.join(dir, 'whatever.ipk');
  fs.writeFileSync(ipkPath, IPK_BYTES);
  return ipkPath;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Roda buildRepo com GITHUB_REPOSITORY controlado e restaura o ambiente depois.
function withRepoEnv(value, fn) {
  const saved = process.env.GITHUB_REPOSITORY;
  if (value === undefined) delete process.env.GITHUB_REPOSITORY;
  else process.env.GITHUB_REPOSITORY = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = saved;
  }
}

function build(options) {
  const rootDir = options.rootDir || makeRoot();
  const outDir = options.outDir || path.join(tempDir('adblock-out-'), 'site');
  const ipkPath = options.ipkPath || makeIpk();
  const call = () => buildRepo({ ipkPath, version: '1.2.3', outDir, rootDir, ...options.extra });
  withRepoEnv(options.env, call);
  return { rootDir, outDir, ipkPath };
}

test('repo.json matches HBChannel schema', () => {
  const { outDir } = build({ env: undefined });
  const repo = readJson(path.join(outDir, 'repo.json'));

  assert.deepEqual(repo.paging, {
    page: 1,
    count: 1,
    maxPage: 1,
    itemsTotal: 1,
    prevUrl: null,
    nextUrl: null,
  });
  assert.equal(repo.packages.length, 1);

  const pkg = repo.packages[0];
  assert.deepEqual(
    Object.keys(pkg).sort(),
    ['iconUri', 'id', 'manifest', 'manifestUrl', 'shortDescription', 'title'],
  );
  assert.equal(pkg.id, 'org.community.webos.adblocker');
  assert.equal(pkg.title, 'AdBlocker');
  assert.equal(pkg.iconUri, `${PAGES_BASE}icon.png`);
  assert.equal(pkg.manifestUrl, `${PAGES_BASE}${MANIFEST_NAME}`);
  assert.equal(
    pkg.shortDescription,
    'Bloqueia anúncios, telemetria da LG e rastreadores em toda a TV via /etc/hosts (requer root).',
  );
  assert.deepEqual(pkg.manifest, readJson(path.join(outDir, MANIFEST_NAME)));
});

test('manifest has sha256 and size', () => {
  const { outDir } = build({ env: undefined });
  const manifest = readJson(path.join(outDir, MANIFEST_NAME));

  const expectedSha = crypto.createHash('sha256').update(IPK_BYTES).digest('hex');
  assert.deepEqual(manifest.ipkHash, { sha256: expectedSha });
  assert.equal(manifest.ipkSize, IPK_BYTES.length);

  assert.equal(manifest.id, 'org.community.webos.adblocker');
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.type, 'web');
  assert.equal(manifest.title, 'AdBlocker');
  assert.equal(manifest.rootRequired, true);
  assert.equal(manifest.iconUri, `${PAGES_BASE}icon.png`);
  assert.equal(manifest.sourceUrl, `https://github.com/${DEFAULT_REPO}`);
  assert.equal(
    manifest.appDescription,
    'Bloqueia anúncios, telemetria da LG e rastreadores em toda a TV via /etc/hosts (requer root).',
  );
});

test('manifest urls use release tag', () => {
  const { outDir } = build({ env: undefined });
  const manifest = readJson(path.join(outDir, MANIFEST_NAME));

  assert.equal(
    manifest.ipkUrl,
    'https://github.com/mxruyama/webos-adblock/releases/download/v1.2.3/org.community.webos.adblocker_1.2.3_all.ipk',
  );
});

test('owner from GITHUB_REPOSITORY', () => {
  const { outDir } = build({ env: 'SomeOwner/other-repo' });
  const repo = readJson(path.join(outDir, 'repo.json'));
  const manifest = readJson(path.join(outDir, MANIFEST_NAME));

  assert.equal(manifest.sourceUrl, 'https://github.com/SomeOwner/other-repo');
  assert.equal(
    manifest.ipkUrl,
    'https://github.com/SomeOwner/other-repo/releases/download/v1.2.3/org.community.webos.adblocker_1.2.3_all.ipk',
  );
  // O host do Pages usa o owner em minusculas.
  assert.equal(manifest.iconUri, 'https://someowner.github.io/other-repo/icon.png');
  assert.equal(
    repo.packages[0].manifestUrl,
    `https://someowner.github.io/other-repo/${MANIFEST_NAME}`,
  );
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  assert.ok(html.includes('https://someowner.github.io/other-repo/repo.json'));
});

test('explicit repo option wins over GITHUB_REPOSITORY', () => {
  const { outDir } = build({ env: 'SomeOwner/other-repo', extra: { repo: 'acme/tools' } });
  const manifest = readJson(path.join(outDir, MANIFEST_NAME));

  assert.equal(manifest.sourceUrl, 'https://github.com/acme/tools');
  assert.equal(manifest.iconUri, 'https://acme.github.io/tools/icon.png');
});

test('writes site files with icon, lite list, index and nojekyll', () => {
  const { outDir } = build({ env: undefined });

  assert.deepEqual(fs.readFileSync(path.join(outDir, 'icon.png')), ICON_BYTES);
  assert.equal(fs.readFileSync(path.join(outDir, 'lists', 'lite.txt'), 'utf8'), LITE_TEXT);
  assert.ok(fs.existsSync(path.join(outDir, '.nojekyll')));

  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="pt-BR">/);
  assert.ok(html.includes(`${PAGES_BASE}repo.json`));
  assert.ok(html.includes('1.2.3'));
  // Rotulos reais da interface (em ingles) do Homebrew Channel.
  for (const label of ['Settings', 'Repositories', 'Add repository', 'Enter repository URL:']) {
    assert.ok(html.includes(`<strong>${label}</strong>`), label);
  }
  assert.ok(!html.includes('Adicionar repositório'), 'sem rotulos inventados');
});

test('json files are pretty-printed with trailing newline', () => {
  const { outDir } = build({ env: undefined });

  for (const name of ['repo.json', MANIFEST_NAME]) {
    const text = fs.readFileSync(path.join(outDir, name), 'utf8');
    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  }
});

test('buildRepo creates nested outDir and tolerates an existing one', () => {
  const rootDir = makeRoot();
  const outDir = path.join(tempDir('adblock-out-'), 'a', 'b');
  build({ rootDir, outDir, env: undefined });
  build({ rootDir, outDir, env: undefined });
  assert.ok(fs.existsSync(path.join(outDir, 'repo.json')));
});

test('buildRepo rejects a bad version', () => {
  const rootDir = makeRoot();
  const outDir = path.join(tempDir('adblock-out-'), 'site');
  for (const version of ['1.2', 'v1.2.3', '1.2.3-beta', '', undefined]) {
    assert.throws(
      () => buildRepo({ ipkPath: makeIpk(), version, outDir, rootDir }),
      /versão inválida/,
    );
  }
});

test('buildRepo reports missing inputs', () => {
  const outDir = path.join(tempDir('adblock-out-'), 'site');

  assert.throws(
    () => buildRepo({ ipkPath: path.join(tempDir('adblock-none-'), 'x.ipk'), version: '1.0.0', outDir, rootDir: makeRoot() }),
    /ipk/i,
  );

  const noIcon = makeRoot();
  fs.unlinkSync(path.join(noIcon, 'app', 'icon.png'));
  assert.throws(
    () => buildRepo({ ipkPath: makeIpk(), version: '1.0.0', outDir, rootDir: noIcon }),
    /icon\.png/,
  );

  const noLite = makeRoot();
  fs.unlinkSync(path.join(noLite, 'service', 'lists', 'lite.txt'));
  assert.throws(
    () => buildRepo({ ipkPath: makeIpk(), version: '1.0.0', outDir, rootDir: noLite }),
    /lite\.txt/,
  );
});

test('buildRepo rejects a malformed repo', () => {
  assert.throws(
    () => buildRepo({ ipkPath: makeIpk(), version: '1.0.0', outDir: tempDir('adblock-out-'), rootDir: makeRoot(), repo: 'no-slash' }),
    /owner\/nome/,
  );
});

// --- setVersion ---------------------------------------------------------

const VERSION_FILES = {
  'app/appinfo.json': { id: 'org.community.webos.adblocker', version: '1.0.0', title: 'AdBlocker' },
  'service/package.json': { name: 'org.community.webos.adblocker.service', version: '1.0.0', main: 'service.js' },
  'package.json': { name: 'webos-adblock', version: '1.0.0', private: true, scripts: { test: 'node --test' } },
};

function makeVersionRoot(omit) {
  const root = tempDir('adblock-version-');
  for (const [rel, data] of Object.entries(VERSION_FILES)) {
    if (rel === omit) continue;
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  return root;
}

test('setVersion updates three files', () => {
  const root = makeVersionRoot();
  setVersion('2.3.4', root);

  for (const [rel, data] of Object.entries(VERSION_FILES)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.equal(text, `${JSON.stringify({ ...data, version: '2.3.4' }, null, 2)}\n`, rel);
  }
});

test('setVersion rejects bad version', () => {
  const root = makeVersionRoot();
  const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');

  for (const bad of ['1.2', 'v1.2.3', '1.2.3-beta', '1.2.x', '', ' 1.2.3', '1.2.3\n', undefined, 123]) {
    assert.throws(() => setVersion(bad, root), /versão inválida/);
  }
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
});

test('setVersion fails clearly when a file is missing and writes nothing', () => {
  const root = makeVersionRoot('service/package.json');
  const appBefore = fs.readFileSync(path.join(root, 'app/appinfo.json'), 'utf8');

  assert.throws(() => setVersion('2.0.0', root), /service[\\/]package\.json/);
  assert.equal(fs.readFileSync(path.join(root, 'app/appinfo.json'), 'utf8'), appBefore);
});
