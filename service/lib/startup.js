'use strict';

// Bloco marcado em /var/lib/webosbrew/startup.sh que remonta o hosts de bloqueio a cada boot.
// Funcoes puras (texto -> texto) mais um IO fino (ensureBlock/dropBlock) sobre um objeto "fs".

var BEGIN = '# >>> org.community.webos.adblocker >>>';
var END = '# <<< org.community.webos.adblocker <<<';

var BLOCK = BEGIN + '\n' +
  'if [ -s /var/lib/webosbrew/hosts.block ]; then\n' +
  '    mount --bind /var/lib/webosbrew/hosts.block /etc/hosts\n' +
  'fi\n' +
  END + '\n';

var MISSING_WARNING = 'startup.sh não encontrado; o bloqueio não persistirá após reiniciar';
var DEFAULT_MODE = 493; // 0755
var MODE_MASK = 4095; // 07777

function isLineStart(text, index) {
  return index === 0 || text.charAt(index - 1) === '\n';
}

// Acha o primeiro bloco completo: uma linha END e a linha BEGIN mais proxima antes dela.
// Devolve {start, end} (end ja inclui o fim de linha do marcador final) ou null.
// Um BEGIN sem END (ou o contrario) nao conta, para nunca apagar conteudo do usuario por engano.
function findBlock(text) {
  var from = 0;
  var endAt;
  while ((endAt = text.indexOf(END, from)) !== -1) {
    if (isLineStart(text, endAt)) {
      var search = endAt - BEGIN.length;
      while (search >= 0) {
        var beginAt = text.lastIndexOf(BEGIN, search);
        if (beginAt === -1) break;
        if (isLineStart(text, beginAt)) {
          var newline = text.indexOf('\n', endAt);
          return { start: beginAt, end: newline === -1 ? text.length : newline + 1 };
        }
        search = beginAt - 1;
      }
    }
    from = endAt + END.length;
  }
  return null;
}

function hasBlock(text) {
  return findBlock(text) !== null;
}

function removeBlock(text) {
  var found = findBlock(text);
  while (found) {
    text = text.slice(0, found.start) + text.slice(found.end);
    found = findBlock(text);
  }
  return text;
}

function addBlock(text) {
  var base = removeBlock(text);
  if (base.length > 0 && base.charAt(base.length - 1) !== '\n') base += '\n';
  return base + BLOCK;
}

// IO em 'binary' (1 byte = 1 caractere): devolve byte a byte qualquer conteudo, mesmo que nao seja UTF-8
// (com 'utf8', bytes invalidos virariam U+FFFD). Os marcadores e o BLOCK sao ASCII, entao indexOf/slice funcionam igual.
// Grava em path + '.tmp', copia o modo original e troca por rename (nunca deixa o arquivo pela metade).
function writeAtomic(fs, path, text) {
  var tmp = path + '.tmp';
  var mode = (fs.statSync(path).mode & MODE_MASK) || DEFAULT_MODE;
  try {
    fs.writeFileSync(tmp, text, 'binary');
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, path);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (ignored) {
      // melhor esforco: o erro original e o que importa
    }
    throw err;
  }
}

function ensureBlock(fs, path) {
  if (!fs.existsSync(path)) return { persistent: false, warning: MISSING_WARNING };
  var current = fs.readFileSync(path, 'binary');
  var next = addBlock(current);
  if (next !== current) writeAtomic(fs, path, next);
  return { persistent: true };
}

function dropBlock(fs, path) {
  if (!fs.existsSync(path)) return;
  var current = fs.readFileSync(path, 'binary');
  var next = removeBlock(current);
  if (next !== current) writeAtomic(fs, path, next);
}

module.exports = {
  BEGIN: BEGIN,
  END: END,
  BLOCK: BLOCK,
  hasBlock: hasBlock,
  addBlock: addBlock,
  removeBlock: removeBlock,
  ensureBlock: ensureBlock,
  dropBlock: dropBlock
};
