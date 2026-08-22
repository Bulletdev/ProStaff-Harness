```
        ██████╗ ███████╗██╗  ██╗
        ██╔══██╗██╔════╝██║  ██║
        ██████╔╝███████╗███████║
        ██╔═══╝ ╚════██║██╔══██║
        ██║     ███████║██║  ██║
        ╚═╝     ╚══════╝╚═╝  ╚═╝
   ProStaff Harness - portoes que exigem prova
```

<div align="center">

[![CI](https://github.com/Bulletdev/ProStaff-Harness/actions/workflows/psh.yml/badge.svg)](https://github.com/Bulletdev/ProStaff-Harness/actions/workflows/psh.yml)
[![Bun](https://img.shields.io/badge/bun-1.3+-000000?logo=bun&logoColor=white)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)](https://sqlite.org/)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](CHANGELOG.md)

</div>

---

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  PSH - Harness de execucao para agentes de codigo                            ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Portoes de qualidade que consomem evidencia produzida pelo nucleo, nunca    ║
║  numero informado pelo agente. Cobertura, teste, lint e seguranca viram      ║
║  registro assinado por hash da arvore verificada.                            ║
║                                                                              ║
║  v0.1.0 - nucleo verificavel  ·  236 testes  ·  binario unico                ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

## O problema

Um agente de codigo que reporta a propria nota nao esta sendo avaliado, esta se
autodeclarando aprovado. O padrao aparece sempre da mesma forma:

```
agente: "rodei os testes, cobertura 87%, pode avancar de fase"
harness: portao aprovado
```

Ninguem rodou nada. O numero veio do modelo. E mesmo quando o teste roda de
verdade, nada impede continuar editando o codigo depois e seguir usando aquele
resultado.

O `psh` fecha esses dois buracos. O portao le **exclusivamente** registros de
evidencia que o proprio nucleo produziu, e cada registro carrega o hash da
arvore de arquivos que estava no disco no momento da verificacao. Editou depois,
a evidencia vence.

```
$ psh advance --coverage 99
psh: portao nao aceita metrica vinda do chamador: [coverage].
     Valor de portao so vem de registro de evidencia produzido por 'psh verify'.
$ echo $?
5
```

A recusa e explicita de proposito. Tratada como "flag desconhecida", o caminho
nunca apareceria em teste e ninguem saberia se a garantia existe.

---

<details>
<summary><kbd>▶ Funcionalidades (clique para expandir)</kbd></summary>

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  [■] Evidence Engine     - o nucleo executa o verificador, o agente nunca   │
│  [■] Frescor por hash    - editou arquivo observado, a evidencia vence      │
│  [■] Trilha encadeada    - JSONL com prev_hash, detecta remocao e edicao    │
│  [■] Ancora externa      - pega reescrita coordenada da cadeia inteira      │
│  [■] Workflow Engine     - fases, portoes e protocolo de falha por classe   │
│  [■] Contrato validado   - JSON Schema + integridade referencial no load    │
│  [■] Override rastreado  - passed-with-override permanente, nunca passed    │
│  [■] Extratores nativos  - lcov, Cobertura, SimpleCov, go cover, JSON Ptr   │
│  [■] Exit code manda     - texto extrai detalhe, nunca decide veredito      │
│  [■] Adapter CI          - headless, JSON, codigo de saida estavel          │
│  [■] psh doctor          - diagnostico fora do runtime, colavel em issue    │
│  [■] Binario unico       - bun build --compile, sem runtime instalado       │
└─────────────────────────────────────────────────────────────────────────────┘
```

</details>

---

## Sumario

```
┌──────────────────────────────────────────────────────┐
│  01 · Instalacao                                     │
│  02 · Primeiros passos                               │
│  03 · Como um portao decide                          │
│  04 · Contrato de workflow                           │
│  05 · Codigos de saida                               │
│  06 · Integracao com CI                              │
│  07 · O que a v0.1 nao faz                           │
│  08 · Desenvolvimento                                │
│  09 · Roadmap                                        │
└──────────────────────────────────────────────────────┘
```

---

## 01 · Instalacao

Requer [Bun](https://bun.sh/) 1.3 ou superior para compilar.

```sh
git clone https://github.com/Bulletdev/ProStaff-Harness.git
cd ProStaff-Harness/psh
bun install
bun run build          # gera dist/psh, binario unico
```

Isolamento de execucao e opcional e usa o [ai-jail](https://github.com/akitaonrails/ai-jail)
0.10.0 ou superior. Sem ele o `psh` roda em modo degradado, **declarado** no
`psh status`, no `psh doctor` e dentro de cada registro de evidencia.

---

## 02 · Primeiros passos

```sh
psh init --profile lean   # detecta a stack, mostra o plano, pede confirmacao
psh verify                # o NUCLEO roda os verificadores do portao atual
psh status                # fase, tentativa, portao, sandbox, trilha
psh advance               # avalia o portao e decide a transicao
psh audit verify          # integridade da trilha encadeada
psh doctor                # diagnostico completo
```

`psh init` e nao destrutivo: mostra o plano, faz backup do que sobrescrever e
so escreve dentro de `.harness/`. Use `--dry-run` para so ver o plano.

```
$ psh status
perfil        lean
fase          phase.5.build - Build + Quality
tentativa     2 (retries 1/2)
status        in-progress
sandbox       ai-jail 0.10.0 operante
fronteira     ausente (C3 entra na v0.2)
trilha        integra (47 entradas, 0 problemas)

portao all-of: REPROVADO
  ok  verifier-status:tests           observado 0   esperado exit 0
  NAO verifier:coverage               observado 78.4  esperado min 85
      78.4 abaixo do minimo 85
```

---

## 03 · Como um portao decide

```
psh verify   ->  nucleo executa o verificador dentro do sandbox
             ->  extrai o valor do relatorio, ou usa o codigo de saida
             ->  calcula o hash da arvore dos paths observados
             ->  grava .harness/evidence/<fase>/<tentativa>/<verificador>.json

psh advance  ->  le APENAS registros de evidencia
             ->  recalcula o hash da arvore agora
             ->  divergiu = evidencia obsoleta, nomeando o arquivo que mudou
             ->  compara com o threshold do contrato
             ->  grava evento, encadeia na trilha, atualiza state.json
```

O que isso impede, na pratica:

| Tentativa | Resultado |
|---|---|
| Passar a metrica por argumento | recusa nomeada, saida 5 |
| Avancar sem ter verificado | reprova por "nao verificado" |
| Verificar e continuar editando | reprova por evidencia obsoleta, com o arquivo citado |
| Verificador que falhou ao rodar | reprova, e a metrica do relatorio nao e aproveitada |
| Suite morta por timeout ou sinal | falha, nunca zero |
| Apagar uma linha da trilha | `psh audit verify` acusa, saida 4 |
| Reescrever a trilha inteira relinkada | a ancora fora do arquivo acusa |

---

## 04 · Contrato de workflow

Fases, portoes e verificadores ficam em `.harness/workflow.json`, validado
contra JSON Schema no carregamento. Contrato invalido e falha fatal, nunca
aviso.

```json
{
  "_type": "psh-workflow",
  "version": 1,
  "profile": "lean",
  "verifiers": [
    {
      "id": "coverage",
      "run": ["npm", "run", "test:coverage"],
      "extract": { "kind": "lcov", "file": "coverage/lcov.info", "metric": "lines.pct" },
      "watch": ["src/**", "tests/**", "package.json"],
      "timeout_s": 900
    }
  ],
  "phases": [
    {
      "id": "phase.5.build",
      "name": "Build + Quality",
      "terminal": false,
      "next": ["phase.6.ux-gate"],
      "gate": {
        "type": "all-of",
        "checks": [{ "kind": "verifier", "verifier": "coverage", "min": 85 }],
        "on_fail": {
          "action": "rework",
          "loopback_to": "phase.5.build",
          "message": "cobertura abaixo do minimo"
        }
      },
      "on_failure": { "class": "quality", "max_auto_retries": 2 }
    }
  ]
}
```

O threshold mora em um lugar so: no check do portao, nunca no verificador. O
contrato nao tem onde declarar o mesmo numero duas vezes com valores
diferentes.

Fase terminal e declarada com `"terminal": true`, nunca inferida de um `next`
vazio. Um `next` que aponta para fase inexistente derruba o carregamento em vez
de virar erro em runtime, quando ja e tarde.

---

## 05 · Codigos de saida

| Codigo | Significado |
|--------|-----------------------------------------------------|
|   `0`  | sucesso                                             |
|   `1`  | falha generica: uso incorreto, verificador com erro |
|   `2`  | portao reprovado                                    |
|   `3`  | contrato invalido                                   |
|   `4`  | cadeia de auditoria comprometida                    |
|   `5`  | metrica forjada recusada                            |
|   `6`  | projeto sem `.harness/`                             |

---

## 06 · Integracao com CI

```yaml
- name: portoes de qualidade
  run: psh adapter ci --json
```

O adapter verifica, avalia o portao e decide a transicao em uma chamada, sem
TTY e sem interacao. Ele nao oferece `--force`: override e ato humano com
confirmacao, e CI nao tem humano para confirmar.

```json
{
  "_type": "psh-ci-report",
  "phase": "phase.5.build",
  "sandbox_mode": "ai-jail",
  "boundary_engine": "absent",
  "verify": { "ran": [{ "verifier": "coverage", "status": "ok", "value": 87.4 }] },
  "gate": { "passed": true },
  "advance": { "decision": "advanced", "to": "phase.6.ux-gate" },
  "audit_ok": true
}
```

`--gate-only` avalia sem mexer no estado. `--skip-verify` reaproveita evidencia
existente em vez de reverificar.

---

## 07 · O que a v0.1 nao faz

Esta secao existe porque um harness que promete garantia que nao tem e pior que
nao ter harness nenhum.

- **Nao impede um agente de escrever em `.harness/evidence/`.** Isso depende do
  motor de fronteira, que entra na 0.2. Hoje a protecao e convencao, nao
  mecanismo, e o `psh doctor` declara `fronteira ausente` em vez de sugerir o
  contrario.
- **Nao exige sandbox.** O contrato de isolamento esta implementado, mas sem
  `ai-jail` instalado o modo e `degraded` - e isso aparece no estado, no
  diagnostico e em cada registro de evidencia.
- **Nao gerencia modelo, custo ou memoria entre sessoes.** Marcos posteriores.

---

## 08 · Desenvolvimento

```sh
cd psh
bun run check      # typecheck + verificacao estatica + testes com cobertura
bun test           # 236 testes
bun run build      # binario unico
```

```
┌──────────────────────────────────────────────────────────────────────────┐
│  psh/src/workflow    fases, portoes, protocolo de falha, estado          │
│  psh/src/evidence    execucao de verificador, extratores, frescor        │
│  psh/src/gate        avaliacao de portao sobre evidencia                 │
│  psh/src/audit       trilha encadeada por hash                           │
│  psh/src/adapters    ci (headless)                                       │
│  psh/schemas         contratos de dados versionados                      │
└──────────────────────────────────────────────────────────────────────────┘
```

Regras da suite: todo arquivo em `tests/` roda por glob, nunca por lista
enumerada - teste que nao roda e pior que teste ausente, porque cria confianca.
Nenhum teste escreve no diretorio de trabalho nem toca no Git da arvore real.
Cobertura de linha acima de 85% em `audit` e em `evidence`, acima de 70% no
resto, com **todo** arquivo de `src/` entrando na medicao.

---

## 09 · Roadmap

| Versao | Escopo | Estado |
|--------|-------------------------------------------------------------------------------|--------------|
|  0.1   | Nucleo verificavel: workflow, evidencia, auditoria, CLI, adapter CI           | **entregue** |
|  0.2   | Motor de fronteira, integracao com ai-jail, modo degradado, suite adversarial | em andamento |
|  0.3   | Adapter Claude Code e memoria entre sessoes | planejado |
|  0.4   | Roteamento de modelo, contabilidade de token e custo | planejado |
|  0.5   | Adapter OpenCode, perfis por stack | planejado |
|  1.0   | Endurecimento, binarios assinados, matriz de CI completa | planejado |
---

## Licenca

[AGPL-3.0](LICENSE), a mesma do `prostaff-api`.

O `ai-jail` e GPL-3.0 e entra como **dependencia externa invocada como
processo**, nunca linkada: o `psh` monta um argv e executa o binario. Nao ha
obra derivada, e as duas licencas convivem.

---

## Creditos

- **Fabio Akita** ([@akitaonrails](https://github.com/akitaonrails)) - autor do
  [ai-jail](https://github.com/akitaonrails/ai-jail), consumido aqui como
  dependencia externa para isolamento de execucao.

---

<div align="center">

Parte do ecossistema **[ProStaff](https://github.com/Bulletdev)**

</div>
