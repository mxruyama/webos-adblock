'use strict';

// Download de listas: Node https (com bundle de CA embutido) -> curl -> wget.
// Dependencias injetaveis: https, execFile, ca, timeoutMs.

var urlLib = require('url');

var MAX_REDIRECTS = 5;
var MAX_BUFFER = 32 * 1024 * 1024;
var DEFAULT_TIMEOUT_MS = 60000;
var USER_AGENT = 'webos-adblock';

function createDownloader(deps) {
  var https = deps.https;
  var execFile = deps.execFile;
  var ca = deps.ca;
  var timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;

  // Uma tentativa via https; segue ate `redirectsLeft` redirecionamentos. cb(err, text).
  function fetchHttps(target, redirectsLeft, cb) {
    var options = urlLib.parse(target);
    if (options.protocol !== 'https:') {
      cb(new Error('Protocolo não suportado: ' + target));
      return;
    }
    options.ca = ca;
    options.headers = { 'User-Agent': USER_AGENT };

    // Cada salto tem seu proprio "encerrado": eventos tardios de uma requisicao ja concluida
    // ou redirecionada (timeout, erro de socket) nao podem derrubar o salto seguinte.
    var hopDone = false;
    function finish(err, text) {
      if (hopDone) return;
      hopDone = true;
      cb(err, text);
    }
    function fail(err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }

    var req;
    try {
      req = https.get(options, function (res) {
        var status = res.statusCode;
        var location = res.headers && res.headers.location;

        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (hopDone) return;
          if (redirectsLeft <= 0) {
            finish(new Error('Redirecionamentos demais'));
            return;
          }
          hopDone = true;
          fetchHttps(urlLib.resolve(target, location), redirectsLeft - 1, cb);
          return;
        }
        if (status !== 200) {
          res.resume();
          finish(new Error('HTTP ' + status));
          return;
        }

        var chunks = [];
        res.on('data', function (chunk) {
          chunks.push(chunk);
        });
        res.on('end', function () {
          finish(null, Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', fail);
        // Conexao encerrada antes do fim da resposta (corpo truncado).
        res.on('aborted', function () {
          fail(new Error('Conexão encerrada antes do fim da resposta'));
        });
        res.on('close', function () {
          fail(new Error('Conexão encerrada antes do fim da resposta'));
        });
      });
    } catch (err) {
      fail(err);
      return;
    }

    req.on('error', fail);
    req.setTimeout(timeoutMs, function () {
      if (hopDone) return;
      req.abort();
      fail(new Error('Tempo esgotado ao baixar ' + target));
    });
  }

  // Uma tentativa via comando externo (curl/wget). cb(err, text).
  function fetchExec(cmd, args, cb) {
    var done = false;
    function finish(err, text) {
      if (done) return;
      done = true;
      cb(err, text);
    }
    try {
      execFile(cmd, args, { maxBuffer: MAX_BUFFER, timeout: timeoutMs }, function (err, stdout) {
        if (err) finish(err);
        else finish(null, String(stdout || ''));
      });
    } catch (err) {
      finish(err);
    }
  }

  function download(target, cb) {
    var attempts = [
      function (done) {
        fetchHttps(target, MAX_REDIRECTS, done);
      },
      function (done) {
        fetchExec('curl', ['-fsSL', '--max-time', '60', target], done);
      },
      function (done) {
        fetchExec('wget', ['-q', '-O', '-', target], done);
      }
    ];
    var index = 0;
    var lastMessage = 'erro desconhecido';

    function next() {
      if (index >= attempts.length) {
        cb(new Error('Falha ao baixar ' + target + ': ' + lastMessage));
        return;
      }
      var attempt = attempts[index];
      index += 1;
      attempt(function (err, text) {
        if (err) {
          lastMessage = err.message || String(err);
          next();
          return;
        }
        cb(null, text);
      });
    }

    next();
  }

  return { download: download };
}

module.exports = { createDownloader: createDownloader };
