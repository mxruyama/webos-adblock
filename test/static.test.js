'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');

function readJson(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^﻿/, '');
  return JSON.parse(text);
}

// Lista recursivamente os .js de um diretorio (que pode nao existir), ignorando node_modules.
function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

function parseEs5(source) {
  return acorn.parse(source, { ecmaVersion: 5, sourceType: 'script' });
}

test('json files parse', () => {
  const appinfo = readJson('app/appinfo.json');
  const servicePkg = readJson('service/package.json');
  const services = readJson('service/services.json');

  assert.equal(appinfo.id, 'org.community.webos.adblocker');
  assert.equal(appinfo.type, 'web');
  assert.equal(appinfo.main, 'index.html');
  assert.equal(servicePkg.name, 'org.community.webos.adblocker.service');
  assert.equal(servicePkg.main, 'service.js');
  assert.equal(services.id, 'org.community.webos.adblocker.service');
  assert.equal(services.services[0].name, 'org.community.webos.adblocker.service');
});

test('app and service code is ES5', () => {
  const files = [
    ...listJsFiles(path.join(ROOT, 'app', 'js')),
    ...listJsFiles(path.join(ROOT, 'service')),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    try {
      parseEs5(source);
    } catch (err) {
      assert.fail('Nao e ES5: ' + path.relative(ROOT, file) + ': ' + err.message);
    }
  }
});

test('ES5 checker rejects modern syntax', () => {
  const modern = ['let a = 1;', 'const b = 2;', 'var f = () => 1;', 'var s = `x`;', 'class A {}'];
  for (const snippet of modern) {
    assert.throws(() => parseEs5(snippet), SyntaxError, snippet);
  }
  assert.doesNotThrow(() => parseEs5('var a = function (x) { return x + 1; };'));
});
