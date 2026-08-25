# psh - núcleo verificável do ProStaff Harness

Marco **v0.3**: os quatro motores que fazem um portão valer alguma coisa,
memória que sobrevive à sessão, fronteira aplicada pelo kernel, e os adapters
`ci` e `claude-code`.

Os identificadores no formato `R1.1`, `R2.4` e afins apontam para a
especificação interna do projeto.

Ficam aqui como âncora de rastreabilidade, e o texto ao lado sempre explica o
que cada um exige.

O que o marco resolve, em uma frase: **nenhum valor de portão vem de quem está
sendo avaliado.**

O agente não executa verificador, não escreve evidência, não passa métrica por
argumento e não consegue reaproveitar um teste antigo depois de continuar
editando.

## Escopo entregue

| Componente         | Requisitos                                               | Estado   |
|--------------------|----------------------------------------------------------|----------|
| C1 Workflow engine | R1.1 a R1.6                                              | completo |
| C2 Evidence engine | R2.1 a R2.7, mais R2.10 a R2.14                          | completo |
| C3 Boundary engine | R3.1 a R3.6                                              | completo |
| C4 Audit engine    | R4.1 a R4.3                                              | completo |
| C5 Memory engine   | R5.1, R5.3 a R5.5, R5.7; R5.2 sem a narrativa por LLM     | parcial  |
| C8 Adapters        | R8.1, R8.2, R8.2b, R8.6b a R8.6g; sem MCP e sem R8.7     | parcial  |
| CLI                | `init`, `status`, `verify`, `advance`, `audit`, `doctor` | completo |
| Adapter            | `ci` (headless) e `claude-code` (cinco hooks)            | completo |

Dois comandos além do mínimo declarado no roadmap, porque sem eles o marco não
fecha sozinho:

- `psh approve <assunto>` - portão de `user-approval` não teria como ser
  satisfeito, e o perfil `strict` começa por um.
- `psh internal spec-coverage` - o verificador nativo `spec-coverage` do R2.5 é
  calculado pelo núcleo por parse dos artefatos, então o núcleo precisa de um
  ponto de entrada para se reinvocar.

## Fora do escopo da v0.3, e declarado como tal

- **Página de sessão reescrita como narrativa** (R5.2).

  O `psh memory consolidate` monta a página a partir da trilha, linha por linha,
  cada uma carregando o número da entrada que a originou.

  A reescrita em prosa é chamada de modelo e depende do Maestro, que é marco
  seguinte. Até lá a página é fiel e seca, que é a ordem certa das duas.

- **Servidor MCP com as tools do núcleo** (R5.6, R8.2).

  O agente fala com o harness por linha de comando, não por tool.

- **Sandbox sem `ai-jail` instalado.**

  O contrato do R2.7 está implementado, e com `ai-jail` presente a fronteira é
  aplicada pelo kernel.

  Sem ele o modo é `degraded`, que reverte em vez de impedir, e isso é declarado
  no `psh status`, no `psh doctor` e dentro de **cada registro de evidência**.

- **C6, C7, C9, e o C11 além de cobertura.**

  Marcos seguintes.

- **Cinco achados do primeiro teste de campo.**

  Verificador não tem como declarar toolchain nem credencial; `advance --force`
  passa sem `--reason`; a recusa de métrica forjada usa lista fixa de nomes em vez
  dos ids do contrato carregado; depois da fase terminal o estado fica sem nome;
  e `psh exec` captura o stdout do comando em vez de repassá-lo.

  Estão descritos em `DEVDOCS/CAMPO-01-multilingo.md`, com repro. Nenhum deles
  produz valor de portão errado, que foi o critério para não segurar a versão.

## Instalação e uso

```sh
bun install
bun run build          # dist/psh, binário único
bun run check          # typecheck + verificação estática de R2.14 + testes
```

```sh
psh init --profile lean        # detecta stack, mostra o plano, pede confirmação
psh verify                     # o NÚCLEO roda os verificadores do portão atual
psh status                     # fase, tentativa, portão, sandbox, trilha
psh advance                    # avalia o portão e decide a transição
psh audit verify               # integridade da trilha encadeada
psh audit reanchor --reason    # caminho de volta quando trilha e âncora divergem
psh doctor                     # diagnóstico colável em issue
psh adapter ci --json          # verify + gate + advance, headless
```

`psh init` é não destrutivo.

Mostra o plano, faz backup do que sobrescreve e só escreve dentro de
`.harness/`.

`--dry-run` imprime o plano e sai.

## Como um portão decide

```
psh verify   ->  núcleo executa o verificador dentro do sandbox
             ->  extrai o valor do relatório (lcov, cobertura, simplecov,
                 go cover, JSON Pointer) ou usa o código de saída
             ->  calcula o hash da árvore dos paths em `watch`
             ->  grava .harness/evidence/<fase>/<tentativa>/<verificador>.json

psh advance  ->  lê APENAS registros de evidência
             ->  recalcula o hash da árvore agora
             ->  hash divergente = evidência obsoleta, com o nome do arquivo
                 que mudou depois da verificação
             ->  compara com o threshold do contrato
             ->  grava evento, encadeia na trilha, atualiza state.json
```

Uma métrica passada pelo chamador não é ignorada, é **recusada com nome**:

```
$ psh advance --coverage 99
psh: portão não aceita métrica vinda do chamador: [coverage].
     Valor de portão só vem de registro de evidência produzido por 'psh verify' (R2.1).
$ echo $?
5
```

A recusa é explícita de propósito.

Se fosse tratada como "flag desconhecida", o caminho nunca apareceria em teste e
ninguém saberia se a garantia existe.

## Códigos de saída

| Código | Significado                                |
|--------|--------------------------------------------|
| 0      | sucesso                                    |
| 1      | falha genérica (uso, verificador com erro) |
| 2      | portão reprovado                           |
| 3      | contrato inválido                          |
| 4      | cadeia de auditoria comprometida           |
| 5      | métrica forjada recusada                   |
| 6      | projeto sem `.harness/`                    |

## Decisões que valem registro

**Threshold mora em um lugar só.**

O `min` fica no check do portão, nunca no verificador.

O contrato não tem onde declarar o mesmo número duas vezes com valores
diferentes (O9).

**`success_exit_codes` é declarado, nunca inferido.**

`npm audit` sai com 1 quando acha vulnerabilidade, e isso é resultado, não
falha.

Em vez de deduzir isso do texto da saída, o contrato declara `[0, 1]`.

O código de saída continua sendo a autoridade (R2.10b); o que muda é qual código
significa sucesso.

**Sinal nunca vira zero.**

`res.status ?? null`, jamais `?? 0`.

Processo morto por timeout ou por sinal é falha.

O atalho `?? 0` transforma `SIGTERM` em sucesso silencioso, e um portão que
aprova por causa disso é pior que portão nenhum.

Há teste para o caminho nos três modos de sandbox.

**Fase terminal é declarada.**

Uma máquina de estados que infere "é o fim" de um `next` que não resolve esconde
erro de digitação até a hora de transitar.

O contrato exige `"terminal": true`, e um `next` apontando para fase inexistente
derruba o carregamento em vez de virar surpresa em runtime (R1.5b).

**Portão vazio não vira portão aberto.**

Quando `psh init` poda os checks de uma fase porque a stack não tem aquele
verificador, o portão vira aprovação humana declarada.

O plano diz quantos checks examinou e quantos podou.

**Enumeração da árvore é declarada.**

Com Git, `git ls-files -c -o --exclude-standard` respeita o `.gitignore`.

Sem Git, caminhada.

Com `.git/` presente mas `git` indisponível, o modo é `walk-fallback` e o
`psh doctor` reprova.

Sem isso, arquivo ignorado entraria no hash e evidência válida viraria obsoleta
sozinha.

**Contagem de candidatos em toda varredura (R2.13).**

Extrator de métrica, `spec-coverage`, varredura de segredo, verificação de
trilha e o próprio `check-no-path-regex` reportam quantos candidatos
examinaram.

Zero achados com zero candidatos é erro de configuração, não resultado limpo.

**Contrato composto não compartilha objeto com os JSON embarcados.**

Perfis e stack packs são módulos JSON, ou seja, singletons do processo.

`psh init` copia antes de devolver: sem isso, qualquer mutação a jusante
corromperia todo `init` seguinte no mesmo processo.

Achado durante a validação da v0.1, com teste de regressão.

**Flag booleana não consome o token seguinte.**

`psh audit --json log` fazia `--json` engolir `log`, o subcomando sumia e o
comando caía no default sem avisar.

Também achado na validação, também com teste de regressão.

**Observar um workspace não pode modificá-lo.**

A infraestrutura que mede a árvore não entra na medição, senão ela mede a si
mesma e a evidência cai sozinha.

Duas coisas saem daí. O sandbox roda com `--clean --no-save-config`, então o
`psh` não lê nem grava o `.ai-jail` do projeto e uma corrida não tem como
envenenar a seguinte. E o que o núcleo escreve dentro de `.harness/` enquanto
opera fica fora do cálculo de frescor, listado em `HARNESS_RUNTIME_PATHS`.

A lista é nomeada, não é "tudo dentro de `.harness/`": contrato e documento de
fase moram no mesmo diretório e continuam observáveis, porque escondê-los abriria
a classe dos arquivos invisíveis ao observador.

E a exclusão aparece contada e nomeada no manifesto da evidência, porque decisão
de medição que não fica no registro não pode ser auditada depois.

Os dois casos foram achados no Campo 01, e a invariante é
`sandbox(corrida atual)` não depender de `sandbox(corrida anterior)`.

**Trilha divergente tem caminho de volta declarado.**

A recusa de escrever em trilha que não bate com a âncora está certa, mas travar
sem saída deixava uma alternativa real só, que era apagar o `.harness` na mão -
exatamente como evidência de adulteração desaparece.

`psh audit reanchor --reason "..."` grava na própria trilha o que a âncora dizia,
o que o arquivo diz, quem decidiu e por quê, e só então move a âncora.

Ele recusa quando o defeito está dentro do arquivo, porque aí a âncora não é o
problema e mover a âncora só trocaria um relatório vermelho por outro.

**Um fato, uma fonte.**

O relatório de CI dizia `boundary_engine: "absent"` enquanto o `psh status` dizia
`fronteira mount`, no mesmo projeto e no mesmo instante.

O defeito não foi o valor errado, foi haver duas declarações paralelas do mesmo
fato. O adapter passou a chamar a mesma função que alimenta o `status`, e há
teste que exige que os dois digam a mesma coisa palavra por palavra.

**Caminho nunca vira expressão regular (R2.14).**

Casamento por `Bun.Glob` com o caminho sempre do lado da entrada, comparação de
contenção por API de path, e JSON Pointer no lugar de regex sobre relatório.

`bun run lint:regex` reprova o build se algum `new RegExp` receber qualquer
coisa que não seja literal constante.

## Layout em disco

```
<projeto>/.harness/
  workflow.json      contrato de fases, portões e verificadores (humano)
  state.json         snapshot da fase (NÚCLEO, apenas)
  boundary.json      allowlist por agente (humano; aplicada pelo motor do C3)
  harness.db         SQLite: eventos, índice de evidência, contadores, âncora
  evidence/<fase>/<tentativa>/<verificador>.json      (NÚCLEO, apenas)
                                        .manifest.json  arquivo -> hash
                                        .stdout.log / .stderr.log
  reviews/*.review.json    score de LLM amarrado ao hash do artefato
  approvals/*.json         aprovação humana amarrada ao conteúdo
  audit/chain.jsonl        trilha encadeada por hash
  memory/pages/*.md        página de memória (canônica; o SQLite é só índice)
  memory/consolidation.json  marca d'água da consolidação de sessão
  tmp/                     rascunho de execução, por exemplo o snapshot da fronteira
```

`harness.db`, `evidence/`, `audit/`, `approvals/` e `memory/` entram no
`.gitignore` gerado pelo `psh init`.

O que dentro de `.harness/` é escrito pelo núcleo enquanto ele opera está
declarado em `HARNESS_RUNTIME_PATHS`, e fica fora do cálculo de frescor.

O contrato e os documentos de fase moram no mesmo diretório e continuam
observáveis, listados em `HARNESS_OBSERVABLE_PATHS`. Há teste cobrando que todo
caminho do `Layout` esteja numa das duas listas.

## Qualidade

`bun test` roda tudo em `tests/` por glob, nunca por lista enumerada (R11.2c).

Nenhum teste escreve em `process.cwd()` nem toca no Git da árvore real: cada um
cria seu próprio temporário (R11.2b).

Cobertura de linha nos módulos que o R11.1 exige em 85%:

| Módulo                  | Linhas |
|-------------------------|--------|
| `audit/chain.ts`        | 100%   |
| `evidence/workspace.ts` | 95%    |
| `gate/evaluate.ts`      | 93%    |
| `evidence/sandbox.ts`   | 93%    |
| `evidence/runner.ts`    | 92%    |
| `evidence/store.ts`     | 88%    |
| `evidence/extract/`     | 85%    |

O projeto inteiro está em 98% de linha, com a suíte rodando com `ai-jail` real e
rede.

Nos demais módulos o piso é 70%, e o menor é `util/self.ts` com 71%.

São 236 testes e 1 declarado como `skip`, com média geral de 94% de linha.

**Todo arquivo de `src/` aparece na medição.**

A CLI é exercitada em processo, com a saída desviada por `cli/io.ts`, e não só
por subprocesso.

Teste por subprocesso passa no CI mas não entra no relatório de cobertura, então
o código pareceria testado sem que ninguém soubesse quanto dele roda de fato.

Todo perfil (`strict`, `lean`, `gate-only`) cruzado com todo stack pack (`node`,
`bun`, `ruby`, `python`, `go`, `generic`) passa pelo loader real em teste, o que
dá 18 combinações.

Sem isso, um erro em `ruby.json` só apareceria na máquina de quem rodasse
`psh init` com aquela combinação.

Casos da suíte adversarial do R11.2 já cobertos:

- **3** - métrica forjada, métrica ausente, verificador que falhou e evidência
  obsoleta
- **4** - código de saída nos três modos de sandbox
- **7** - adulteração da cadeia, incluindo reescrita coordenada da âncora
- **10** - contrato com `next` inválido e `gate.type` desconhecido
- **11** - ciclo de retry até a escalação, com contador em disco
- **15** - instalação em diretório com `+`, `[` e espaço no nome
- **16** - varredura sem nenhum candidato

Os casos 1, 2, 5, 6 e 9 dependem do motor de fronteira, entregue na v0.2.

## Rodando a suíte completa

Dezessete testes de integração exercitam a fronteira e a jaula contra o `ai-jail`
de verdade, três deles medindo rede real, e alguns dependem de Git.

Quando as ferramentas não estão presentes eles são declarados `skip`, porque
passar sem exercitar seria pior do que não existir.

Para rodar tudo:

```sh
gh release download -R akitaonrails/ai-jail -p 'ai-jail-linux-x86_64.tar.gz*'
sha256sum -c ai-jail-linux-x86_64.tar.gz.sha256
tar xzf ai-jail-linux-x86_64.tar.gz

PSH_AI_JAIL_BIN=$PWD/ai-jail bun test
```

A suíte roda em modo degradado por padrão, independente de haver um `ai-jail`
instalado na máquina.

Sem isso o resultado mudaria conforme o ambiente, e um teste que depende de qual
binário está instalado não é um teste confiável.

## Plataformas

O núcleo roda onde o Bun roda.

O que depende de plataforma é como a fronteira de escrita é aplicada: Linux por
bubblewrap e Landlock, macOS por seatbelt, Windows **somente via WSL2**.

O CI cobre os três: Linux e macOS diretamente, e Windows dentro de um WSL2 real,
que mede Landlock e bubblewrap antes de rodar a suíte.

Windows nativo não tem como aplicar a fronteira pelo kernel, porque namespace de
usuário e Landlock são construções do Linux.

Nesse caso o `psh` cai no modo degradado, que reverte em vez de impedir, e diz
isso no `psh status` e no `psh doctor`.

## Nota de ambiente

Um `bun` instalado por snap roda confinado, e o confinamento aparece de quatro
formas.

Não enxerga o `git` do sistema: o frescor cai para caminhada e o `.gitignore`
deixa de ser respeitado.

Tem `/tmp` privado: um projeto ali fica invisível para processos fora do snap.

Tem `HOME` redirecionado para `~/snap/bun-js/<rev>`, então `homedir()` não é o
home real.

E o AppArmor do snap nega `exec` de binário de fora do confinamento: um
`spawn` do `ai-jail` volta `EACCES` mesmo com o caminho absoluto certo e o bit
de execução no lugar.

O `psh doctor` reprova com `workspace-enum` no primeiro caso, e é o quarto que
deixa os testes de `boundary-aijail.test.ts` em `skip` permanente, incluindo os
que provam que a jaula de uma corrida não contamina a seguinte.

Para exercitá-los é preciso um `bun` fora do snap:

```sh
curl -fsSL -o bun.zip https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip
unzip -q bun.zip && mv bun-linux-x64/bun ~/.cache/psh-bin/bun

PSH_AI_JAIL_BIN=$PWD/ai-jail ~/.cache/psh-bin/bun test
```

Com ele a suíte roda inteira, sem nenhum `skip`.

O binário compilado por `bun run build` não tem nenhuma dessas limitações.
