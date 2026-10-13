# webos-adblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App webOS `.ipk` com serviço root que bloqueia anúncios/telemetria via bind-mount de `/etc/hosts`, mais repositório Homebrew Channel no GitHub Pages publicado por GitHub Actions.

**Architecture:** UI web ES5 (`app/`) fala via Luna com um serviço Node ES5 (`service/`) cuja lógica fica em módulos `lib/` com dependências injetadas (fs, exec, download) e testados com fakes em memória. CI empacota com `ares-package`, cria Release e gera `repo.json` + manifesto para a branch `gh-pages`.

**Tech Stack:** HTML/CSS/JS ES5, Node `webos-service`, `node:test` (Node 22+), `acorn` (checagem ES5), `@webos-tools/cli`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-13-webos-adblock-design.md` — leia antes de qualquer tarefa.

## Global Constraints

- Todo `.js` em `app/` e `service/` é ES5 puro (sem `let/const`, arrow, template string, classes, `Promise`, `Object.assign`, `Array.prototype.includes`); APIs assíncronas usam callbacks Node `cb(err, result)`.
- Testes e `scripts/` podem usar JS moderno (Node 22).
- App ID `org.community.webos.adblocker`; serviço `org.community.webos.adblocker.service`; versão inicial `1.0.0`.
- Repo `mxruyama/webos-adblock`; Pages `https://mxruyama.github.io/webos-adblock/`.
- Caminhos na TV: `/var/lib/webosbrew/hosts.block`, `/var/lib/webosbrew/adblocker.json`, `/var/lib/webosbrew/startup.sh`, `/etc/hosts`.
- Textos de UI e mensagens de erro em português do Brasil.
- Fins de linha LF em todo o repositório (`.gitattributes`).
- Subagentes NÃO executam comandos git; o controlador faz os commits.

## Review Focus

1. Lista remota (StevenBlack) contém `0.0.0.0 0.0.0.0`, `127.0.0.1 localhost`, `::1 ip6-localhost`, `fe80::1%lo0 localhost`, `255.255.255.255 broadcasthost` → nenhum vira domínio bloqueado (Task 2: `parseDomains ignores localhost/broadcast/IP-like entries`).
2. HBChannel já montou `/tmp/hosts` sobre `/etc/hosts` (bloqueio de updates) → ativar preserva as linhas `snu.lge.com`; desativar desmonta só a nossa camada e o mount do HBChannel continua (Task 5: `enable preserves HBChannel update-block hosts` e `disable leaves foreign mount`).
3. `startup.sh` com CRLF ou sem `\n` final → add/remove mantêm o resto byte a byte (Task 3: `addBlock handles missing trailing newline`, `removeBlock preserves CRLF content`).
4. Cliques repetidos (enable e disable em sequência rápida) → operações serializadas, estado final coerente (Task 5: `operations are serialized`).
5. `update` com lista completa enquanto ativo e download falha → continua ativo com a lista anterior e mount intacto (Task 5: `update failure keeps previous list mounted`).

## Execution waves

- Onda 1: Task 1 (controlador).
- Onda 2 (paralelo): Tasks 2, 3, 4, 6, 7.
- Onda 3 (paralelo): Task 5, Task 8.
- Onda 4: Task 9 (controlador: integração, push, release).

---

### Task 1: Scaffold, fakes de teste e checagens globais

**Files:**
- Create: `package.json`, `.gitignore`, `.gitattributes`, `LICENSE`, `app/appinfo.json`, `service/package.json`, `service/services.json`, `test/helpers/fakes.js`, `test/static.test.js`

**Interfaces:**
- Produces: `test/helpers/fakes.js` → `createFakeSystem(files: {[path]: string}, opts?: {failCommands?: string[]})` retorna `{fs, exec, mounts, calls, read(path): string}`.
  - `fs`: `readFileSync(p, enc?)`, `writeFileSync(p, data, opts?)`, `renameSync(a, b)`, `unlinkSync(p)`, `existsSync(p)`, `statSync(p)` → `{dev, ino, mode, size, isFile()}`, `chmodSync(p, mode)`. Erros com `code: 'ENOENT'`.
  - Modelo inode: `paths → inode`, `mounts[target] = inode`; leitura/stat de um alvo montado usa o inode montado; `renameSync` dá ao destino o inode da origem (o mount continua no inode antigo).
  - `exec(cmd: string, args: string[], cb(err, stdout))`: `mount --bind src dst` e `umount dst` (erro se não montado); outros comandos → erro; comando em `failCommands` → erro. Registra `{cmd, args}` em `calls`. Callback via `setImmediate`.
- Produces: `npm test` = `node --test "test/**/*.test.js"`; `npm run package` = `ares-package app service -o dist --no-minify`.

- [ ] Step 1: `package.json` (private, version `1.0.0`, devDependencies `@webos-tools/cli`, `acorn`), scripts `test`, `package`, `icons` (`node scripts/make-icons.js`), `engines.node >=22`. `.gitattributes`: `* text=auto eol=lf`, `*.png binary`, `*.ipk binary`. `.gitignore`: `node_modules/`, `dist/`, `site/`. MIT LICENSE (2026, webos-adblock contributors).
- [ ] Step 2: `app/appinfo.json` com os campos da spec; `service/package.json` (`name` = id do serviço, `main: service.js`, `version 1.0.0`); `service/services.json` (`id`, `description`, `services:[{name, description}]`).
- [ ] Step 3: `test/static.test.js`: `json files parse` (os três JSON) e `app and service code is ES5` (acorn `ecmaVersion: 5`, `sourceType: 'script'`, todo `.js` em `app/js` e `service/` exceto `node_modules`); passa com zero arquivos.
- [ ] Step 4: `test/helpers/fakes.js` + `test/fakes.test.js` (mount/umount/rename/stat cobrindo o modelo inode).
- [ ] Step 5: `npm install`, `npm test` → todos passam. Commit.

### Task 2: Montagem do hosts (`service/lib/hosts.js`)

**Files:** Create `service/lib/hosts.js`, `test/hosts.test.js`

**Interfaces:**
- Produces (CommonJS, ES5): `MARKER = '# >>> webos-adblock'`, `MAX_BYTES = 15 * 1024 * 1024`,
  `parseDomains(text: string): string[]`, `stripOurBlock(hostsText: string): string`,
  `buildHostsFile(baseHosts: string, domains: string[], meta: {list: string, date: string}): {text: string, count: number}`.

- [ ] Step 1: Testes:
  - `parseDomains reads hosts and plain formats`: `"0.0.0.0 a.com\n127.0.0.1 b.com c.com\nd.com\n# x\n"` → `['a.com','b.com','c.com','d.com']`.
  - `parseDomains lowercases, dedupes, strips inline comments`: `"A.com #c\na.com"` → `['a.com']`.
  - `parseDomains ignores localhost/broadcast/IP-like entries` (Review Focus 1).
  - `parseDomains ignores lines with other IPs` (`"192.168.0.1 x.com"` → `[]`) e domínios inválidos (`"-bad.com"`, `"nodot"`, `"a..b.com"`).
  - `stripOurBlock removes generated section`: texto com `MARKER` no meio → só o que vem antes, terminando em `\n`; sem marker → texto inalterado (com `\n` final garantido).
  - `buildHostsFile keeps base and appends block`: base `"127.0.0.1 localhost\n"` + `['x.com']` → contém base, linha começando com `MARKER` incluindo `lista lite` e `1 domínios`, linha `0.0.0.0 x.com`; `count === 1`.
  - `buildHostsFile adds localhost entries when missing`: base `""` → texto contém `127.0.0.1 localhost` e `::1 localhost`.
  - `buildHostsFile skips domains already in base and rebuilds over old block`: base contendo bloco antigo é passado por `stripOurBlock` internamente.
  - `buildHostsFile throws over MAX_BYTES` com mensagem `Lista de hosts excede 15 MB`.
- [ ] Step 2: rodar `node --test test/hosts.test.js` → FAIL.
- [ ] Step 3: implementar (regex de domínio exatamente a da spec; IPs aceitos `0.0.0.0`, `127.0.0.1`, `::1`; descartar `localhost`, `localhost.localdomain`, `local`, `broadcasthost`, `ip6-*`, `0.0.0.0`). Cabeçalho: `# >>> webos-adblock (gerado em <date>, lista <list>, <n> domínios)`.
- [ ] Step 4: `npm test` → PASS.

### Task 3: Bloco do startup.sh (`service/lib/startup.js`)

**Files:** Create `service/lib/startup.js`, `test/startup.test.js`

**Interfaces:**
- Consumes: `createFakeSystem` (Task 1).
- Produces: `BEGIN`, `END`, `BLOCK` (texto exato da spec, linhas com `\n`), `hasBlock(text): boolean`, `addBlock(text): string`, `removeBlock(text): string`,
  `ensureBlock(fs, path): {persistent: boolean, warning?: string}`, `dropBlock(fs, path): void`.

- [ ] Step 1: Testes:
  - `addBlock appends block once` (aplicar 2x = mesmo resultado; termina com `BLOCK`).
  - `addBlock handles missing trailing newline` (`"echo hi"` → `"echo hi\n" + BLOCK`).
  - `removeBlock restores original` (`removeBlock(addBlock(x)) === x` para `x` terminando em `\n`).
  - `removeBlock preserves CRLF content` (texto `"a\r\nb\r\n"` + BLOCK → `"a\r\nb\r\n"`).
  - `ensureBlock writes atomically and keeps mode` (fake fs com startup.sh modo `0o755` → depois `hasBlock` true, modo `0o755`, sem `.tmp` sobrando, `{persistent: true}`).
  - `ensureBlock without startup.sh` → `{persistent: false, warning: 'startup.sh não encontrado; o bloqueio não persistirá após reiniciar'}` e não cria o arquivo.
  - `dropBlock is tolerant` (arquivo ausente ou sem bloco → sem erro).
- [ ] Step 2: FAIL. Step 3: implementar (escrita via `path + '.tmp'`, `chmodSync(tmp, mode & 0o7777 || 0o755)`, `renameSync`). Step 4: `npm test` → PASS.

### Task 4: Mount, estado, download, listas e certificados

**Files:** Create `service/lib/mounts.js`, `service/lib/state.js`, `service/lib/download.js`, `service/lists/lite.txt`, `service/certs/cacert.pem`, `test/mounts.test.js`, `test/state.test.js`, `test/download.test.js`

**Interfaces:**
- Consumes: `createFakeSystem` (Task 1).
- Produces:
  - `mounts.js`: `createMounts({fs, exec, hostsPath, blockPath})` → `{isOurMount(): boolean, mount(cb), unmountOurs(cb)}` (`unmountOurs` repete `umount hostsPath` enquanto `isOurMount()`, máx. 3; não erra se não for nosso).
  - `state.js`: `DEFAULT_STATE = {enabled: false, list: 'lite', count: 0, updatedAt: null}`, `readState(fs, path): object` (arquivo ausente/corrompido → cópia de `DEFAULT_STATE`), `writeState(fs, path, state): void` (tmp + rename).
  - `download.js`: `createDownloader({https, execFile, ca, timeoutMs})` → `download(url, cb(err, text))`. Ordem: `https.get` com `ca`, segue até 5 redirects (3xx com `location`), status ≠ 200 = falha; depois `execFile('curl', ['-fsSL','--max-time','60',url])`; depois `execFile('wget', ['-q','-O','-',url])`. Erro final: `Falha ao baixar <url>: <última mensagem>`.

- [ ] Step 1: Testes:
  - mounts: `isOurMount false before mount`, `mount binds block over hosts` (stat iguais, conteúdo lido de `/etc/hosts` = do block), `unmountOurs leaves foreign mount` (hosts montado de `/tmp/hosts` → nenhum `umount` chamado), `unmountOurs removes stacked mounts`.
  - state: `readState defaults when missing`, `readState defaults when corrupt`, `writeState roundtrip`.
  - download (fakes de `https` e `execFile`): `uses https first`, `follows redirect`, `falls back to curl on https error`, `falls back to wget`, `reports last error when all fail`.
- [ ] Step 2: FAIL. Step 3: implementar.
- [ ] Step 4: `service/certs/cacert.pem` = download de `https://curl.se/ca/cacert.pem`.
- [ ] Step 5: `service/lists/lite.txt`: cabeçalho de comentário (propósito, formato, fontes consultadas) + domínios de anúncios/ACR/telemetria LG, um por linha, formato `0.0.0.0 domínio`. Consulte listas públicas (ex.: hagezi `native.lgwebos`, Perflyst SmartTV) e inclua apenas hosts de anúncio/telemetria. NUNCA inclua: `lgappstv.com` raiz, `lgtvsdp.com` raiz, `lge.com` raiz, `lgeapi.com`, `snu.lge.com`, `su.lge.com`, `su-ssl.lge.com`, domínios de login LG ou de serviços de streaming. Teste `lite list parses` em `test/state.test.js`: `parseDomains` (Task 2 — se ainda não existir, use regex simples `^0\.0\.0\.0 \S+$` por linha não-comentário) retorna ≥ 20 domínios e nenhum dos proibidos.
- [ ] Step 6: `npm test` → PASS.

### Task 5: Orquestrador e camada Luna (`blocker.js`, `service.js`)

**Files:** Create `service/lib/blocker.js`, `service/service.js`, `test/blocker.test.js`

**Interfaces:**
- Consumes: Tasks 2, 3, 4 (assinaturas acima).
- Produces: `createBlocker(deps)` com `deps = {fs, exec, download, isRoot(): boolean, now(): Date, paths: {hosts, block, state, startup, liteList}, liteUrl, fullUrl}` → `{status(cb), enable(opts, cb), disable(cb), update(opts, cb)}`; `cb(err, resp)` com `resp = {active, persistent, root, list, count, updatedAt, warning?}`.
  `service.js` registra `status`, `enable`, `disable`, `update`, `restart` com `require('webos-service')`; responde `{returnValue: true, ...resp}` ou `{returnValue: false, errorText: err.message, ...status quando disponível}`; `restart` responde e `setTimeout(process.exit, 200)`. URLs: `liteUrl = https://mxruyama.github.io/webos-adblock/lists/lite.txt`, `fullUrl = https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts`. `isRoot = process.getuid && process.getuid() === 0`. Downloader com `ca` lido de `certs/cacert.pem`, timeout 60000.

- [ ] Step 1: Testes (fake system com `/etc/hosts`, `/var/lib/webosbrew/startup.sh` modo 0o755, `liteList` embutida; `download` fake):
  - `status reports inactive initially`.
  - `enable lite mounts block, persists and saves state` (active, persistent true, count > 0, startup.sh com bloco, `/etc/hosts` lido contém `0.0.0.0`).
  - `enable lite falls back to embedded list when download fails`.
  - `enable full merges lite and remote`; `enable full fails when remote download fails` (estado continua inativo).
  - `enable preserves HBChannel update-block hosts` e `disable leaves foreign mount` (Review Focus 2).
  - `disable restores hosts, removes block and file`; `disable when inactive succeeds`.
  - `update while active swaps list and remounts`; `update when inactive errors 'Bloqueio inativo'`.
  - `update failure keeps previous list mounted` (Review Focus 5).
  - `writes require root` (`isRoot` false → erro `Serviço sem root. Use 'Conceder root'.`; `status` funciona com `root: false`).
  - `status self-heals missing startup block` e `status remounts when enabled but not mounted`.
  - `operations are serialized` (Review Focus 4: enable e disable disparados juntos → terminam na ordem, final inativo).
  - `startup.sh missing gives warning` (`persistent: false`, `warning` da Task 3).
- [ ] Step 2: FAIL. Step 3: implementar `blocker.js` (fila FIFO interna; rollback: se falhar depois de desmontar, tenta `mount` do block anterior). Base do hosts conforme spec (“Base do hosts”).
- [ ] Step 4: implementar `service.js` (fino, sem lógica). Step 5: `npm test` → PASS (inclui checagem ES5).

### Task 6: Frontend TV (`app/`)

**Files:** Create `app/index.html`, `app/css/app.css`, `app/js/luna.js`, `app/js/spatial-nav.js`, `app/js/app.js`, `scripts/make-icons.js`, `app/icon.png`, `app/largeIcon.png`, `app/splash.png`, `test/spatial-nav.test.js`

**Interfaces:**
- Consumes: contrato Luna da Task 5 (métodos e campos de resposta); HBChannel `getConfiguration` → `{root}`, `elevateService {id}`.
- Produces: `window.Luna.call(uri: string, params: object, cb(err, resp))` (com `?mock=1` ou sem `PalmServiceBridge` usa mock em memória com latência 300 ms, começa sem root, `elevateService`+`restart` passam a root); `window.SpatialNav` e `module.exports` com `pickNext(fromRect, candidates: [{rect, el}], dir: 'left'|'right'|'up'|'down'): el|null` e `init(root)`.

- [ ] Step 1: Teste `test/spatial-nav.test.js` (carrega o arquivo em Node via `module.exports`): `picks nearest to the right`, `ignores candidates behind`, `prefers aligned over diagonal`, `returns null at edge`.
- [ ] Step 2: FAIL → implementar `spatial-nav.js` (candidatos no semiplano da direção; distância = primária + 2×secundária entre centros; ignora `disabled`; `mouseover` foca; teclas 37–40 navegam; 13 = click; 461/Escape → `window.close()`).
- [ ] Step 3: `luna.js`, `index.html`, `app.css`, `app.js` conforme seção Frontend da spec (layout, cores `#2ecc71`/`#e74c3c`, anel de foco amarelo 6px, fontes ≥ 28px, overlay “Processando…”, banner de root, radio Leve/Completa, mensagens em pt-BR). CSS sem custom properties/grid; flexbox ok. Sem frameworks.
- [ ] Step 4: `scripts/make-icons.js` (Node puro, `zlib` + CRC32 próprio) gera PNG RGBA: `icon.png` 80×80, `largeIcon.png` 130×130, `splash.png` 1920×1080 — escudo verde em fundo `#101418`. Rodar `npm run icons`; verificar dimensões lendo o IHDR.
- [ ] Step 5: `npm test` → PASS (ES5 inclui `app/js`).

### Task 7: Scripts de release (`build-repo.js`, `set-version.js`)

**Files:** Create `scripts/build-repo.js`, `scripts/set-version.js`, `test/build-repo.test.js`

**Interfaces:**
- Produces:
  - `scripts/build-repo.js` exporta `buildRepo({ipkPath, version, outDir, repo = process.env.GITHUB_REPOSITORY || 'mxruyama/webos-adblock', rootDir})` e funciona via CLI `--ipk --version --out`. Escreve `repo.json`, `org.community.webos.adblocker.manifest.json`, `icon.png` (de `app/icon.png`), `lists/lite.txt` (de `service/lists/lite.txt`), `index.html`, `.nojekyll`. Pages base = `https://<owner>.github.io/<name>/`.
  - `scripts/set-version.js <x.y.z>` exporta `setVersion(version, rootDir)`; atualiza `app/appinfo.json`, `service/package.json`, `package.json` (preserva formatação 2 espaços + `\n`); rejeita versão fora de `^\d+\.\d+\.\d+$`.
- [ ] Step 1: Testes (dir temporário, ipk falso de bytes conhecidos): `repo.json matches HBChannel schema` (`paging` completo, `packages[0]` com `id,title,iconUri,manifestUrl,shortDescription,manifest`), `manifest has sha256 and size` (sha256 calculado no teste), `manifest urls use release tag` (`ipkUrl` exato da spec para a versão `1.2.3`), `owner from GITHUB_REPOSITORY`, `setVersion updates three files`, `setVersion rejects bad version`.
- [ ] Step 2: FAIL → implementar → `npm test` PASS.

### Task 8: CI/CD e documentação

**Files:** Create `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `README.md`, `CONTRIBUTING.md`

**Interfaces:**
- Consumes: scripts npm (Task 1), `scripts/set-version.js`, `scripts/build-repo.js` (Task 7), saída `dist/org.community.webos.adblocker_<ver>_all.ipk`.

- [ ] Step 1: `ci.yml` (push em `main` e PR; ubuntu-latest; `actions/checkout@v4`, `actions/setup-node@v4` Node 22 com cache npm; `npm ci`; `npm test`; `npm run package`).
- [ ] Step 2: `release.yml` conforme spec (tag `v*`, `permissions: contents: write`, `concurrency` por ref; versão `${GITHUB_REF_NAME#v}`; `softprops/action-gh-release@v2` com `files: dist/*.ipk` e `generate_release_notes: true`; `peaceiris/actions-gh-pages@v4` com `publish_branch: gh-pages`, `publish_dir: ./site`). Validar YAML com `node -e` + pacote `yaml` via `npx --yes yaml valid < arquivo` ou parse equivalente.
- [ ] Step 3: `README.md` em pt-BR: o que faz; aviso (requer root/HBChannel; uso por conta e risco); instalação pela TV (Homebrew Channel → Configurações → adicionar repositório `https://mxruyama.github.io/webos-adblock/repo.json` → instalar → abrir → “Conceder root” → escolher lista → “Ativar Bloqueio”); instalação manual (`ares-install`); como desfazer; como funciona (bind-mount, bloco no `startup.sh`, auto-reparo); listas; desenvolvimento local (`npm install`, `npm test`, `npm run icons`, `npm run package`, abrir `app/index.html?mock=1`); publicar versão (`git tag vX.Y.Z && git push --tags`; ativar Pages na branch `gh-pages` se necessário); checklist de teste manual na TV; solução de problemas (via SSH: `cat /proc/mounts | grep hosts`, `umount /etc/hosts`). `CONTRIBUTING.md`: regras ES5, testes, padrões de commit, como propor domínios para a lista leve.

### Task 9: Integração, verificação e publicação (controlador)

- [ ] Step 1: `npm test` completo → PASS; `npm run package` → `dist/org.community.webos.adblocker_1.0.0_all.ipk`; inspecionar com `tar`/`ar` (contém `usr/palm/applications/<id>/appinfo.json` e `usr/palm/services/<service-id>/service.js`).
- [ ] Step 2: UI no Chrome via DevTools MCP em `app/index.html?mock=1` (servidor estático local): screenshot inicial (sem root), “Conceder root”, ativar lite, contador, desativar, navegação por setas/Enter.
- [ ] Step 3: `node scripts/build-repo.js --ipk dist/... --version 1.0.0 --out site` e conferência do JSON.
- [ ] Step 4: revisão final do branch inteiro; commit; `git push -u origin main`; `git tag v1.0.0 && git push origin v1.0.0`.
- [ ] Step 5: acompanhar Actions pela API pública; conferir Release com `.ipk`, `https://mxruyama.github.io/webos-adblock/repo.json` e sha256 do manifesto = sha256 do asset baixado. Se Pages não estiver ativo, ativar via API (`POST /repos/mxruyama/webos-adblock/pages` com `source.branch=gh-pages`) usando a credencial do Git Credential Manager.

### Task 10: Integração real em Linux (root, mount real, Node 0.12 e 22)

Adicionada durante a execução: não há Linux local; o runner `ubuntu-latest` do GitHub Actions dá root real, `mount --bind` real, resolvedor glibc e permite rodar o Node 0.12.18 (runtime do webOS 3).

**Files:**
- Create: `service/lib/runtime.js`, `test/integration/linux-root.js`
- Modify: `service/service.js` (passa a usar `runtime.js`), `.github/workflows/ci.yml` (job `integration`)

**Interfaces:**
- Consumes: `createBlocker`, `createDownloader`, `splitPemBundle`, `BEGIN` de `startup.js`.
- Produces: `service/lib/runtime.js` (ES5) exporta `LITE_URL`, `FULL_URL`, `DEFAULT_PATHS` e `createRuntimeBlocker(overrides?: {paths?, liteUrl?, fullUrl?, execFile?}) → blocker`, com as mesmas dependências reais que hoje estão em `service.js` (exec com timeout 30000 e erro do stderr, `isRoot`, downloader com `ca` = `splitPemBundle(certs/cacert.pem)`, timeout 60000). `service.js` fica só com a camada Luna.

- [ ] Step 1: extrair `runtime.js`; `service.js` usa `createRuntimeBlocker()`; `npm test` continua verde (incluindo `test/service.test.js`).
- [ ] Step 2: `test/integration/linux-root.js` (ES5, roda em Node 0.12 e 22; não casa com o glob `*.test.js`; sai com código ≠ 0 na primeira falha, imprimindo cada passo `ok - …`). Recusa rodar se não for Linux+root. Usa os caminhos reais (`/etc/hosts`, `/var/lib/webosbrew/*`). Passos e asserções:
  1. Prepara `/var/lib/webosbrew/startup.sh` mínimo (`#!/bin/sh` + `echo boot`), modo 0755; guarda cópias para comparação.
  2. Simula o bloqueio de updates do HBChannel: `/tmp/hosts` = `/etc/hosts` + `127.0.0.1 snu.lge.com`; `mount --bind /tmp/hosts /etc/hosts`.
  3. `status` → `active:false`, `root:true`.
  4. `enable {list:'lite'}` (liteUrl apontando para URL inexistente → cai na lista embutida) → `active`, `persistent`, `count >= 200`; `/etc/hosts` contém `snu.lge.com`, `localhost` e `0.0.0.0 ad.lgappstv.com`; `getent hosts ad.lgappstv.com` retorna `0.0.0.0`.
  5. Download https puro (downloader com `execFile` que sempre falha, forçando o caminho `https` + CA em array) de `FULL_URL` → texto > 1 MB.
  6. `enable {list:'full'}` → `count > 50000`; `getent hosts ad.doubleclick.net` → `0.0.0.0`.
  7. `update {list:'lite'}` → `count < 1000`, ainda ativo.
  8. Reboot simulado: `umount /etc/hosts` (uma camada) → `sh /var/lib/webosbrew/startup.sh` → `status.active === true`.
  9. `disable` → `active:false`; `/etc/hosts` = conteúdo de `/tmp/hosts` (camada HBChannel intacta, sem `# >>> webos-adblock`); `startup.sh` byte a byte igual ao original; `hosts.block` removido.
  10. Limpeza: `umount /etc/hosts` (camada HBChannel).
- [ ] Step 3: job `integration` no `ci.yml` (ubuntu-latest, matriz `node: ['0.12.18', '22']`): Node 22 via `actions/setup-node@v4`; Node 0.12.18 baixado de `https://nodejs.org/dist/v0.12.18/node-v0.12.18-linux-x64.tar.gz` e posto no PATH; executa `sudo env "PATH=$PATH" node test/integration/linux-root.js`.
