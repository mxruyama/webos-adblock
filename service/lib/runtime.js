'use strict';

// Dependencias reais do blocker (fs, mount/umount, downloads, root, relogio) e os caminhos da TV.
// service.js usa createRuntimeBlocker() sem argumentos; o teste de integracao (test/integration/linux-root.js)
// troca so o que precisa: overrides = {paths?, liteUrl?, fullUrl?, execFile?}, sendo execFile o do downloader.

var fs = require('fs');
var path = require('path');
var https = require('https');
var childProcess = require('child_process');
var createBlocker = require('./blocker').createBlocker;
var createDownloader = require('./download').createDownloader;
var splitPemBundle = require('./certs').splitPemBundle;

var SERVICE_DIR = path.join(__dirname, '..');
var LITE_URL = 'https://mxruyama.github.io/webos-adblock/lists/lite.txt';
var FULL_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts';
var EXEC_TIMEOUT_MS = 30000;
var DOWNLOAD_TIMEOUT_MS = 60000;

var DEFAULT_PATHS = {
  hosts: '/etc/hosts',
  block: '/var/lib/webosbrew/hosts.block',
  state: '/var/lib/webosbrew/adblocker.json',
  startup: '/var/lib/webosbrew/startup.sh',
  liteList: path.join(SERVICE_DIR, 'lists', 'lite.txt')
};

function exec(cmd, args, cb) {
  childProcess.execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS }, function (err, stdout, stderr) {
    cb(err ? new Error(String(stderr || '').trim() || err.message) : null, stdout);
  });
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// Bundle Mozilla quebrado em certificados; sem ele o https usa as CAs do Node (e cai para curl/wget).
function loadCa() {
  try {
    return splitPemBundle(fs.readFileSync(path.join(SERVICE_DIR, 'certs', 'cacert.pem'), 'utf8'));
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

function createRuntimeBlocker(overrides) {
  var options = overrides || {};
  var downloader = createDownloader({
    https: https,
    execFile: options.execFile || childProcess.execFile,
    ca: loadCa(),
    timeoutMs: DOWNLOAD_TIMEOUT_MS
  });

  return createBlocker({
    fs: fs,
    exec: exec,
    download: downloader.download,
    isRoot: isRoot,
    now: function () {
      return new Date();
    },
    paths: extend(extend({}, DEFAULT_PATHS), options.paths || {}),
    liteUrl: options.liteUrl || LITE_URL,
    fullUrl: options.fullUrl || FULL_URL
  });
}

module.exports = {
  LITE_URL: LITE_URL,
  FULL_URL: FULL_URL,
  DEFAULT_PATHS: DEFAULT_PATHS,
  loadCa: loadCa,
  createRuntimeBlocker: createRuntimeBlocker
};
