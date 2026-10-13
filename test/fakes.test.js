'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSystem } = require('./helpers/fakes');

const HOSTS = '/etc/hosts';
const BLOCK = '/var/lib/webosbrew/hosts.block';

function run(sys, cmd, args) {
  return new Promise((resolve) => {
    sys.exec(cmd, args, (err, stdout) => resolve({ err, stdout }));
  });
}

function bindMount(sys, src, dst) {
  return run(sys, 'mount', ['--bind', src, dst]);
}

function makeSys(extra, opts) {
  const files = { [HOSTS]: '127.0.0.1 localhost\n', [BLOCK]: '0.0.0.0 ads.example\n' };
  return createFakeSystem(Object.assign(files, extra), opts);
}

test('readFileSync returns text with encoding and a Buffer without; ENOENT when missing', () => {
  const sys = makeSys();
  assert.equal(sys.fs.readFileSync(HOSTS, 'utf8'), '127.0.0.1 localhost\n');
  assert.equal(sys.fs.readFileSync(HOSTS, { encoding: 'utf8' }), '127.0.0.1 localhost\n');
  assert.ok(Buffer.isBuffer(sys.fs.readFileSync(HOSTS)));
  assert.throws(() => sys.fs.readFileSync('/nope', 'utf8'), (err) => err.code === 'ENOENT');
  assert.throws(() => sys.read('/nope'), (err) => err.code === 'ENOENT');
});

test('file content is byte-exact (CRLF and missing trailing newline)', () => {
  const sys = makeSys({ '/a': 'x\r\ny' });
  assert.equal(sys.read('/a'), 'x\r\ny');
  sys.fs.writeFileSync('/b', Buffer.from([0xc3, 0xa9]));
  assert.equal(sys.read('/b'), 'é');
  assert.equal(sys.fs.statSync('/b').size, 2);
});

test('writeFileSync creates new files with mode 0o644 by default and honors opts.mode', () => {
  const sys = makeSys();
  sys.fs.writeFileSync('/new', 'a');
  assert.equal(sys.fs.statSync('/new').mode, 0o644);
  sys.fs.writeFileSync('/exec', 'b', { mode: 0o755 });
  assert.equal(sys.fs.statSync('/exec').mode, 0o755);
  assert.equal(sys.fs.statSync(HOSTS).mode, 0o644);
});

test('writeFileSync over an existing path keeps its inode and mode', () => {
  const sys = makeSys();
  sys.fs.chmodSync(BLOCK, 0o755);
  const before = sys.fs.statSync(BLOCK);
  sys.fs.writeFileSync(BLOCK, 'new content\n', { mode: 0o600 });
  const after = sys.fs.statSync(BLOCK);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, 0o755);
  assert.equal(sys.read(BLOCK), 'new content\n');
});

test('writeFileSync rejects non string/Buffer data and unsupported flags', () => {
  const sys = makeSys();
  assert.throws(() => sys.fs.writeFileSync('/x', undefined), TypeError);
  assert.throws(() => sys.fs.writeFileSync('/x', 42), TypeError);
  assert.throws(() => sys.fs.writeFileSync('/x', 'a', { flag: 'a' }), Error);
});

test('statSync reports dev, distinct ino, byte size and isFile; ENOENT when missing', () => {
  const sys = makeSys({ '/utf8': 'éé' });
  const a = sys.fs.statSync(HOSTS);
  const b = sys.fs.statSync(BLOCK);
  assert.equal(a.dev, b.dev);
  assert.notEqual(a.ino, b.ino);
  assert.equal(a.size, 20);
  assert.equal(sys.fs.statSync('/utf8').size, 4);
  assert.equal(a.isFile(), true);
  assert.throws(() => sys.fs.statSync('/nope'), (err) => err.code === 'ENOENT');
});

test('existsSync reflects files', () => {
  const sys = makeSys();
  assert.equal(sys.fs.existsSync(HOSTS), true);
  assert.equal(sys.fs.existsSync('/nope'), false);
});

test('chmodSync changes mode; ENOENT when missing', () => {
  const sys = makeSys();
  sys.fs.chmodSync(HOSTS, 0o755);
  assert.equal(sys.fs.statSync(HOSTS).mode, 0o755);
  assert.throws(() => sys.fs.chmodSync('/nope', 0o755), (err) => err.code === 'ENOENT');
});

test('paths are normalized', () => {
  const sys = makeSys();
  assert.equal(sys.read('/etc//hosts'), '127.0.0.1 localhost\n');
  assert.equal(sys.fs.existsSync('/etc/../etc/hosts'), true);
});

test('mount --bind makes the target read through the source inode', async () => {
  const sys = makeSys();
  const { err } = await bindMount(sys, BLOCK, HOSTS);
  assert.equal(err, null);
  assert.equal(sys.read(HOSTS), '0.0.0.0 ads.example\n');
  assert.equal(sys.fs.readFileSync(HOSTS, 'utf8'), '0.0.0.0 ads.example\n');
  assert.equal(sys.fs.statSync(HOSTS).ino, sys.fs.statSync(BLOCK).ino);
  assert.equal(sys.fs.statSync(HOSTS).dev, sys.fs.statSync(BLOCK).dev);
  assert.equal(sys.mounts[HOSTS], sys.fs.statSync(BLOCK).ino);
  assert.deepEqual(sys.calls, [{ cmd: 'mount', args: ['--bind', BLOCK, HOSTS] }]);
});

test('writing to a mount target writes into the mounted inode', async () => {
  const sys = makeSys();
  await bindMount(sys, BLOCK, HOSTS);
  sys.fs.writeFileSync(HOSTS, 'through mount\n');
  assert.equal(sys.read(BLOCK), 'through mount\n');
  assert.equal(sys.fs.statSync(HOSTS).ino, sys.fs.statSync(BLOCK).ino);
  sys.fs.writeFileSync(BLOCK, 'in place\n');
  assert.equal(sys.read(HOSTS), 'in place\n');
});

test('umount removes the mount and reveals the original file', async () => {
  const sys = makeSys();
  const original = sys.fs.statSync(HOSTS).ino;
  await bindMount(sys, BLOCK, HOSTS);
  const { err } = await run(sys, 'umount', [HOSTS]);
  assert.equal(err, null);
  assert.equal(sys.read(HOSTS), '127.0.0.1 localhost\n');
  assert.equal(sys.fs.statSync(HOSTS).ino, original);
  assert.deepEqual(sys.mounts, {});
});

test('umount of a path that is not mounted fails', async () => {
  const sys = makeSys();
  const { err } = await run(sys, 'umount', [HOSTS]);
  assert.ok(err instanceof Error);
  assert.deepEqual(sys.calls, [{ cmd: 'umount', args: [HOSTS] }]);
});

test('mount fails when source or target does not exist', async () => {
  const sys = makeSys();
  assert.ok((await bindMount(sys, '/nope', HOSTS)).err instanceof Error);
  assert.ok((await bindMount(sys, BLOCK, '/nope')).err instanceof Error);
  assert.deepEqual(sys.mounts, {});
});

test('mounts stack: umount pops only the top layer (foreign mount survives)', async () => {
  const sys = makeSys({ '/tmp/hosts': '0.0.0.0 snu.lge.com\n' });
  await bindMount(sys, '/tmp/hosts', HOSTS);
  const foreign = sys.fs.statSync('/tmp/hosts').ino;
  await bindMount(sys, BLOCK, HOSTS);
  assert.equal(sys.read(HOSTS), '0.0.0.0 ads.example\n');
  await run(sys, 'umount', [HOSTS]);
  assert.equal(sys.read(HOSTS), '0.0.0.0 snu.lge.com\n');
  assert.equal(sys.mounts[HOSTS], foreign);
  await run(sys, 'umount', [HOSTS]);
  assert.equal(sys.read(HOSTS), '127.0.0.1 localhost\n');
  assert.equal(sys.mounts[HOSTS], undefined);
});

test('mounts accept direct assignment to the live object', async () => {
  const sys = makeSys({ '/tmp/hosts': 'foreign\n' });
  sys.mounts[HOSTS] = sys.fs.statSync('/tmp/hosts').ino;
  assert.equal(sys.read(HOSTS), 'foreign\n');
  await run(sys, 'umount', [HOSTS]);
  assert.equal(sys.read(HOSTS), '127.0.0.1 localhost\n');
});

test('a stale layer is not resurrected after a mount is removed directly', async () => {
  const sys = makeSys({ '/tmp/hosts': 'foreign\n' });
  await bindMount(sys, '/tmp/hosts', HOSTS);
  await bindMount(sys, BLOCK, HOSTS);
  delete sys.mounts[HOSTS];
  await bindMount(sys, BLOCK, HOSTS);
  await run(sys, 'umount', [HOSTS]);
  assert.equal(sys.mounts[HOSTS], undefined);
  assert.equal(sys.read(HOSTS), '127.0.0.1 localhost\n');
});

test('bind-mounting a path that is itself mounted uses the mounted inode', async () => {
  const sys = makeSys({ '/tmp/hosts': 'foreign\n', '/copy-target': 'x' });
  await bindMount(sys, '/tmp/hosts', HOSTS);
  await bindMount(sys, HOSTS, '/copy-target');
  assert.equal(sys.read('/copy-target'), 'foreign\n');
});

test('renameSync gives the destination the source inode; the mount stays on the old inode', async () => {
  const sys = makeSys({ [BLOCK + '.tmp']: '0.0.0.0 new.example\n' });
  await bindMount(sys, BLOCK, HOSTS);
  const oldIno = sys.fs.statSync(BLOCK).ino;
  const tmpIno = sys.fs.statSync(BLOCK + '.tmp').ino;
  sys.fs.renameSync(BLOCK + '.tmp', BLOCK);
  assert.equal(sys.fs.existsSync(BLOCK + '.tmp'), false);
  assert.equal(sys.fs.statSync(BLOCK).ino, tmpIno);
  assert.equal(sys.read(BLOCK), '0.0.0.0 new.example\n');
  assert.equal(sys.fs.statSync(HOSTS).ino, oldIno);
  assert.notEqual(sys.fs.statSync(HOSTS).ino, sys.fs.statSync(BLOCK).ino);
  assert.equal(sys.read(HOSTS), '0.0.0.0 ads.example\n');
  assert.equal(sys.mounts[HOSTS], oldIno);
});

test('renameSync keeps source mode; ENOENT for missing source; EBUSY on mount targets', async () => {
  const sys = makeSys();
  sys.fs.writeFileSync('/s.tmp', 'x', { mode: 0o755 });
  sys.fs.renameSync('/s.tmp', '/s');
  assert.equal(sys.fs.statSync('/s').mode, 0o755);
  assert.throws(() => sys.fs.renameSync('/missing', '/s'), (err) => err.code === 'ENOENT');
  await bindMount(sys, BLOCK, HOSTS);
  sys.fs.writeFileSync('/other', 'o');
  assert.throws(() => sys.fs.renameSync('/other', HOSTS), (err) => err.code === 'EBUSY');
  assert.throws(() => sys.fs.renameSync(HOSTS, '/other2'), (err) => err.code === 'EBUSY');
});

test('unlinkSync removes the path but a mounted inode stays readable; mount target is EBUSY', async () => {
  const sys = makeSys();
  await bindMount(sys, BLOCK, HOSTS);
  assert.throws(() => sys.fs.unlinkSync(HOSTS), (err) => err.code === 'EBUSY');
  sys.fs.unlinkSync(BLOCK);
  assert.equal(sys.fs.existsSync(BLOCK), false);
  assert.throws(() => sys.fs.readFileSync(BLOCK, 'utf8'), (err) => err.code === 'ENOENT');
  assert.equal(sys.read(HOSTS), '0.0.0.0 ads.example\n');
  assert.throws(() => sys.fs.unlinkSync(BLOCK), (err) => err.code === 'ENOENT');
});

test('exec rejects unknown commands with "command not found: <cmd>" and records the call', async () => {
  const sys = makeSys();
  const { err } = await run(sys, 'curl', ['-fsSL', 'http://x']);
  assert.equal(err.message, 'command not found: curl');
  assert.deepEqual(sys.calls, [{ cmd: 'curl', args: ['-fsSL', 'http://x'] }]);
});

test('exec failCommands fail even for supported commands, without changing state', async () => {
  const sys = makeSys({}, { failCommands: ['mount'] });
  const { err } = await bindMount(sys, BLOCK, HOSTS);
  assert.ok(err instanceof Error);
  assert.deepEqual(sys.mounts, {});
  assert.equal(sys.calls.length, 1);
  sys.failCommands.length = 0;
  assert.equal((await bindMount(sys, BLOCK, HOSTS)).err, null);
  assert.equal(sys.read(HOSTS), '0.0.0.0 ads.example\n');
});

test('exec callback is asynchronous and the mount only takes effect before the callback', (t, done) => {
  const sys = makeSys();
  let sync = true;
  sys.exec('mount', ['--bind', BLOCK, HOSTS], (err, stdout) => {
    assert.equal(sync, false);
    assert.equal(err, null);
    assert.equal(stdout, '');
    assert.equal(sys.read(HOSTS), '0.0.0.0 ads.example\n');
    done();
  });
  assert.equal(sys.read(HOSTS), '127.0.0.1 localhost\n');
  sync = false;
});

test('exec calls are recorded in invocation order and applied in order', async () => {
  const sys = makeSys();
  const first = run(sys, 'mount', ['--bind', BLOCK, HOSTS]);
  const second = run(sys, 'umount', [HOSTS]);
  const results = await Promise.all([first, second]);
  assert.equal(results[0].err, null);
  assert.equal(results[1].err, null);
  assert.deepEqual(sys.calls.map((c) => c.cmd), ['mount', 'umount']);
  assert.deepEqual(sys.mounts, {});
});

test('exec tolerates an omitted args array', async () => {
  const sys = makeSys();
  const err = await new Promise((resolve) => sys.exec('whoami', (e) => resolve(e)));
  assert.equal(err.message, 'command not found: whoami');
});
