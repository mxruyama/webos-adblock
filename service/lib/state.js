'use strict';

// Estado persistido em /var/lib/webosbrew/adblocker.json: {enabled, list, count, updatedAt}.

var DEFAULT_STATE = { enabled: false, list: 'lite', count: 0, updatedAt: null };

function defaultState() {
  return {
    enabled: DEFAULT_STATE.enabled,
    list: DEFAULT_STATE.list,
    count: DEFAULT_STATE.count,
    updatedAt: DEFAULT_STATE.updatedAt
  };
}

// Arquivo ausente ou corrompido -> padrao. Campos ausentes ou com tipo invalido -> padrao do campo.
function readState(fs, path) {
  var parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    return defaultState();
  }
  if (parsed === null || typeof parsed !== 'object' || Object.prototype.toString.call(parsed) === '[object Array]') {
    return defaultState();
  }

  var state = defaultState();
  if (typeof parsed.enabled === 'boolean') state.enabled = parsed.enabled;
  if (parsed.list === 'lite' || parsed.list === 'full') state.list = parsed.list;
  if (typeof parsed.count === 'number' && isFinite(parsed.count) && parsed.count >= 0) state.count = parsed.count;
  if (typeof parsed.updatedAt === 'string') state.updatedAt = parsed.updatedAt;
  return state;
}

// Grava em <path>.tmp e renomeia sobre o destino (troca atomica).
function writeState(fs, path, state) {
  var tmp = path + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  try {
    fs.renameSync(tmp, path);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (ignored) {
      // melhor esforco: o erro original do rename e o que importa
    }
    throw err;
  }
}

module.exports = { DEFAULT_STATE: DEFAULT_STATE, readState: readState, writeState: writeState };
