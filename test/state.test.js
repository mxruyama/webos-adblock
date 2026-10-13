'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const path = require('node:path');
const { createFakeSystem } = require('./helpers/fakes');
const { DEFAULT_STATE, readState, writeState } = require('../service/lib/state');

const STATE = '/var/lib/webosbrew/adblocker.json';

test('DEFAULT_STATE has the documented shape', () => {
  assert.deepEqual(DEFAULT_STATE, { enabled: false, list: 'lite', count: 0, updatedAt: null });
});

test('readState defaults when missing', () => {
  const sys = createFakeSystem({});
  const state = readState(sys.fs, STATE);
  assert.deepEqual(state, DEFAULT_STATE);
  assert.notEqual(state, DEFAULT_STATE);
  state.enabled = true;
  assert.equal(DEFAULT_STATE.enabled, false);
});

test('readState defaults when corrupt', () => {
  for (const content of ['not json {', '', 'null', '[1,2]', '"text"', '42']) {
    const sys = createFakeSystem({ [STATE]: content });
    assert.deepEqual(readState(sys.fs, STATE), DEFAULT_STATE, JSON.stringify(content));
  }
});

test('readState fills missing fields and drops invalid ones', () => {
  const sys = createFakeSystem({
    [STATE]: JSON.stringify({ enabled: true, list: 'bogus', count: 'many', extra: 1 }),
  });
  assert.deepEqual(readState(sys.fs, STATE), {
    enabled: true,
    list: 'lite',
    count: 0,
    updatedAt: null,
  });
});

test('writeState roundtrip', () => {
  const sys = createFakeSystem({});
  const state = { enabled: true, list: 'full', count: 1234, updatedAt: '2026-10-13T12:00:00.000Z' };
  writeState(sys.fs, STATE, state);
  assert.deepEqual(readState(sys.fs, STATE), state);
  assert.deepEqual(JSON.parse(sys.read(STATE)), state);
});

test('writeState writes via tmp file and rename, leaving no tmp behind', () => {
  const sys = createFakeSystem({ [STATE]: '{"enabled":false}' });
  const before = sys.fs.statSync(STATE).ino;
  writeState(sys.fs, STATE, { enabled: true, list: 'lite', count: 5, updatedAt: null });

  assert.equal(sys.fs.existsSync(STATE + '.tmp'), false);
  assert.notEqual(sys.fs.statSync(STATE).ino, before);
  assert.equal(readState(sys.fs, STATE).enabled, true);
});

test('writeState cleans the tmp file and rethrows when rename fails', () => {
  const sys = createFakeSystem({});
  const failing = Object.create(sys.fs);
  failing.renameSync = () => {
    throw new Error('rename falhou');
  };
  assert.throws(
    () => writeState(failing, STATE, DEFAULT_STATE),
    (err) => err.message === 'rename falhou'
  );
  assert.equal(sys.fs.existsSync(STATE + '.tmp'), false);
});

// --- lista leve embutida ---------------------------------------------------------------------

const LITE = path.join(__dirname, '..', 'service', 'lists', 'lite.txt');
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const FORBIDDEN = [
  'lgappstv.com',
  'lgtvsdp.com',
  'lge.com',
  'lgeapi.com',
  'snu.lge.com',
  'su.lge.com',
  'su-ssl.lge.com',
];
// Fragmentos de dominios de streaming/login que nunca devem ser bloqueados pela lista leve.
const FORBIDDEN_FRAGMENTS = [
  'netflix',
  'youtube',
  'googlevideo',
  'hulu',
  'disney',
  'primevideo',
  'amazonvideo',
  'spotify',
  'hbo',
  'max.com',
  'plex',
  'lgaccount',
  'login',
  'signin',
  'auth',
];

function liteLines() {
  return nodeFs.readFileSync(LITE, 'utf8').split('\n');
}

// Leitura independente (nao depende de lib/hosts.js): linhas de dados no formato "0.0.0.0 dominio".
function liteDomains() {
  return liteLines()
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      assert.match(line, /^0\.0\.0\.0 \S+$/, 'linha fora do formato: ' + JSON.stringify(line));
      return line.slice('0.0.0.0 '.length);
    });
}

test('lite list parses', () => {
  const domains = liteDomains();
  assert.ok(domains.length >= 20, 'esperado >= 20 dominios, obtido ' + domains.length);

  for (const domain of domains) {
    assert.match(domain, DOMAIN_RE, domain);
    assert.equal(domain, domain.toLowerCase(), domain);
    assert.equal(FORBIDDEN.includes(domain), false, 'dominio proibido: ' + domain);
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      assert.equal(domain.includes(fragment), false, domain + ' contem ' + fragment);
    }
  }
  assert.equal(new Set(domains).size, domains.length, 'dominios duplicados na lista leve');

  // Dominios LG compartilhados com loja/login/updates: so os subdominios de anuncio/telemetria entram.
  const under = (root) => domains.filter((d) => d.endsWith('.' + root));
  assert.deepEqual(under('lgappstv.com'), ['ad.lgappstv.com']);
  assert.ok(under('lgtvsdp.com').every((d) => /(^|\.)rdx2\.lgtvsdp\.com$/.test(d)));
  assert.deepEqual(under('lge.com'), []);
  assert.deepEqual(under('lgeapi.com'), []);
});

test('lite list is LF-only with a credited header', () => {
  const text = nodeFs.readFileSync(LITE, 'utf8');
  assert.equal(text.includes('\r'), false);
  assert.ok(text.endsWith('\n'));
  const header = liteLines().filter((l) => l.startsWith('#')).join('\n');
  assert.match(header, /hagezi/i);
  assert.match(header, /Perflyst/i);
});

test('lite list agrees with parseDomains when lib/hosts.js is available', () => {
  let hosts = null;
  try {
    hosts = require('../service/lib/hosts');
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
  }
  if (!hosts || typeof hosts.parseDomains !== 'function') return;
  const parsed = hosts.parseDomains(nodeFs.readFileSync(LITE, 'utf8'));
  assert.deepEqual([...parsed].sort(), liteDomains().sort());
});
