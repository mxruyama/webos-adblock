'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSystem } = require('./helpers/fakes');
const { createBlocker } = require('../service/lib/blocker');
const startup = require('../service/lib/startup');

const HOSTS = '/etc/hosts';
const BLOCK = '/var/lib/webosbrew/hosts.block';
const STATE = '/var/lib/webosbrew/adblocker.json';
const STARTUP = '/var/lib/webosbrew/startup.sh';
const LITE_LIST = '/media/developer/apps/service/lists/lite.txt';
const FOREIGN = '/tmp/hosts';

const LITE_URL = 'https://lists.example.org/lite.txt';
const FULL_URL = 'https://lists.example.org/full.txt';
const NOW = new Date('2026-10-13T12:34:56.000Z');
const NOW_ISO = '2026-10-13T12:34:56.000Z';

const NO_ROOT = "Serviço sem root. Use 'Conceder root'.";
const MISSING_STARTUP = 'startup.sh não encontrado; o bloqueio não persistirá após reiniciar';

const ORIGINAL_HOSTS = '127.0.0.1 localhost\n::1 localhost ip6-localhost\n';
const STARTUP_SH = '#!/bin/sh\n# webosbrew startup\nif [ -f /tmp/x ]; then\n    echo ok\nfi\n';
const HBCHANNEL_HOSTS = '127.0.0.1 localhost\n::1 localhost\n127.0.0.1 snu.lge.com su.lge.com\n';

// Lista embutida: 2 dominios. Lista leve remota: 3 dominios (um so existe nela).
const EMBEDDED_LITE = '# lista embutida\n0.0.0.0 ads.lgtv.test\n0.0.0.0 telemetry.lgtv.test\n';
const REMOTE_LITE = '0.0.0.0 ads.lgtv.test\n0.0.0.0 telemetry.lgtv.test\n0.0.0.0 remote-only.lgtv.test\n';
// Formato StevenBlack: entradas de sistema que nao podem virar bloqueio + 3 dominios (1 repetido da leve).
const STEVENBLACK =
  '# StevenBlack\n127.0.0.1 localhost\n127.0.0.1 localhost.localdomain\n255.255.255.255 broadcasthost\n' +
  '::1 localhost\nfe80::1%lo0 localhost\n0.0.0.0 0.0.0.0\n' +
  '0.0.0.0 tracker.example.com\n0.0.0.0 ads.lgtv.test\n0.0.0.0 doubleclick.example.net\n';

const INACTIVE = { active: false, persistent: false, root: true, list: 'lite', count: 0, updatedAt: null };

function setup(options = {}) {
  const files = { [HOSTS]: ORIGINAL_HOSTS, [LITE_LIST]: EMBEDDED_LITE, ...options.files };
  if (options.startup !== false) files[STARTUP] = STARTUP_SH;
  const sys = createFakeSystem(files);
  if (options.startup !== false) sys.fs.chmodSync(STARTUP, 0o755);

  // fs com falhas injetaveis: fail(metodo, caminho) faz a chamada lancar erro.
  const faults = [];
  const fs = {};
  for (const name of Object.keys(sys.fs)) {
    fs[name] = (...args) => {
      const fault = faults.find((f) => f.method === name && f.path === args[0]);
      if (fault) throw new Error(fault.message);
      return sys.fs[name](...args);
    };
  }

  // download falso: texto do mapa `remote`; null -> erro.
  const remote = { [LITE_URL]: REMOTE_LITE, [FULL_URL]: STEVENBLACK, ...options.remote };
  const downloads = [];
  const download = (url, cb) => {
    downloads.push(url);
    setImmediate(() => {
      const text = remote[url];
      if (typeof text === 'string') cb(null, text);
      else cb(new Error('Falha ao baixar ' + url + ': HTTP 404'));
    });
  };

  // exec com gancho opcional: afterExec(cmd, sys) roda depois do efeito e antes do callback.
  const exec = (cmd, args, cb) => {
    sys.exec(cmd, args, (err, out) => {
      if (options.afterExec) options.afterExec(cmd, sys);
      cb(err, out);
    });
  };

  const env = { root: options.root !== false, isRootError: null };
  const blocker = createBlocker({
    fs,
    exec,
    download,
    isRoot() {
      if (env.isRootError) throw env.isRootError;
      return env.root;
    },
    now: () => NOW,
    paths: { hosts: HOSTS, block: BLOCK, state: STATE, startup: STARTUP, liteList: LITE_LIST },
    liteUrl: LITE_URL,
    fullUrl: FULL_URL,
  });

  return {
    sys,
    blocker,
    remote,
    downloads,
    env,
    fail(method, path, message) {
      faults.push({ method, path, message: message || 'falha simulada' });
    },
  };
}

// Chama fn(...args, cb) e devolve {err, resp}; falha se o callback vier mais de uma vez.
function run(fn, ...args) {
  return new Promise((resolve, reject) => {
    let calls = 0;
    fn(...args, (err, resp) => {
      calls += 1;
      if (calls > 1) reject(new Error('callback chamado mais de uma vez'));
      else setImmediate(() => resolve({ err, resp }));
    });
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function rawMount(sys, src) {
  sys.exec('mount', ['--bind', src, HOSTS], () => {});
  await tick();
}

async function rawUmount(sys) {
  sys.exec('umount', [HOSTS], () => {});
  await tick();
}

function readState(sys) {
  return JSON.parse(sys.read(STATE));
}

function isOurMount(sys) {
  if (!sys.fs.existsSync(BLOCK)) return false;
  return sys.fs.statSync(HOSTS).ino === sys.fs.statSync(BLOCK).ino;
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

function cmds(sys) {
  return sys.calls.map((c) => c.cmd + ' ' + c.args.join(' '));
}

async function enabled(env, list) {
  const r = await run(env.blocker.enable, { list: list || 'lite' });
  assert.equal(r.err, null);
  return r.resp;
}

test('status reports inactive initially', async () => {
  const { sys, blocker } = setup();
  const { err, resp } = await run(blocker.status);

  assert.equal(err, null);
  assert.deepEqual(resp, INACTIVE);
  assert.equal(sys.calls.length, 0);
  assert.equal(sys.fs.existsSync(STATE), false);
  assert.equal(sys.read(HOSTS), ORIGINAL_HOSTS);
});

test('enable lite mounts block, persists and saves state', async () => {
  const env = setup();
  const { sys, blocker, downloads } = env;
  const { err, resp } = await run(blocker.enable, { list: 'lite' });

  assert.equal(err, null);
  assert.deepEqual(resp, { active: true, persistent: true, root: true, list: 'lite', count: 3, updatedAt: NOW_ISO });
  assert.deepEqual(downloads, [LITE_URL]);
  assert.deepEqual(cmds(sys), ['mount --bind ' + BLOCK + ' ' + HOSTS]);
  assert.equal(isOurMount(sys), true);

  const hosts = sys.read(HOSTS);
  assert.ok(hosts.startsWith(ORIGINAL_HOSTS), hosts);
  assert.ok(hosts.includes('# >>> webos-adblock (gerado em ' + NOW_ISO + ', lista lite, 3 domínios)\n'), hosts);
  assert.ok(hosts.includes('0.0.0.0 ads.lgtv.test\n'));
  assert.ok(hosts.includes('0.0.0.0 remote-only.lgtv.test\n'), 'usa a lista leve baixada');
  assert.equal(sys.read(BLOCK), hosts);
  assert.equal(sys.fs.existsSync(BLOCK + '.tmp'), false);

  const script = sys.read(STARTUP);
  assert.equal(startup.hasBlock(script), true);
  assert.equal(script, startup.addBlock(STARTUP_SH));
  assert.equal(sys.fs.statSync(STARTUP).mode, 0o755);

  assert.deepEqual(readState(sys), { enabled: true, list: 'lite', count: 3, updatedAt: NOW_ISO });

  const status = await run(blocker.status);
  assert.deepEqual(status.resp, resp);
});

test('enable defaults to the lite list', async () => {
  const { blocker } = setup();
  const { err, resp } = await run(blocker.enable, {});
  assert.equal(err, null);
  assert.equal(resp.list, 'lite');
  assert.equal(resp.active, true);
});

test('enable lite falls back to embedded list when download fails', async () => {
  const { sys, blocker } = setup({ remote: { [LITE_URL]: null } });
  const { err, resp } = await run(blocker.enable, { list: 'lite' });

  assert.equal(err, null);
  assert.equal(resp.active, true);
  assert.equal(resp.count, 2);
  const hosts = sys.read(HOSTS);
  assert.ok(hosts.includes('0.0.0.0 telemetry.lgtv.test\n'));
  assert.ok(!hosts.includes('remote-only.lgtv.test'));
});

test('enable lite falls back to embedded list when download has no domains', async () => {
  const { sys, blocker } = setup({ remote: { [LITE_URL]: '<html>portal cativo</html>\n' } });
  const { err, resp } = await run(blocker.enable, { list: 'lite' });

  assert.equal(err, null);
  assert.equal(resp.count, 2);
  assert.ok(sys.read(HOSTS).includes('0.0.0.0 ads.lgtv.test\n'));
});

test('enable full merges lite and remote', async () => {
  const { sys, blocker, downloads } = setup();
  const { err, resp } = await run(blocker.enable, { list: 'full' });

  assert.equal(err, null);
  assert.equal(resp.list, 'full');
  assert.equal(resp.count, 5);
  assert.deepEqual(downloads, [LITE_URL, FULL_URL]);
  const hosts = sys.read(HOSTS);
  assert.ok(hosts.includes('0.0.0.0 remote-only.lgtv.test\n'));
  assert.ok(hosts.includes('0.0.0.0 tracker.example.com\n'));
  assert.ok(hosts.includes('0.0.0.0 doubleclick.example.net\n'));
  assert.equal(countOf(hosts, '0.0.0.0 ads.lgtv.test\n'), 1);
  assert.ok(!hosts.includes('0.0.0.0 0.0.0.0'));
  assert.ok(!hosts.includes('broadcasthost'));
  assert.deepEqual(readState(sys), { enabled: true, list: 'full', count: 5, updatedAt: NOW_ISO });
});

test('enable full fails when remote download fails', async () => {
  const { sys, blocker } = setup({ remote: { [FULL_URL]: null } });
  const { err, resp } = await run(blocker.enable, { list: 'full' });

  assert.ok(err instanceof Error);
  assert.equal(err.message, 'Falha ao baixar a lista completa: HTTP 404');
  assert.deepEqual(resp, INACTIVE);
  assert.equal(sys.calls.length, 0);
  assert.equal(sys.read(HOSTS), ORIGINAL_HOSTS);
  assert.equal(sys.fs.existsSync(BLOCK), false);
  assert.equal(sys.fs.existsSync(BLOCK + '.tmp'), false);
  assert.equal(sys.fs.existsSync(STATE), false);
  assert.equal(sys.read(STARTUP), STARTUP_SH);
});

test('enable rejects an invalid list', async () => {
  const { sys, blocker, downloads } = setup();
  const { err, resp } = await run(blocker.enable, { list: 'enorme' });

  assert.equal(err.message, 'Lista inválida');
  assert.deepEqual(resp, INACTIVE);
  assert.equal(downloads.length, 0);
  assert.equal(sys.calls.length, 0);
});

test('enable preserves HBChannel update-block hosts', async () => {
  const { sys, blocker } = setup({ files: { [FOREIGN]: HBCHANNEL_HOSTS } });
  await rawMount(sys, FOREIGN);

  const { err, resp } = await run(blocker.enable, { list: 'lite' });

  assert.equal(err, null);
  assert.equal(resp.active, true);
  const hosts = sys.read(HOSTS);
  assert.ok(hosts.startsWith(HBCHANNEL_HOSTS), hosts);
  assert.ok(hosts.includes('127.0.0.1 snu.lge.com su.lge.com\n'));
  assert.ok(hosts.includes('0.0.0.0 ads.lgtv.test\n'));
  assert.equal(sys.read(FOREIGN), HBCHANNEL_HOSTS, 'arquivo do HBChannel intacto');
});

test('disable leaves foreign mount', async () => {
  const env = setup({ files: { [FOREIGN]: HBCHANNEL_HOSTS } });
  const { sys, blocker } = env;
  await rawMount(sys, FOREIGN);
  await enabled(env);

  const { err, resp } = await run(blocker.disable);

  assert.equal(err, null);
  assert.equal(resp.active, false);
  assert.equal(sys.read(HOSTS), HBCHANNEL_HOSTS);
  assert.equal(sys.fs.statSync(HOSTS).ino, sys.fs.statSync(FOREIGN).ino, 'mount do HBChannel continua');
  assert.equal(cmds(sys).filter((c) => c.startsWith('umount')).length, 1);
});

test('disable restores hosts, removes block and file', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env);

  const { err, resp } = await run(blocker.disable);

  assert.equal(err, null);
  assert.deepEqual(resp, { active: false, persistent: false, root: true, list: 'lite', count: 0, updatedAt: NOW_ISO });
  assert.equal(sys.read(HOSTS), ORIGINAL_HOSTS);
  assert.equal(sys.fs.existsSync(BLOCK), false);
  assert.equal(sys.read(STARTUP), STARTUP_SH);
  assert.equal(sys.fs.statSync(STARTUP).mode, 0o755);
  assert.deepEqual(readState(sys), { enabled: false, list: 'lite', count: 0, updatedAt: NOW_ISO });
});

test('disable when inactive succeeds', async () => {
  const { sys, blocker } = setup();
  const { err, resp } = await run(blocker.disable);

  assert.equal(err, null);
  assert.deepEqual(resp, INACTIVE);
  assert.equal(sys.calls.length, 0);
  assert.equal(sys.read(HOSTS), ORIGINAL_HOSTS);
  assert.equal(sys.read(STARTUP), STARTUP_SH);
});

test('disable fails without changes when our mount cannot be removed', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env);
  const hostsBefore = sys.read(HOSTS);
  sys.failCommands.push('umount');

  const { err, resp } = await run(blocker.disable);

  assert.equal(err.message, 'Não foi possível desmontar /etc/hosts');
  assert.equal(resp.active, true);
  assert.equal(sys.read(HOSTS), hostsBefore);
  assert.equal(sys.fs.existsSync(BLOCK), true);
  assert.equal(startup.hasBlock(sys.read(STARTUP)), true);
  assert.equal(readState(sys).enabled, true);
});

test('disable reports startup.sh cleanup failure as warning', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env);
  env.fail('writeFileSync', STARTUP + '.tmp', 'disco cheio');

  const { err, resp } = await run(blocker.disable);

  assert.equal(err, null);
  assert.equal(resp.active, false);
  assert.equal(resp.warning, 'Falha ao limpar startup.sh: disco cheio');
  assert.equal(sys.fs.existsSync(BLOCK), false, 'sem hosts.block o bloco de boot nao monta nada');
  assert.equal(readState(sys).enabled, false);
});

test('enable while active regenerates without stacking mounts', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env);

  const { err, resp } = await run(blocker.enable, { list: 'full' });

  assert.equal(err, null);
  assert.equal(resp.list, 'full');
  const hosts = sys.read(HOSTS);
  assert.equal(countOf(hosts, '# >>> webos-adblock'), 1);
  assert.equal(countOf(hosts, '127.0.0.1 localhost\n'), 1);
  await rawUmount(sys);
  assert.equal(sys.read(HOSTS), ORIGINAL_HOSTS, 'so uma camada nossa');
});

test('update while active swaps list and remounts', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env, 'lite');
  const inoBefore = sys.fs.statSync(HOSTS).ino;

  const { err, resp } = await run(blocker.update, { list: 'full' });

  assert.equal(err, null);
  assert.deepEqual(resp, { active: true, persistent: true, root: true, list: 'full', count: 5, updatedAt: NOW_ISO });
  assert.deepEqual(cmds(sys), [
    'mount --bind ' + BLOCK + ' ' + HOSTS,
    'umount ' + HOSTS,
    'mount --bind ' + BLOCK + ' ' + HOSTS,
  ]);
  assert.notEqual(sys.fs.statSync(HOSTS).ino, inoBefore, 'novo inode montado');
  const hosts = sys.read(HOSTS);
  assert.ok(hosts.startsWith(ORIGINAL_HOSTS));
  assert.ok(hosts.includes('0.0.0.0 tracker.example.com\n'));
  assert.equal(countOf(hosts, '# >>> webos-adblock'), 1);
  assert.equal(sys.fs.existsSync(BLOCK + '.tmp'), false);
  assert.deepEqual(readState(sys), { enabled: true, list: 'full', count: 5, updatedAt: NOW_ISO });
});

test('update without list keeps the current list', async () => {
  const env = setup();
  await enabled(env, 'full');
  const { err, resp } = await run(env.blocker.update, {});
  assert.equal(err, null);
  assert.equal(resp.list, 'full');
  assert.equal(resp.count, 5);
});

test("update when inactive errors 'Bloqueio inativo'", async () => {
  const { sys, blocker, downloads } = setup();
  const { err, resp } = await run(blocker.update, { list: 'lite' });

  assert.equal(err.message, 'Bloqueio inativo');
  assert.deepEqual(resp, INACTIVE);
  assert.equal(downloads.length, 0);
  assert.equal(sys.calls.length, 0);
});

test('update failure keeps previous list mounted', async () => {
  const env = setup();
  const { sys, blocker, remote } = env;
  await enabled(env, 'lite');
  const hostsBefore = sys.read(HOSTS);
  const callsBefore = sys.calls.length;
  remote[FULL_URL] = null;

  const { err, resp } = await run(blocker.update, { list: 'full' });

  assert.match(err.message, /^Falha ao baixar a lista completa: (?!Falha ao baixar)/);
  assert.equal(err.message, 'Falha ao baixar a lista completa: HTTP 404');
  assert.deepEqual(resp, { active: true, persistent: true, root: true, list: 'lite', count: 3, updatedAt: NOW_ISO });
  assert.equal(sys.calls.length, callsBefore, 'nada desmontado');
  assert.equal(isOurMount(sys), true);
  assert.equal(sys.read(HOSTS), hostsBefore);
  assert.equal(sys.fs.existsSync(BLOCK + '.tmp'), false);
  assert.deepEqual(readState(sys), { enabled: true, list: 'lite', count: 3, updatedAt: NOW_ISO });
});

test('update rolls back to the previous block when the swap fails', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env, 'lite');
  const hostsBefore = sys.read(HOSTS);
  env.fail('renameSync', BLOCK + '.tmp', 'EIO simulado');

  const { err, resp } = await run(blocker.update, { list: 'full' });

  assert.equal(err.message, 'Falha ao gravar ' + BLOCK + ': EIO simulado');
  assert.equal(resp.active, true);
  assert.equal(isOurMount(sys), true, 'hosts.block anterior remontado');
  assert.equal(sys.read(HOSTS), hostsBefore);
  assert.equal(sys.fs.existsSync(BLOCK + '.tmp'), false);
  assert.equal(readState(sys).list, 'lite');
});

test('update picks up lower-layer changes (HBChannel update block)', async () => {
  const env = setup({ files: { [FOREIGN]: HBCHANNEL_HOSTS } });
  const { sys, blocker } = env;
  await rawMount(sys, FOREIGN);
  await enabled(env);
  // O usuario liga outra opcao do HBChannel com o AdBlocker ativo: a camada de baixo ganha uma linha.
  const lower = HBCHANNEL_HOSTS + '127.0.0.1 su-ssl.lge.com\n';
  sys.fs.writeFileSync(FOREIGN, lower);
  assert.ok(!sys.read(HOSTS).includes('su-ssl.lge.com'), 'nosso mount esconde a mudanca');

  const { err, resp } = await run(blocker.update, {});

  assert.equal(err, null);
  assert.equal(resp.active, true);
  const hosts = sys.read(HOSTS);
  assert.ok(hosts.startsWith(lower), hosts);
  assert.ok(hosts.includes('0.0.0.0 ads.lgtv.test\n'));
  assert.equal(countOf(hosts, '# >>> webos-adblock'), 1);
  await rawUmount(sys);
  assert.equal(sys.read(HOSTS), lower, 'so uma camada nossa, sobre a do HBChannel');
});

test('build failure after unmount remounts the previous block', async () => {
  const env = setup({ files: { [FOREIGN]: HBCHANNEL_HOSTS } });
  const { sys, blocker } = env;
  await rawMount(sys, FOREIGN);
  await enabled(env, 'lite');
  const hostsBefore = sys.read(HOSTS);
  // A camada de baixo passa do limite de 15 MB: buildHostsFile lanca depois do umount.
  sys.fs.writeFileSync(FOREIGN, HBCHANNEL_HOSTS + '# ' + 'x'.repeat(15 * 1024 * 1024) + '\n');

  const { err, resp } = await run(blocker.update, { list: 'full' });

  assert.equal(err.message, 'Lista de hosts excede 15 MB');
  assert.equal(resp.active, true);
  assert.equal(isOurMount(sys), true, 'hosts.block anterior remontado');
  assert.equal(sys.read(HOSTS), hostsBefore);
  assert.equal(sys.fs.existsSync(BLOCK + '.tmp'), false);
  assert.deepEqual(readState(sys), { enabled: true, list: 'lite', count: 3, updatedAt: NOW_ISO });
  assert.deepEqual(cmds(sys).slice(-2), ['umount ' + HOSTS, 'mount --bind ' + BLOCK + ' ' + HOSTS]);
});

test('write failure after unmount remounts the previous block', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env, 'lite');
  const hostsBefore = sys.read(HOSTS);
  env.fail('writeFileSync', BLOCK + '.tmp', 'ENOSPC simulado');

  const { err, resp } = await run(blocker.update, { list: 'full' });

  assert.equal(err.message, 'Falha ao gravar ' + BLOCK + ': ENOSPC simulado');
  assert.equal(resp.active, true);
  assert.equal(isOurMount(sys), true, 'hosts.block anterior remontado');
  assert.equal(sys.read(HOSTS), hostsBefore);
  assert.equal(sys.fs.existsSync(BLOCK + '.tmp'), false);
  assert.equal(readState(sys).list, 'lite');
});

test('enable full fails when the remote list has no valid domains', async () => {
  const { sys, blocker } = setup({ remote: { [FULL_URL]: '<html>portal cativo</html>\n' } });
  const { err, resp } = await run(blocker.enable, { list: 'full' });

  assert.equal(err.message, 'Falha ao baixar a lista completa: nenhum domínio válido');
  assert.deepEqual(resp, INACTIVE);
  assert.equal(sys.calls.length, 0);
  assert.equal(sys.read(HOSTS), ORIGINAL_HOSTS);
  assert.equal(sys.fs.existsSync(BLOCK), false);
  assert.equal(sys.fs.existsSync(STATE), false);
  assert.equal(sys.read(STARTUP), STARTUP_SH);
});

test('disable wraps a hosts.block removal failure in pt-BR', async () => {
  const env = setup();
  const { blocker } = env;
  await enabled(env);
  env.fail('unlinkSync', BLOCK, 'EIO simulado');

  const { err, resp } = await run(blocker.disable);

  assert.equal(err.message, 'Falha ao apagar ' + BLOCK + ': EIO simulado');
  assert.equal(resp.active, false);
});

test('mount failure retries once and reports the error', async () => {
  const { sys, blocker } = setup();
  sys.failCommands.push('mount');

  const { err, resp } = await run(blocker.enable, { list: 'lite' });

  assert.equal(err.message, 'Falha ao montar /etc/hosts: command failed: mount');
  assert.equal(resp.active, false);
  assert.equal(cmds(sys).filter((c) => c.startsWith('mount')).length, 2);
  assert.equal(sys.read(HOSTS), ORIGINAL_HOSTS);
  assert.equal(sys.fs.existsSync(STATE), false);
  assert.equal(sys.read(STARTUP), STARTUP_SH);
});

test('mount retry that succeeds completes the operation', async () => {
  // O primeiro mount falha; o fake volta a montar normalmente a partir do segundo.
  const { sys, blocker } = setup({
    afterExec(cmd, s) {
      const i = s.failCommands.indexOf('mount');
      if (cmd === 'mount' && i !== -1) s.failCommands.splice(i, 1);
    },
  });
  sys.failCommands.push('mount');

  const { err, resp } = await run(blocker.enable, { list: 'lite' });

  assert.equal(err, null);
  assert.deepEqual(resp, { active: true, persistent: true, root: true, list: 'lite', count: 3, updatedAt: NOW_ISO });
  assert.equal(cmds(sys).filter((c) => c.startsWith('mount')).length, 2);
  assert.equal(isOurMount(sys), true);
  assert.deepEqual(readState(sys), { enabled: true, list: 'lite', count: 3, updatedAt: NOW_ISO });
  assert.equal(startup.hasBlock(sys.read(STARTUP)), true);
});

test('writes require root', async () => {
  const { sys, blocker, downloads } = setup({ root: false });
  const expected = { ...INACTIVE, root: false };

  for (const [name, args] of [['enable', [{ list: 'lite' }]], ['disable', []], ['update', [{}]]]) {
    const { err, resp } = await run(blocker[name], ...args);
    assert.equal(err.message, NO_ROOT, name);
    assert.deepEqual(resp, expected, name);
  }

  const status = await run(blocker.status);
  assert.equal(status.err, null);
  assert.deepEqual(status.resp, expected);
  assert.equal(downloads.length, 0);
  assert.equal(sys.calls.length, 0);
  assert.equal(sys.fs.existsSync(STATE), false);
  assert.equal(sys.read(STARTUP), STARTUP_SH);
});

test('status self-heals missing startup block', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env);
  sys.fs.writeFileSync(STARTUP, STARTUP_SH, 'binary'); // ex.: HBChannel atualizado sobrescreveu o arquivo

  const { err, resp } = await run(blocker.status);

  assert.equal(err, null);
  assert.equal(resp.persistent, true);
  assert.equal(resp.warning, undefined);
  assert.equal(sys.read(STARTUP), startup.addBlock(STARTUP_SH));
  assert.equal(sys.fs.statSync(STARTUP).mode, 0o755);
});

test('status remounts when enabled but not mounted', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env);
  const content = sys.read(BLOCK);
  await rawUmount(sys); // ex.: reboot sem o bloco de boot
  assert.equal(isOurMount(sys), false);

  const { err, resp } = await run(blocker.status);

  assert.equal(err, null);
  assert.equal(resp.active, true);
  assert.equal(resp.warning, undefined);
  assert.equal(cmds(sys).at(-1), 'mount --bind ' + BLOCK + ' ' + HOSTS);
  assert.equal(sys.read(HOSTS), content);
});

test('status reports self-heal failure as warning', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env);
  await rawUmount(sys);
  sys.failCommands.push('mount');

  const { err, resp } = await run(blocker.status);

  assert.equal(err, null);
  assert.equal(resp.active, false);
  assert.equal(resp.warning, 'Falha ao montar /etc/hosts: command failed: mount');
});

test('status does not remount an empty hosts.block', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env);
  await rawUmount(sys);
  sys.fs.writeFileSync(BLOCK, '');
  const callsBefore = sys.calls.length;

  const { err, resp } = await run(blocker.status);

  assert.equal(err, null);
  assert.equal(resp.active, false);
  assert.equal(sys.calls.length, callsBefore);
});

test('status does not self-heal without root', async () => {
  const env = setup();
  const { sys, blocker } = env;
  await enabled(env);
  await rawUmount(sys);
  sys.fs.writeFileSync(STARTUP, STARTUP_SH, 'binary');
  const callsBefore = sys.calls.length;
  env.env.root = false;

  const { err, resp } = await run(blocker.status);

  assert.equal(err, null);
  assert.deepEqual(resp, { active: false, persistent: false, root: false, list: 'lite', count: 3, updatedAt: NOW_ISO });
  assert.equal(sys.calls.length, callsBefore);
  assert.equal(sys.read(STARTUP), STARTUP_SH);
});

test('operations are serialized', async () => {
  const { sys, blocker } = setup();
  const finished = [];

  await new Promise((resolve) => {
    const settle = (name) => (err, resp) => {
      finished.push({ name, err, active: resp.active });
      if (finished.length === 3) resolve();
    };
    blocker.enable({ list: 'full' }, settle('enable'));
    blocker.disable(settle('disable'));
    blocker.status(settle('status'));
  });

  assert.deepEqual(finished, [
    { name: 'enable', err: null, active: true },
    { name: 'disable', err: null, active: false },
    { name: 'status', err: null, active: false },
  ]);
  assert.deepEqual(cmds(sys), ['mount --bind ' + BLOCK + ' ' + HOSTS, 'umount ' + HOSTS]);
  assert.equal(sys.read(HOSTS), ORIGINAL_HOSTS);
  assert.equal(readState(sys).enabled, false);
});

test('queue keeps going after a job throws synchronously', async () => {
  const env = setup();
  env.env.isRootError = new Error('falha inesperada');

  const first = await run(env.blocker.status);
  assert.equal(first.err.message, 'falha inesperada');

  env.env.isRootError = null;
  const second = await run(env.blocker.status);
  assert.equal(second.err, null);
  assert.deepEqual(second.resp, INACTIVE);
});

test('startup.sh missing gives warning', async () => {
  const { sys, blocker } = setup({ startup: false });
  const { err, resp } = await run(blocker.enable, { list: 'lite' });

  assert.equal(err, null);
  assert.equal(resp.active, true);
  assert.equal(resp.persistent, false);
  assert.equal(resp.warning, MISSING_STARTUP);
  assert.equal(sys.fs.existsSync(STARTUP), false, 'nao cria startup.sh');
  assert.equal(readState(sys).enabled, true);

  const status = await run(blocker.status);
  assert.equal(status.resp.persistent, false);
  assert.equal(status.resp.warning, MISSING_STARTUP);
});

test('state write failure is reported in pt-BR', async () => {
  const env = setup();
  env.fail('writeFileSync', STATE + '.tmp', 'ENOSPC: no space left on device');

  const { err, resp } = await run(env.blocker.enable, { list: 'lite' });

  assert.equal(err.message, 'Falha ao gravar ' + STATE + ': ENOSPC: no space left on device');
  assert.equal(resp.active, true);
});

test('startup.sh write failure is a warning, not an error', async () => {
  const env = setup();
  const { sys, blocker } = env;
  env.fail('writeFileSync', STARTUP + '.tmp', 'somente leitura');

  const { err, resp } = await run(blocker.enable, { list: 'lite' });

  assert.equal(err, null);
  assert.equal(resp.active, true);
  assert.equal(resp.persistent, false);
  assert.equal(resp.warning, 'Falha ao gravar startup.sh: somente leitura');
  assert.equal(sys.read(STARTUP), STARTUP_SH);
  assert.equal(readState(sys).enabled, true);
});
