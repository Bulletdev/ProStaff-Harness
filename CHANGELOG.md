# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

Versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

Motor de memória (C5), primeira metade da v0.3.

Falta a outra metade para publicar: a captura de **prompt do usuário** (R5.1)
depende dos hooks do adapter `claude-code`, e a reescrita da página de sessão
como narrativa (R5.2) depende do Maestro.

O resto da captura já existe sem adapter nenhum, porque a trilha de auditoria
sempre registrou decisão de fase, resultado de verificador e anotação.

A revisão desta metade caiu em cima do C3 e endureceu o motor de fronteira, o
que está registrado mais abaixo.

### Adicionado

- Página de memória em `.harness/memory/pages/<slug>.md`, markdown com cabeçalho
  validado por JSON Schema.

  O arquivo é a versão canônica; o SQLite é só índice, e pode ser apagado e
  reconstruído sem perda. É a mesma divisão da evidência.

- Índice FTS5 com frescor por hash do arquivo (R5.3).

  Toda busca sincroniza o índice antes de responder: página editada fora do
  `psh` entra na resposta seguinte, página corrompida sai do índice **com
  aviso**, e o número de páginas examinadas vai na saída (R2.13).

- Modo degradado declarado na busca: SQLite sem FTS5 responde por varredura de
  substring, e diz que respondeu por varredura, no resultado e no `psh doctor`.

- `psh remember "<fato>"` (R5.5), `psh memory
  list|search|get|promote|consolidate|reindex` e `psh handoff` (R5.4).

- `psh handoff` monta o bloco de retomada a partir do estado e da evidência em
  disco, nunca de resumo de modelo: fase, tentativa, última decisão, o que
  reprova o portão agora, memória fixada e o próximo comando.

  É o caso de uso UC3: fechar a sessão às 18h por limite de plano e reabrir
  amanhã, possivelmente em outro runtime.

- `psh memory promote <slug>` leva a página para `docs/decisoes/` no
  repositório e deixa a página apontando para o destino (R5.7).

  Duas cópias sem ponteiro seriam duas verdades.

- `psh memory consolidate` fecha a sessão numa página (R5.2), a partir da faixa
  da trilha que ainda não foi consolidada.

  Fases, verificadores, violações de fronteira, decisões humanas, anotações e
  comandos, cada linha carregando o número da entrada que a originou.

  A marca d'água mora em `.harness/memory/consolidation.json`, fora do índice,
  e só avança depois de a página existir e a trilha registrar.

### Decisões que valem registro

- **A memória entra no deny duro da fronteira.**

  O bloco de handoff é injetado no início da sessão seguinte. Memória que o
  agente escreve à mão é texto que ele injeta em si mesmo depois, sem passar por
  nenhuma porta do núcleo. Escrita de página é por `psh remember`, mesmo com
  `write: ["**"]` na allowlist.

- **O cabeçalho não aceita o que não consegue devolver.**

  `psh remember --title $'x\npinned: false'` gravava a página, reportava sucesso
  e deixava a anotação ilegível para sempre. Tag com vírgula voltava partida em
  duas. Quebra de linha e vírgula agora param na porta de escrita, com o campo
  nomeado: perder a anotação que o comando existe para guardar é pior do que
  recusar o título.

- **Promover não contorna a fronteira de quem promove.**

  `psh memory promote x --to src/web/app.tsx --force` deixaria um agente com
  allowlist `src/api/**` escrever fora dela com a assinatura do núcleo. O
  destino passa pela fronteira do agente quando há agente; o humano continua
  sendo a autoridade que define a allowlist.

- **Symlink não é página.**

  Ele não era lido, mas também não era contado nem nomeado em lugar nenhum, o
  que contraria o R2.13. Agora entra na contagem e sai nomeado na lista de
  ignorados, e `psh memory get` recusa pelo mesmo motivo que a enumeração.

- **A consulta do usuário nunca é sintaxe de FTS.**

  Cada termo vira literal entre aspas com prefixo. Quem digita
  `psh memory search "NOT ai-jail"` está procurando essas três palavras, não
  escrevendo expressão booleana, e um termo com `*`, `(` ou `"` não derruba a
  busca nem vira operador por acidente.

- **O slug é conferido antes de virar caminho.**

  Minúscula, dígito e hífen. `psh memory get ../../etc/passwd` para no alfabeto,
  não no sistema de arquivos (R2.14).

- **A página fixada vem antes da relevância na ordenação.**

  R5.5 diz que ela não pode ser perdida na consolidação, e ser empurrada para
  fora do limite da busca é uma forma de perder.

- **`.harness/memory/` fica fora do repositório.**

  A faixa é transitória por definição (R5.7). O que precisa sobreviver com
  garantia sai dela por `psh memory promote` e vira arquivo versionado, que entra
  em revisão como qualquer outro.

- **Cabeçalho de página é lido em modo estrito.**

  Campo desconhecido, campo repetido ou fechamento ausente derrubam a leitura.
  Página meio lida vira contexto errado na sessão seguinte, e contexto errado não
  avisa que está errado.

- **O bloco de retomada tem teto declarado.**

  Ele vai para o início da sessão seguinte, e janela útil é recurso medido
  (R7.2). Doze páginas fixadas, quatrocentos caracteres por corpo, e o que ficou
  de fora sai dito no próprio bloco, com o comando que traz o resto.

- **A trilha é a captura (R5.1).**

  Decisão de fase, resultado de verificador e anotação já entram nela por R4.3,
  encadeados por hash e conferíveis por `psh audit verify`. Guardar uma segunda
  cópia dos mesmos fatos num buffer paralelo criaria duas versões da mesma
  sessão, e a segunda não teria como provar que é verdadeira.

  O que falta é prompt do usuário, que só o adapter enxerga.

- **A consolidação não resume a si mesma.**

  Ela grava uma entrada `memory.write` ao terminar. Sem filtrar essa entrada,
  rodar o comando três vezes seguidas produzia três páginas, e as duas últimas
  só falavam da anterior.

- **Trilha comprometida não vira memória.**

  A consolidação verifica a cadeia antes de resumir. Assinar como memória um
  relato que a própria cadeia não sustenta seria fabricar prova.

- **A narrativa por LLM não foi improvisada.**

  R5.2 pede a página reescrita como narrativa, e isso é chamada de modelo pelo
  Maestro, que é v0.4. Em vez de chamar modelo por fora do roteador, a página
  sai montada da trilha, com o número de cada entrada, e diz na própria página
  que foi montada sem modelo. Quando o C6 entrar, a narrativa vira uma reescrita
  por cima deste texto.

### Corrigido no motor de auditoria

- **Uma escrita nova consertava a âncora de uma trilha adulterada.**

  A âncora existe para pegar reescrita coordenada (R4.1), mas quem a conferia era
  só o `verify`. Como todo `append` regrava a âncora com o topo novo, bastava
  uma escrita qualquer depois da adulteração, `psh remember` ou o hook de fim de
  sessão, para a cadeia voltar a fechar e o estrago sumir do relatório.

  Agora o `append` recusa escrever numa trilha que não bate com a própria
  âncora. A conferência é por contagem de linha e hash do topo, sem re-hashear a
  cadeia inteira: remoção no meio muda a contagem, edição ou religamento mudam o
  topo.

  Achado por um teste do adapter que esperava a consolidação falhar numa trilha
  quebrada e viu ela passar.

### Corrigido fora do escopo da memória

- **Flag de traço simples nunca existiu no parser.**

  `psh audit log -n 5` virava dois posicionais ignorados: o comando respondia com
  o limite padrão e sem erro nenhum. Pior, o `-n` chegava a comando que lê
  posicional e virava nome de coisa.

  Agora argumento que parece flag e não é flag falha dizendo qual é a forma
  certa, e o uso continua possível depois de `--`. O texto de ajuda, que
  documentava `-n`, passou a documentar `--n`.

- **`--n abc` chegava ao `LIMIT` do SQLite.**

  O usuário via `datatype mismatch` com pilha de exceção no lugar de "use um
  número". Erro de uso é falha de uso, não erro inesperado.

### Corrigido no motor de fronteira

- **O `ai-jail` gravava a própria configuração dentro do projeto.**

  Por padrão ele escreve um `.ai-jail` na raiz e o lê na execução seguinte. O
  arquivo mora na árvore que o agente edita, e parte da montagem passaria a vir
  de algo que o próprio enjaulado escreve, que é exatamente o G4.

  Na prática ele também acumulava lixo: cada corrida somava os `deny_paths` de
  novo, guardados como `~/...`, e o `ai-jail` os reabria como `<raiz>/~/...`,
  avisando `rule not applied` para regra que não existia. A regra que valia
  continuava sendo a do argv, medido, mas o ruído escondia o aviso de verdade.

  O argv passou a levar `--clean --no-save-config`. A jaula é montada só a
  partir do contrato do `psh`.

- **O `.ai-jail` estava fora do relatório de violação.**

  A exceção existia porque o sandbox escrevia o arquivo. Com a escrita
  desligada, ela só servia para deixar passar uma cópia feita pelo agente. O
  conjunto de arquivos perdoados ficou vazio, e o arquivo entra no deny como
  qualquer outro.

- **A jaula zera o ambiente do processo filho.**

  `PSH_AGENT` no `env` do spawn chega vazio lá dentro. A marca de qual agente
  está executando vai explícita no argv, por `--env`, para que o núcleo saiba
  quem pediu a ação também dentro da jaula.

### Qualidade

- 444 testes, acima dos 326 da v0.2.0, todos passando **também com o `ai-jail`
  real ligado**, sem nenhum pulado.

- Cobertura de linha de 94,44% no projeto, 100% em `memory/search.ts`,
  `memory/consolidate.ts` e `cli/args.ts`.

- Cinco casos novos na suíte de integração com a jaula real: nenhuma
  configuração deixada no projeto, a terceira corrida enjaula igual à primeira,
  configuração plantada na raiz não muda a fronteira, o id do agente atravessa a
  jaula, e a memória fica fora de alcance pelo kernel.

## [0.2.0] - 2026-08-22

Motor de fronteira (C3).

Verificado contra o `ai-jail` 1.19.2 real, com o kernel aplicando a fronteira.

### Adicionado

- Allowlist de escrita por agente em `boundary.json`, validada por JSON Schema.

- Deny duro no binario, nunca no arquivo.
  
  Evidencia, review, trilha, `state.json`, a propria allowlist e o diretorio de
  instalacao ficam fora do alcance de qualquer agente, mesmo com `write: ["**"]`.

- Modo degradado declarado: sem `ai-jail`, snapshot antes, comparacao depois, e
  toda escrita fora da fronteira e revertida e registrada como violacao.

- Reversao impossivel e declarada como `unrevertable`, em vez de reportar
  sucesso.

- `psh boundary list|check|add` e `psh exec --agent <id> -- <comando>`.

- Deteccao de comando destrutivo como **alerta**, nunca bloqueio (R3.3).
  
  O comando roda; quem decide escrita e a fronteira.

- Codigo de saida 7 para violacao de fronteira.
  
  Ganha do codigo do comando: uma corrida que tentou escapar nao reporta
  sucesso.

### Verificado contra o binário real

A montagem inicial estava errada e só apareceu contra o `ai-jail` de verdade.

Montar a raiz somente leitura e reabrir o escopo por cima não funciona: o
ai-jail recusa `--rw-map` que se sobrepõe a um `--map` read-only, e o agente
ficava sem escrever nem no próprio escopo.

Negar a raiz inteira ou `**` quebra o setup do bwrap.

A montagem passou a ser por complemento: nega o que existe e não está na
allowlist, descendo só por onde a allowlist aponta.

O que o mount não expressa é entrada nova criada em diretório gravável fora do
escopo, e por isso o snapshot continua ligado também no modo enjaulado.

São as duas camadas do R3.1, na ordem de confiança que ele descreve.

### Corrigido

- **Symlink contornava o deny duro.**
  
  A contencao resolvia symlink, mas o caminho usado na regra era o nome, nao o
  destino.
  
  Um link dentro do escopo do agente apontando para `.harness/evidence/`
  passava direto, o que permitiria forjar evidencia sem passar por portao
  nenhum.
  
  Agora o symlink e resolvido antes de qualquer decisao.

- **O `.ai-jail` que o sandbox grava virava violação do agente.**

  Acusar o mecanismo de isolamento de violar a fronteira que ele aplica polui o
  relatório e treina quem lê a ignorar violação de verdade.

- **A suíte dependia de haver um `ai-jail` instalado.**

  Com o binário presente, 25 testes reprovavam por motivo de ambiente: o
  ai-jail monta `/tmp` como tmpfs e os projetos temporários vivem lá.

  Agora a suíte roda em modo degradado por padrão e dá o mesmo resultado com e
  sem o binário.

## [0.1.0] - 2026-08-22

Primeiro marco publicado: o núcleo verificável.

Entrega os três motores que fazem um portão de qualidade valer alguma coisa,
mais a CLI mínima e o adapter headless para CI.

A garantia central da versão: **nenhum valor de portão vem de quem está sendo
avaliado.**

O agente não executa verificador, não escreve evidência, não passa métrica por
argumento e não reaproveita um teste antigo depois de continuar editando.

### Adicionado

**Workflow engine**

- Contrato de fases em `workflow.json`, validado contra JSON Schema no
  carregamento.
  
  Contrato inválido é falha fatal, nunca aviso.
- Integridade referencial no load: todo `next` resolve para fase declarada,
  todo verificador referenciado existe, e fase terminal é declarada
  explicitamente.
  
  Nunca inferida de um `next` que não resolve.
- Perfis `strict`, `lean` e `gate-only`, com stack packs para Node, Bun, Ruby,
  Python e Go.
- Protocolo de falha por classe (`transient`, `quality`, `user-action`,
  `fatal`), com o contador de tentativa persistido no caminho de falha antes do
  retorno.
  
  Sem isso o retry nunca esgota e a escalação nunca acontece.
- `psh advance --force` com confirmação interativa obrigatória.
  
  O resultado fica como `passed-with-override` permanente no histórico e nunca
  vira `passed`.
- `state.json` gravado exclusivamente pelo núcleo, validado contra schema antes
  de tocar o disco.

**Evidence engine**

- O núcleo executa o verificador; o agente nunca executa.
  
  O resultado vira um registro de evidência assinado por hash da árvore
  observada.
- Extratores nativos: lcov, Cobertura, SimpleCov, perfil de cobertura do Go e
  JSON Pointer.
  
  O verificador de rastreabilidade `spec-coverage` é calculado por parse dos
  artefatos, nunca perguntado ao modelo.
- Frescor por hash de árvore: o portão recalcula na avaliação e reprova
  evidência obsoleta, nomeando exatamente o arquivo que mudou depois da
  verificação.
- Código de saída é a autoridade sobre sucesso ou falha.
  
  Parse de texto extrai detalhe, nunca veredito.
  
  Processo morto por sinal ou timeout é falha, nunca zero.
- Falha de execução nunca produz valor.
  
  Comando que não roda, timeout, relatório ausente e extrator sem match geram
  registro de erro e reprovam o portão.
  
  Métrica ausente é ausência, não zero.
- Verificador que não se aplica à stack vira `skipped` explícito, e o portão que
  dependia dele reprova por "não verificado".
  
  Nunca passa por omissão.
- Score de review por LLM só vale com o hash do artefato revisado batendo com o
  arquivo atual.
- Toda varredura reporta quantos candidatos examinou.
  
  Zero achados com zero candidatos é erro de configuração, não resultado limpo.
- Caminho de arquivo nunca é interpolado em expressão regular, com verificação
  estática que reprova o build.

**Audit engine**

- Trilha em JSONL com cada linha encadeada por hash.
  
  `psh audit verify` detecta remoção, edição e reordenação.
- Âncora do topo da cadeia guardada fora do arquivo da trilha, o que permite
  detectar reescrita coordenada internamente consistente.
- Falha de escrita na trilha é erro fatal que interrompe a execução.

**CLI e adapters**

- `psh init`, `status`, `verify`, `advance`, `approve`, `audit` e `doctor`.
- `psh adapter ci`: verifica, avalia o portão e decide a transição em uma
  chamada, sem interação e com relatório JSON.
- `psh doctor` roda fora do runtime e emite um dump colável em issue.

### Notas desta versão

- **Motor de fronteira ausente.**
  
  Impedir que um agente escreva em `.harness/evidence/` e `.harness/reviews/`
  depende do boundary engine, que entra na 0.2.
  
  Nesta versão a proteção é convenção, não mecanismo, e o `psh doctor`, o
  `psh status` e o relatório do adapter `ci` declaram isso em vez de sugerir
  garantia.

- **Sandbox opcional.**
  
  O contrato de isolamento está implementado, mas sem o `ai-jail` instalado o
  modo é `degraded`.
  
  O modo fica declarado no diagnóstico, no estado e dentro de cada registro de
  evidência.

### Qualidade

- 236 testes, 1 declarado como `skip` por falta de Git no ambiente.
- Cobertura de linha acima de 85% em `audit` e em todos os módulos de
  `evidence`, acima de 70% no restante.
  
  Todo arquivo de `src/` entra na medição.
- Verificação estática de path em expressão regular integrada ao CI.
- Matriz de CI em Linux e macOS.

[0.2.0]: https://github.com/Bulletdev/ProStaff-Harness/releases/tag/v0.2.0
[0.1.0]: https://github.com/Bulletdev/ProStaff-Harness/releases/tag/v0.1.0
