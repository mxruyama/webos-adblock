'use strict';

// Sistema de arquivos + exec falsos para testar o servico sem tocar na TV.
//
// Modelo inode (espelha o que importa do Linux para bind-mount de arquivo):
//   paths  : caminho -> inode           (nomes de arquivo)
//   mounts : alvo    -> inode montado   (objeto vivo; leitura/stat/escrita no alvo usam esse inode)
// Consequencias:
//   - gravar num caminho existente (ou alvo de mount) reaproveita o inode (escrita no lugar);
//   - gravar num caminho novo cria um inode novo;
//   - renameSync(a, b) faz b apontar para o inode de a; um mount que apontava para o inode
//     antigo de b continua apontando para ele;
//   - mounts empilham: umount remove so a camada de cima (ex.: o mount do HBChannel sobrevive).

const posixPath = require('node:path').posix;

const DEV = 2049; // mesmo dev para todos os arquivos
const DEFAULT_MODE = 0o644;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalize(p) {
  if (typeof p !== 'string' || p === '') {
    const err = new TypeError('O caminho deve ser uma string nao vazia');
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  let n = posixPath.normalize(p.replace(/\\/g, '/'));
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

const ERRNO = { ENOENT: [-2, 'no such file or directory'], EBUSY: [-16, 'resource busy or locked'] };

function fsError(code, syscall, p, dest) {
  const text = code + ': ' + ERRNO[code][1] + ', ' + syscall + " '" + p + "'" + (dest ? " -> '" + dest + "'" : '');
  const err = new Error(text);
  err.code = code;
  err.errno = ERRNO[code][0];
  err.syscall = syscall;
  err.path = p;
  if (dest) err.dest = dest;
  return err;
}

function commandError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function toBuffer(data, encoding) {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, encoding || 'utf8');
  const err = new TypeError('Os dados devem ser string ou Buffer');
  err.code = 'ERR_INVALID_ARG_TYPE';
  throw err;
}

function toMode(mode) {
  const value = typeof mode === 'string' ? parseInt(mode, 8) : mode;
  return value & 0o7777;
}

function readOptions(opts) {
  if (typeof opts === 'string') return { encoding: opts };
  return opts || {};
}

function createFakeSystem(files, opts) {
  opts = opts || {};

  const inodes = new Map(); // ino -> { ino, data: Buffer, mode }
  const paths = new Map(); // caminho -> ino
  const mounts = {}; // alvo -> ino montado (camada de cima)
  const lowerLayers = {}; // alvo -> [inos cobertos por mounts empilhados]
  const calls = [];
  const failCommands = (opts.failCommands || []).slice();
  let nextIno = 1;

  function createInode(data, mode) {
    const inode = { ino: nextIno++, data: data, mode: mode };
    inodes.set(inode.ino, inode);
    return inode;
  }

  function isMountTarget(p) {
    return hasOwn(mounts, p);
  }

  // Inode visto atraves dos mounts (ou undefined).
  function resolve(p) {
    if (isMountTarget(p)) return inodes.get(mounts[p]);
    return inodes.get(paths.get(p));
  }

  function getInode(p, syscall) {
    const inode = resolve(p);
    if (!inode) throw fsError('ENOENT', syscall, p);
    return inode;
  }

  Object.keys(files || {}).forEach((p) => {
    const n = normalize(p);
    paths.set(n, createInode(toBuffer(files[p]), DEFAULT_MODE).ino);
  });

  const fs = {
    readFileSync(p, options) {
      const n = normalize(p);
      const encoding = readOptions(options).encoding;
      const data = getInode(n, 'open').data;
      return encoding ? data.toString(encoding) : Buffer.from(data);
    },

    writeFileSync(p, data, options) {
      const n = normalize(p);
      const o = readOptions(options);
      if (o.flag !== undefined && o.flag !== 'w') {
        throw new Error("fake fs: flag nao suportada '" + o.flag + "'");
      }
      const buf = toBuffer(data, o.encoding);
      const existing = resolve(n);
      if (existing) {
        existing.data = buf; // escrita no lugar: mesmo inode, mesmo modo
      } else {
        const mode = o.mode !== undefined ? toMode(o.mode) : DEFAULT_MODE;
        paths.set(n, createInode(buf, mode).ino);
      }
    },

    renameSync(from, to) {
      const a = normalize(from);
      const b = normalize(to);
      if (isMountTarget(a) || isMountTarget(b)) throw fsError('EBUSY', 'rename', a, b);
      if (!paths.has(a)) throw fsError('ENOENT', 'rename', a, b);
      if (a === b) return;
      const ino = paths.get(a);
      paths.delete(a);
      paths.set(b, ino);
    },

    unlinkSync(p) {
      const n = normalize(p);
      if (isMountTarget(n)) throw fsError('EBUSY', 'unlink', n);
      if (!paths.has(n)) throw fsError('ENOENT', 'unlink', n);
      paths.delete(n); // o inode continua vivo enquanto algum mount o referenciar
    },

    existsSync(p) {
      try {
        return resolve(normalize(p)) !== undefined;
      } catch (err) {
        return false;
      }
    },

    statSync(p) {
      const inode = getInode(normalize(p), 'stat');
      return {
        dev: DEV,
        ino: inode.ino,
        mode: inode.mode,
        size: inode.data.length,
        isFile() {
          return true;
        },
        isDirectory() {
          return false;
        },
      };
    },

    chmodSync(p, mode) {
      getInode(normalize(p), 'chmod').mode = toMode(mode);
    },
  };

  function mountBind(args) {
    if (args.length !== 3 || args[0] !== '--bind') {
      throw commandError('mount: argumentos nao suportados pelo fake: ' + args.join(' '), 1);
    }
    const src = normalize(args[1]);
    const dst = normalize(args[2]);
    const srcInode = resolve(src);
    if (!srcInode) throw commandError('mount: ' + src + ': special device does not exist', 32);
    if (!resolve(dst)) throw commandError('mount: ' + dst + ': mount point does not exist', 32);
    if (isMountTarget(dst)) {
      (lowerLayers[dst] = lowerLayers[dst] || []).push(mounts[dst]);
    } else {
      delete lowerLayers[dst]; // remocao direta de mounts nao deixa camadas fantasmas
    }
    mounts[dst] = srcInode.ino;
  }

  function umount(args) {
    if (args.length !== 1) {
      throw commandError('umount: argumentos nao suportados pelo fake: ' + args.join(' '), 1);
    }
    const dst = normalize(args[0]);
    if (!isMountTarget(dst)) throw commandError('umount: ' + dst + ': not mounted.', 32);
    const lower = lowerLayers[dst];
    if (lower && lower.length) {
      mounts[dst] = lower.pop();
    } else {
      delete mounts[dst];
      delete lowerLayers[dst];
    }
  }

  function runCommand(cmd, args) {
    if (failCommands.indexOf(cmd) !== -1) throw commandError('command failed: ' + cmd, 1);
    if (cmd === 'mount') mountBind(args);
    else if (cmd === 'umount') umount(args);
    else throw commandError('command not found: ' + cmd, 'ENOENT');
    return '';
  }

  // exec(cmd, args, cb) | exec(cmd, cb) | exec(cmd, args, options, cb), como child_process.execFile.
  // A chamada e registrada na hora; o efeito e o callback acontecem juntos, depois, via setImmediate.
  function exec(cmd, args, options, cb) {
    if (typeof args === 'function') {
      cb = args;
      args = [];
    } else if (typeof options === 'function') {
      cb = options;
    }
    args = (args || []).slice();
    calls.push({ cmd: cmd, args: args.slice() });
    setImmediate(() => {
      let stdout = '';
      let error = null;
      try {
        stdout = runCommand(cmd, args);
      } catch (err) {
        error = err;
      }
      if (typeof cb === 'function') cb(error, error ? '' : stdout);
    });
  }

  return {
    fs: fs,
    exec: exec,
    mounts: mounts,
    calls: calls,
    failCommands: failCommands,
    // Conveniencia de teste: conteudo (utf8) do caminho como visto atraves dos mounts.
    read(p) {
      return getInode(normalize(p), 'open').data.toString('utf8');
    },
  };
}

module.exports = { createFakeSystem };
