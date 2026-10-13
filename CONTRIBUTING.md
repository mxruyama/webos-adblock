# Contribuindo

Obrigado por querer ajudar. Este projeto é pequeno e quer continuar assim: mudanças focadas, testadas e que
funcionem em TVs antigas.

## Preparar o ambiente

Requisitos: Node.js 22 ou mais novo.

```sh
npm install
npm test
```

Para ver a interface sem uma TV, abra `app/index.html?mock=1` no Chrome. O modo `?mock=1` usa um mock em memória
no lugar do barramento Luna (simula root, estado e latência).

## Regras de ES5 (app e serviço)

O app roda no Chrome 38 (webOS 3.x) e o serviço no Node da época (0.12). Por isso **todo `.js` em `app/` e
`service/` é ES5 puro**. Scripts (`scripts/`) e testes (`test/`) podem usar JavaScript moderno (Node 22).

Sintaxe proibida em `app/js/**` e `service/**`:

- `let` e `const` (use `var`);
- funções de seta `=>` (use `function`);
- template strings com crase (use concatenação com `+`);
- `class`, `extends`, `super`;
- desestruturação, parâmetros padrão, `...rest` e `...spread`;
- `for...of`, geradores (`function*`), `async`/`await`;
- atalhos de objeto (`{ a, b }`, `{ metodo() {} }`) e chaves computadas (`{ [k]: v }`);
- `import`/`export` (no serviço use CommonJS com `require`/`module.exports`; no app, scripts globais).

APIs proibidas (não existem no Chrome 38 / Node 0.12, ou não podemos contar com elas):

- `Promise`, `async` e qualquer API baseada em promessa (`fs.promises`, `util.promisify`, `fetch`). A
  convenção é callback no estilo Node: `cb(err, resultado)`. No app use `XMLHttpRequest` se precisar de HTTP.
- `Object.assign`, `Object.entries`, `Object.values`;
- `Array.prototype.includes`, `Array.from`, `Array.prototype.find`/`findIndex`;
- `String.prototype.includes`, `startsWith`, `endsWith`, `repeat`, `padStart`/`padEnd`, `trimStart`/`trimEnd`;
- `Map`, `Set`, `WeakMap`, `Symbol` e `Array.prototype.fill` quando a compatibilidade for duvidosa;
- no serviço, APIs recentes do Node, como `Buffer.from`/`Buffer.alloc`, `fs.copyFileSync`, `fs.mkdtempSync`.
  Prefira as APIs clássicas (`readFileSync`, `writeFileSync`, `renameSync`, `child_process.execFile`).

Em CSS: sem custom properties (`var(--x)`) e sem `grid`; flexbox é permitido. O app não usa frameworks.

O teste `test/static.test.js` valida a **sintaxe** (acorn com `ecmaVersion: 5`) de todo `.js` em `app/js` e
`service/`; ele **não** detecta o uso de APIs proibidas. Isso fica para a revisão.

## Arquitetura do serviço

`service/service.js` é só a camada Luna (sem lógica). A lógica fica em `service/lib/`, com dependências
**injetáveis** (`fs`, `exec`, `download`, caminhos, relógio, `isRoot`), para ser testada sem tocar na máquina.
`test/helpers/fakes.js` fornece um sistema falso (`createFakeSystem`) com modelo de inodes, `mount --bind` e
`umount`. Leia-o antes de escrever testes de serviço: o `mount` exige que origem e alvo existam, mounts empilham,
`umount` remove a camada de cima e `rename`/`unlink` sobre um alvo montado dão `EBUSY`.

## Testes

```sh
npm test                           # tudo (node --test "test/**/*.test.js")
node --test test/hosts.test.js     # um arquivo só, enquanto itera
npm run package                    # valida o empacotamento (gera dist/*.ipk)
```

- Escreva o teste antes ou junto com a mudança. Bug corrigido sem teste que o reproduza costuma voltar.
- Teste comportamento observável (conteúdo do hosts, estado, chamadas de `mount`/`umount`), não detalhes internos.
- A saída da suíte deve ficar limpa: sem avisos nem logs soltos.
- O CI (`.github/workflows/ci.yml`) roda `npm ci`, `npm test` e `npm run package` em cada push para `main` e em
  cada pull request, e publica o `.ipk` como artefato, útil para quem testa na TV.
- O CI também roda o teste de integração `test/integration/linux-root.js` (Linux + root, `mount --bind` real
  sobre `/etc/hosts`, no Node 0.12.18 e no 22). Ele **sobrescreve** `/var/lib/webosbrew/startup.sh`, apaga
  `hosts.block`/`adblocker.json` e monta arquivos sobre `/etc/hosts`, por isso só roda com `GITHUB_ACTIONS=true`
  (o CI) ou com a confirmação explícita `ADBLOCK_INTEGRATION=1`; sem ela sai com código 2 sem mexer em nada.
  Para rodar fora do CI, use uma máquina ou VM Linux descartável:

  ```sh
  sudo env "PATH=$PATH" ADBLOCK_INTEGRATION=1 node test/integration/linux-root.js
  ```
- Mudanças de interface: confira em `app/index.html?mock=1` (setas, Enter e os três estados: sem root, inativo e
  ativo). Mudanças de serviço que mexem em mount, `startup.sh` ou lista **precisam** passar também pelo
  [checklist de teste manual](README.md#checklist-de-teste-manual-na-tv) numa TV real antes de uma release.

## Commits

Usamos [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/):

```
<tipo>(<escopo opcional>): <descrição curta no imperativo>
```

Tipos: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`. Escopos comuns: `app`,
`service`, `lists`, `scripts`, `ci`, `docs`, `release`. Exemplos:

```
feat(service): preserva o bloqueio de updates do Homebrew Channel
fix(app): foca o botão certo ao voltar do overlay
feat(lists): adiciona ads.example.com à lista leve
docs: explica o passo Conceder root
```

Mudança incompatível: `!` depois do tipo/escopo (`feat(service)!: ...`) e um parágrafo `BREAKING CHANGE:` no
corpo. Mantenha cada commit pequeno e com uma única intenção; mensagens em português ou inglês, mas coerentes no
mesmo pull request. Todo o repositório usa fins de linha LF (`.gitattributes`).

## Propor domínios para a lista leve

A lista leve (`service/lists/lite.txt`, formato `0.0.0.0 dominio`, um por linha) é a que a maioria dos usuários
ativa. O critério é conservador: **só entram domínios de anúncio, rastreamento ou telemetria**. Um domínio errado
pode quebrar a loja, o login ou os apps de uma TV inteira sem que o usuário entenda por quê.

Para propor, abra uma issue ou um pull request com:

1. o(s) domínio(s) exato(s);
2. a evidência de que é anúncio/telemetria: de onde veio (log de DNS da TV, lista pública como hagezi ou
   Perflyst SmartTV, análise de rede) e o que ele faz;
3. um teste prático: com o domínio bloqueado, a loja de apps da LG, o login LG, as atualizações de apps e os apps
   de streaming continuam funcionando.

Cada linha deve ser um domínio válido, sem duplicatas, e o comentário no topo do arquivo deve citar as fontes
consultadas. `npm test` precisa passar: há um teste (`lite list parses`) que garante que a lista tem domínios
válidos e **nenhum dos proibidos** abaixo.

### Nunca entram na lista leve

- `lgappstv.com` (domínio raiz): loja e conteúdo de apps da LG;
- `lgtvsdp.com` (domínio raiz): serviços de plataforma da TV;
- `lge.com` (domínio raiz);
- `lgeapi.com`;
- `snu.lge.com`, `su.lge.com` e `su-ssl.lge.com`: atualizações do sistema. O Homebrew Channel cuida
  do bloqueio de updates por conta própria, e o AdBlocker só preserva essas entradas;
- domínios de **login da conta LG**;
- domínios de **serviços de streaming** (vídeo, música, etc.) e de qualquer coisa necessária para loja ou
  atualização de apps.

“Domínio raiz” significa o domínio inteiro: bloqueá-lo derruba todos os subdomínios. Um subdomínio específico
que for claramente só de anúncio ou telemetria pode ser avaliado caso a caso, com a evidência do item 2.

Domínios mais agressivos, que bloqueiam anúncios da web em geral, não pertencem à lista leve: a lista
**Completa** já inclui o [StevenBlack/hosts](https://github.com/StevenBlack/hosts).

Observação: a cópia da lista no GitHub Pages (`/lists/lite.txt`) só é atualizada a cada release, porque é gerada
pelo `build-repo.js` a partir do repositório. Uma lista nova chega às TVs depois da próxima tag.

## Processo de release

Só quem mantém o repositório publica versões. O versionamento é [SemVer](https://semver.org/lang/pt-BR/)
(`MAJOR.MINOR.PATCH`).

1. Garanta que `main` está verde no CI e que o checklist manual da TV foi feito para o que mudou.
2. Crie e envie a tag. **A versão vem da tag**; não edite `package.json`, `appinfo.json` ou
   `service/package.json` à mão:

   ```sh
   git tag vX.Y.Z
   git push --tags
   ```

3. O workflow `.github/workflows/release.yml` (disparado por tags `v*`) executa, nesta ordem: `npm ci`,
   `npm test`, `scripts/set-version.js` com a versão da tag, `npm run package`, conferência do
   `dist/org.community.webos.adblocker_<versao>_all.ipk`, `scripts/build-repo.js`, criação da Release (com o
   `.ipk` e notas geradas) e publicação do repositório do Homebrew Channel na branch `gh-pages`.
4. Depois que o workflow terminar, confira: a Release tem o `.ipk`; <https://cdn.jsdelivr.net/gh/mxruyama/webos-adblock@gh-pages/repo.json>
   mostra a versão nova; o `sha256` do manifesto confere com o do `.ipk` baixado.
5. Na primeira vez, ative o GitHub Pages (**Settings → Pages**, *Deploy from a branch*, branch `gh-pages`,
   pasta `/ (root)`).

Uma tag fora do formato `vX.Y.Z` (por exemplo `v1.0`) faz o workflow falhar em `set-version` antes de publicar
qualquer coisa. Se uma release sair com problema, não reaproveite a tag: corrija e publique uma nova versão.

## Código de conduta

Seja respeitoso e objetivo. Críticas são sobre o código, não sobre as pessoas.
