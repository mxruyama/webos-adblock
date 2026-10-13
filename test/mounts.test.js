'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSystem } = require('./helpers/fakes');
const { createMounts } = require('../service/lib/mounts');

const HOSTS = '/etc/hosts';
const BLOCK = '/var/lib/webosbrew/hosts.block';
const FOREIGN = '/tmp/hosts';

function setup(extraFiles, opts) {
  const files = Object.assign(
    {
      [HOSTS]: '127.0.0.1 localhost\n',
      [BLOCK]: '127.0.0.1 localhost\n0.0.0.0 ads.example\n',
    },
    extraFiles
  );
  const sys = createFakeSystem(files, opts);
  const mounts = createMounts({ fs: sys.fs, exec: sys.exec, hostsPath: HOSTS, blockPath: BLOCK });
  return { sys, mounts };
}

function call(fn) {
  return new Promise((resolve) => {
    fn((err) => resolve(err));
  });
}

function umountCalls(sys) {
  return sys.calls.filter((c) => c.cmd === 'umount');
}

test('isOurMount false before mount', () => {
  const { mounts } = setup();
  assert.equal(mounts.isOurMount(), false);
});

test('isOurMount false when hosts.block does not exist', () => {
  const sys = createFakeSystem({ [HOSTS]: '127.0.0.1 localhost\n' });
  const mounts = createMounts({ fs: sys.fs, exec: sys.exec, hostsPath: HOSTS, blockPath: BLOCK });
  assert.equal(mounts.isOurMount(), false);
});

test('mount binds block over hosts', async () => {
  const { sys, mounts } = setup();
  const err = await call(mounts.mount);

  assert.equal(err, null);
  assert.deepEqual(sys.calls, [{ cmd: 'mount', args: ['--bind', BLOCK, HOSTS] }]);
  assert.equal(mounts.isOurMount(), true);
  const a = sys.fs.statSync(HOSTS);
  const b = sys.fs.statSync(BLOCK);
  assert.equal(a.dev, b.dev);
  assert.equal(a.ino, b.ino);
  assert.equal(sys.read(HOSTS), '127.0.0.1 localhost\n0.0.0.0 ads.example\n');
});

test('mount reports the command error', async () => {
  const { mounts } = setup({}, { failCommands: ['mount'] });
  const err = await call(mounts.mount);
  assert.ok(err instanceof Error);
  assert.match(err.message, /mount/);
  assert.equal(mounts.isOurMount(), false);
});

test('unmountOurs does nothing when nothing is mounted', async () => {
  const { sys, mounts } = setup();
  const err = await call(mounts.unmountOurs);
  assert.equal(err, null);
  assert.equal(sys.calls.length, 0);
});

test('unmountOurs removes our mount and restores the original hosts', async () => {
  const { sys, mounts } = setup();
  await call(mounts.mount);
  const err = await call(mounts.unmountOurs);

  assert.equal(err, null);
  assert.deepEqual(umountCalls(sys), [{ cmd: 'umount', args: [HOSTS] }]);
  assert.equal(mounts.isOurMount(), false);
  assert.equal(sys.read(HOSTS), '127.0.0.1 localhost\n');
});

test('unmountOurs leaves foreign mount', async () => {
  const { sys, mounts } = setup({ [FOREIGN]: '127.0.0.1 localhost\n0.0.0.0 snu.lge.com\n' });
  sys.exec('mount', ['--bind', FOREIGN, HOSTS], () => {});
  await new Promise((resolve) => setImmediate(resolve));
  const callsBefore = sys.calls.length;

  const err = await call(mounts.unmountOurs);

  assert.equal(err, null);
  assert.equal(umountCalls(sys).length, 0);
  assert.equal(sys.calls.length, callsBefore);
  assert.equal(sys.read(HOSTS), '127.0.0.1 localhost\n0.0.0.0 snu.lge.com\n');
});

test('unmountOurs removes stacked mounts', async () => {
  const { sys, mounts } = setup();
  await call(mounts.mount);
  await call(mounts.mount);

  const err = await call(mounts.unmountOurs);

  assert.equal(err, null);
  assert.equal(umountCalls(sys).length, 2);
  assert.equal(mounts.isOurMount(), false);
  assert.equal(sys.read(HOSTS), '127.0.0.1 localhost\n');
});

test('unmountOurs only pops our layer and keeps the foreign mount below', async () => {
  const { sys, mounts } = setup({ [FOREIGN]: '127.0.0.1 localhost\n0.0.0.0 snu.lge.com\n' });
  sys.exec('mount', ['--bind', FOREIGN, HOSTS], () => {});
  await new Promise((resolve) => setImmediate(resolve));
  await call(mounts.mount);
  assert.equal(mounts.isOurMount(), true);

  const err = await call(mounts.unmountOurs);

  assert.equal(err, null);
  assert.equal(umountCalls(sys).length, 1);
  assert.equal(mounts.isOurMount(), false);
  assert.equal(sys.read(HOSTS), '127.0.0.1 localhost\n0.0.0.0 snu.lge.com\n');
});

test('unmountOurs gives up after 3 attempts with a pt-BR error', async () => {
  const { sys, mounts } = setup();
  await call(mounts.mount);
  sys.failCommands.push('umount');

  const err = await call(mounts.unmountOurs);

  assert.ok(err instanceof Error);
  assert.equal(err.message, 'Não foi possível desmontar /etc/hosts');
  assert.equal(umountCalls(sys).length, 3);
  assert.equal(mounts.isOurMount(), true);
});

test('unmountOurs succeeds if the mount disappears despite a command error', async () => {
  const { sys, mounts } = setup();
  await call(mounts.mount);
  const realExec = sys.exec;
  let first = true;
  // O primeiro umount "falha", mas desmonta mesmo assim (ex.: erro espurio no codigo de saida).
  const flaky = (cmd, args, cb) => {
    realExec(cmd, args, (err, out) => {
      if (cmd === 'umount' && first) {
        first = false;
        cb(new Error('umount: codigo de saida 1'), '');
        return;
      }
      cb(err, out);
    });
  };
  const m = createMounts({ fs: sys.fs, exec: flaky, hostsPath: HOSTS, blockPath: BLOCK });

  const err = await call(m.unmountOurs);

  assert.equal(err, null);
  assert.equal(m.isOurMount(), false);
});
