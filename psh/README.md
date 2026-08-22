# psh - nucleo verificavel do ProStaff Harness

Marco **v0.1**: os tres motores que fazem um portao valer alguma coisa, mais a
CLI minima e o adapter `ci`.

Os identificadores no formato `R1.1`, `R2.4` e afins apontam para a
especificacao interna do projeto. Ficam aqui como ancora de rastreabilidade; o
texto ao lado sempre explica o que cada um exige.

O que o marco resolve, em uma frase: **nenhum valor de portao vem de quem esta
sendo avaliado.** O agente nao executa verificador, nao escreve evidencia, nao
passa metrica por argumento, e nao consegue reaproveitar um teste antigo depois
de continuar editando.

## Escopo entregue

| Componente | Requisitos | Estado |
|---|---|---|
| C1 Workflow engine | R1.1 a R1.6 | completo |
| C2 Evidence engine | R2.1 a R2.7, mais R2.10 a R2.14 | completo |
| C4 Audit engine | R4.1 a R4.3 | completo |
| CLI | `init`, `status`, `verify`, `advance`, `audit`, `doctor` | completo |
| Adapter | `ci` (headless) | completo |

Dois comandos alem do minimo declarado no roadmap, porque sem eles o marco nao
fecha sozinho:

- `psh approve <assunto>` - portao de `user-approval` nao teria como ser
  satisfeito, e o perfil `strict` comeca por um.
- `psh internal spec-coverage` - o verificador nativo `spec-coverage` do R2.5 e
  calculado pelo nucleo por parse dos artefatos, entao o nucleo precisa de um
  ponto de entrada para se reinvocar.

## Fora do escopo da v0.1, e declarado como tal

- **C3, motor de fronteira.** Entra na v0.2. Ate la, `psh doctor` e `psh status`
  dizem `fronteira ausente`, e o adapter `ci` devolve `boundary_engine: absent`
  no relatorio. R2.6b (evidencia e review inalcancaveis por agente) hoje e
  convencao, nao mecanismo, e o codigo diz isso em vez de sugerir garantia.
- **Sandbox real.** O contrato de R2.7 esta implementado (rede desligada por
  padrao, opt-in declarado por verificador, credencial de agente nao montada),
  mas sem `ai-jail` instalado o modo e `degraded`, declarado no `psh status`, no
  `psh doctor` e dentro de **cada registro de evidencia**.
- C5 a C9, C11 alem de cobertura: marcos seguintes.

## Instalacao e uso

```sh
bun install
bun run build          # dist/psh, binario unico
bun run check          # typecheck + verificacao estatica de R2.14 + testes
```

```sh
psh init --profile lean        # detecta stack, mostra o plano, pede confirmacao
psh verify                     # o NUCLEO roda os verificadores do portao atual
psh status                     # fase, tentativa, portao, sandbox, trilha
psh advance                    # avalia o portao e decide a transicao
psh audit verify               # integridade da trilha encadeada
psh doctor                     # diagnostico colavel em issue
psh adapter ci --json          # verify + gate + advance, headless
```

`psh init` e nao destrutivo: mostra o plano, faz backup do que sobrescreve e
so escreve dentro de `.harness/`. `--dry-run` imprime o plano e sai.

## Como um portao decide

```
psh verify   ->  nucleo executa o verificador dentro do sandbox
             ->  extrai o valor do relatorio (lcov, cobertura, simplecov,
                 go cover, JSON Pointer) ou usa o codigo de saida
             ->  calcula o hash da arvore dos paths em `watch`
             ->  grava .harness/evidence/<fase>/<tentativa>/<verificador>.json

psh advance  ->  le APENAS registros de evidencia
             ->  recalcula o hash da arvore agora
             ->  hash divergente = evidencia obsoleta, com o nome do arquivo
                 que mudou depois da verificacao
             ->  compara com o threshold do contrato
             ->  grava evento, encadeia na trilha, atualiza state.json
```

Uma metrica passada pelo chamador nao e ignorada, e **recusada com nome**:

```
$ psh advance --coverage 99
psh: portao nao aceita metrica vinda do chamador: [coverage].
     Valor de portao so vem de registro de evidencia produzido por 'psh verify' (R2.1).
$ echo $?
5
```

A recusa e explicita de proposito. Se fosse tratada como "flag desconhecida",
o caminho nunca apareceria em teste e ninguem saberia se a garantia existe.

## Codigos de saida

| Codigo | Significado |
|---|---|
| 0 | sucesso |
| 1 | falha generica (uso, verificador com erro) |
| 2 | portao reprovado |
| 3 | contrato invalido |
| 4 | cadeia de auditoria comprometida |
| 5 | metrica forjada recusada |
| 6 | projeto sem `.harness/` |

## Decisoes que valem registro

**Threshold mora em um lugar so.** O `min` fica no check do portao, nunca no
verificador. O contrato nao tem onde declarar o mesmo numero duas vezes com
valores diferentes (O9).

**`success_exit_codes` e declarado, nunca inferido.** `npm audit` sai com 1
quando acha vulnerabilidade, e isso e resultado, nao falha. Em vez de deduzir
isso do texto da saida, o contrato declara `[0, 1]`. O codigo de saida continua
sendo a autoridade (R2.10b); o que muda e qual codigo significa sucesso.

**Sinal nunca vira zero.** `res.status ?? null`, jamais `?? 0`. Processo morto
por timeout ou por sinal e falha. O atalho `?? 0` transforma `SIGTERM` em
sucesso silencioso, e um portao que aprova por causa disso e pior que portao
nenhum. Ha teste para o caminho nos tres modos de sandbox.

**Fase terminal e declarada.** Uma maquina de estados que infere "e o fim"
de um `next` que nao resolve esconde erro de digitacao ate a hora de transitar.
O contrato exige `"terminal": true`, e um `next` apontando para fase inexistente
derruba o carregamento em vez de virar surpresa em runtime (R1.5b).

**Portao vazio nao vira portao aberto.** Quando `psh init` poda os checks de uma
fase porque a stack nao tem aquele verificador, o portao vira aprovacao humana
declarada, e o plano diz quantos checks examinou e quantos podou.

**Enumeracao da arvore e declarada.** Com Git, `git ls-files -c -o
--exclude-standard` respeita o `.gitignore`. Sem Git, caminhada. Com `.git/`
presente mas `git` indisponivel, o modo e `walk-fallback` e o `psh doctor`
reprova: sem isso, arquivo ignorado entraria no hash e evidencia valida viraria
obsoleta sozinha.

**Contagem de candidatos em toda varredura (R2.13).** Extrator de metrica,
`spec-coverage`, varredura de segredo, verificacao de trilha e o proprio
`check-no-path-regex` reportam quantos candidatos examinaram. Zero achados com
zero candidatos e erro de configuracao, nao resultado limpo.

**Contrato composto nao compartilha objeto com os JSON embarcados.** Perfis e
stack packs sao modulos JSON, ou seja, singletons do processo. `psh init` copia
antes de devolver: sem isso, qualquer mutacao a jusante corromperia todo `init`
seguinte no mesmo processo. Achado durante a validacao da v0.1, com teste de
regressao.

**Flag booleana nao consome o token seguinte.** `psh audit --json log` fazia
`--json` engolir `log`, o subcomando sumia e o comando caia no default sem
avisar. Tambem achado na validacao, tambem com teste de regressao.

**Caminho nunca vira expressao regular (R2.14).** Casamento por `Bun.Glob` com o
caminho sempre do lado da entrada, comparacao de contencao por API de path, e
JSON Pointer no lugar de regex sobre relatorio. `bun run lint:regex` reprova o
build se algum `new RegExp` receber qualquer coisa que nao seja literal
constante.

## Layout em disco

```
<projeto>/.harness/
  workflow.json      contrato de fases, portoes e verificadores (humano)
  state.json         snapshot da fase (NUCLEO, apenas)
  boundary.json      allowlist (humano; motor entra na v0.2)
  harness.db         SQLite: eventos, indice de evidencia, contadores, ancora
  evidence/<fase>/<tentativa>/<verificador>.json      (NUCLEO, apenas)
                                        .manifest.json  arquivo -> hash
                                        .stdout.log / .stderr.log
  reviews/*.review.json    score de LLM amarrado ao hash do artefato
  approvals/*.json         aprovacao humana amarrada ao conteudo
  audit/chain.jsonl        trilha encadeada por hash
```

`harness.db`, `evidence/`, `audit/` e `approvals/` entram no `.gitignore`
gerado pelo `psh init`.

## Qualidade

`bun test` roda tudo em `tests/` por glob, nunca por lista enumerada (R11.2c).
Nenhum teste escreve em `process.cwd()` nem toca no Git da arvore real: cada um
cria seu proprio temporario (R11.2b).

Cobertura de linha nos modulos que o R11.1 exige em 85%:

| Modulo | Linhas |
|---|---|
| `audit/chain.ts` | 100% |
| `evidence/sandbox.ts` | 100% |
| `evidence/runner.ts` | 92% |
| `evidence/workspace.ts` | 89% |
| `evidence/store.ts` | 88% |
| `evidence/extract/` | 85% |
| `gate/evaluate.ts` | 93% |

Nos demais modulos o piso e 70%, e o menor e `util/self.ts` com 71%.
236 testes e 1 declarado como `skip`, media geral de 94% de linha.

**Todo arquivo de `src/` aparece na medicao.** A CLI e exercitada em processo,
com a saida desviada por `cli/io.ts`, e nao so por subprocesso: teste por
subprocesso passa no CI mas nao entra no relatorio de cobertura, entao o codigo
pareceria testado sem que ninguem soubesse quanto dele roda de fato.

Todo perfil (`strict`, `lean`, `gate-only`) cruzado com todo stack pack
(`node`, `bun`, `ruby`, `python`, `go`, `generic`) passa pelo loader real em
teste: 18 combinacoes. Sem isso, um erro em `ruby.json` so apareceria na maquina
de quem rodasse `psh init` com aquela combinacao.

Casos da suite adversarial do R11.2 ja cobertos: 3 (metrica forjada, metrica
ausente, verificador que falhou, evidencia obsoleta), 4 (codigo de saida nos
tres modos de sandbox), 7 (adulteracao da cadeia, incluindo reescrita coordenada
da ancora), 10 (contrato com `next` invalido e `gate.type` desconhecido), 11
(ciclo de retry ate a escalacao com contador em disco), 15 (instalacao em
diretorio com `+`, `[` e espaco), 16 (varredura sem candidato).

Os casos 1, 2, 5, 6 e 9 dependem do motor de fronteira e entram na v0.2.

## Nota de ambiente

Um `bun` instalado por snap roda confinado e nao enxerga o `git` do sistema.
Nesse caso o frescor cai para caminhada e o `.gitignore` deixa de ser
respeitado. O `psh doctor` reprova com `workspace-enum` quando isso acontece; o
binario compilado por `bun run build` nao tem essa limitacao.
