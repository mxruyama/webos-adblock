'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'app.js'), 'utf8');
const SERVICE = 'luna://org.community.webos.adblocker.service/';
const HBCHANNEL = 'luna://org.webosbrew.hbchannel.service/';

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

// DOM minimo: elementos com className/textContent/disabled/atributos; "visivel" = nem ele nem os pais com "hidden".
function fakeDocument() {
  const doc = { readyState: 'complete', activeElement: null, byId: {} };

  function element(id, className, parent, attrs) {
    const el = {
      id,
      className,
      parent: parent || null,
      textContent: '',
      disabled: false,
      attrs: Object.assign({}, attrs),
      listeners: {},
      badge: null,
      setAttribute(name, value) {
        this.attrs[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      querySelector() {
        return this.badge;
      },
      focus() {
        doc.activeElement = this;
      },
      click() {
        this.listeners.click();
      },
      get offsetWidth() {
        for (let node = this; node; node = node.parent) {
          if (/(^|\s)hidden(\s|$)/.test(node.className)) return 0;
        }
        return 100;
      },
    };
    if (id) doc.byId[id] = el;
    return el;
  }

  const app = element('app', 'app');
  element('version', 'version', app);
  element('mock-tag', 'tag hidden', app);
  const banner = element('root-banner', 'banner hidden', app);
  element('btn-root', 'btn btn-warning', banner);
  for (const id of ['status-dot', 'status-text', 'status-count', 'status-updated', 'status-persist']) {
    element(id, '', app);
  }
  for (const list of ['lite', 'full']) {
    const radio = element('list-' + list, 'radio', app, { 'data-list': list });
    radio.badge = element(null, 'badge hidden', radio);
  }
  element('btn-enable', 'btn btn-primary', app);
  element('btn-disable', 'btn btn-danger', app);
  element('btn-update', 'btn', app);
  element('message-text', 'message-text', app);
  element('message-warning', 'message-warning', app);
  element('overlay', 'overlay hidden');

  doc.getElementById = (id) => doc.byId[id] || null;
  doc.addEventListener = () => {};
  return doc;
}

// Carrega app.js com Luna falso: as chamadas ficam em `calls` e o teste responde com reply(uri, err, resp).
function load() {
  const clock = fakeClock();
  const doc = fakeDocument();
  const calls = [];
  const Luna = {
    isMock: false,
    call(uri, params, cb, timeoutMs) {
      calls.push({ uri, params, cb, timeoutMs, answered: false });
    },
  };
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};
  const context = {
    document: doc,
    Luna,
    SpatialNav: {
      init() {},
      focus(el) {
        el.focus();
      },
    },
    XMLHttpRequest,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    JSON,
    Date,
    Error,
    String,
    isNaN,
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);

  function pending(uri) {
    return calls.filter((c) => c.uri === uri && !c.answered);
  }

  return {
    doc,
    clock,
    calls,
    pending,
    reply(uri, err, resp) {
      const call = pending(uri)[0];
      assert.ok(call, 'nenhuma chamada pendente para ' + uri);
      call.answered = true;
      call.cb(err, resp);
    },
  };
}

const NO_ROOT_STATUS = { returnValue: true, active: false, persistent: false, root: false, list: 'lite', count: 0, updatedAt: null };
const ROOT_STATUS = { ...NO_ROOT_STATUS, root: true };

// Do clique em "Conceder root" ate a chamada de restart.
function startGrantRoot(env) {
  env.reply(SERVICE + 'status', null, NO_ROOT_STATUS);
  const btnRoot = env.doc.byId['btn-root'];
  assert.equal(env.doc.activeElement, btnRoot, 'foco inicial no Conceder root');
  btnRoot.click();
  env.reply(HBCHANNEL + 'getConfiguration', null, { returnValue: true, root: true });
  env.reply(HBCHANNEL + 'elevateService', null, { returnValue: true });
  assert.equal(env.pending(SERVICE + 'restart').length, 1);
}

test('grant root success moves focus to "Ativar Bloqueio"', () => {
  const env = load();
  startGrantRoot(env);
  env.reply(SERVICE + 'restart', null, { returnValue: true });
  env.clock.advance(2000);
  env.reply(SERVICE + 'status', null, ROOT_STATUS);

  assert.equal(env.doc.byId['message-text'].textContent, 'Root concedido ao serviço');
  assert.equal(env.doc.byId['root-banner'].offsetWidth, 0, 'banner escondido');
  assert.equal(env.doc.activeElement, env.doc.byId['btn-enable']);
});

test('grant root continues when restart never replies (4 s)', () => {
  const env = load();
  startGrantRoot(env);

  env.clock.advance(3999);
  assert.equal(env.pending(SERVICE + 'status').length, 0);
  env.clock.advance(1); // prazo do restart
  env.clock.advance(2000); // re-status
  assert.equal(env.pending(SERVICE + 'status').length, 1);
  env.reply(SERVICE + 'status', null, ROOT_STATUS);
  assert.equal(env.doc.byId['message-text'].textContent, 'Root concedido ao serviço');
  assert.equal(env.doc.byId['overlay'].offsetWidth, 0, 'overlay fechado');

  // Resposta atrasada do restart nao dispara um segundo re-status.
  env.reply(SERVICE + 'restart', null, { returnValue: true });
  env.clock.advance(10000);
  assert.equal(env.pending(SERVICE + 'status').length, 0);
});

test('grant root with a prompt restart reply re-checks status only once', () => {
  const env = load();
  startGrantRoot(env);
  env.reply(SERVICE + 'restart', new Error('serviço encerrado'), { returnValue: false });

  env.clock.advance(10000);
  assert.equal(env.pending(SERVICE + 'status').length, 1);
});
