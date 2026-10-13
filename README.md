# AdBlocker para webOS

[![CI](https://github.com/mxruyama/webos-adblock/actions/workflows/ci.yml/badge.svg)](https://github.com/mxruyama/webos-adblock/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mxruyama/webos-adblock?label=release)](https://github.com/mxruyama/webos-adblock/releases/latest)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)

Bloqueador de anúncios, telemetria da LG e rastreadores para **TVs LG com webOS**, instalável pelo
[Homebrew Channel](https://www.webosbrew.org/).

## O que faz

O AdBlocker é um app webOS (`.ipk`) com um serviço que roda como **root** na TV. O serviço monta uma lista de
domínios indesejados em um arquivo `hosts` e o aplica sobre `/etc/hosts` com um *bind-mount*. A partir daí,
qualquer app da TV que tente falar com esses domínios recebe `0.0.0.0` e não consegue conectar.

- Bloqueio em toda a TV (apps, tela inicial, ACR/telemetria da LG), sem proxy e sem DNS externo.
- Duas listas: **Leve** (curada, segura para o uso diário) e **Completa** (Leve + StevenBlack).
- O bloqueio **persiste após reiniciar** a TV.
- Desativar restaura o `/etc/hosts` original, inclusive o bloqueio de atualizações do Homebrew Channel.
- Funciona em webOS 3.x ou mais novo: todo o JavaScript do app e do serviço é ES5.
- Interface pensada para controle remoto: navegação por setas, OK para confirmar, Magic Remote com ponteiro.

## Aviso

- **Projeto não oficial e sem qualquer vínculo com a LG Electronics.** “LG” e “webOS” são marcas de seus
  respectivos donos.
- Exige uma TV com **root** e o **Homebrew Channel** instalado. Veja [rootmy.tv](https://rootmy.tv/) e
  [webosbrew.org](https://www.webosbrew.org/). Este projeto **não** faz root da TV.
- O app altera `/etc/hosts` (por montagem, sem sobrescrever o arquivo original) e acrescenta um bloco ao
  `/var/lib/webosbrew/startup.sh`. **Uso por sua conta e risco**, sem garantia de nenhum tipo (licença MIT).
- Listas de bloqueio podem quebrar um app ou serviço específico. Se algo parar de funcionar, desative o bloqueio
  (veja [Como desfazer](#como-desfazer)) e, se possível, avise qual domínio causou o problema.

## Instalação pela TV (recomendada)

Pré-requisito: TV com root e Homebrew Channel instalado e funcionando.

1. Abra o **Homebrew Channel** na TV.
2. Abra as configurações: **Settings** (ícone de engrenagem). A interface do Homebrew Channel é em inglês.
3. Na seção **Repositories**, escolha **Add repository** (adicionar repositório).
4. No diálogo **Enter repository URL:**, digite

   ```
   https://cdn.jsdelivr.net/gh/mxruyama/webos-adblock@gh-pages/repo.json
   ```

   e confirme no botão **Add repository**. (A página <https://mxruyama.github.io/webos-adblock/> mostra a
   mesma URL.)

   > **Por que jsDelivr?** TVs LG mais antigas não confiam no certificado Let's Encrypt (ISRG Root X1)
   > do GitHub Pages; o repositório não carrega e o app não aparece na lista. O jsDelivr serve os mesmos
   > arquivos da branch `gh-pages` com um certificado aceito por essas TVs. Em TVs novas, a URL
   > `https://mxruyama.github.io/webos-adblock/repo.json` também funciona.
5. Volte para a lista de aplicativos do Homebrew Channel e toque no botão de **recarregar** (seta circular no
   topo) ou feche e reabra o Homebrew Channel: o **AdBlocker** aparece ali. Abra-o e instale.
6. Abra o **AdBlocker** pelo launcher da TV.
7. Se aparecer o aviso de root, selecione **Conceder root** e aguarde alguns segundos (veja
   [o que “Conceder root” faz](#o-que-conceder-root-faz)).
8. Escolha a lista: **Leve — anúncios e telemetria LG** ou **Completa — StevenBlack + LG**.
9. Selecione **Ativar Bloqueio**. Quando o status mudar para **Ativo** (bolinha verde), está pronto.

> Opção “Block system updates” do Homebrew Channel: ela **convive** com o AdBlocker. O conteúdo que o Homebrew
> Channel coloca no `/etc/hosts` (domínios de atualização da LG) é preservado no hosts do AdBlocker, e ao desativar
> o AdBlocker só a camada dele é removida: o bloqueio de atualizações do Homebrew Channel continua como estava.
> Ligou ou desligou “Block system updates” com o AdBlocker já ativo? Selecione **Atualizar Listas**: o hosts é
> regenerado sobre o `/etc/hosts` atual (sem a camada do AdBlocker) e passa a refletir a mudança. Não é preciso
> desativar o bloqueio antes.

### O que “Conceder root” faz

O Homebrew Channel **não** eleva serviços de terceiros durante a instalação. Por isso, na primeira vez o serviço
do AdBlocker (`org.community.webos.adblocker.service`) ainda roda sem privilégios e não pode alterar o
`/etc/hosts`. O botão **Conceder root**:

1. consulta o Homebrew Channel (`getConfiguration`) para confirmar que a TV tem root; sem root ou sem o Homebrew
   Channel, o app mostra “TV sem root / Homebrew Channel ausente”;
2. pede ao Homebrew Channel que eleve o serviço (`elevateService`), o que registra o serviço como root de forma
   persistente;
3. reinicia o serviço (`restart`) para que ele renasça já como root e consulta o status de novo.

Isso só precisa ser feito uma vez.

## Instalação manual

Use se preferir instalar o `.ipk` diretamente (por exemplo, para testar uma versão local). Mesmo assim, o
Homebrew Channel precisa estar instalado na TV para o passo “Conceder root”.

1. Ative o **Developer Mode** na TV e cadastre-a no `ares-setup-device` (a CLI vem do pacote
   `@webos-tools/cli`, já listado nas `devDependencies`):

   ```sh
   npm install
   npx ares-setup-device
   ```

2. Baixe o `.ipk` em [Releases](https://github.com/mxruyama/webos-adblock/releases/latest) ou gere um com
   `npm run package` (a saída fica em `dist/`).
3. Instale:

   ```sh
   npx ares-install --device tv dist/org.community.webos.adblocker_<versao>_all.ipk
   ```

   (`tv` é o nome dado ao dispositivo no `ares-setup-device`; troque `<versao>` pela versão do arquivo.)
4. Abra o **AdBlocker** pelo launcher e siga os passos 7 a 9 da seção anterior.

## Como usar o app

| Elemento | O que faz |
|---|---|
| Cartão de status | Mostra **Ativo** (verde) ou **Inativo** (vermelho), “N domínios bloqueados”, “Atualizado em …” e avisos (por exemplo, falta de persistência). |
| Lista **Leve** / **Completa** | Escolhe a fonte de domínios usada em **Ativar Bloqueio** e **Atualizar Listas**. |
| **Ativar Bloqueio** | Baixa a lista, aplica o bloqueio agora e o torna permanente. Desabilitado quando já está ativo. |
| **Desativar Bloqueio** | Remove o bloqueio e restaura o `/etc/hosts`. Desabilitado quando está inativo. |
| **Atualizar Listas** | Baixa as listas de novo e troca o bloqueio em uso por uma versão atualizada. Só funciona com o bloqueio ativo (inativo: erro “Bloqueio inativo”). |
| **Conceder root** | Aparece quando o serviço ainda não roda como root. |

Navegue com as setas do controle, **OK** aciona o botão em foco e **Voltar** fecha o app. Durante uma operação
aparece “Processando…” e os botões ficam desabilitados.

## Como desfazer

**Pelo app (jeito certo):**

1. Abra o AdBlocker e selecione **Desativar Bloqueio**. Isso desmonta a camada do AdBlocker em `/etc/hosts`,
   remove o bloco do `startup.sh` e apaga o `hosts.block`.
2. Só então desinstale o app (pelo Homebrew Channel ou pelo launcher da TV).

Desinstalar o app **sem** desativar antes deixa o bloqueio montado e o bloco no `startup.sh`: o bloqueio
continua valendo e é reaplicado a cada boot, sem o app para desligá-lo.

**Emergência, via SSH** (por exemplo, se o app não abre mais ou foi desinstalado com o bloqueio ativo):

```sh
# 1. Confira o que está montado sobre o hosts (a camada do AdBlocker é a última da lista)
cat /proc/mounts | grep hosts

# 2. Desmonte a camada do AdBlocker. Repita se houver mais de uma camada nossa.
umount /etc/hosts

# 3. Remova do startup.sh o bloco entre os marcadores
#    "# >>> org.community.webos.adblocker >>>" e "# <<< org.community.webos.adblocker <<<"
#    (com sed, ou abrindo o arquivo em um editor)
sed -i '/# >>> org.community.webos.adblocker >>>/,/# <<< org.community.webos.adblocker <<</d' /var/lib/webosbrew/startup.sh

# 4. Obrigatório: apague os arquivos de dados do AdBlocker
rm -f /var/lib/webosbrew/hosts.block /var/lib/webosbrew/adblocker.json
```

O passo 4 não é opcional: enquanto o `adblocker.json` disser que o bloqueio está ligado, basta abrir o app (ou
qualquer consulta de status) para o auto-reparo recolocar o bloco no `startup.sh` e, se o `hosts.block` ainda
existir, montar o hosts de novo, reativando o bloqueio.

> Se você usa “Block system updates” do Homebrew Channel, o `/etc/hosts` pode ter também a camada dele. Faça
> `umount /etc/hosts` uma vez por vez e confira com `cat /proc/mounts | grep hosts`: remover a camada do
> Homebrew Channel só desliga o bloqueio de atualizações dele até o próximo boot.

## Como funciona

```
app/ (UI web, ES5) ──Luna──► service/ (Node, root após elevação)
                  └──────► luna://org.webosbrew.hbchannel.service/{getConfiguration,elevateService}
service/ ──► fs: /var/lib/webosbrew/{hosts.block, adblocker.json, startup.sh}, /etc/hosts
         ──► mount, umount, (curl|wget como alternativa de download)
         ──► https: listas remotas
```

- **Bind-mount do hosts.** O serviço grava o hosts completo (o `/etc/hosts` atual mais um bloco com
  `0.0.0.0 <domínio>` por linha) em `/var/lib/webosbrew/hosts.block` e executa
  `mount --bind /var/lib/webosbrew/hosts.block /etc/hosts`. O `/etc/hosts` original não é reescrito: ao
  desmontar, ele volta intacto. O hosts gerado traz o cabeçalho
  `# >>> webos-adblock (gerado em …, lista …, N domínios)`, é limitado a 15 MB e sempre garante as entradas
  `127.0.0.1 localhost` e `::1 localhost`.
- **Persistência.** Para sobreviver ao reboot, o serviço acrescenta ao fim de
  `/var/lib/webosbrew/startup.sh` (que o Homebrew Channel executa uma vez por boot) este bloco:

  ```sh
  # >>> org.community.webos.adblocker >>>
  if [ -s /var/lib/webosbrew/hosts.block ]; then
      mount --bind /var/lib/webosbrew/hosts.block /etc/hosts
  fi
  # <<< org.community.webos.adblocker <<<
  ```

  A escrita é atômica (arquivo temporário e `rename`) e preserva o modo do arquivo. Se o `startup.sh` não
  existir, o app **não** o cria: o bloqueio funciona até reiniciar, e o status avisa
  “startup.sh não encontrado; o bloqueio não persistirá após reiniciar”.
- **Auto-reparo.** A cada consulta de status, se o bloqueio está ativado mas o bloco sumiu do `startup.sh` (por
  exemplo, porque uma atualização do Homebrew Channel sobrescreveu o arquivo), o serviço o reinsere; se o hosts
  não está montado mas o `hosts.block` existe, ele monta de novo.
- **Atualizar com o bloqueio ativo.** O bind-mount aponta para o inode do arquivo, então reescrever no lugar não
  teria efeito. O serviço baixa as listas primeiro (falha aqui não muda nada), desmonta a camada própria, monta o
  hosts novo sobre o `/etc/hosts` que ficou por baixo (assim entram mudanças do Homebrew Channel), grava
  `hosts.block.tmp`, renomeia e monta de novo. Se algo falha depois de desmontar, ele remonta o `hosts.block`
  anterior.
- **Segurança das operações.** Ações de escrita exigem root (`Serviço sem root. Use 'Conceder root'.` caso
  contrário) e são executadas em fila, então cliques repetidos não se atropelam. Desativar é tolerante: não há
  erro se o mount, o bloco ou os arquivos já não existirem, e só a camada montada pelo AdBlocker é desmontada.
- **Estado.** `/var/lib/webosbrew/adblocker.json` guarda `{enabled, list, count, updatedAt}`.

## Listas

| Lista | Conteúdo | Fonte |
|---|---|---|
| **Leve** | Anúncios, ACR e telemetria da LG, curados à mão. **Não** inclui nada necessário para loja de apps, login LG, atualizações de apps ou streaming. | `service/lists/lite.txt` (embutida no app). Em cada ativação/atualização o serviço tenta baixar a versão mais nova de <https://mxruyama.github.io/webos-adblock/lists/lite.txt>; se falhar, usa a embutida sem avisar. |
| **Completa** | Leve + [StevenBlack/hosts](https://github.com/StevenBlack/hosts) (anúncios, rastreadores e malware da web em geral). | Baixada de `raw.githubusercontent.com/StevenBlack/hosts/master/hosts`. Se o download falhar, a operação dá erro e o estado anterior é mantido. |

A lista Completa é bem maior e bloqueia mais, mas também tem mais risco de afetar algum site ou app. Comece pela
Leve. O download tenta o `https` do Node com o pacote de certificados embutido (`service/certs/cacert.pem`), depois
`curl` e por fim `wget`. Para propor domínios, veja o [CONTRIBUTING.md](CONTRIBUTING.md).

## Desenvolvimento local

Requisitos: Node.js 22 ou mais novo.

```sh
npm install        # dependências de desenvolvimento (@webos-tools/cli, acorn)
npm test           # testes unitários + checagem ES5
npm run icons      # regenera app/icon.png, largeIcon.png e splash.png (já estão versionados)
npm run package    # gera dist/org.community.webos.adblocker_<versao>_all.ipk
```

Para ver a interface sem uma TV, abra `app/index.html?mock=1` no Chrome (direto do disco ou por qualquer servidor
estático). O modo `?mock=1` substitui o barramento Luna por um mock em memória
que simula root, estado e latência. Sem `PalmServiceBridge` (fora da TV) o mock é usado automaticamente.

A lógica do serviço fica em `service/lib/` com dependências injetáveis (`fs`, `exec`, `download`, caminhos) e é
coberta por testes com um sistema de arquivos falso (`test/helpers/fakes.js`). Detalhes de estilo, ES5 e commits
em [CONTRIBUTING.md](CONTRIBUTING.md).

### Estrutura do projeto

```
app/                    Interface web da TV (ES5)
  appinfo.json
  index.html
  css/app.css
  js/luna.js            ponte Luna (+ mock com ?mock=1)
  js/spatial-nav.js     navegação por foco para controle remoto
  js/app.js
  icon.png  largeIcon.png  splash.png
service/                Serviço Node que roda como root (ES5)
  package.json  services.json  service.js   camada Luna fina
  lib/hosts.js          parse/montagem do hosts
  lib/startup.js        bloco do startup.sh
  lib/mounts.js         bind-mount do hosts
  lib/download.js       https -> curl -> wget
  lib/certs.js          quebra o cacert.pem em um certificado por item (Node 0.12)
  lib/state.js          adblocker.json
  lib/blocker.js        orquestração (enable/disable/update/status)
  lib/runtime.js        dependências reais e caminhos da TV (usado por service.js)
  lists/lite.txt        lista leve embutida
  certs/cacert.pem      certificados para o download https
scripts/                Ferramentas de build (Node moderno)
  build-repo.js         gera repo.json, manifesto e página do Pages
  set-version.js        grava a versão nos três package/appinfo
  make-icons.js         gera os PNGs
test/                   Testes (node --test)
  helpers/fakes.js      sistema de arquivos + mount/umount falsos
  integration/linux-root.js   integração real (Linux + root), roda no CI
.github/workflows/      ci.yml e release.yml
package.json  README.md  CONTRIBUTING.md  LICENSE
```

## Publicar uma versão

O repositório do Homebrew Channel e a Release são gerados pelo GitHub Actions a cada tag `v*`:

```sh
git tag vX.Y.Z
git push --tags
```

O workflow `release.yml` roda os testes, grava a versão da tag (sem o `v`) nos arquivos do projeto, empacota o
`.ipk`, cria a Release com o arquivo anexado, gera o repositório (`repo.json`, manifesto com sha256 e tamanho,
ícone, `lists/lite.txt`, página inicial) e o publica na branch `gh-pages`.

Na primeira publicação, ative o GitHub Pages em **Settings → Pages → Build and deployment**, com
**Source: Deploy from a branch**, branch **`gh-pages`** e pasta **`/ (root)`**. Depois confira:

- a Release tem o `.ipk` anexado;
- <https://cdn.jsdelivr.net/gh/mxruyama/webos-adblock@gh-pages/repo.json> e <https://mxruyama.github.io/webos-adblock/repo.json> respondem com a versão nova (o workflow limpa o cache do jsDelivr);
- o `sha256` do manifesto confere com o do `.ipk` baixado da Release.

O número da versão vem sempre da tag; não é preciso editá-lo à mão. Mais detalhes em
[CONTRIBUTING.md](CONTRIBUTING.md#processo-de-release).

## Checklist de teste manual na TV

Não há como automatizar a execução em uma TV real. Antes de divulgar uma versão, confira:

- [ ] O repositório foi adicionado no Homebrew Channel (**Settings → Repositories → Add repository**) e o AdBlocker aparece na lista.
- [ ] A instalação pelo Homebrew Channel termina sem erro e o app abre pelo launcher.
- [ ] Sem root concedido, o aviso e o botão **Conceder root** aparecem e o status mostra **Inativo**.
- [ ] **Conceder root** funciona: o aviso some após alguns segundos e o status é consultado de novo.
- [ ] **Ativar Bloqueio** (lista Leve): status **Ativo**, contador de domínios maior que zero.
- [ ] `cat /proc/mounts | grep hosts` (SSH) mostra o mount do `hosts.block` e `grep -c '^0\.0\.0\.0' /etc/hosts` é maior que zero.
- [ ] A loja de apps da LG, o login LG e os apps de streaming continuam funcionando com o bloqueio ativo.
- [ ] Reiniciar a TV: ao abrir o app, o status continua **Ativo**.
- [ ] **Atualizar Listas** com o bloqueio ativo termina com sucesso e o “Atualizado em …” muda.
- [ ] Trocar para a lista **Completa** e ativar/atualizar funciona (e, sem internet, dá erro sem alterar o estado).
- [ ] Com “Block system updates” do Homebrew Channel ligado: ativar mantém as entradas de atualização (por exemplo, `snu.lge.com`) no hosts.
- [ ] **Desativar Bloqueio**: status **Inativo**, `/etc/hosts` volta ao original, o bloco some do `startup.sh`, `hosts.block` é apagado.
- [ ] Reiniciar a TV após desativar: o bloqueio não volta.
- [ ] Navegação por setas, **OK** e **Voltar** (fecha o app) funcionam; com o Magic Remote o ponteiro foca os botões.

## Solução de problemas

| Sintoma | O que fazer |
|---|---|
| O AdBlocker não aparece no Homebrew Channel | Use a URL do jsDelivr (`https://cdn.jsdelivr.net/gh/mxruyama/webos-adblock@gh-pages/repo.json`) — TVs antigas recusam o certificado do GitHub Pages e mostram “An error occured while downloading some repositories”. Em **Settings → Repositories**, remova a URL antiga (`github.io`), adicione a do jsDelivr e recarregue a lista (seta circular no topo) ou reabra o Homebrew Channel. Confira também a internet da TV. |
| “TV sem root / Homebrew Channel ausente” | A TV precisa de root e do Homebrew Channel (veja [rootmy.tv](https://rootmy.tv/)). |
| “Serviço sem root. Use 'Conceder root'.” | Selecione **Conceder root**, aguarde cerca de 2 segundos e tente de novo. Se persistir, reabra o app. |
| Status **Inativo** depois de reiniciar a TV | Confira se `/var/lib/webosbrew/startup.sh` existe. Sem ele não há persistência (o app avisa). Se o arquivo voltou, abra o app: o status reinsere o bloco sozinho. |
| Falha ao baixar a lista | Verifique a internet/DNS da TV. O app tenta `https`, depois `curl` e depois `wget`; só então mostra “Falha ao baixar …”. A lista Leve cai para a embutida; a Completa não. |
| Um app ou site parou de funcionar | Desative o bloqueio e teste de novo. Se for causa do AdBlocker, abra uma issue com o domínio (veja o CONTRIBUTING). |

Diagnóstico por SSH:

```sh
cat /proc/mounts | grep hosts        # há um mount sobre /etc/hosts?
ls -l /var/lib/webosbrew/            # hosts.block, adblocker.json, startup.sh
grep -c '^0\.0\.0\.0' /etc/hosts    # quantas linhas de bloqueio estão valendo
grep -n 'org.community.webos.adblocker' /var/lib/webosbrew/startup.sh
```

Para desfazer à força, veja [Como desfazer](#como-desfazer).

## Contribuindo

Pull requests e issues são bem-vindos. Leia o [CONTRIBUTING.md](CONTRIBUTING.md) antes (regras de ES5,
testes, commits e como propor domínios para a lista Leve).

## Licença

[MIT](LICENSE). Projeto da comunidade, não oficial e sem vínculo com a LG Electronics.

### Créditos de terceiros

- `service/certs/cacert.pem`: pacote de certificados raiz da Mozilla, na extração publicada pelo projeto curl
  (<https://curl.se/docs/caextract.html>), distribuído sob a [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/).
- Lista **Leve**: seleção própria; os nomes de host foram conferidos em
  [hagezi/dns-blocklists](https://github.com/hagezi/dns-blocklists) (LG webOS Tracker),
  [Perflyst/PiHoleBlocklist](https://github.com/Perflyst/PiHoleBlocklist) (SmartTV) e
  [hugobatista/lg-tv-ad-block](https://github.com/hugobatista/lg-tv-ad-block).
- Lista **Completa**: inclui o [StevenBlack/hosts](https://github.com/StevenBlack/hosts), baixado na TV na hora
  da ativação/atualização (não é redistribuído por este projeto).
