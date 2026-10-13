'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const hosts = require('../service/lib/hosts');

const { MARKER, MAX_BYTES, parseDomains, stripOurBlock, buildHostsFile } = hosts;

const META = { list: 'lite', date: '2026-10-13' };
const LOCALHOSTS = '127.0.0.1 localhost\n::1 localhost\n';

test('constants have the documented values', () => {
  assert.equal(MARKER, '# >>> webos-adblock');
  assert.equal(MAX_BYTES, 15 * 1024 * 1024);
});

// ---------- parseDomains ----------

test('parseDomains reads hosts and plain formats', () => {
  const text = '0.0.0.0 a.com\n127.0.0.1 b.com c.com\nd.com\n# x\n';
  assert.deepEqual(parseDomains(text), ['a.com', 'b.com', 'c.com', 'd.com']);
});

test('parseDomains lowercases, dedupes, strips inline comments', () => {
  assert.deepEqual(parseDomains('A.com #c\na.com'), ['a.com']);
  assert.deepEqual(parseDomains('0.0.0.0 X.Example.COM # tracker\n0.0.0.0 x.example.com'), ['x.example.com']);
});

test('parseDomains accepts ::1 as a blocking IP', () => {
  assert.deepEqual(parseDomains('::1 v6.example.com'), ['v6.example.com']);
});

test('parseDomains ignores localhost/broadcast/IP-like entries', () => {
  const text = [
    '# StevenBlack-style header',
    '127.0.0.1 localhost',
    '127.0.0.1 localhost.localdomain',
    '127.0.0.1 local',
    '255.255.255.255 broadcasthost',
    '::1 localhost',
    '::1 ip6-localhost',
    '::1 ip6-loopback',
    'fe80::1%lo0 localhost',
    'ff00::0 ip6-localnet',
    'ff02::1 ip6-allnodes',
    '0.0.0.0 0.0.0.0',
    '0.0.0.0 ip6-something.example.com',
    '0.0.0.0 1.2.3.44',
    '1.2.3.44',
    'localhost',
    'localhost.localdomain',
    'broadcasthost',
    '0.0.0.0 ads.example.com',
  ].join('\n');
  assert.deepEqual(parseDomains(text), ['ads.example.com']);
});

test('parseDomains ignores lines with other IPs', () => {
  assert.deepEqual(parseDomains('192.168.0.1 x.com'), []);
  assert.deepEqual(parseDomains('10.0.0.1 x.com\n0.0.0.0 y.com'), ['y.com']);
});

test('parseDomains ignores invalid domains', () => {
  assert.deepEqual(parseDomains('-bad.com\nnodot\na..b.com\n0.0.0.0 -bad.com nodot a..b.com ok.com'), ['ok.com']);
  assert.deepEqual(parseDomains('0.0.0.0 bad_.com\n0.0.0.0 ex@mple.com'), []);
  assert.deepEqual(parseDomains('0.0.0.0 ' + new Array(300).join('a') + '.com'), []);
});

test('parseDomains ignores bare lines with several words', () => {
  assert.deepEqual(parseDomains('foo.com bar.com'), []);
});

test('parseDomains handles CRLF, tabs and blank lines', () => {
  const text = '0.0.0.0\ta.com\r\n\r\n   \r\n# c\r\nb.com\r\n';
  assert.deepEqual(parseDomains(text), ['a.com', 'b.com']);
});

test('parseDomains is safe with prototype-like names', () => {
  // '__proto__.com' termina o label em '_' (invalido pela regex da spec); os demais nomes sao validos.
  const text = '0.0.0.0 __proto__.com\n0.0.0.0 constructor.com\n0.0.0.0 hasownproperty.com\n0.0.0.0 constructor.com\n';
  assert.deepEqual(parseDomains(text), ['constructor.com', 'hasownproperty.com']);
});

test('parseDomains returns [] for empty input', () => {
  assert.deepEqual(parseDomains(''), []);
});

// ---------- stripOurBlock ----------

test('stripOurBlock removes generated section', () => {
  const text = '127.0.0.1 localhost\n' + MARKER + ' (gerado em x, lista lite, 1 domínios)\n0.0.0.0 a.com\n';
  assert.equal(stripOurBlock(text), '127.0.0.1 localhost\n');
});

test('stripOurBlock leaves text without marker unchanged, ensuring trailing newline', () => {
  assert.equal(stripOurBlock('127.0.0.1 localhost\n'), '127.0.0.1 localhost\n');
  assert.equal(stripOurBlock('127.0.0.1 localhost'), '127.0.0.1 localhost\n');
  assert.equal(stripOurBlock(''), '');
});

test('stripOurBlock drops everything when the block starts the file', () => {
  assert.equal(stripOurBlock(MARKER + ' (x)\n0.0.0.0 a.com\n'), '');
});

test('stripOurBlock handles CRLF input', () => {
  const text = '127.0.0.1 localhost\r\n' + MARKER + ' (x)\r\n0.0.0.0 a.com\r\n';
  assert.equal(stripOurBlock(text), '127.0.0.1 localhost\r\n');
});

test('stripOurBlock ignores the marker when it is not at the start of a line', () => {
  const text = '127.0.0.1 localhost # ' + MARKER + '\n';
  assert.equal(stripOurBlock(text), text);
});

// ---------- buildHostsFile ----------

test('buildHostsFile keeps base and appends block', () => {
  const base = '127.0.0.1 localhost\n';
  const out = buildHostsFile(base, ['x.com'], META);
  assert.equal(out.count, 1);
  assert.ok(out.text.indexOf(base) === 0, 'base preserved at the start');
  const lines = out.text.split('\n');
  const header = lines.filter((l) => l.indexOf(MARKER) === 0);
  assert.equal(header.length, 1);
  assert.equal(header[0], MARKER + ' (gerado em 2026-10-13, lista lite, 1 domínios)');
  assert.ok(header[0].indexOf('lista lite') !== -1);
  assert.ok(header[0].indexOf('1 domínios') !== -1);
  assert.ok(lines.indexOf('0.0.0.0 x.com') > lines.indexOf(header[0]));
  assert.ok(out.text.endsWith('\n'));
});

test('buildHostsFile adds localhost entries when missing', () => {
  const out = buildHostsFile('', ['x.com'], META);
  assert.ok(out.text.indexOf('127.0.0.1 localhost\n') !== -1);
  assert.ok(out.text.indexOf('::1 localhost\n') !== -1);
  assert.ok(out.text.indexOf('::1 localhost') < out.text.indexOf(MARKER));
});

test('buildHostsFile adds only the missing localhost entry', () => {
  const v4only = buildHostsFile('127.0.0.1 localhost\n', [], META).text;
  assert.equal(v4only.split('127.0.0.1 localhost').length - 1, 1);
  assert.ok(v4only.indexOf('::1 localhost') !== -1);

  const v6only = buildHostsFile('::1 localhost\n', [], META).text;
  assert.equal(v6only.split('::1 localhost').length - 1, 1);
  assert.ok(v6only.indexOf('127.0.0.1 localhost') !== -1);
});

test('buildHostsFile does not duplicate localhost when listed with aliases', () => {
  const base = '127.0.0.1\tlocalhost localhost.localdomain\n::1 ip6-localhost localhost\n';
  const out = buildHostsFile(base, [], META);
  assert.equal(out.text.indexOf(base), 0);
  assert.equal(out.text.indexOf('127.0.0.1 localhost\n'), -1);
  assert.equal(out.text.indexOf('::1 localhost\n'), -1);
});

test('buildHostsFile skips domains already in base and rebuilds over old block', () => {
  const base =
    LOCALHOSTS +
    '127.0.0.1 snu.lge.com\n' +
    '0.0.0.0 dup.com\n' +
    MARKER + ' (gerado em 2020-01-01, lista full, 1 domínios)\n' +
    '0.0.0.0 old.com\n';
  const out = buildHostsFile(base, ['dup.com', 'snu.lge.com', 'new.com', 'old-not-listed.com'], META);
  assert.equal(out.count, 2);
  const lines = out.text.split('\n');
  assert.equal(lines.filter((l) => l.indexOf(MARKER) === 0).length, 1);
  assert.equal(lines.filter((l) => l === '0.0.0.0 dup.com').length, 1);
  assert.equal(lines.indexOf('0.0.0.0 snu.lge.com'), -1);
  assert.ok(lines.indexOf('127.0.0.1 snu.lge.com') !== -1);
  assert.equal(lines.indexOf('0.0.0.0 old.com'), -1);
  assert.ok(lines.indexOf('0.0.0.0 new.com') !== -1);
  assert.ok(out.text.indexOf('lista lite, 2 domínios') !== -1);
});

test('buildHostsFile only treats 0.0.0.0/127.0.0.1 entries in base as already blocked', () => {
  const base = LOCALHOSTS + '192.168.1.5 nas.example.com\n';
  const out = buildHostsFile(base, ['nas.example.com'], META);
  assert.equal(out.count, 1);
  assert.ok(out.text.indexOf('0.0.0.0 nas.example.com\n') !== -1);
});

test('buildHostsFile dedupes preserving order, lowercasing', () => {
  const out = buildHostsFile(LOCALHOSTS, ['b.com', 'A.com', 'b.com', 'a.com', 'c.com'], META);
  assert.equal(out.count, 3);
  const entries = out.text.split('\n').filter((l) => l.indexOf('0.0.0.0 ') === 0);
  assert.deepEqual(entries, ['0.0.0.0 b.com', '0.0.0.0 a.com', '0.0.0.0 c.com']);
});

test('buildHostsFile never emits localhost-style or malformed names', () => {
  const evil = ['localhost', 'localhost.localdomain', 'local', 'broadcasthost', 'ip6-localhost', '0.0.0.0', 'nodot', 'x.com\n127.0.0.1 evil.com', 'ok.com'];
  const out = buildHostsFile(LOCALHOSTS, evil, META);
  assert.equal(out.count, 1);
  assert.equal(out.text.indexOf('evil.com'), -1);
  assert.ok(out.text.indexOf('0.0.0.0 ok.com\n') !== -1);
  assert.equal(out.text.indexOf('0.0.0.0 localhost'), -1);
});

test('buildHostsFile is idempotent when rebuilt over its own output', () => {
  const base = '127.0.0.1 localhost\n127.0.0.1 snu.lge.com\n';
  const first = buildHostsFile(base, ['a.com', 'b.com'], META);
  const second = buildHostsFile(first.text, ['a.com', 'b.com'], META);
  assert.equal(second.text, first.text);
  assert.equal(second.count, 2);
});

test('buildHostsFile with no domains writes a header and zero entries', () => {
  const out = buildHostsFile(LOCALHOSTS, [], META);
  assert.equal(out.count, 0);
  assert.equal(out.text, LOCALHOSTS + MARKER + ' (gerado em 2026-10-13, lista lite, 0 domínios)\n');
});

test('buildHostsFile throws over MAX_BYTES', () => {
  const bigBase = LOCALHOSTS + '#' + new Array(MAX_BYTES + 1).join('a') + '\n';
  assert.throws(() => buildHostsFile(bigBase, ['x.com'], META), /Lista de hosts excede 15 MB/);
});

test('buildHostsFile accepts exactly MAX_BYTES and rejects one byte more', () => {
  const baseline = buildHostsFile(LOCALHOSTS + '#\n', ['x.com'], META).text;
  const baselineBytes = Buffer.byteLength(baseline, 'utf8');
  const padding = (n) => LOCALHOSTS + '#' + new Array(n + 1).join('a') + '\n';

  const exact = buildHostsFile(padding(MAX_BYTES - baselineBytes), ['x.com'], META);
  assert.equal(Buffer.byteLength(exact.text, 'utf8'), MAX_BYTES);

  assert.throws(() => buildHostsFile(padding(MAX_BYTES - baselineBytes + 1), ['x.com'], META), /Lista de hosts excede 15 MB/);
});
