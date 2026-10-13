'use strict';

// download.js usa url.parse porque o servico roda em Node antigo (sem WHATWG URL); o aviso DEP0169
// so aparece no Node >= 24 dos testes e poluiria a saida.
process.noDeprecation = true;

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDownloader } = require('../service/lib/download');

const URL1 = 'https://example.com/lists/hosts.txt';
const CA = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n';

// https falso. `handler(options, n)` devolve uma das formas:
//   { status, headers, chunks }  resposta (chunks: array de Buffers/strings)
//   { error }                    'error' no request
//   { hang: true }               nunca responde (so dispara o timeout, se registrado)
//   { dropAfter: chunks }        entrega os chunks e depois 'close' sem 'end'
function createFakeHttps(handler) {
  const calls = [];
  const requests = [];
  return {
    calls: calls,
    requests: requests,
    get(options, onResponse) {
      const n = calls.length;
      calls.push(options);
      const req = new EventEmitter();
      req.aborted = false;
      req.timeoutMs = null;
      req.timeoutFn = null;
      req.setTimeout = (ms, fn) => {
        req.timeoutMs = ms;
        req.timeoutFn = fn;
        return req;
      };
      req.abort = () => {
        req.aborted = true;
      };
      requests.push(req);

      const plan = handler(options, n);
      setImmediate(() => {
        if (plan.error) {
          req.emit('error', plan.error);
        } else if (plan.hang) {
          if (req.timeoutFn) req.timeoutFn();
          // Como o Node real: abortar depois do timeout ainda gera um 'error' no request.
          if (req.aborted) req.emit('error', new Error('socket hang up'));
        } else {
          const res = new EventEmitter();
          res.statusCode = plan.status === undefined ? 200 : plan.status;
          res.headers = plan.headers || {};
          res.resumed = false;
          res.resume = () => {
            res.resumed = true;
          };
          onResponse(res);
          setImmediate(() => {
            const chunks = plan.chunks || plan.dropAfter || [];
            chunks.forEach((c) => res.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c)));
            if (plan.dropAfter) res.emit('close');
            else res.emit('end');
          });
        }
      });
      return req;
    },
  };
}

// execFile falso. `handlers[cmd]` = { error } | { stdout }; comando sem handler falha com ENOENT.
function createFakeExecFile(handlers) {
  const calls = [];
  function execFile(cmd, args, options, cb) {
    calls.push({ cmd: cmd, args: args, options: options });
    const h = handlers[cmd];
    setImmediate(() => {
      if (!h) {
        const err = new Error('spawn ' + cmd + ' ENOENT');
        err.code = 'ENOENT';
        cb(err, '', '');
      } else if (h.error) {
        cb(h.error, '', 'stderr');
      } else {
        cb(null, h.stdout, '');
      }
    });
  }
  execFile.calls = calls;
  return execFile;
}

function setup(httpsHandler, execHandlers, extra) {
  const https = createFakeHttps(httpsHandler);
  const execFile = createFakeExecFile(execHandlers || {});
  const download = createDownloader(
    Object.assign({ https: https, execFile: execFile, ca: CA, timeoutMs: 1234 }, extra)
  ).download;
  return { https, execFile, download };
}

function run(download, url) {
  return new Promise((resolve) => {
    const results = [];
    download(url, (err, text) => {
      results.push({ err, text });
      // Espera um pouco para flagrar chamadas duplicadas do callback.
      setTimeout(() => resolve(results), 20);
    });
  });
}

test('uses https first', async () => {
  const { https, execFile, download } = setup(() => ({ status: 200, chunks: ['0.0.0.0 ads.example\n'] }));
  const results = await run(download, URL1);

  assert.equal(results.length, 1);
  assert.equal(results[0].err, null);
  assert.equal(results[0].text, '0.0.0.0 ads.example\n');
  assert.equal(execFile.calls.length, 0);
  assert.equal(https.calls.length, 1);
  const opts = https.calls[0];
  assert.equal(opts.hostname, 'example.com');
  assert.equal(opts.path, '/lists/hosts.txt');
  assert.equal(opts.ca, CA);
  assert.equal(opts.headers['User-Agent'], 'webos-adblock');
  assert.equal(https.requests[0].timeoutMs, 1234);
});

test('decodes utf8 split across chunks', async () => {
  const bytes = Buffer.from('# ação — lista\n0.0.0.0 ads.example\n', 'utf8');
  const cut = bytes.indexOf(0xc3) + 1; // meio do primeiro caractere multibyte
  const { download } = setup(() => ({ chunks: [bytes.subarray(0, cut), bytes.subarray(cut)] }));
  const results = await run(download, URL1);
  assert.equal(results[0].text, '# ação — lista\n0.0.0.0 ads.example\n');
});

test('follows redirect', async () => {
  const { https, execFile, download } = setup((options, n) => {
    if (n === 0) return { status: 301, headers: { location: 'https://cdn.example.net/a/hosts.txt' } };
    if (n === 1) return { status: 302, headers: { location: '/final/hosts.txt' } };
    return { status: 200, chunks: ['0.0.0.0 final.example\n'] };
  });
  const results = await run(download, URL1);

  assert.equal(results.length, 1);
  assert.equal(results[0].text, '0.0.0.0 final.example\n');
  assert.equal(execFile.calls.length, 0);
  assert.deepEqual(
    https.calls.map((o) => o.hostname + o.path),
    ['example.com/lists/hosts.txt', 'cdn.example.net/a/hosts.txt', 'cdn.example.net/final/hosts.txt']
  );
  assert.ok(https.calls.every((o) => o.ca === CA));
});

test('follows up to 5 redirects and no more', async () => {
  const chain = (limit) =>
    setup((options, n) =>
      n < limit
        ? { status: 302, headers: { location: '/r' + (n + 1) } }
        : { status: 200, chunks: ['ok\n'] }
    );

  const five = chain(5);
  assert.equal((await run(five.download, URL1))[0].text, 'ok\n');
  assert.equal(five.https.calls.length, 6);
  assert.equal(five.execFile.calls.length, 0);

  const six = chain(6);
  const results = await run(six.download, URL1);
  assert.equal(six.https.calls.length, 6);
  assert.equal(six.execFile.calls[0].cmd, 'curl'); // https desistiu; caiu para o curl
  assert.match(results[0].err.message, /^Falha ao baixar /);
});

test('non-200 status falls back to curl', async () => {
  const { https, execFile, download } = setup(
    () => ({ status: 404, chunks: ['not found'] }),
    { curl: { stdout: 'via curl\n' } }
  );
  const results = await run(download, URL1);

  assert.equal(results[0].err, null);
  assert.equal(results[0].text, 'via curl\n');
  assert.equal(https.requests[0].aborted, false);
  assert.equal(execFile.calls.length, 1);
});

test('redirect without location falls back to curl', async () => {
  const { execFile, download } = setup(() => ({ status: 302, headers: {} }), {
    curl: { stdout: 'via curl\n' },
  });
  const results = await run(download, URL1);
  assert.equal(results[0].text, 'via curl\n');
  assert.equal(execFile.calls.length, 1);
});

test('redirect to a non-https url is refused', async () => {
  const { https, execFile, download } = setup(
    () => ({ status: 302, headers: { location: 'http://insecure.example/hosts.txt' } }),
    { curl: { stdout: 'via curl\n' } }
  );
  const results = await run(download, URL1);
  assert.equal(https.calls.length, 1);
  assert.equal(results[0].text, 'via curl\n');
  assert.equal(execFile.calls.length, 1);
});

test('falls back to curl on https error', async () => {
  const { https, execFile, download } = setup(
    () => ({ error: new Error('ECONNRESET') }),
    { curl: { stdout: '0.0.0.0 ads.example\n' } }
  );
  const results = await run(download, URL1);

  assert.equal(results.length, 1);
  assert.equal(results[0].err, null);
  assert.equal(results[0].text, '0.0.0.0 ads.example\n');
  assert.equal(https.calls.length, 1);
  assert.equal(execFile.calls.length, 1);
  assert.equal(execFile.calls[0].cmd, 'curl');
  assert.deepEqual(execFile.calls[0].args, ['-fsSL', '--max-time', '60', URL1]);
  assert.equal(execFile.calls[0].options.maxBuffer, 32 * 1024 * 1024);
  assert.equal(execFile.calls[0].options.timeout, 1234);
});

test('https timeout aborts the request, falls back and calls back once', async () => {
  const { https, execFile, download } = setup(() => ({ hang: true }), {
    curl: { stdout: 'via curl\n' },
  });
  const results = await run(download, URL1);

  assert.equal(results.length, 1);
  assert.equal(results[0].text, 'via curl\n');
  assert.equal(https.requests[0].aborted, true);
  assert.equal(execFile.calls.length, 1);
});

test('connection dropped mid-body falls back', async () => {
  const { execFile, download } = setup(() => ({ dropAfter: ['0.0.0.0 par'] }), {
    curl: { stdout: 'via curl\n' },
  });
  const results = await run(download, URL1);
  assert.equal(results[0].text, 'via curl\n');
  assert.equal(execFile.calls.length, 1);
});

test('a throwing https.get falls back', async () => {
  const execFile = createFakeExecFile({ curl: { stdout: 'via curl\n' } });
  const https = {
    get() {
      throw new Error('boom');
    },
  };
  const { download } = createDownloader({ https, execFile, ca: CA, timeoutMs: 1000 });
  const results = await run(download, URL1);
  assert.equal(results[0].text, 'via curl\n');
});

test('falls back to wget', async () => {
  const { execFile, download } = setup(
    () => ({ error: new Error('ECONNRESET') }),
    { curl: { error: new Error('curl: (60) SSL certificate problem') }, wget: { stdout: 'via wget\n' } }
  );
  const results = await run(download, URL1);

  assert.equal(results.length, 1);
  assert.equal(results[0].err, null);
  assert.equal(results[0].text, 'via wget\n');
  assert.deepEqual(
    execFile.calls.map((c) => c.cmd),
    ['curl', 'wget']
  );
  assert.deepEqual(execFile.calls[1].args, ['-q', '-O', '-', URL1]);
  assert.equal(execFile.calls[1].options.maxBuffer, 32 * 1024 * 1024);
  assert.equal(execFile.calls[1].options.timeout, 1234);
});

test('reports last error when all fail', async () => {
  const { download } = setup(
    () => ({ error: new Error('ECONNRESET') }),
    { curl: { error: new Error('curl falhou') }, wget: { error: new Error('wget falhou') } }
  );
  const results = await run(download, URL1);

  assert.equal(results.length, 1);
  assert.ok(results[0].err instanceof Error);
  assert.equal(results[0].err.message, 'Falha ao baixar ' + URL1 + ': wget falhou');
  assert.equal(results[0].text, undefined);
});

test('missing curl and wget are reported', async () => {
  const { download } = setup(() => ({ error: new Error('ECONNRESET') }), {});
  const results = await run(download, URL1);
  assert.equal(results[0].err.message, 'Falha ao baixar ' + URL1 + ': spawn wget ENOENT');
});

test('defaults timeoutMs to 60 seconds', async () => {
  const https = createFakeHttps(() => ({ chunks: ['x\n'] }));
  const { download } = createDownloader({ https, execFile: createFakeExecFile({}), ca: CA });
  await run(download, URL1);
  assert.equal(https.requests[0].timeoutMs, 60000);
});
