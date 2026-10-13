'use strict';

// Camada Luna do servico: so liga os metodos ao blocker (dependencias reais em lib/runtime.js); nenhuma logica aqui.

var Service = require('webos-service');
var createRuntimeBlocker = require('./lib/runtime').createRuntimeBlocker;

var SERVICE_ID = 'org.community.webos.adblocker.service';
var RESTART_DELAY_MS = 200;

function extend(target, source) {
  var key;
  for (key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
  }
  return target;
}

var blocker = createRuntimeBlocker();

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
