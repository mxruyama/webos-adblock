'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { splitPemBundle } = require('../service/lib/certs');

const BUNDLE = path.join(__dirname, '..', 'service', 'certs', 'cacert.pem');
const BEGIN = '-----BEGIN CERTIFICATE-----';
const END = '-----END CERTIFICATE-----';

test('splitPemBundle returns one entry per certificate, without the text around them', () => {
  const text = '## cabecalho\n\nCA Um\n=====\n' + BEGIN + '\nAAAA\n' + END + '\n\nCA Dois\n' + BEGIN + '\nBBBB\n' + END + '\n';
  assert.deepEqual(splitPemBundle(text), [BEGIN + '\nAAAA\n' + END + '\n', BEGIN + '\nBBBB\n' + END + '\n']);
});

test('splitPemBundle ignores a truncated last certificate and empty input', () => {
  assert.deepEqual(splitPemBundle(BEGIN + '\nAAAA\n' + END + '\n' + BEGIN + '\nBB'), [BEGIN + '\nAAAA\n' + END + '\n']);
  assert.deepEqual(splitPemBundle(''), []);
});

test('splitPemBundle handles CRLF bundles', () => {
  const certs = splitPemBundle('x\r\n' + BEGIN + '\r\nAAAA\r\n' + END + '\r\n');
  assert.deepEqual(certs, [BEGIN + '\r\nAAAA\r\n' + END + '\n']);
});

test('splitPemBundle splits the shipped Mozilla bundle into valid certificates', () => {
  const text = fs.readFileSync(BUNDLE, 'utf8');
  const certs = splitPemBundle(text);

  assert.equal(certs.length, text.split(BEGIN).length - 1);
  assert.ok(certs.length > 100);
  for (const pem of certs) {
    assert.ok(pem.startsWith(BEGIN) && pem.endsWith(END + '\n'));
    assert.equal(pem.split(BEGIN).length, 2, 'um certificado por entrada');
    assert.doesNotThrow(() => new X509Certificate(pem));
  }
});
