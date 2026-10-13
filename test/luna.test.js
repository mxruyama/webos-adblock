'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'luna.js'), 'utf8');
const SERVICE = 'luna://org.community.webos.adblocker.service/';
const HBCHANNEL = 'luna://org.webosbrew.hbchannel.service/';
const TIMEOUT_TEXT = 'Tempo esgotado aguardando o serviço';

// Relogio falso: advance(ms) dispara, em ordem, os timers que vencem ate la.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + (ms || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending() {
      return timers.size;
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) {
          if (t.at <= until && (!due || t.at < due[1].at)) due = [id, t];
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

// Carrega luna.js num contexto isolado. bridge: classe PalmServiceBridge (ou undefined); search: location.search.
function load({ bridge, search = '' } = {}) {
  const clock = fakeClock();
  const context = {
    location: { search },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    JSON,
    Date,
    Error,
    RegExp,
  };
  if (bridge) context.PalmServiceBridge = bridge;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { Luna: context.Luna, clock };
}

// PalmServiceBridge falso: guarda as pontes criadas; reply(i, obj) responde pela ponte i.
function fakeBridges(options = {}) {
  const created = [];
  function PalmServiceBridge() {
    if (options.throwOnCreate) throw new Error(options.throwOnCreate);
    this.calls = [];
    created.push(this);
  }
  PalmServiceBridge.prototype.call = function (uri, params) {
    if (options.throwOnCall) throw new Error(options.throwOnCall);
    this.calls.push({ uri, params: JSON.parse(params) });
  };
  return {
    PalmServiceBridge,
    created,
    reply(i, obj) {
      created[i].onservicecallback(JSON.stringify(obj));
    },
  };
}

function recorder() {
  const replies = [];
  const cb = (err, resp) => replies.push({ err, resp });
  return { replies, cb };
}

test('bridge reply is delivered once and the watchdog is cleared', () => {
  const bridges = fakeBridges();
  const { Luna, clock } = load({ bridge: bridges.PalmServiceBridge });
  const { replies, cb } = recorder();

  Luna.call(SERVICE + 'status', { a: 1 }, cb);
  assert.deepEqual(bridges.created[0].calls, [{ uri: SERVICE + 'status', params: { a: 1 } }]);
  bridges.reply(0, { returnValue: true, active: false });
  clock.advance(10 * 60 * 1000);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].err, null);
  assert.equal(replies[0].resp.active, false);
  assert.equal(clock.pending(), 0);
});

test('bridge constructor failure becomes an error reply', () => {
  const bridges = fakeBridges({ throwOnCreate: 'sem ponte' });
  const { Luna, clock } = load({ bridge: bridges.PalmServiceBridge });
  const { replies, cb } = recorder();

  Luna.call(SERVICE + 'status', {}, cb);
  clock.advance(10 * 60 * 1000);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].err.message, 'Falha ao chamar o serviço: sem ponte');
  assert.deepEqual({ ...replies[0].resp }, { returnValue: false, errorText: 'Falha ao chamar o serviço: sem ponte' });
  assert.equal(clock.pending(), 0);
});

test('bridge call failure becomes an error reply and late callbacks are ignored', () => {
  const bridges = fakeBridges({ throwOnCall: 'URI recusada' });
  const { Luna, clock } = load({ bridge: bridges.PalmServiceBridge });
  const { replies, cb } = recorder();

  Luna.call(SERVICE + 'status', {}, cb);
  bridges.reply(0, { returnValue: true });
  clock.advance(10 * 60 * 1000);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].err.message, 'Falha ao chamar o serviço: URI recusada');
});

test('watchdog fires after 7 minutes and ignores the late reply', () => {
  const bridges = fakeBridges();
  const { Luna, clock } = load({ bridge: bridges.PalmServiceBridge });
  const { replies, cb } = recorder();

  Luna.call(SERVICE + 'update', {}, cb);
  clock.advance(419999);
  assert.equal(replies.length, 0);
  clock.advance(1);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].err.message, TIMEOUT_TEXT);
  assert.deepEqual({ ...replies[0].resp }, { returnValue: false, errorText: TIMEOUT_TEXT });
  bridges.reply(0, { returnValue: true });
  assert.equal(replies.length, 1, 'resposta atrasada ignorada');
});

test('watchdog timeout can be overridden per call', () => {
  const bridges = fakeBridges();
  const { Luna, clock } = load({ bridge: bridges.PalmServiceBridge });
  const { replies, cb } = recorder();

  Luna.call(SERVICE + 'restart', {}, cb, 4000);
  clock.advance(3999);
  assert.equal(replies.length, 0);
  clock.advance(1);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].err.message, TIMEOUT_TEXT);
});

// Chama no mock e avanca o relogio ate a resposta.
function mockCall(env, uri, params) {
  const { replies, cb } = recorder();
  env.Luna.call(uri, params, cb);
  env.clock.advance(1000);
  assert.equal(replies.length, 1);
  return replies[0];
}

test('mock warns about persistence only with root and active blocking', () => {
  const env = load({ search: '?mock=1&warn=1' });
  assert.equal(env.Luna.isMock, true);

  assert.equal(mockCall(env, SERVICE + 'status', {}).resp.warning, undefined, 'sem root');
  mockCall(env, HBCHANNEL + 'elevateService', { id: 'org.community.webos.adblocker.service' });
  mockCall(env, SERVICE + 'restart', {});
  const inactive = mockCall(env, SERVICE + 'status', {}).resp;
  assert.equal(inactive.root, true);
  assert.equal(inactive.warning, undefined, 'inativo');

  const enabled = mockCall(env, SERVICE + 'enable', { list: 'lite' }).resp;
  assert.equal(enabled.active, true);
  assert.equal(enabled.persistent, false);
  assert.equal(enabled.warning, 'startup.sh não encontrado; o bloqueio não persistirá após reiniciar');
});

test('mock rejects an invalid list with the service text', () => {
  const env = load({ search: '?mock=1' });
  mockCall(env, HBCHANNEL + 'elevateService', { id: 'org.community.webos.adblocker.service' });
  mockCall(env, SERVICE + 'restart', {});

  const { err, resp } = mockCall(env, SERVICE + 'enable', { list: 'enorme' });

  assert.equal(err.message, 'Lista inválida');
  assert.equal(resp.errorText, 'Lista inválida');
});
