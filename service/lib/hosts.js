'use strict';

// Montagem pura do arquivo hosts (sem IO). ES5 para rodar no Node antigo da TV.

var MARKER = '# >>> webos-adblock';
var MAX_BYTES = 15 * 1024 * 1024;

var DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
var IPV4_RE = /^\d+\.\d+\.\d+\.\d+$/;
var LINE_BREAK = /\r\n|\n|\r/;

// IPs aceitos em listas de bloqueio; so os dois primeiros bloqueiam de fato no hosts (IPv4).
var LIST_IPS = ['0.0.0.0', '127.0.0.1', '::1'];
var BLOCK_IPS = ['0.0.0.0', '127.0.0.1'];
var DISCARD = ['localhost', 'localhost.localdomain', 'local', 'broadcasthost', '0.0.0.0'];

// Cabecalho do bloco gerado; o fonte e UTF-8 ("domínios" vai literal para o hosts, que e gravado em UTF-8).
function headerLine(meta, count) {
  return MARKER + ' (gerado em ' + meta.date + ', lista ' + meta.list + ', ' + count + ' domínios)';
}

// Devolve o dominio em minusculas se for bloqueavel, senao null.
function normalizeDomain(name) {
  var domain = String(name).toLowerCase();
  if (IPV4_RE.test(domain)) return null;
  if (DISCARD.indexOf(domain) !== -1) return null;
  if (domain.indexOf('ip6-') === 0) return null;
  return DOMAIN_RE.test(domain) ? domain : null;
}

// Tokens minusculos da linha, sem comentario (#) nem espacos nas pontas.
function tokensOf(line) {
  var hash = line.indexOf('#');
  var body = (hash === -1 ? line : line.substring(0, hash)).trim();
  return body === '' ? [] : body.toLowerCase().split(/\s+/);
}

function isIpLike(token) {
  return token.indexOf(':') !== -1 || IPV4_RE.test(token);
}

// Dominios validos, unicos e em ordem de aparicao. Linhas com IP so contam se o IP estiver em
// allowedIps; linhas sem IP (uma palavra so) contam apenas com allowBare.
function scanDomains(text, allowedIps, allowBare) {
  var lines = text.split(LINE_BREAK);
  var seen = {};
  var found = [];
  var i;
  var j;
  var tokens;
  var start;
  var domain;
  for (i = 0; i < lines.length; i++) {
    tokens = tokensOf(lines[i]);
    if (tokens.length === 0) continue;
    start = 0;
    if (isIpLike(tokens[0])) {
      if (allowedIps.indexOf(tokens[0]) === -1) continue;
      start = 1;
    } else if (!allowBare || tokens.length !== 1) {
      continue;
    }
    for (j = start; j < tokens.length; j++) {
      domain = normalizeDomain(tokens[j]);
      // O prefixo "$" evita colisao com chaves especiais como "__proto__".
      if (domain !== null && !seen['$' + domain]) {
        seen['$' + domain] = true;
        found.push(domain);
      }
    }
  }
  return found;
}

function parseDomains(text) {
  if (typeof text !== 'string') return [];
  return scanDomains(text, LIST_IPS, true);
}

// Remove nosso bloco gerado: tudo a partir da linha que comeca com MARKER. Garante "\n" final.
function stripOurBlock(hostsText) {
  var text = String(hostsText);
  var from = 0;
  var index;
  var before;
  for (;;) {
    index = text.indexOf(MARKER, from);
    if (index === -1) break;
    before = index === 0 ? '\n' : text.charAt(index - 1);
    if (before === '\n' || before === '\r') {
      text = text.substring(0, index);
      break;
    }
    from = index + 1;
  }
  if (text !== '' && text.charAt(text.length - 1) !== '\n') text += '\n';
  return text;
}

// A linha "<ip> ... <name> ..." existe no texto?
function hasHostEntry(text, ip, name) {
  var lines = text.split(LINE_BREAK);
  var tokens;
  var i;
  for (i = 0; i < lines.length; i++) {
    tokens = tokensOf(lines[i]);
    if (tokens.length > 1 && tokens[0] === ip && tokens.indexOf(name) !== -1) return true;
  }
  return false;
}

function buildHostsFile(baseHosts, domains, meta) {
  var base = stripOurBlock(baseHosts);
  var seen = {};
  var entries = [];
  var inBase = scanDomains(base, BLOCK_IPS, false);
  var head = base;
  var i;
  var domain;
  var text;

  for (i = 0; i < inBase.length; i++) seen['$' + inBase[i]] = true;

  for (i = 0; i < domains.length; i++) {
    domain = normalizeDomain(domains[i]);
    if (domain === null || seen['$' + domain]) continue;
    seen['$' + domain] = true;
    entries.push('0.0.0.0 ' + domain);
  }

  if (!hasHostEntry(base, '127.0.0.1', 'localhost')) head += '127.0.0.1 localhost\n';
  if (!hasHostEntry(base, '::1', 'localhost')) head += '::1 localhost\n';

  text = head + headerLine(meta, entries.length) + '\n';
  if (entries.length > 0) text += entries.join('\n') + '\n';

  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    throw new Error('Lista de hosts excede 15 MB');
  }
  return { text: text, count: entries.length };
}

module.exports = {
  MARKER: MARKER,
  MAX_BYTES: MAX_BYTES,
  parseDomains: parseDomains,
  stripOurBlock: stripOurBlock,
  buildHostsFile: buildHostsFile
};
