'use strict';

// Teste de integracao REAL do servico: Linux + root, mount --bind de verdade sobre /etc/hosts,
// resolvedor glibc (getent) e o startup.sh executado pelo sh. Roda no CI (job "integration") em
// Node 0.12.18 (runtime do webOS 3) e 22.
// ATENCAO: mexe no /etc/hosts e em /var/lib/webosbrew/* da maquina; use so em runner descartavel.
//
// Uso: sudo env "PATH=$PATH" node test/integration/linux-root.js
//
// ES5 puro e so modulos nativos + codigo do servico (nada de node_modules). Imprime "ok - <passo>" a cada
// passo; na primeira falha imprime "not ok - <passo>: <detalhes>", um diagnostico ("# ..."), limpa
// (disable + umount das camadas extras de /etc/hosts) e sai com 1. Sai com 2 se nao for Linux + root.

var fs = require('fs');
var https = require('https');
var childProcess = require('child_process');
var runtime = require('../../service/lib/runtime');
var createDownloader = require('../../service/lib/download').createDownloader;
var STARTUP_BEGIN = require('../../service/lib/startup').BEGIN;

var HOSTS = '/etc/hosts';
var HB_HOSTS = '/tmp/hosts';
var WEBOSBREW_DIR = '/var/lib/webosbrew';
var BLOCK = '/var/lib/webosbrew/hosts.block';
var STATE = '/var/lib/webosbrew/adblocker.json';
var STARTUP = '/var/lib/webosbrew/startup.sh';
var HOSTS_MARKER = '# >>> webos-adblock';
var MISSING_LITE_URL = 'https://mxruyama.github.io/webos-adblock/__nao_existe__/lite.txt';
var STARTUP_TEXT = '#!/bin/sh\necho boot\n';
var MODE_755 = parseInt('755', 8);
var PERMISSION_BITS = parseInt('777', 8);
var ONE_MB = 1024 * 1024;
var STEP_TIMEOUT_MS = 5 * 60 * 1000;
var CLEANUP_TIMEOUT_MS = 30 * 1000;
var MAX_CLEANUP_UMOUNTS = 5;

if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) {
  console.error('Recusado: este teste só roda em Linux como root (faz mount --bind sobre /etc/hosts).');
  console.error('Uso: sudo env "PATH=$PATH" node test/integration/linux-root.js');
  process.exit(2);
}

// Lista leve aponta para uma URL inexistente: o enable tem de cair na lista embutida.
var blocker = runtime.createRuntimeBlocker({ liteUrl: MISSING_LITE_URL });

// Linha de base, preenchida no passo 1: copias para comparar e quantas camadas /etc/hosts ja tinha.
var original = { hosts: null, startupHex: null, hostsMounts: null };

// --- Utilitarios ---

function describe(err) {
  return err && err.message ? err.message : String(err);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function hex(file) {
  return fs.readFileSync(file).toString('hex');
}

function modeOf(file) {
  return fs.statSync(file).mode & PERMISSION_BITS;
}

function removeIfExists(file) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function hasLine(text, line) {
  return text.split(/\r?\n/).indexOf(line) !== -1;
}

// Comando sincrono; o erro traz o stderr.
function sh(cmd, args) {
  try {
    return String(childProcess.execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    throw new Error(cmd + ' ' + args.join(' ') + ' falhou: ' + (String(err.stderr || '').trim() || describe(err)));
  }
}

function shQuietly(cmd, args) {
  try {
    return sh(cmd, args).trim();
  } catch (err) {
    return describe(err);
  }
}

// Linhas de /proc/mounts cujo ponto de montagem e /etc/hosts (uma por camada empilhada).
function hostsMounts() {
  return read('/proc/mounts').split('\n').filter(function (line) {
    return line.split(' ')[1] === HOSTS;
  });
}

// `getent hosts` passa pelo nsswitch (files = /etc/hosts), como as libs do sistema: toda linha tem de ser 0.0.0.0.
function checkResolvesToZero(domain) {
  var output = shQuietly('getent', ['hosts', domain]);
  var lines = output === '' ? [] : output.split('\n');
  var allZero = lines.length > 0 && lines.every(function (line) {
    return line.split(/\s+/)[0] === '0.0.0.0';
  });
  if (!allZero) {
    throw new Error('getent hosts ' + domain + ' devolveu "' + output + '" (esperado 0.0.0.0); ' +
      'getent ahostsv4: "' + shQuietly('getent', ['ahostsv4', domain]) + '"');
  }
}

// Chama blocker[method] e passa a resposta para verify; erro do blocker ou excecao em verify falham o passo.
// (O blocker engole excecoes lancadas dentro do callback, por isso o try/catch aqui.)
function callBlocker(method, opts, done, verify) {
  function onReply(err, resp) {
    try {
      if (resp && resp.warning) console.log('# aviso do ' + method + ': ' + resp.warning);
      if (err) throw new Error(method + ' falhou: ' + describe(err) + ' | resp = ' + JSON.stringify(resp));
      verify(resp);
    } catch (failure) {
      done(failure);
      return;
    }
    done(null);
  }
  if (opts === null) blocker[method](onReply);
  else blocker[method](opts, onReply);
}

// https real que guarda o motivo de cada falha (o downloader so repassa a mensagem da ultima tentativa).
function httpsWithErrorLog(log) {
  return {
    get: function (options, onResponse) {
      var req = https.get(options, function (res) {
        if (res.statusCode >= 400) log.push('HTTP ' + res.statusCode);
        onResponse(res);
      });
      req.on('error', function (err) {
        log.push(describe(err));
      });
      return req;
    }
  };
}

// --- Passos ---

var steps = [];

function step(name, fn) {
  steps.push({ name: name, fn: fn });
}

step('1. startup.sh mínimo (0755), estado limpo e cópias para comparação', function (done) {
  original.hostsMounts = hostsMounts().length;
  original.hosts = read(HOSTS);
  sh('mkdir', ['-p', WEBOSBREW_DIR]);
  removeIfExists(BLOCK);
  removeIfExists(STATE);
  fs.writeFileSync(STARTUP, STARTUP_TEXT);
  fs.chmodSync(STARTUP, MODE_755);
  original.startupHex = hex(STARTUP);
  check(modeOf(STARTUP) === MODE_755, 'startup.sh com modo ' + modeOf(STARTUP).toString(8) + ', esperado 755');
  done(null);
});

step('2. bloqueio de updates do HBChannel: /tmp/hosts (+ snu.lge.com) montado sobre /etc/hosts', function (done) {
  var base = original.hosts;
  if (base !== '' && base.charAt(base.length - 1) !== '\n') base += '\n';
  fs.writeFileSync(HB_HOSTS, base + '127.0.0.1 snu.lge.com\n');
  sh('mount', ['--bind', HB_HOSTS, HOSTS]);
  check(hostsMounts().length === original.hostsMounts + 1, 'o mount do /tmp/hosts não apareceu em /proc/mounts');
  check(read(HOSTS) === read(HB_HOSTS), '/etc/hosts não mostra o conteúdo de /tmp/hosts');
  done(null);
});

step('3. status: inativo e com root', function (done) {
  callBlocker('status', null, done, function (resp) {
    check(resp.active === false, 'active = ' + resp.active + ', esperado false');
    check(resp.root === true, 'root = ' + resp.root + ', esperado true');
  });
});

step('4. enable lite (URL inexistente -> lista embutida): ativo, persistente, >= 200 domínios, resolvedor bloqueia', function (done) {
  callBlocker('enable', { list: 'lite' }, done, function (resp) {
    check(resp.active === true, 'active = ' + resp.active + ', esperado true');
    check(resp.persistent === true, 'persistent = ' + resp.persistent + ', esperado true');
    check(resp.count >= 200, 'count = ' + resp.count + ', esperado >= 200');
    var hosts = read(HOSTS);
    check(hosts.indexOf('snu.lge.com') !== -1, '/etc/hosts perdeu snu.lge.com (camada do HBChannel)');
    check(hosts.indexOf('localhost') !== -1, '/etc/hosts sem localhost');
    check(hasLine(hosts, '0.0.0.0 ad.lgappstv.com'), '/etc/hosts sem a linha "0.0.0.0 ad.lgappstv.com"');
    check(read(STARTUP).indexOf(STARTUP_BEGIN) !== -1, 'startup.sh sem o bloco de boot');
    checkResolvesToZero('ad.lgappstv.com');
  });
});

step('5. download só por https (curl/wget desativados, CA em array) da lista completa: > 1 MB', function (done) {
  var ca = runtime.loadCa();
  var httpsErrors = [];
  check(ca instanceof Array && ca.length > 0, 'loadCa() não devolveu os certificados');
  var downloader = createDownloader({
    https: httpsWithErrorLog(httpsErrors),
    execFile: function (cmd, args, options, cb) {
      cb(new Error(cmd + ' desativado no teste'));
    },
    ca: ca,
    timeoutMs: 60000
  });
  downloader.download(runtime.FULL_URL, function (err, text) {
    try {
      check(!err, describe(err) + ' | falhas do https: ' + (httpsErrors.join('; ') || 'nenhuma registrada'));
      var size = Buffer.byteLength(text, 'utf8');
      check(size > ONE_MB, 'baixou ' + size + ' bytes, esperado > 1 MB');
    } catch (failure) {
      done(failure);
      return;
    }
    done(null);
  });
});

step('6. enable full: > 50000 domínios e ad.doubleclick.net bloqueado no resolvedor', function (done) {
  callBlocker('enable', { list: 'full' }, done, function (resp) {
    check(resp.active === true, 'active = ' + resp.active + ', esperado true');
    check(resp.list === 'full', 'list = ' + resp.list + ', esperado full');
    check(resp.count > 50000, 'count = ' + resp.count + ', esperado > 50000');
    checkResolvesToZero('ad.doubleclick.net');
  });
});

step('7. update lite: < 1000 domínios e continua ativo', function (done) {
  callBlocker('update', { list: 'lite' }, done, function (resp) {
    check(resp.active === true, 'active = ' + resp.active + ', esperado true');
    check(resp.list === 'lite', 'list = ' + resp.list + ', esperado lite');
    check(resp.count < 1000, 'count = ' + resp.count + ', esperado < 1000');
  });
});

step('8. reboot simulado: umount de uma camada, sh startup.sh remonta, status ativo', function (done) {
  sh('umount', [HOSTS]);
  check(read(HOSTS) === read(HB_HOSTS), 'depois do umount o /etc/hosts deveria ser o /tmp/hosts (camada do HBChannel)');
  var output = sh('sh', [STARTUP]);
  check(output.indexOf('boot') !== -1, 'startup.sh não executou o conteúdo original (saída: "' + output + '")');
  // Antes do status, que remontaria sozinho (auto-reparo): prova que foi o startup.sh.
  check(read(HOSTS).indexOf(HOSTS_MARKER) !== -1, 'startup.sh não remontou o hosts.block sobre /etc/hosts');
  callBlocker('status', null, done, function (resp) {
    check(resp.active === true, 'active = ' + resp.active + ', esperado true');
  });
});

step('9. disable: camada do HBChannel intacta, startup.sh original byte a byte, hosts.block removido', function (done) {
  callBlocker('disable', null, done, function (resp) {
    check(resp.active === false, 'active = ' + resp.active + ', esperado false');
    var hosts = read(HOSTS);
    check(hosts === read(HB_HOSTS), '/etc/hosts difere de /tmp/hosts');
    check(hosts.indexOf(HOSTS_MARKER) === -1, '/etc/hosts ainda tem "' + HOSTS_MARKER + '"');
    check(hostsMounts().length === original.hostsMounts + 1, 'esperada só a camada do HBChannel sobre /etc/hosts');
    check(hex(STARTUP) === original.startupHex, 'startup.sh difere do original: ' + JSON.stringify(read(STARTUP)));
    check(modeOf(STARTUP) === MODE_755, 'startup.sh com modo ' + modeOf(STARTUP).toString(8) + ', esperado 755');
    check(!fs.existsSync(BLOCK), 'hosts.block não foi removido');
  });
});

step('10. limpeza: umount da camada do HBChannel', function (done) {
  sh('umount', [HOSTS]);
  check(hostsMounts().length === original.hostsMounts, 'ainda há camadas extras sobre /etc/hosts');
  check(read(HOSTS) === original.hosts, '/etc/hosts não voltou ao original');
  done(null);
});

// --- Diagnostico e limpeza em caso de falha ---

function printBlock(title, produce) {
  var text;
  try {
    text = String(produce());
  } catch (err) {
    text = '(erro: ' + describe(err) + ')';
  }
  console.log('# ' + title + ':');
  text.replace(/\s+$/, '').split('\n').forEach(function (line) {
    console.log('#   ' + line);
  });
}

// Primeiras linhas + resumo (o hosts com a lista completa tem dezenas de milhares de linhas).
function headOf(file, count) {
  var text = read(file);
  var lines = text.split('\n');
  return lines.slice(0, count).join('\n') + '\n(' + lines.length + ' linhas; bloco "' + HOSTS_MARKER + '": ' +
    (text.indexOf(HOSTS_MARKER) !== -1 ? 'presente' : 'ausente') + ')';
}

function diagnose() {
  printBlock('node', function () {
    return process.version;
  });
  printBlock('/proc/mounts | grep hosts', function () {
    return read('/proc/mounts').split('\n').filter(function (line) {
      return line.indexOf('hosts') !== -1;
    }).join('\n');
  });
  printBlock(HOSTS + ' (início)', function () {
    return headOf(HOSTS, 30);
  });
  printBlock(HB_HOSTS + ' (início)', function () {
    return headOf(HB_HOSTS, 30);
  });
  printBlock('ls -la ' + WEBOSBREW_DIR, function () {
    return sh('ls', ['-la', WEBOSBREW_DIR]);
  });
  printBlock(STARTUP, function () {
    return read(STARTUP);
  });
  printBlock(STATE, function () {
    return read(STATE);
  });
}

// Desmonta o que estiver acima da linha de base de /etc/hosts (nossa camada que sobrou e a do HBChannel).
function popExtraHostsMounts() {
  var attempts = 0;
  if (original.hostsMounts === null) return;
  while (attempts < MAX_CLEANUP_UMOUNTS && hostsMounts().length > original.hostsMounts) {
    attempts += 1;
    console.log('# limpeza: ' + (shQuietly('umount', [HOSTS]) || 'umount ' + HOSTS));
  }
  console.log('# limpeza: camadas sobre ' + HOSTS + ': ' + hostsMounts().length + ' (linha de base ' + original.hostsMounts + ')');
}

// Melhor esforco: disable pelo blocker (tira a nossa camada, o hosts.block e o bloco do startup.sh),
// depois umount do que sobrar. O disable pode ficar preso atras de um passo travado: tem prazo.
function cleanup(cb) {
  var finished = false;
  var timer;

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try {
      popExtraHostsMounts();
    } catch (err) {
      console.log('# limpeza: ' + describe(err));
    }
    cb();
  }

  console.log('# limpeza: disable + umount das camadas extras de ' + HOSTS);
  timer = setTimeout(function () {
    console.log('# limpeza: disable não respondeu em ' + CLEANUP_TIMEOUT_MS / 1000 + ' s');
    finish();
  }, CLEANUP_TIMEOUT_MS);
  try {
    blocker.disable(function (err) {
      if (err) console.log('# limpeza: disable falhou: ' + describe(err));
      finish();
    });
  } catch (err) {
    console.log('# limpeza: disable lançou: ' + describe(err));
    finish();
  }
}

// --- Execucao sequencial ---

var aborting = false;
var currentStep = '(início)';

function abort(name, err) {
  if (aborting) {
    console.log('# erro durante a limpeza: ' + describe(err));
    return;
  }
  aborting = true;
  console.log('not ok - ' + name + ': ' + describe(err));
  diagnose();
  cleanup(function () {
    process.exit(1);
  });
}

function runFrom(index) {
  if (index >= steps.length) {
    console.log('# ' + steps.length + ' passos ok (node ' + process.version + ')');
    process.exit(0);
    return;
  }
  var item = steps[index];
  var settled = false;
  var timer = setTimeout(function () {
    settle(new Error('tempo esgotado (' + STEP_TIMEOUT_MS / 1000 + ' s)'));
  }, STEP_TIMEOUT_MS);
  currentStep = item.name;

  function settle(err) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (err) {
      abort(item.name, err);
      return;
    }
    console.log('ok - ' + item.name);
    setImmediate(function () {
      runFrom(index + 1);
    });
  }

  try {
    item.fn(settle);
  } catch (err) {
    settle(err);
  }
}

process.on('uncaughtException', function (err) {
  abort(currentStep, err && err.stack ? err.stack : err);
});

console.log('# node ' + process.version + ', ' + process.platform + ', uid ' + process.getuid());
runFrom(0);
