# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [0.1.0] - 2026-08-22

Primeiro marco publicado: o nucleo verificavel. Entrega os tres motores que
fazem um portao de qualidade valer alguma coisa, mais a CLI minima e o adapter
headless para CI.

A garantia central da versao: **nenhum valor de portao vem de quem esta sendo
avaliado.** O agente nao executa verificador, nao escreve evidencia, nao passa
metrica por argumento e nao reaproveita um teste antigo depois de continuar
editando.

### Adicionado

**Workflow engine**
- Contrato de fases em `workflow.json`, validado contra JSON Schema no
  carregamento. Contrato invalido e falha fatal, nunca aviso.
- Integridade referencial no load: todo `next` resolve para fase declarada,
  todo verificador referenciado existe, fase terminal e declarada
  explicitamente e nunca inferida de um `next` que nao resolve.
- Perfis `strict`, `lean` e `gate-only`, com stack packs para Node, Bun, Ruby,
  Python e Go.
- Protocolo de falha por classe (`transient`, `quality`, `user-action`,
  `fatal`), com o contador de tentativa persistido no caminho de falha antes do
  retorno - sem isso o retry nunca esgota e a escalacao nunca acontece.
- `psh advance --force` com confirmacao interativa obrigatoria. O resultado fica
  como `passed-with-override` permanente no historico e nunca vira `passed`.
- `state.json` gravado exclusivamente pelo nucleo, validado contra schema antes
  de tocar o disco.

**Evidence engine**
- O nucleo executa o verificador; o agente nunca executa. O resultado vira um
  registro de evidencia assinado por hash da arvore observada.
- Extratores nativos: lcov, Cobertura, SimpleCov, perfil de cobertura do Go e
  JSON Pointer. Verificador de rastreabilidade `spec-coverage` calculado por
  parse dos artefatos.
- Frescor por hash de arvore: o portao recalcula na avaliacao e reprova
  evidencia obsoleta nomeando exatamente o arquivo que mudou depois da
  verificacao.
- Codigo de saida e a autoridade sobre sucesso ou falha. Parse de texto extrai
  detalhe, nunca veredito. Processo morto por sinal ou timeout e falha, nunca
  zero.
- Falha de execucao nunca produz valor: comando que nao roda, timeout,
  relatorio ausente e extrator sem match geram registro de erro e reprovam o
  portao. Metrica ausente e ausencia, nao zero.
- Verificador que nao se aplica a stack vira `skipped` explicito, e o portao que
  dependia dele reprova por "nao verificado", nunca passa por omissao.
- Score de review por LLM so vale com o hash do artefato revisado batendo com o
  arquivo atual.
- Toda varredura reporta quantos candidatos examinou. Zero achados com zero
  candidatos e erro de configuracao, nao resultado limpo.
- Caminho de arquivo nunca e interpolado em expressao regular, com verificacao
  estatica que reprova o build.

**Audit engine**
- Trilha em JSONL com cada linha encadeada por hash. `psh audit verify` detecta
  remocao, edicao e reordenacao.
- Ancora do topo da cadeia guardada fora do arquivo da trilha, o que permite
  detectar reescrita coordenada internamente consistente.
- Falha de escrita na trilha e erro fatal que interrompe a execucao.

**CLI e adapters**
- `psh init`, `status`, `verify`, `advance`, `approve`, `audit`, `doctor`.
- `psh adapter ci`: verifica, avalia o portao e decide a transicao em uma
  chamada, sem interacao e com relatorio JSON.
- `psh doctor` roda fora do runtime e emite um dump colavel em issue.

### Notas desta versao

- **Motor de fronteira ausente.** Impedir que um agente escreva em
  `.harness/evidence/` e `.harness/reviews/` depende do boundary engine, que
  entra na 0.2. Nesta versao a protecao e convencao, nao mecanismo, e o
  `psh doctor`, o `psh status` e o relatorio do adapter `ci` declaram isso em
  vez de sugerir garantia.
- **Sandbox opcional.** O contrato de isolamento esta implementado, mas sem o
  `ai-jail` instalado o modo e `degraded` - declarado no diagnostico, no estado
  e dentro de cada registro de evidencia.

### Qualidade

- 236 testes, 1 declarado como `skip` por falta de Git no ambiente.
- Cobertura de linha acima de 85% em `audit` e em todos os modulos de
  `evidence`, acima de 70% no restante. Todo arquivo de `src/` entra na medicao.
- Verificacao estatica de path em expressao regular integrada ao CI.
- Matriz de CI em Linux e macOS.

[0.1.0]: https://github.com/Bulletdev/ProStaff-Harness/releases/tag/v0.1.0
