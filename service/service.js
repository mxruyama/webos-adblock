'use strict';

// Camada Luna do servico: so liga os metodos ao blocker (lib/blocker.js); nenhuma logica aqui.

var fs = require('fs');
var path = require('path');
var https = require('https');
var childProcess = require('child_process');
var Service = require('webos-service');
var createBlocker = require('./lib/blocker').createBlocker;
var createDownloader = require('./lib/download').createDownloader;
var splitPemBundle = require('./lib/certs').splitPemBundle;

var SERVICE_ID = 'org.community.webos.adblocker.service';
var LITE_URL = 'https://mxruyama.github.io/webos-adblock/lists/lite.txt';
var FULL_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts';
var EXEC_TIMEOUT_MS = 30000;
var DOWNLOAD_TIMEOUT_MS = 60000;
var RESTART_DELAY_MS = 200;

function exec(cmd, args, cb) {
  childProcess.execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS }, function (err, stdout, stderr) {
    cb(err ? new Error(String(stderr || '').trim() || err.message) : null, stdout);
  });
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// Bundle Mozilla quebrado em certificados; sem ele o https usa as CAs do Node (e cai para curl/wget).
function readCa() {
  try {
    return splitPemBundle(fs.readFileSync(path.join(__dirname, 'certs', 'cacert.pem'), 'utf8'));
  } catch (err) {
    return undefined;
  }
}

function extend(target, source) {
  var key;
  for (key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
  }
  return target;
}

var downloader = createDownloader({
  https: https,
  execFile: childProcess.execFile,
  ca: readCa(),
  timeoutMs: DOWNLOAD_TIMEOUT_MS
});

var blocker = createBlocker({
  fs: fs,
  exec: exec,
  download: downloader.download,
  isRoot: isRoot,
  now: function () {
    return new Date();
  },
  paths: {
    hosts: '/etc/hosts',
    block: '/var/lib/webosbrew/hosts.block',
    state: '/var/lib/webosbrew/adblocker.json',
    startup: '/var/lib/webosbrew/startup.sh',
    liteList: path.join(__dirname, 'lists', 'lite.txt')
  },
  liteUrl: LITE_URL,
  fullUrl: FULL_URL
});

// Responde exatamente uma vez: {returnValue: true, ...resp} ou {returnValue: false, errorText, ...status}.
function handle(message, operation) {
  var answered = false;
  function reply(err, resp) {
    if (answered) return;
    answered = true;
    var out = extend({ returnValue: !err }, resp || {});
    if (err) out.errorText = err.message || String(err);
    message.respond(out);
  }
  try {
    operation(message.payload || {}, reply);
  } catch (err) {
    reply(err);
  }
}

var service = new Service(SERVICE_ID);

service.register('status', function (message) {
  handle(message, function (payload, reply) {
    blocker.status(reply);
  });
});

service.register('enable', function (message) {
  handle(message, function (payload, reply) {
    blocker.enable({ list: payload.list }, reply);
  });
});

service.register('disable', function (message) {
  handle(message, function (payload, reply) {
    blocker.disable(reply);
  });
});

service.register('update', function (message) {
  handle(message, function (payload, reply) {
    blocker.update({ list: payload.list }, reply);
  });
});

// Encerra o processo para o servico renascer como root depois do elevateService.
service.register('restart', function (message) {
  message.respond({ returnValue: true });
  setTimeout(function () {
    process.exit(0);
  }, RESTART_DELAY_MS);
});
