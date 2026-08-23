# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

Versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

Endurecimento do motor de fronteira (C3), medido contra o `ai-jail` 1.19.2.

### Corrigido

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

- Quatro casos novos na suíte de integração com a jaula real: nenhuma
  configuração deixada no projeto, a terceira corrida enjaula igual à primeira,
  configuração plantada na raiz não muda a fronteira, e o id do agente atravessa
  a jaula.

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
