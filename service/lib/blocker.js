'use strict';

// Orquestrador do bloqueio: status/enable/disable/update sobre hosts, startup.sh, mounts e estado.
// Dependencias injetaveis: deps = {fs, exec, download, isRoot(), now(), paths, liteUrl, fullUrl}
// com paths = {hosts, block, state, startup, liteList}. Callbacks cb(err, resp), sendo
// resp = {active, persistent, root, list, count, updatedAt, warning?}; em erro, resp traz o status atual.

var hostsLib = require('./hosts');
var startup = require('./startup');
var mountsLib = require('./mounts');
var stateLib = require('./state');

var NO_ROOT = 'Serviço sem root. Use \'Conceder root\'.';
var INACTIVE = 'Bloqueio inativo';
var INVALID_LIST = 'Lista inválida';
var LISTS = ['lite', 'full'];

function prefixed(prefix, err) {
  return new Error(prefix + ': ' + (err && err.message ? err.message : String(err)));
}

function createBlocker(deps) {
  var fs = deps.fs;
  var paths = deps.paths;
  var mounts = mountsLib.createMounts({
    fs: fs,
    exec: deps.exec,
    hostsPath: paths.hosts,
    blockPath: paths.block
  });

  // --- Fila FIFO: uma operacao por vez; cada job chama done exatamente uma vez. ---

  var queue = [];
  var busy = false;

  function enqueue(job, cb) {
    queue.push({ job: job, cb: typeof cb === 'function' ? cb : function () {} });
    if (!busy) runNext();
  }

  function runNext() {
    var item = queue.shift();
    var finished = false;
    if (!item) {
      busy = false;
      return;
    }
    busy = true;

    function done(err, resp) {
      if (finished) return;
      finished = true;
      if (err && resp === undefined) resp = safeStatus();
      try {
        item.cb(err || null, resp);
      } finally {
        runNext();
      }
    }

    try {
      item.job(done);
    } catch (err) {
      done(err);
    }
  }

  // Envolve um callback assincrono: excecao vira done(err) em vez de derrubar o processo.
  function guard(done, fn) {
    return function () {
      try {
        fn.apply(null, arguments);
      } catch (err) {
        done(err);
      }
    };
  }

  // --- Leitura de status ---

  function readState() {
    return stateLib.readState(fs, paths.state);
  }

  function saveState(state) {
    try {
      stateLib.writeState(fs, paths.state, state);
    } catch (err) {
      throw prefixed('Falha ao gravar ' + paths.state, err);
    }
  }

  function isPersistent() {
    try {
      return fs.existsSync(paths.startup) && startup.hasBlock(fs.readFileSync(paths.startup, 'binary'));
    } catch (err) {
      return false;
    }
  }

  function buildStatus() {
    var state = readState();
    return {
      active: mounts.isOurMount(),
      persistent: isPersistent(),
      root: deps.isRoot() === true,
      list: state.list,
      count: state.count,
      updatedAt: state.updatedAt
    };
  }

  function safeStatus() {
    try {
      return buildStatus();
    } catch (err) {
      return undefined;
    }
  }

  function withWarnings(resp, warnings) {
    if (warnings.length > 0) resp.warning = warnings.join(' ');
    return resp;
  }

  // --- Listas ---

  // Leve: baixada; erro ou nenhum dominio -> embutida.
  function loadLite(cb) {
    deps.download(deps.liteUrl, function (err, text) {
      var domains = err ? [] : hostsLib.parseDomains(text);
      var embedded;
      if (domains.length > 0) {
        cb(null, domains);
        return;
      }
      try {
        embedded = fs.readFileSync(paths.liteList, 'utf8');
      } catch (readErr) {
        cb(prefixed('Falha ao ler a lista embutida', readErr));
        return;
      }
      cb(null, hostsLib.parseDomains(embedded));
    });
  }

  // Completa = leve + StevenBlack; falha no download da completa e erro.
  function loadDomains(list, done, cb) {
    loadLite(guard(done, function (err, lite) {
      if (err || list === 'lite') {
        cb(err, lite);
        return;
      }
      deps.download(deps.fullUrl, guard(done, function (fullErr, text) {
        if (fullErr) {
          cb(prefixed('Falha ao baixar a lista completa', fullErr));
          return;
        }
        cb(null, lite.concat(hostsLib.parseDomains(text)));
      }));
    }));
  }

  // Base do hosts: com o nosso mount ativo, o proprio hosts.block (buildHostsFile tira o bloco antigo);
  // senao, o /etc/hosts atual (inclui o bloqueio de updates do HBChannel, se montado).
  function readBase() {
    if (mounts.isOurMount()) return fs.readFileSync(paths.block, 'utf8');
    try {
      return fs.readFileSync(paths.hosts, 'utf8');
    } catch (err) {
      return '';
    }
  }

  function removeQuietly(path) {
    try {
      fs.unlinkSync(path);
    } catch (err) {
      // melhor esforco
    }
  }

  // --- Troca do hosts.block montado ---

  // tmp -> (desmonta o nosso) -> rename -> mount. O bind aponta para o inode, por isso o rename.
  function swapBlock(tmp, done, cb) {
    var wasMounted = mounts.isOurMount();
    if (!wasMounted) {
      install(tmp, false, done, cb);
      return;
    }
    mounts.unmountOurs(guard(done, function (err) {
      if (err) {
        removeQuietly(tmp);
        cb(err);
        return;
      }
      install(tmp, true, done, cb);
    }));
  }

  function install(tmp, wasMounted, done, cb) {
    try {
      fs.renameSync(tmp, paths.block);
    } catch (err) {
      removeQuietly(tmp);
      var failure = prefixed('Falha ao gravar ' + paths.block, err);
      if (!wasMounted) {
        cb(failure);
        return;
      }
      // Rollback: o hosts.block anterior continua no lugar; remonta.
      mounts.mount(function () {
        cb(failure);
      });
      return;
    }
    mounts.mount(guard(done, function (err) {
      if (!err) {
        cb(null);
        return;
      }
      // Rollback: uma nova tentativa de montar.
      mounts.mount(function () {
        cb(prefixed('Falha ao montar ' + paths.hosts, err));
      });
    }));
  }

  // --- Operacoes ---

  // Monta a lista inteira antes de tocar no disco: falha de download/montagem deixa tudo como estava.
  function applyList(list, done) {
    loadDomains(list, done, guard(done, function (err, domains) {
      if (err) {
        done(err);
        return;
      }
      var updatedAt = deps.now().toISOString();
      var built = hostsLib.buildHostsFile(readBase(), domains, { list: list, date: updatedAt });
      var tmp = paths.block + '.tmp';
      try {
        fs.writeFileSync(tmp, built.text, 'utf8');
      } catch (writeErr) {
        removeQuietly(tmp);
        done(prefixed('Falha ao gravar ' + paths.block, writeErr));
        return;
      }
      swapBlock(tmp, done, guard(done, function (swapErr) {
        if (swapErr) {
          done(swapErr);
          return;
        }
        var warnings = [];
        try {
          var boot = startup.ensureBlock(fs, paths.startup);
          if (boot.warning) warnings.push(boot.warning);
        } catch (bootErr) {
          warnings.push('Falha ao gravar startup.sh: ' + bootErr.message);
        }
        saveState({
          enabled: true,
          list: list,
          count: built.count,
          updatedAt: updatedAt
        });
        done(null, withWarnings(buildStatus(), warnings));
      }));
    }));
  }

  function hasRoot() {
    return deps.isRoot() === true;
  }

  function enableJob(opts, done) {
    if (!hasRoot()) {
      done(new Error(NO_ROOT));
      return;
    }
    var list = opts && opts.list != null ? opts.list : 'lite';
    if (LISTS.indexOf(list) === -1) {
      done(new Error(INVALID_LIST));
      return;
    }
    applyList(list, done);
  }

  function updateJob(opts, done) {
    if (!hasRoot()) {
      done(new Error(NO_ROOT));
      return;
    }
    var state = readState();
    if (!state.enabled) {
      done(new Error(INACTIVE));
      return;
    }
    var list = opts && opts.list != null ? opts.list : state.list;
    if (LISTS.indexOf(list) === -1) {
      done(new Error(INVALID_LIST));
      return;
    }
    applyList(list, done);
  }

  // Apaga hosts.block antes de limpar o startup.sh: o bloco de boot so monta arquivo nao vazio.
  function disableJob(done) {
    if (!hasRoot()) {
      done(new Error(NO_ROOT));
      return;
    }
    mounts.unmountOurs(guard(done, function (err) {
      if (err) {
        done(err);
        return;
      }
      try {
        fs.unlinkSync(paths.block);
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
      }
      var warnings = [];
      try {
        startup.dropBlock(fs, paths.startup);
      } catch (bootErr) {
        warnings.push('Falha ao limpar startup.sh: ' + bootErr.message);
      }
      var state = readState();
      saveState({
        enabled: false,
        list: state.list,
        count: 0,
        updatedAt: state.updatedAt
      });
      done(null, withWarnings(buildStatus(), warnings));
    }));
  }

  function hasBlockContent() {
    try {
      return fs.statSync(paths.block).size > 0;
    } catch (err) {
      return false;
    }
  }

  // Com root e bloqueio ligado: remonta o hosts.block se preciso e recoloca o bloco no startup.sh.
  // Falhas do auto-reparo viram warning; o status em si nao falha por elas.
  function statusJob(done) {
    var resp = buildStatus();
    var warnings = [];
    if (!resp.root || !readState().enabled) {
      done(null, resp);
      return;
    }

    function healStartup() {
      if (!isPersistent()) {
        try {
          var boot = startup.ensureBlock(fs, paths.startup);
          if (boot.warning) warnings.push(boot.warning);
        } catch (bootErr) {
          warnings.push('Falha ao gravar startup.sh: ' + bootErr.message);
        }
      }
      done(null, withWarnings(buildStatus(), warnings));
    }

    if (resp.active || !hasBlockContent()) {
      healStartup();
      return;
    }
    mounts.mount(guard(done, function (err) {
      if (err) warnings.push(prefixed('Falha ao montar ' + paths.hosts, err).message);
      healStartup();
    }));
  }

  return {
    status: function (cb) {
      enqueue(statusJob, cb);
    },
    enable: function (opts, cb) {
      enqueue(function (done) {
        enableJob(opts, done);
      }, cb);
    },
    disable: function (cb) {
      enqueue(disableJob, cb);
    },
    update: function (opts, cb) {
      enqueue(function (done) {
        updateJob(opts, done);
      }, cb);
    }
  };
}

module.exports = { createBlocker: createBlocker };
