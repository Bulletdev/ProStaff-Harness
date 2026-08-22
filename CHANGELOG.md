# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento [SemVer](https://semver.org/lang/pt-BR/).

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

[0.1.0]: https://github.com/Bulletdev/ProStaff-Harness/releases/tag/v0.1.0
