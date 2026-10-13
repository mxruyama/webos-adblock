/*
 * Chamadas Luna via PalmServiceBridge. Com ?mock=1 (ou fora da TV, sem PalmServiceBridge)
 * usa um servico simulado em memoria, com latencia, para testar a interface no navegador.
 * ES5 puro (Chrome 38 / webOS 3).
 */
(function (global) {
  'use strict';

  var SERVICE = 'luna://org.community.webos.adblocker.service/';
  var HBCHANNEL = 'luna://org.webosbrew.hbchannel.service/';
  var SERVICE_ID = 'org.community.webos.adblocker.service';
  var MOCK_LATENCY_MS = 300;
  // Mais que o pior caso do servico (cadeia de downloads com retentativas); restart usa um prazo proprio.
  var DEFAULT_TIMEOUT_MS = 420000;
  var TIMEOUT_TEXT = 'Tempo esgotado aguardando o serviço';

  function queryHas(name) {
    var search = (global.location && global.location.search) || '';
    return new RegExp('[?&]' + name + '=1(&|$)').test(search);
  }

  var useMock = queryHas('mock') || typeof global.PalmServiceBridge === 'undefined';

  // Converte a resposta Luna em cb(err, resp); returnValue false vira erro (resp segue junto).
  function deliver(cb, resp) {
    if (!resp || resp.returnValue === false) {
      var err = new Error((resp && resp.errorText) || 'Erro desconhecido');
      cb(err, resp || null);
      return;
    }
    cb(null, resp);
  }

  // --- Ponte real ---

  // Mantem referencia as pontes ate a resposta chegar (senao o GC pode coleta-las).
  var pendingBridges = [];

  function releaseBridge(bridge) {
    for (var i = 0; i < pendingBridges.length; i++) {
      if (pendingBridges[i] === bridge) {
        pendingBridges.splice(i, 1);
        return;
      }
    }
  }

  // Entrega a resposta em cb e devolve cancel(), que solta a ponte (resposta tardia e ignorada).
  // Falha ao criar a ponte ou ao chamar vira resposta de erro.
  function bridgeCall(uri, params, cb) {
    var bridge = null;
    var answered = false;

    function cancel() {
      answered = true;
      if (bridge) releaseBridge(bridge);
    }

    try {
      bridge = new global.PalmServiceBridge();
      pendingBridges.push(bridge);
      bridge.onservicecallback = function (msg) {
        if (answered) return;
        cancel();
        var resp;
        try {
          resp = JSON.parse(msg);
        } catch (e) {
          resp = { returnValue: false, errorText: 'Resposta inválida do serviço' };
        }
        deliver(cb, resp);
      };
      bridge.call(uri, JSON.stringify(params || {}));
    } catch (err) {
      if (answered) throw err; // excecao do proprio cb numa resposta sincrona: nao e falha da ponte
      cancel();
      deliver(cb, {
        returnValue: false,
        errorText: 'Falha ao chamar o serviço: ' + (err && err.message ? err.message : String(err))
      });
    }
    return cancel;
  }

  // --- Mock em memoria ---

  var MOCK_COUNTS = { lite: 312, full: 81234 };
  var NO_ROOT_TEXT = 'Serviço sem root. Use \'Conceder root\'.';
  var NO_PERSIST_WARNING = 'startup.sh não encontrado; o bloqueio não persistirá após reiniciar';

  // ?mock=1&warn=1 simula TV sem startup.sh (persistent false + warning).
  var mock = {
    root: false,
    elevatePending: false,
    active: false,
    persistent: !queryHas('warn'),
    list: 'lite',
    count: 0,
    updatedAt: null
  };

  function mockStatus() {
    var resp = {
      returnValue: true,
      active: mock.active,
      persistent: mock.persistent,
      root: mock.root,
      list: mock.list,
      count: mock.count,
      updatedAt: mock.updatedAt
    };
    // Como o servico: o aviso so vem com root e bloqueio ligado.
    if (!mock.persistent && mock.root && mock.active) resp.warning = NO_PERSIST_WARNING;
    return resp;
  }

  function mockError(text) {
    var resp = mockStatus();
    resp.returnValue = false;
    resp.errorText = text;
    return resp;
  }

  function mockLoadList(list) {
    mock.list = list;
    mock.count = MOCK_COUNTS[list];
    mock.updatedAt = new Date().toISOString();
  }

  function mockService(method, params) {
    if (method === 'status') return mockStatus();
    if (method === 'restart') {
      var resp = mockStatus();
      if (mock.elevatePending) {
        mock.elevatePending = false;
        mock.root = true;
      }
      return resp;
    }
    if (method !== 'enable' && method !== 'disable' && method !== 'update') {
      return mockError('Método desconhecido: ' + method);
    }
    if (!mock.root) return mockError(NO_ROOT_TEXT);

    var list = params.list === undefined ? null : params.list;
    if (list !== null && !MOCK_COUNTS.hasOwnProperty(list)) return mockError('Lista inválida');

    if (method === 'enable') {
      mockLoadList(list || 'lite');
      mock.active = true;
    } else if (method === 'disable') {
      mock.active = false;
      mock.count = 0;
    } else {
      if (!mock.active) return mockError('Bloqueio inativo');
      mockLoadList(list || mock.list);
    }
    return mockStatus();
  }

  function mockHandle(uri, params) {
    if (uri === HBCHANNEL + 'getConfiguration') {
      return { returnValue: true, root: true };
    }
    if (uri === HBCHANNEL + 'elevateService') {
      if (params.id !== SERVICE_ID) {
        return { returnValue: false, errorText: 'Serviço desconhecido: ' + params.id };
      }
      mock.elevatePending = true;
      return { returnValue: true };
    }
    if (uri.indexOf(SERVICE) === 0) {
      return mockService(uri.substring(SERVICE.length), params);
    }
    return { returnValue: false, errorText: 'Serviço não encontrado: ' + uri };
  }

  function mockCall(uri, params, cb) {
    var timer = global.setTimeout(function () {
      deliver(cb, mockHandle(uri, params || {}));
    }, MOCK_LATENCY_MS);
    return function () {
      global.clearTimeout(timer);
    };
  }

  // Luna.call(uri, params, cb[, timeoutMs]): cb(err, resp) exatamente uma vez. Sem resposta em timeoutMs
  // (padrao 7 min), entrega o erro de tempo esgotado e ignora a resposta que chegar depois.
  function call(uri, params, cb, timeoutMs) {
    var settled = false;
    var cancel = null;
    var timer = global.setTimeout(function () {
      if (settled) return;
      settled = true;
      if (cancel) cancel();
      deliver(cb, { returnValue: false, errorText: TIMEOUT_TEXT });
    }, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);

    function once(err, resp) {
      if (settled) return;
      settled = true;
      global.clearTimeout(timer);
      cb(err, resp);
    }

    cancel = useMock ? mockCall(uri, params, once) : bridgeCall(uri, params, once);
  }

  global.Luna = {
    call: call,
    isMock: useMock
  };
})(this);
