'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// 'webos-service' so existe na TV: um stub registra os handlers que service.js publica.
const STUB_PATH = path.join(__dirname, 'helpers', 'webos-service.stub.js');
const services = [];

function FakeService(id) {
  this.id = id;
  this.handlers = {};
  services.push(this);
}
FakeService.prototype.register = function (name, handler) {
  this.handlers[name] = handler;
};

const stub = new Module(STUB_PATH);
stub.filename = STUB_PATH;
stub.loaded = true;
stub.exports = FakeService;

function loadService() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'webos-service') return STUB_PATH;
    return originalResolve.call(this, request, ...rest);
  };
  require.cache[STUB_PATH] = stub;
  try {
    require('../service/service.js');
  } finally {
    Module._resolveFilename = originalResolve;
    delete require.cache[STUB_PATH];
  }
  return services[services.length - 1];
}

const service = loadService();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// Chama um metodo registrado e espera a resposta.
function call(name, payload) {
  return new Promise((resolve) => {
    const responses = [];
    service.handlers[name]({
      payload: payload || {},
      respond(obj) {
        responses.push(obj);
        setTimeout(() => resolve(responses), 20);
      },
    });
  });
}

test('registers the service and its five methods', () => {
  assert.equal(services.length, 1);
  assert.equal(service.id, 'org.community.webos.adblocker.service');
  assert.deepEqual(Object.keys(service.handlers).sort(), ['disable', 'enable', 'restart', 'status', 'update']);
});

test('status responds once with returnValue and the status fields', async () => {
  const responses = await call('status');
  assert.equal(responses.length, 1);
  const resp = responses[0];
  assert.equal(resp.returnValue, true);
  assert.equal(resp.active, false);
  assert.equal(typeof resp.persistent, 'boolean');
  assert.equal(resp.root, isRoot);
  assert.equal(resp.list, 'lite');
  assert.equal(resp.count, 0);
  assert.equal(resp.updatedAt, null);
  assert.equal('errorText' in resp, false);
});

test('write methods answer with errorText and status fields without root', { skip: isRoot }, async () => {
  const responses = await call('enable', { list: 'lite' });
  assert.equal(responses.length, 1);
  const resp = responses[0];
  assert.equal(resp.returnValue, false);
  assert.equal(resp.errorText, "Serviço sem root. Use 'Conceder root'.");
  assert.equal(resp.root, false);
  assert.equal(resp.active, false);
  assert.equal(resp.list, 'lite');
});

test('restart responds and exits after 200 ms', async () => {
  const originalExit = process.exit;
  const exits = [];
  process.exit = (code) => {
    exits.push(code);
  };
  try {
    const responses = await call('restart');
    assert.deepEqual(responses, [{ returnValue: true }]);
    assert.deepEqual(exits, [], 'ainda nao saiu');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(exits, [0]);
  } finally {
    process.exit = originalExit;
  }
});
