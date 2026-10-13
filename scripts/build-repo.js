'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const { assertVersion } = require('./set-version.js');

const APP_ID = 'org.community.webos.adblocker';
const APP_TITLE = 'AdBlocker';
const DESCRIPTION =
  'Bloqueia anúncios, telemetria da LG e rastreadores em toda a TV via /etc/hosts (requer root).';
const DEFAULT_REPO = 'mxruyama/webos-adblock';
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function readRequired(file, label) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    throw new Error(`${label} não encontrado ou ilegível (${file}): ${err.message}`);
  }
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderIndex({ repoJsonUrl, pagesRepoJsonUrl, version }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APP_TITLE} para webOS</title>
<style>
  body { font-family: system-ui, sans-serif; background: #101418; color: #e6e9ec; margin: 0; padding: 2rem 1rem; line-height: 1.5; }
  main { max-width: 40rem; margin: 0 auto; }
  h1 { margin-top: 0; }
  code { background: #1c232b; padding: 0.15rem 0.4rem; border-radius: 4px; word-break: break-all; }
  .repo { display: block; padding: 0.75rem 1rem; margin: 1rem 0; }
  a { color: #6cb6ff; }
  small { color: #9aa5b1; }
</style>
</head>
<body>
<main>
<h1>${APP_TITLE} para webOS</h1>
<p>${DESCRIPTION}</p>
<p>URL do repositório do Homebrew Channel:</p>
<code class="repo">${repoJsonUrl}</code>
<p><small>Alternativa (TVs mais novas): <code>${pagesRepoJsonUrl}</code>. A URL do jsDelivr funciona também em TVs antigas, que não confiam no certificado do GitHub Pages.</small></p>
<h2>Como instalar</h2>
<ol>
<li>Abra o Homebrew Channel na TV.</li>
<li>Abra as configurações: <strong>Settings</strong> (ícone de engrenagem). A interface do Homebrew Channel é em inglês.</li>
<li>Na seção <strong>Repositories</strong>, escolha <strong>Add repository</strong>.</li>
<li>No diálogo <strong>Enter repository URL:</strong>, digite a URL acima e confirme no botão <strong>Add repository</strong>.</li>
<li>Volte à lista de aplicativos, abra o ${APP_TITLE} e instale.</li>
</ol>
<p><small>Versão ${version}. Requer TV com acesso root (Homebrew Channel).</small></p>
</main>
</body>
</html>
`;
}

// Gera em `outDir` o repositorio do Homebrew Channel (repo.json + manifesto), os assets
// publicados no GitHub Pages (servidos tambem pelo jsDelivr) e a pagina de instrucoes.
function buildRepo({
  ipkPath,
  version,
  outDir,
  repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO,
  rootDir = path.resolve(__dirname, '..'),
}) {
  assertVersion(version);
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`repositório inválido: ${JSON.stringify(repo)} (esperado owner/nome)`);
  }
  if (!ipkPath) throw new Error('caminho do .ipk não informado');
  if (!outDir) throw new Error('diretório de saída não informado');

  // Le todas as entradas antes de criar qualquer saida.
  const ipk = readRequired(ipkPath, 'Arquivo .ipk');
  const icon = readRequired(path.join(rootDir, 'app', 'icon.png'), 'Ícone app/icon.png');
  const lite = readRequired(
    path.join(rootDir, 'service', 'lists', 'lite.txt'),
    'Lista service/lists/lite.txt',
  );

  const [owner, name] = repo.split('/');
  const pagesBase = `https://${owner.toLowerCase()}.github.io/${name}/`;
  // A TV le repo.json, manifesto e icone pelo jsDelivr (mesmos arquivos da branch gh-pages):
  // a cadeia do certificado dele termina numa raiz antiga (AAA Certificate Services), aceita
  // por TVs que nao confiam na ISRG Root X1 (Let's Encrypt) usada pelo GitHub Pages.
  const cdnBase = `https://cdn.jsdelivr.net/gh/${owner}/${name}@gh-pages/`;
  const ipkName = `${APP_ID}_${version}_all.ipk`;
  const manifestName = `${APP_ID}.manifest.json`;
  const iconUri = `${cdnBase}icon.png`;

  const manifest = {
    id: APP_ID,
    version,
    type: 'web',
    title: APP_TITLE,
    appDescription: DESCRIPTION,
    iconUri,
    sourceUrl: `https://github.com/${repo}`,
    rootRequired: true,
    ipkUrl: `https://github.com/${repo}/releases/download/v${version}/${ipkName}`,
    ipkHash: { sha256: crypto.createHash('sha256').update(ipk).digest('hex') },
    ipkSize: ipk.length,
  };

  const repoJson = {
    paging: { page: 1, count: 1, maxPage: 1, itemsTotal: 1, prevUrl: null, nextUrl: null },
    packages: [
      {
        id: APP_ID,
        title: APP_TITLE,
        iconUri,
        manifestUrl: `${cdnBase}${manifestName}`,
        shortDescription: DESCRIPTION,
        manifest,
      },
    ],
  };

  fs.mkdirSync(path.join(outDir, 'lists'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'repo.json'), json(repoJson));
  fs.writeFileSync(path.join(outDir, manifestName), json(manifest));
  fs.writeFileSync(path.join(outDir, 'icon.png'), icon);
  fs.writeFileSync(path.join(outDir, 'lists', 'lite.txt'), lite);
  fs.writeFileSync(
    path.join(outDir, 'index.html'),
    renderIndex({
      repoJsonUrl: `${cdnBase}repo.json`,
      pagesRepoJsonUrl: `${pagesBase}repo.json`,
      version,
    }),
  );
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');

  return { manifest, repoJson };
}

module.exports = { buildRepo };

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: {
        ipk: { type: 'string' },
        version: { type: 'string' },
        out: { type: 'string' },
      },
    });
    if (!values.ipk || !values.version || !values.out) {
      throw new Error('uso: node scripts/build-repo.js --ipk <arquivo> --version <x.y.z> --out <dir>');
    }
    buildRepo({ ipkPath: values.ipk, version: values.version, outDir: values.out });
    console.log(`Repositório gerado em ${values.out}`);
  } catch (err) {
    console.error(`build-repo: ${err.message}`);
    process.exit(1);
  }
}
