'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSystem } = require('./helpers/fakes');
const startup = require('../service/lib/startup');

const { BEGIN, END, BLOCK, hasBlock, addBlock, removeBlock, ensureBlock, dropBlock } = startup;

const STARTUP = '/var/lib/webosbrew/startup.sh';
const ORIGINAL = '#!/bin/sh\nif [ ! -e /tmp/webosbrew_startup ]; then\n    touch /tmp/webosbrew_startup\nfi\n';
const MISSING_WARNING = 'startup.sh não encontrado; o bloqueio não persistirá após reiniciar';

function makeSys(content, mode) {
  const files = {};
  if (content !== undefined) files[STARTUP] = content;
  const sys = createFakeSystem(files);
  if (content !== undefined && mode !== undefined) sys.fs.chmodSync(STARTUP, mode);
  return sys;
}

test('BLOCK matches the spec text exactly', () => {
  assert.equal(BEGIN, '# >>> org.community.webos.adblocker >>>');
  assert.equal(END, '# <<< org.community.webos.adblocker <<<');
  assert.equal(
    BLOCK,
    '# >>> org.community.webos.adblocker >>>\n' +
      'if [ -s /var/lib/webosbrew/hosts.block ]; then\n' +
      '    mount --bind /var/lib/webosbrew/hosts.block /etc/hosts\n' +
      'fi\n' +
      '# <<< org.community.webos.adblocker <<<\n',
  );
});

test('hasBlock detects the marked block', () => {
  assert.equal(hasBlock(''), false);
  assert.equal(hasBlock(ORIGINAL), false);
  assert.equal(hasBlock(ORIGINAL + BLOCK), true);
  assert.equal(hasBlock(BLOCK + ORIGINAL), true);
});

test('hasBlock ignores markers that are not on their own line start', () => {
  assert.equal(hasBlock('echo "' + BEGIN + '"\necho "' + END + '"\n'), false);
});

test('hasBlock needs both markers in order', () => {
  assert.equal(hasBlock(BEGIN + '\nfoo\n'), false);
  assert.equal(hasBlock(END + '\n' + BEGIN + '\n'), false);
});

test('addBlock appends block once', () => {
  const once = addBlock(ORIGINAL);
  assert.ok(once.endsWith(BLOCK));
  assert.equal(once, ORIGINAL + BLOCK);
  assert.equal(addBlock(once), once);
  assert.equal(once.split(BEGIN).length - 1, 1);
});

test('addBlock handles missing trailing newline', () => {
  assert.equal(addBlock('echo hi'), 'echo hi\n' + BLOCK);
});

test('addBlock on empty text yields just the block', () => {
  assert.equal(addBlock(''), BLOCK);
});

test('addBlock moves a block found mid-file to the end and collapses duplicates', () => {
  const messy = BLOCK + 'echo middle\n' + BLOCK + 'echo tail\n';
  assert.equal(addBlock(messy), 'echo middle\necho tail\n' + BLOCK);
});

test('addBlock rewrites an old CRLF-edited block with LF', () => {
  const crlfBlock = BLOCK.replace(/\n/g, '\r\n');
  assert.equal(addBlock('a\r\n' + crlfBlock), 'a\r\n' + BLOCK);
});

test('removeBlock restores original', () => {
  const inputs = [ORIGINAL, '', '\n', 'echo hi\n', 'a\n\n\n', '#!/bin/sh\n\n'];
  for (const x of inputs) {
    assert.equal(removeBlock(addBlock(x)), x, JSON.stringify(x));
  }
});

test('removeBlock without a block is a no-op', () => {
  assert.equal(removeBlock(ORIGINAL), ORIGINAL);
  assert.equal(removeBlock(''), '');
  assert.equal(removeBlock('no newline'), 'no newline');
});

test('removeBlock preserves CRLF content', () => {
  assert.equal(removeBlock('a\r\nb\r\n' + BLOCK), 'a\r\nb\r\n');
  assert.equal(removeBlock('a\r\nb\r\n' + BLOCK + 'c\r\n'), 'a\r\nb\r\nc\r\n');
});

test('removeBlock removes a block with CRLF line endings', () => {
  const crlfBlock = BLOCK.replace(/\n/g, '\r\n');
  assert.equal(removeBlock('a\r\n' + crlfBlock + 'b\r\n'), 'a\r\nb\r\n');
});

test('removeBlock removes a block at the start and in the middle', () => {
  assert.equal(removeBlock(BLOCK + ORIGINAL), ORIGINAL);
  assert.equal(removeBlock('x\n' + BLOCK + 'y\n'), 'x\ny\n');
});

test('removeBlock removes a block that ends the file without a final newline', () => {
  assert.equal(removeBlock('x\n' + BLOCK.slice(0, -1)), 'x\n');
});

test('removeBlock removes every copy of the block', () => {
  assert.equal(removeBlock(BLOCK + 'x\n' + BLOCK), 'x\n');
});

test('removeBlock leaves an unterminated marker alone', () => {
  const dangling = 'a\n' + BEGIN + '\nuser stuff\n';
  assert.equal(removeBlock(dangling), dangling);
});

test('removeBlock only drops the block nearest to the end marker', () => {
  const dangling = BEGIN + '\nuser stuff\n';
  assert.equal(removeBlock(dangling + BLOCK), dangling);
});

test('ensureBlock writes atomically and keeps mode', () => {
  const sys = makeSys(ORIGINAL, 0o755);
  const result = ensureBlock(sys.fs, STARTUP);

  assert.deepEqual(result, { persistent: true });
  const written = sys.read(STARTUP);
  assert.equal(hasBlock(written), true);
  assert.equal(written, ORIGINAL + BLOCK);
  assert.equal(sys.fs.statSync(STARTUP).mode, 0o755);
  assert.equal(sys.fs.existsSync(STARTUP + '.tmp'), false);
});

test('ensureBlock keeps a non-default mode', () => {
  const sys = makeSys(ORIGINAL, 0o700);
  ensureBlock(sys.fs, STARTUP);
  assert.equal(sys.fs.statSync(STARTUP).mode, 0o700);
});

test('ensureBlock falls back to 0755 when the original mode has no permission bits', () => {
  const sys = makeSys(ORIGINAL, 0);
  ensureBlock(sys.fs, STARTUP);
  assert.equal(sys.fs.statSync(STARTUP).mode, 0o755);
});

test('ensureBlock does not rewrite when the block is already identical', () => {
  const sys = makeSys(ORIGINAL + BLOCK, 0o755);
  const inoBefore = sys.fs.statSync(STARTUP).ino;

  assert.deepEqual(ensureBlock(sys.fs, STARTUP), { persistent: true });
  assert.equal(sys.fs.statSync(STARTUP).ino, inoBefore);
  assert.equal(sys.read(STARTUP), ORIGINAL + BLOCK);
  assert.equal(sys.fs.existsSync(STARTUP + '.tmp'), false);
});

test('ensureBlock is idempotent across calls', () => {
  const sys = makeSys(ORIGINAL, 0o755);
  ensureBlock(sys.fs, STARTUP);
  const inoAfterFirst = sys.fs.statSync(STARTUP).ino;
  ensureBlock(sys.fs, STARTUP);
  assert.equal(sys.fs.statSync(STARTUP).ino, inoAfterFirst);
  assert.equal(sys.read(STARTUP), ORIGINAL + BLOCK);
});

test('ensureBlock keeps CRLF content untouched', () => {
  const sys = makeSys('a\r\nb\r\n', 0o755);
  ensureBlock(sys.fs, STARTUP);
  assert.equal(sys.read(STARTUP), 'a\r\nb\r\n' + BLOCK);
});

test('ensureBlock without startup.sh', () => {
  const sys = makeSys();
  const result = ensureBlock(sys.fs, STARTUP);

  assert.deepEqual(result, { persistent: false, warning: MISSING_WARNING });
  assert.equal(sys.fs.existsSync(STARTUP), false);
  assert.equal(sys.fs.existsSync(STARTUP + '.tmp'), false);
});

test('ensureBlock cleans up the temp file and rethrows when the swap fails', () => {
  const sys = makeSys(ORIGINAL, 0o755);
  const failing = Object.create(sys.fs);
  failing.renameSync = () => {
    throw new Error('rename falhou');
  };

  assert.throws(() => ensureBlock(failing, STARTUP), /rename falhou/);
  assert.equal(sys.fs.existsSync(STARTUP + '.tmp'), false);
  assert.equal(sys.read(STARTUP), ORIGINAL);
});

test('dropBlock removes the block and keeps mode', () => {
  const sys = makeSys(ORIGINAL + BLOCK, 0o755);
  dropBlock(sys.fs, STARTUP);

  assert.equal(sys.read(STARTUP), ORIGINAL);
  assert.equal(sys.fs.statSync(STARTUP).mode, 0o755);
  assert.equal(sys.fs.existsSync(STARTUP + '.tmp'), false);
});

test('dropBlock undoes ensureBlock', () => {
  const sys = makeSys(ORIGINAL, 0o755);
  ensureBlock(sys.fs, STARTUP);
  dropBlock(sys.fs, STARTUP);
  assert.equal(sys.read(STARTUP), ORIGINAL);
});

test('dropBlock is tolerant', () => {
  const missing = makeSys();
  assert.doesNotThrow(() => dropBlock(missing.fs, STARTUP));
  assert.equal(missing.fs.existsSync(STARTUP), false);

  const clean = makeSys(ORIGINAL, 0o755);
  const inoBefore = clean.fs.statSync(STARTUP).ino;
  assert.doesNotThrow(() => dropBlock(clean.fs, STARTUP));
  assert.equal(clean.read(STARTUP), ORIGINAL);
  assert.equal(clean.fs.statSync(STARTUP).ino, inoBefore);
});
