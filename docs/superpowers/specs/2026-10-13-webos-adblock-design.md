# webos-adblock — Design

Data: 2026-10-13 · Repositório: https://github.com/mxruyama/webos-adblock

## Objetivo

App webOS (`.ipk`) com serviço root que bloqueia anúncios, telemetria LG e rastreadores em toda a TV
via bind-mount de `/etc/hosts`, distribuído por um repositório compatível com o webOS Homebrew Channel
hospedado no GitHub Pages e publicado automaticamente pelo GitHub Actions a cada tag `v*`.

Critérios de sucesso:
- Usuário adiciona `https://mxruyama.github.io/webos-adblock/repo.json` no Homebrew Channel e instala com 1 clique.
- App concede root ao próprio serviço, ativa/desativa/atualiza o bloqueio, e o bloqueio persiste após reboot.
- Desativar restaura `/etc/hosts` original sem quebrar o sistema (inclusive o bloqueio de updates do HBChannel).
- Roda em webOS 3.x+ (Chrome 38 / Node 0.12): todo JS do app e do serviço é ES5.

## Decisões fixadas (com o usuário)

| Tema | Decisão |
|---|---|
| Repo GitHub | `mxruyama/webos-adblock`, Pages em `https://mxruyama.github.io/webos-adblock/` |
| webOS mínimo | 3.x — ES5 estrito no app e no serviço; CSS sem custom properties nem grid |
| Persistência | bloco marcado inserido no fim de `/var/lib/webosbrew/startup.sh` |
| Publicação | Claude cria commits, faz push para `origin main` e cria a tag `v1.0.0` |
| App ID | `org.community.webos.adblocker`; serviço `org.community.webos.adblocker.service` |

## Fatos verificados no código do Homebrew Channel (HBChannel)

- Repositório = qualquer URL JSON com `{"paging":{...},"packages":[...]}`. Cada pacote:
  `id`, `title`, `iconUri`, `manifestUrl`, `shortDescription` (opcional `manifest` embutido).
- Manifesto do app (buscado de `manifestUrl`): `id`, `version`, `type` (`"web"` para nós), `title`,
  `appDescription`, `iconUri`, `sourceUrl`, `rootRequired`, `ipkUrl`, `ipkHash.sha256`, `ipkSize`.
  URLs relativas são resolvidas contra `manifestUrl`.
- O HBChannel NÃO eleva serviços de terceiros na instalação. O app deve chamar
  `luna://org.webosbrew.hbchannel.service/elevateService` com `{"id":"org.community.webos.adblocker.service"}`.
  A elevação reescreve arquivos em `/var/luna-service2-dev` (persistente) e roda `ls-control scan-services`;
  o processo atual do serviço precisa ser encerrado para renascer como root.
- `getConfiguration` do HBChannel retorna `{root: bool}` — indica se a TV tem root.
- `/var/lib/webosbrew/startup.sh` roda uma vez por boot (lock em `/tmp/webosbrew_startup`). Termina em `fi`,
  sem `exit`, então um bloco anexado ao fim é executado. Usuários podem sobrescrever esse arquivo ao atualizar o HBChannel.
- Com `/var/luna/preferences/webosbrew_block_updates`, o próprio HBChannel faz `mount --bind /tmp/hosts /etc/hosts`
  com entradas de bloqueio de update da LG. Nosso hosts deve preservar esse conteúdo.

## Arquitetura

```
app/      (UI web, ES5)  ──Luna (PalmServiceBridge)──►  service/ (Node, root após elevação)
                          └──► luna://org.webosbrew.hbchannel.service/{getConfiguration,elevateService}
service/  ──► fs: /var/lib/webosbrew/{hosts.block, adblocker.json, startup.sh}, /etc/hosts
          ──► child_process: mount, umount, (curl|wget fallback)
          ──► https: listas remotas
CI        ──► ares-package → Release (.ipk) → scripts/build-repo.js → branch gh-pages
```

### Layout

```
app/appinfo.json, index.html, css/app.css, js/luna.js, js/spatial-nav.js, js/app.js,
    icon.png (80x80), largeIcon.png (130x130), splash.png (1920x1080)
service/package.json, services.json, service.js,
        lib/hosts.js, lib/startup.js, lib/mounts.js, lib/download.js, lib/state.js, lib/blocker.js,
        lists/lite.txt, certs/cacert.pem
scripts/build-repo.js, scripts/make-icons.js, scripts/set-version.js
test/*.test.js
.github/workflows/ci.yml, .github/workflows/release.yml
package.json (raiz: devDependencies e scripts npm), README.md, CONTRIBUTING.md, LICENSE (MIT), .gitignore
```

## Serviço (service/)

Usa o módulo nativo `webos-service` (`new Service('org.community.webos.adblocker.service')`).
`service.js` é só a camada Luna; toda a lógica fica em `lib/` com dependências injetáveis (`fs`, `exec`,
`download`, caminhos) para teste.

### Constantes de caminho
- `BLOCK_FILE = /var/lib/webosbrew/hosts.block`
- `STATE_FILE = /var/lib/webosbrew/adblocker.json` (`{enabled, list, count, updatedAt}`)
- `STARTUP_FILE = /var/lib/webosbrew/startup.sh`
- `HOSTS = /etc/hosts`

### Métodos Luna
Todas as respostas: `{returnValue, active, persistent, root, list, count, updatedAt}` e, em erro,
`returnValue:false, errorText`.

| Método | Parâmetros | Efeito |
|---|---|---|
| `status` | — | Lê estado; auto-repara bloco do startup.sh se `enabled` e bloco ausente; se `enabled` mas hosts não montado e `hosts.block` existe, remonta |
| `enable` | `{list:"lite"\|"full"}` (padrão `lite`) | Monta lista → grava `hosts.block` → bind-mount → bloco no startup.sh → salva estado |
| `disable` | — | umount (só se o mount for nosso) → remove bloco → apaga `hosts.block` → estado `enabled:false` |
| `update` | `{list?}` | Igual a `enable` usando a lista atual (ou a nova); se inativo, só retorna erro `"Bloqueio inativo"` |
| `restart` | — | Responde e chama `process.exit(0)` após 200 ms (renascer como root) |

Métodos de escrita exigem root (`process.getuid() === 0`); sem root → `errorText: "Serviço sem root. Use 'Conceder root'."`.
Operações são serializadas (fila simples) para evitar corridas entre cliques.

### Montagem da lista (`lib/hosts.js`, puro)
- `parseDomains(text)`: aceita linhas `IP domínio [domínio…]` e linhas com só o domínio; ignora comentários (`#`),
  vazias, IPs fora de `0.0.0.0`/`127.0.0.1`/`::1` quando há IP; normaliza para minúsculas; valida com
  `/^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/`; descarta
  `localhost`, `localhost.localdomain`, `local`, `broadcasthost`, `ip6-*`, `0.0.0.0`.
- `buildHostsFile(baseHosts, domains, meta)`: base (hosts atual sem um bloco nosso anterior) + cabeçalho
  `# >>> webos-adblock (gerado em <data>, lista <list>, <n> domínios)` + `0.0.0.0 <domínio>` por linha, deduplicado
  e preservando ordem; garante `127.0.0.1 localhost` e `::1 localhost` na base se ausentes.
- Limite: arquivo final > 15 MB → erro.

### Fontes
- Leve: `service/lists/lite.txt` (embutida) — anúncios/telemetria LG curados, sem domínios necessários para loja,
  login LG, updates de apps ou streaming. Em `enable`/`update` tenta baixar
  `https://mxruyama.github.io/webos-adblock/lists/lite.txt`; falha → usa a embutida silenciosamente.
- Completa: Leve + `https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts`. Falha no download → erro,
  estado inalterado.

### Download (`lib/download.js`)
Ordem: Node `https` com `ca` = `certs/cacert.pem` (bundle Mozilla, segue até 5 redirects, timeout 60 s) →
`curl -fsSL --max-time 60` → `wget -q -O -`. Retorna o texto ou erro com a última mensagem.

### Base do hosts
Se nosso mount está ativo, base = `hosts.block` sem o nosso bloco (tudo antes do cabeçalho `# >>> webos-adblock`).
Senão, base = conteúdo atual de `/etc/hosts` (inclui o bloqueio de updates do HBChannel, se ativo).

### Mount (`lib/mounts.js`)
- `isOurMount()`: `stat(/etc/hosts)` e `stat(hosts.block)` com mesmo `dev` e `ino`.
- `mount()`: `mount --bind <BLOCK_FILE> /etc/hosts`.
- `unmountOurs()`: enquanto `isOurMount()` (máx. 3 tentativas) → `umount /etc/hosts`.
- Atualizar com mount ativo: grava `hosts.block.tmp` → `unmountOurs()` → `rename` → `mount()`
  (bind aponta para o inode, então reescrever no lugar com rename não teria efeito).

### startup.sh (`lib/startup.js`, puro + IO fino)
Bloco exato:
```sh
# >>> org.community.webos.adblocker >>>
if [ -s /var/lib/webosbrew/hosts.block ]; then
    mount --bind /var/lib/webosbrew/hosts.block /etc/hosts
fi
# <<< org.community.webos.adblocker <<<
```
- `addBlock(text)`: remove bloco existente e anexa ao fim (garante `\n` antes). Idempotente.
- `removeBlock(text)`: remove tudo entre os marcadores (inclusive) e linhas em branco extras deixadas.
- `hasBlock(text)`.
- IO: lê, aplica, grava em `startup.sh.tmp`, `chmod` com o modo original (padrão 0755), `rename`.
- Arquivo ausente → não cria; `persistent:false` e `warning:"startup.sh não encontrado; o bloqueio não persistirá após reiniciar"`.

## Frontend (app/)

- `appinfo.json`: `id`, `version`, `vendor:"webos-adblock"`, `type:"web"`, `main:"index.html"`, `title:"AdBlocker"`,
  `icon`, `largeIcon`, `splashBackground:"splash.png"`, `bgColor:"#101418"`, `resolution:"1920x1080"`,
  `disableBackHistoryAPI:true`.
- `luna.js`: `call(uri, params, cb)` via `PalmServiceBridge`; com `?mock=1` (ou sem bridge) usa um mock em memória
  que simula estado, root e latência.
- `spatial-nav.js`: foco por direção usando `getBoundingClientRect` (candidato mais próximo no semiplano da seta);
  `mouseover` foca (Magic Remote); OK (13) dispara `click`; Back (461/Escape) fecha o app via
  `window.close()`.
- Tela única 1920x1080, tema escuro, fontes ≥ 28px, anel de foco amarelo 6px:
  - Cabeçalho com título e versão.
  - Cartão de status: bolinha + texto "Ativo" (verde `#2ecc71`) / "Inativo" (vermelho `#e74c3c`); contador
    "N domínios bloqueados"; "Atualizado em …"; aviso de persistência.
  - Seleção de lista (radio, dois botões alternáveis): "Leve — anúncios e telemetria LG" / "Completa — StevenBlack + LG".
  - Botões: "Ativar Bloqueio", "Desativar Bloqueio", "Atualizar Listas".
  - Banner de root quando `status.root === false`: botão "Conceder root" → `getConfiguration` do HBChannel
    (se `root:false` → mensagem "TV sem root / Homebrew Channel ausente") → `elevateService` → `restart` →
    re-`status` após 2 s.
  - Área de mensagem (sucesso/erro) e overlay "Processando…" com botões desabilitados durante operações.
- Botões irrelevantes ficam desabilitados (Ativar quando ativo, Desativar/Atualizar quando inativo), mas o foco os pula.

## Repositório Homebrew e CI/CD

### scripts/build-repo.js
`node scripts/build-repo.js --ipk <path> --version <x.y.z> --out <dir>` gera em `<dir>`:
- `repo.json`: `{paging:{page:1,count:1,maxPage:1,itemsTotal:1,prevUrl:null,nextUrl:null}, packages:[{id,title,
  iconUri:"https://mxruyama.github.io/webos-adblock/icon.png", manifestUrl:"https://mxruyama.github.io/webos-adblock/org.community.webos.adblocker.manifest.json",
  shortDescription, manifest:{...igual ao manifesto}}]}`
- `org.community.webos.adblocker.manifest.json`: `{id, version, type:"web", title:"AdBlocker", appDescription,
  iconUri, sourceUrl:"https://github.com/mxruyama/webos-adblock", rootRequired:true,
  ipkUrl:"https://github.com/mxruyama/webos-adblock/releases/download/v<ver>/org.community.webos.adblocker_<ver>_all.ipk",
  ipkHash:{sha256}, ipkSize}`
- `icon.png`, `lists/lite.txt`, `index.html` (página simples com a URL do repositório e instruções).
- Owner/repo vêm de `GITHUB_REPOSITORY` quando definido, padrão `mxruyama/webos-adblock`.

### scripts/set-version.js
Grava a versão em `app/appinfo.json`, `service/package.json` e `package.json`.

### .github/workflows/ci.yml
Em push/PR: Node 20, `npm ci`, `npm test`, `npm run package` (valida empacotamento).

### .github/workflows/release.yml
Em push de tag `v*` (permissões `contents: write`):
1. checkout, Node 20, `npm ci`, `npm test`.
2. `node scripts/set-version.js ${GITHUB_REF_NAME#v}`.
3. `npx ares-package app service -o dist --no-minify` (de `@webos-tools/cli` em devDependencies).
4. Release via `softprops/action-gh-release@v2` com `dist/*.ipk`.
5. `node scripts/build-repo.js ... --out site`; publica `site/` na `gh-pages` com `peaceiris/actions-gh-pages@v4`
   (`keep_files: false`).

## Tratamento de erros
- Todo método Luna responde exatamente uma vez; exceções viram `returnValue:false`.
- `enable`/`update` falhando após desmontar tentam remontar o `hosts.block` anterior (rollback).
- `disable` é tolerante: ausência de mount/bloco/arquivo não é erro.
- O frontend mostra `errorText` e reconsulta `status` após cada operação.

## Testes e validação
1. `node --test` (unitários): `hosts.js` (parse, sanitização, dedupe, base sem bloco antigo, limite),
   `startup.js` (add/remove idempotente, preservação do resto), `blocker.js` com fs/exec/download falsos
   (enable/disable/update/status, rollback, auto-reparo, sem root), `build-repo.js` (schema HBChannel, sha256, URLs).
2. Checagem ES5: `acorn` com `ecmaVersion: 5` em todo `app/js/*.js`, `service/**/*.js`.
3. Validação JSON de `appinfo.json`, `services.json`, `service/package.json`.
4. UI no Chrome (DevTools MCP) com `?mock=1`: navegação por setas/Enter, estados ativo/inativo/sem root, screenshots.
5. `npm run package` gera o `.ipk`; conteúdo inspecionado (app + service + control).
6. Push + tag `v1.0.0`; verificação do Actions, da Release e do `repo.json`/manifesto servidos pelo Pages
   (sha256 confere com o asset).
7. Não testável aqui: execução numa TV real — README traz checklist de teste manual.
