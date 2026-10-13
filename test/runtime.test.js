'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtime = require('../service/lib/runtime');
const startup = require('../service/lib/startup');

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('exports the list URLs, the TV paths and the factories', () => {
  assert.equal(runtime.LITE_URL, 'https://mxruyama.github.io/webos-adblock/lists/lite.txt');
  assert.equal(runtime.FULL_URL, 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts');
  assert.deepEqual(runtime.DEFAULT_PATHS, {
    hosts: '/etc/hosts',
    block: '/var/lib/webosbrew/hosts.block',
    state: '/var/lib/webosbrew/adblocker.json',
    startup: '/var/lib/webosbrew/startup.sh',
    liteList: path.join(__dirname, '..', 'service', 'lists', 'lite.txt'),
  });
  assert.equal(typeof runtime.createRuntimeBlocker, 'function');
  assert.equal(typeof runtime.loadCa, 'function');
});

test('loadCa returns the embedded bundle as one PEM certificate per item', () => {
  const ca = runtime.loadCa();
  assert.ok(Array.isArray(ca));
  assert.ok(ca.length > 100, 'bundle Mozilla tem mais de 100 CAs; veio ' + ca.length);
  for (const cert of ca) {
    assert.match(cert, /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----\n$/);
  }
});

test('loadCa returns undefined when the bundle has no certificates', () => {
  // Array vazio em tls removeria todas as CAs raiz: sem certificado, devolve undefined (CAs do Node).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-adblock-ca-'));
  try {
    const empty = path.join(dir, 'cacert.pem');
    fs.writeFileSync(empty, '# bundle truncado\n');
    assert.equal(runtime.loadCa(empty), undefined);
    assert.equal(runtime.loadCa(path.join(dir, 'nao-existe.pem')), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createRuntimeBlocker merges path overrides over the defaults', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-adblock-runtime-'));
  try {
    const paths = {
      hosts: path.join(dir, 'hosts'),
      block: path.join(dir, 'hosts.block'),
      state: path.join(dir, 'adblocker.json'),
      startup: path.join(dir, 'startup.sh'),
    };
    fs.writeFileSync(paths.hosts, '127.0.0.1 localhost\n');
    fs.writeFileSync(paths.startup, '#!/bin/sh\n' + startup.BLOCK);
    fs.writeFileSync(
      paths.state,
      JSON.stringify({ enabled: false, list: 'full', count: 7, updatedAt: '2026-10-13T00:00:00.000Z' })
    );

    const blocker = runtime.createRuntimeBlocker({ paths });
    const resp = await new Promise((resolve, reject) => {
      blocker.status((err, status) => (err ? reject(err) : resolve(status)));
    });

    assert.deepEqual(resp, {
      active: false,
      persistent: true,
      root: isRoot,
      list: 'full',
      count: 7,
      updatedAt: '2026-10-13T00:00:00.000Z',
    });
    assert.equal(runtime.DEFAULT_PATHS.state, '/var/lib/webosbrew/adblocker.json', 'defaults intactos');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
