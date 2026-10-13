/*
 * Tela do AdBlocker: consulta o status do servico, ativa/desativa/atualiza o bloqueio
 * e concede root ao servico via Homebrew Channel. ES5 puro (Chrome 38 / webOS 3).
 */
(function (global) {
  'use strict';

  var SERVICE = 'luna://org.community.webos.adblocker.service/';
  var HBCHANNEL = 'luna://org.webosbrew.hbchannel.service/';
  var SERVICE_ID = 'org.community.webos.adblocker.service';
  var RESTATUS_DELAY_MS = 2000;
  var RESTART_TIMEOUT_MS = 4000;

  var doc = global.document;
  var Luna = global.Luna;
  var SpatialNav = global.SpatialNav;

  var els = {};
  var status = null; // ultima resposta de status com campos validos
  var selectedList = 'lite';
  var listFromStatus = false; // a selecao ja foi inicializada com status.list
  var busy = false;
  var initialFocusDone = false;

  // --- Formatacao ---

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatCount(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function countText(n) {
    var num = typeof n === 'number' ? n : 0;
    return formatCount(num) + (num === 1 ? ' domínio bloqueado' : ' domínios bloqueados');
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() +
      ' às ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // --- Estado ---

  function hasStatusFields(resp) {
    return !!resp && typeof resp.active === 'boolean';
  }

  function applyStatus(resp) {
    status = resp;
    if (!listFromStatus && (resp.list === 'lite' || resp.list === 'full')) {
      selectedList = resp.list;
      listFromStatus = true;
    }
  }

  function refreshStatus(cb) {
    Luna.call(SERVICE + 'status', {}, function (err, resp) {
      if (hasStatusFields(resp)) applyStatus(resp);
      cb(err);
    });
  }

  // --- Renderizacao ---

  function setMessage(text, kind, warning) {
    els.messageText.textContent = text || '';
    els.messageText.className = 'message-text' + (kind ? ' is-' + kind : '');
    els.messageWarning.textContent = warning || '';
  }

  function show(el, visible) {
    el.className = el.className.replace(/(^|\s)hidden(\s|$)/g, ' ').replace(/^\s+|\s+$/g, '') +
      (visible ? '' : ' hidden');
  }

  function renderStatus(known, active) {
    els.dot.className = 'dot ' + (!known ? 'dot-unknown' : active ? 'dot-on' : 'dot-off');
    els.statusText.className = 'status-text' + (!known ? '' : active ? ' is-on' : ' is-off');
    els.statusText.textContent = !known ? (busy ? 'Consultando…' : 'Indisponível') : active ? 'Ativo' : 'Inativo';

    if (!known) {
      els.count.textContent = '';
      els.updated.textContent = '';
      els.persist.textContent = '';
      return;
    }

    els.count.textContent = active ? countText(status.count) : 'Nenhum domínio bloqueado';
    els.updated.textContent = status.updatedAt ? 'Atualizado em ' + formatDate(status.updatedAt) : 'Nunca atualizado';

    var persistText = '';
    var persistWarn = false;
    if (status.warning) {
      persistText = status.warning;
      persistWarn = true;
    } else if (active) {
      persistText = status.persistent ?
        'Persistente: volta sozinho após reiniciar a TV' :
        'Não persistente: será perdido ao reiniciar a TV';
      persistWarn = !status.persistent;
    }
    els.persist.textContent = persistText;
    els.persist.className = 'status-meta' + (persistWarn ? ' is-warning' : '');
  }

  function renderLists(active) {
    for (var i = 0; i < els.radios.length; i++) {
      var radio = els.radios[i];
      var list = radio.getAttribute('data-list');
      var selected = list === selectedList;
      radio.className = 'radio' + (selected ? ' is-selected' : '');
      radio.setAttribute('aria-checked', selected ? 'true' : 'false');
      radio.disabled = busy;
      show(radio.querySelector('.badge'), active && status.list === list);
    }
  }

  // Foco inicial: primeiro botao principal habilitado (o "Conceder root" vem antes quando visivel).
  function focusInitial() {
    var order = [els.btnRoot, els.btnEnable, els.btnDisable, els.btnUpdate];
    for (var i = 0; i < order.length; i++) {
      var el = order[i];
      if (!el.disabled && el.offsetWidth > 0) {
        SpatialNav.focus(el);
        initialFocusDone = true;
        return;
      }
    }
  }

  function render() {
    var known = !!status;
    var active = known && status.active === true;

    renderStatus(known, active);
    renderLists(active);
    show(els.rootBanner, known && status.root === false);

    // Sem status conhecido (servico falhou) deixa tudo habilitado; o servico decide.
    els.btnEnable.disabled = busy || (known && active);
    els.btnDisable.disabled = busy || (known && !active);
    els.btnUpdate.disabled = busy || (known && !active);
    els.btnRoot.disabled = busy;

    show(els.overlay, busy);
    els.overlay.setAttribute('aria-hidden', busy ? 'false' : 'true');

    if (!busy && !initialFocusDone) focusInitial();
  }

  function setBusy(value) {
    busy = value;
    render();
  }

  // --- Operacoes ---

  // Executa um metodo do servico, reconsulta o status e mostra o resultado.
  function runOperation(method, params, successText) {
    if (busy) return;
    setMessage('');
    setBusy(true);
    Luna.call(SERVICE + method, params, function (opErr, opResp) {
      refreshStatus(function (statusErr) {
        var opWarning = opResp && opResp.warning;
        var warning = opWarning && !(status && status.warning === opWarning) ? opWarning : '';
        if (opErr) {
          setMessage(opErr.message, 'error', warning);
        } else if (statusErr) {
          setMessage(statusErr.message, 'error', warning);
        } else {
          setMessage(successText, 'success', warning);
        }
        setBusy(false);
      });
    });
  }

  function finishRootFlow(text, kind) {
    setMessage(text, kind);
    setBusy(false);
  }

  // getConfiguration (HBChannel) -> elevateService -> restart -> status apos 2 s.
  function grantRoot() {
    if (busy) return;
    setMessage('');
    setBusy(true);
    Luna.call(HBCHANNEL + 'getConfiguration', {}, function (cfgErr, cfg) {
      if (cfgErr || !cfg || cfg.root !== true) {
        finishRootFlow('TV sem root / Homebrew Channel ausente', 'error');
        return;
      }
      Luna.call(HBCHANNEL + 'elevateService', { id: SERVICE_ID }, function (elevErr) {
        if (elevErr) {
          finishRootFlow('Falha ao conceder root: ' + elevErr.message, 'error');
          return;
        }
        // O servico responde e encerra; o erro (se vier) e esperado e ignorado. Sem resposta em 4 s,
        // segue assim mesmo (o processo pode morrer antes de responder).
        var continued = false;
        var restartTimer = global.setTimeout(afterRestart, RESTART_TIMEOUT_MS);
        function afterRestart() {
          if (continued) return;
          continued = true;
          global.clearTimeout(restartTimer);
          global.setTimeout(function () {
            refreshStatus(function (statusErr) {
              if (statusErr) {
                finishRootFlow(statusErr.message, 'error');
              } else if (status && status.root === true) {
                finishRootFlow('Root concedido ao serviço', 'success');
                // O "Conceder root" sumiu: foco no primeiro botao principal habilitado (Ativar Bloqueio).
                focusInitial();
              } else {
                finishRootFlow('O serviço continua sem root. Reinicie a TV e tente de novo.', 'error');
              }
            });
          }, RESTATUS_DELAY_MS);
        }
        Luna.call(SERVICE + 'restart', {}, afterRestart);
      });
    });
  }

  function selectList(list) {
    if (busy) return;
    selectedList = list;
    render();
  }

  // --- Inicializacao ---

  function loadVersion() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'appinfo.json', true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        // Arquivos locais no webOS respondem com status 0.
        if (xhr.status !== 200 && xhr.status !== 0) return;
        try {
          var info = JSON.parse(xhr.responseText);
          if (info.version) els.version.textContent = 'Versão ' + info.version;
        } catch (e) {
          // sem versao no cabecalho
        }
      };
      xhr.send();
    } catch (e) {
      // sem versao no cabecalho
    }
  }

  function byId(id) {
    return doc.getElementById(id);
  }

  function onClick(el, handler) {
    el.addEventListener('click', handler, false);
  }

  function init() {
    els = {
      app: byId('app'),
      version: byId('version'),
      mockTag: byId('mock-tag'),
      rootBanner: byId('root-banner'),
      btnRoot: byId('btn-root'),
      dot: byId('status-dot'),
      statusText: byId('status-text'),
      count: byId('status-count'),
      updated: byId('status-updated'),
      persist: byId('status-persist'),
      radios: [byId('list-lite'), byId('list-full')],
      btnEnable: byId('btn-enable'),
      btnDisable: byId('btn-disable'),
      btnUpdate: byId('btn-update'),
      messageText: byId('message-text'),
      messageWarning: byId('message-warning'),
      overlay: byId('overlay')
    };

    onClick(els.btnEnable, function () {
      runOperation('enable', { list: selectedList }, 'Bloqueio ativado');
    });
    onClick(els.btnDisable, function () {
      runOperation('disable', {}, 'Bloqueio desativado');
    });
    onClick(els.btnUpdate, function () {
      runOperation('update', { list: selectedList }, 'Listas atualizadas');
    });
    onClick(els.btnRoot, grantRoot);
    for (var i = 0; i < els.radios.length; i++) {
      (function (radio) {
        onClick(radio, function () {
          selectList(radio.getAttribute('data-list'));
        });
      })(els.radios[i]);
    }

    show(els.mockTag, Luna.isMock);
    loadVersion();
    SpatialNav.init(els.app);

    setBusy(true);
    refreshStatus(function (err) {
      if (err) setMessage(err.message, 'error');
      setBusy(false);
    });
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init, false);
  } else {
    init();
  }
})(this);
