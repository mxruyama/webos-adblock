'use strict';

// Bind-mount de hosts.block sobre /etc/hosts. Dependencias injetaveis: fs, exec(cmd, args, cb).

var MAX_UNMOUNT_ATTEMPTS = 3;

function createMounts(deps) {
  var fs = deps.fs;
  var exec = deps.exec;
  var hostsPath = deps.hostsPath;
  var blockPath = deps.blockPath;

  // O mount e "nosso" quando /etc/hosts e hosts.block sao o mesmo arquivo (mesmo dev e ino).
  function isOurMount() {
    try {
      var hosts = fs.statSync(hostsPath);
      var block = fs.statSync(blockPath);
      return hosts.dev === block.dev && hosts.ino === block.ino;
    } catch (err) {
      return false;
    }
  }

  function mount(cb) {
    exec('mount', ['--bind', blockPath, hostsPath], function (err) {
      cb(err || null);
    });
  }

  // Desmonta so as camadas nossas: mounts de terceiros (ex.: /tmp/hosts do HBChannel) ficam intactos.
  // O sucesso e decidido por isOurMount(), nao pelo codigo de saida do umount.
  function unmountOurs(cb) {
    var attempts = 0;

    function step() {
      if (!isOurMount()) {
        cb(null);
        return;
      }
      if (attempts >= MAX_UNMOUNT_ATTEMPTS) {
        cb(new Error('Não foi possível desmontar ' + hostsPath));
        return;
      }
      attempts += 1;
      exec('umount', [hostsPath], function () {
        step();
      });
    }

    step();
  }

  return { isOurMount: isOurMount, mount: mount, unmountOurs: unmountOurs };
}

module.exports = { createMounts: createMounts };
