'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

// Arquivos que carregam a versao do projeto, relativos a raiz do repositorio.
const VERSION_FILES = ['app/appinfo.json', 'service/package.json', 'package.json'];

function assertVersion(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`versão inválida: ${JSON.stringify(version)} (esperado x.y.z, ex.: 1.2.3)`);
  }
}

// Grava `version` nos tres arquivos, mantendo indentacao de 2 espacos e "\n" final.
// Le e valida todos antes de escrever, para nao deixar o repositorio pela metade.
function setVersion(version, rootDir = path.resolve(__dirname, '..')) {
  assertVersion(version);

  const updates = VERSION_FILES.map((rel) => {
    const file = path.join(rootDir, ...rel.split('/'));
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`não foi possível ler ${path.join(...rel.split('/'))}: ${err.message}`);
    }
    return { file, data };
  });

  for (const { file, data } of updates) {
    data.version = version;
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }
}

module.exports = { setVersion, assertVersion, VERSION_PATTERN };

if (require.main === module) {
  try {
    setVersion(process.argv[2]);
    console.log(`Versão ${process.argv[2]} gravada em: ${VERSION_FILES.join(', ')}`);
  } catch (err) {
    console.error(`set-version: ${err.message}`);
    process.exit(1);
  }
}
