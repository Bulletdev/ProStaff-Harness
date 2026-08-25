```
        ██████╗ ███████╗██╗  ██╗
        ██╔══██╗██╔════╝██║  ██║
        ██████╔╝███████╗███████║
        ██╔═══╝ ╚════██║██╔══██║
        ██║     ███████║██║  ██║
        ╚═╝     ╚══════╝╚═╝  ╚═╝
   ProStaff Harness - Execução Verificável e Auditoria de Evidências
```

<div align="center">

[![CI](https://github.com/Bulletdev/ProStaff-Harness/actions/workflows/psh.yml/badge.svg)](https://github.com/Bulletdev/ProStaff-Harness/actions/workflows/psh.yml)
[![Bun](https://img.shields.io/badge/bun-1.3+-000000?logo=bun&logoColor=white)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)](https://sqlite.org/)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-orange.svg)](CHANGELOG.md)

</div>

---

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  PSH - Harness de execução para agentes de código                            ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Portões de qualidade que consomem evidência produzida pelo núcleo, nunca    ║
║  número informado pelo agente.                                               ║
║                                                                              ║
║  Cobertura, teste, lint e segurança viram registro assinado por hash da      ║
║  árvore que foi verificada.                                                  ║
║                                                                              ║
║  v0.3.0 · memória entre sessões · adapter Claude Code · 524 testes           ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

## O problema

Um agente de código que reporta a própria nota não está sendo avaliado.

Está se autodeclarando aprovado.

O padrão aparece sempre da mesma forma:

```
agente:  "rodei os testes, cobertura 87%, pode avançar de fase"
harness: portão aprovado
```

Ninguém rodou nada.

O número veio do modelo.

E mesmo quando o teste roda de verdade, nada impede continuar editando o código
depois e seguir usando aquele resultado.

O `psh` fecha esses dois buracos.

O portão lê **exclusivamente** registros de evidência que o próprio núcleo
produziu.

Cada registro carrega o hash da árvore de arquivos que estava no disco no
momento da verificação.

Editou depois, a evidência vence.

```
$ psh advance --coverage 99
psh: portão não aceita métrica vinda do chamador: [coverage].
     Valor de portão só vem de registro de evidência produzido por 'psh verify'.
$ echo $?
5
```

A recusa é explícita de propósito.

Tratada como "flag desconhecida", o caminho nunca apareceria em teste e ninguém
saberia se a garantia existe.

---

<details>
<summary><kbd>▶ Funcionalidades (clique para expandir)</kbd></summary>

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  [■] Evidence Engine     - o núcleo executa o verificador, o agente nunca   │
│  [■] Frescor por hash    - editou arquivo observado, a evidência vence      │
│  [■] Trilha encadeada    - JSONL com prev_hash, detecta remoção e edição    │
│  [■] Âncora externa      - pega reescrita coordenada da cadeia inteira      │
│  [■] Workflow Engine     - fases, portões e protocolo de falha por classe   │
│  [■] Contrato validado   - JSON Schema + integridade referencial no load    │
│  [■] Override rastreado  - passed-with-override permanente, nunca passed    │
│  [■] Extratores nativos  - lcov, Cobertura, SimpleCov, go cover, JSON Ptr   │
│  [■] Exit code manda     - texto extrai detalhe, nunca decide veredito      │
│  [■] Adapter CI          - headless, JSON, código de saída estável          │
│  [■] psh doctor          - diagnóstico fora do runtime, colável em issue    │
│  [■] Binário único       - bun build --compile, sem runtime instalado       │
│  [■] Boundary Engine     - allowlist por agente, aplicada pelo kernel       │
│  [■] Memory Engine       - página em disco, índice FTS5, frescor por hash   │
│  [■] psh handoff         - retomada montada do estado, não de resumo        │
│  [■] Consolidação        - a sessão vira página, cada linha com a origem    │
│  [■] Adapter Claude Code - cinco hooks, contrato lido do binário instalado  │
└─────────────────────────────────────────────────────────────────────────────┘
```

</details>

---

## Sumário

```
┌──────────────────────────────────────────────────────┐
│  01 · Plataformas                                    │
│  02 · Instalação                                     │
│  03 · Primeiros passos                               │
│  04 · Como um portão decide                          │
│  05 · Contrato de workflow                           │
│  06 · Códigos de saída                               │
│  07 · Integração com CI                              │
│  08 · O que o psh não faz                            │
│  09 · Desenvolvimento                                │
│  10 · Roadmap                                        │
└──────────────────────────────────────────────────────┘
```

---

## 01 · Plataformas

O núcleo (workflow, evidência, auditoria) roda onde o Bun roda.

O que depende de plataforma é **como a fronteira de escrita é aplicada**.

| Plataforma           | Fronteira                                    | Estado                                 |
|----------------------|----------------------------------------------|----------------------------------------|
| Linux                | mount pelo kernel, via bubblewrap e Landlock | testado no CI e contra o binário real  |
| macOS                | mount pelo kernel, via seatbelt              | testado no CI, sem o sandbox instalado |
| Windows **via WSL2** | igual ao Linux                               | testado no CI, em WSL2 de verdade      |
| Windows nativo       | nenhuma                                      | não suportado                          |

**Windows exige WSL2.**

Não é preguiça de portar: a fronteira precisa de namespace de usuário e de
Landlock, que são construções do kernel Linux.

O CI roda a suíte dentro de um WSL2 real, e mede o que aquele kernel oferece
antes de rodar qualquer teste:

```
kernel:     Linux 6.18.33.2-microsoft-standard-WSL2
landlock:   101 símbolos em kallsyms
bwrap:      bubblewrap 0.9.0
bwrap real: funciona
```

Ou seja, o WSL2 tem as primitivas necessárias.

A linha da tabela acima é medição, não suposição.

Fora do WSL2 o `psh` cai no modo degradado, que **detecta e reverte** escrita
fora da fronteira em vez de impedir, e isso é uma garantia mais fraca.

O modo aparece no `psh status`, no `psh doctor` e dentro de cada registro de
evidência, nunca em silêncio.

Sem sandbox instalado, em qualquer plataforma, o comportamento é o mesmo modo
degradado declarado.

Dá para trabalhar assim, mas quem impede a escrita passa a ser um snapshot, não
o kernel.

---

## 02 · Instalação

Requer [Bun](https://bun.sh/) 1.3 ou superior para compilar.

```sh
git clone https://github.com/Bulletdev/ProStaff-Harness.git
cd ProStaff-Harness/psh
bun install
bun run build          # gera dist/psh, binário único
```

Isolamento de execução é opcional e usa o
[ai-jail](https://github.com/akitaonrails/ai-jail) 1.19 ou superior.

Sem ele o `psh` roda em modo degradado.

O modo é **declarado** no `psh status`, no `psh doctor` e dentro de cada
registro de evidência, nunca silencioso.

---

## 03 · Primeiros passos

```sh
psh init --profile lean   # detecta a stack, mostra o plano, pede confirmação
psh verify                # o NÚCLEO roda os verificadores do portão atual
psh status                # fase, tentativa, portão, sandbox, trilha
psh advance               # avalia o portão e decide a transição
psh audit verify          # integridade da trilha encadeada
psh audit reanchor        # decisão humana registrada quando trilha e âncora divergem
psh doctor                # diagnóstico completo

psh remember "<fato>"     # fixa o que não pode ser perdido entre sessões
psh memory search <termo> # busca na memória do projeto
psh handoff               # bloco de retomada, pronto para a próxima sessão

psh adapter claude-code install   # registra os cinco hooks em .claude/
psh adapter claude-code contract  # confere o contrato contra o binário instalado
```

`psh init` é não destrutivo.

Mostra o plano, faz backup do que sobrescrever e só escreve dentro de
`.harness/`.

Use `--dry-run` para ver o plano sem aplicar nada.

```
$ psh status
perfil        lean
fase          phase.5.build - Build + Quality
tentativa     2 (retries 1/2)
status        in-progress
sandbox       ai-jail 1.19.2 operante
fronteira     mount (2 agentes)
trilha        íntegra (47 entradas, 0 problemas)

portão all-of: REPROVADO
  ok  verifier-status:tests           observado 0     esperado exit 0
  NÃO verifier:coverage               observado 78.4  esperado min 85
      78.4 abaixo do mínimo 85
```

---

## 04 · Como um portão decide

```
psh verify   ->  núcleo executa o verificador dentro do sandbox
             ->  extrai o valor do relatório, ou usa o código de saída
             ->  calcula o hash da árvore dos paths observados
             ->  grava .harness/evidence/<fase>/<tentativa>/<verificador>.json

psh advance  ->  lê APENAS registros de evidência
             ->  recalcula o hash da árvore agora
             ->  divergiu = evidência obsoleta, nomeando o arquivo que mudou
             ->  compara com o threshold do contrato
             ->  grava evento, encadeia na trilha, atualiza state.json
```

O que isso impede, na prática:

| Tentativa                             | Resultado                                            |
|---------------------------------------|------------------------------------------------------|
| Passar a métrica por argumento        | recusa nomeada, saída 5                              |
| Avançar sem ter verificado            | reprova por "não verificado"                         |
| Verificar e continuar editando        | reprova por evidência obsoleta, com o arquivo citado |
| Verificador que falhou ao rodar       | reprova, e a métrica do relatório não é aproveitada  |
| Suíte morta por timeout ou sinal      | falha, nunca zero                                    |
| Apagar uma linha da trilha            | `psh audit verify` acusa, saída 4                    |
| Reescrever a trilha inteira relinkada | a âncora fora do arquivo acusa                       |
| Escrever depois de adulterar a trilha | recusado antes da escrita, para o estrago não sumir  |

---

## 05 · Contrato de workflow

Fases, portões e verificadores ficam em `.harness/workflow.json`.

O arquivo é validado contra JSON Schema no carregamento.

Contrato inválido é falha fatal, nunca aviso.

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
          "message": "cobertura abaixo do mínimo"
        }
      },
      "on_failure": { "class": "quality", "max_auto_retries": 2 }
    }
  ]
}
```

O threshold mora em um lugar só: no check do portão, nunca no verificador.

O contrato não tem onde declarar o mesmo número duas vezes com valores
diferentes.

Fase terminal é declarada com `"terminal": true`, nunca inferida de um `next`
vazio.

Um `next` que aponta para fase inexistente derruba o carregamento, em vez de
virar erro em runtime quando já é tarde.

---

## 06 · Códigos de saída

| Código | Significado                                         |
|--------|-----------------------------------------------------|
| `0`    | sucesso                                             |
| `1`    | falha genérica: uso incorreto, verificador com erro |
| `2`    | portão reprovado                                    |
| `3`    | contrato inválido                                   |
| `4`    | cadeia de auditoria comprometida                    |
| `5`    | métrica forjada recusada                            |
| `6`    | projeto sem `.harness/`                             |

---

## 07 · Integração com CI

```yaml
- name: portões de qualidade
  run: psh adapter ci --json
```

O adapter verifica, avalia o portão e decide a transição em uma chamada, sem
TTY e sem interação.

Ele não oferece `--force`.

Override é ato humano com confirmação, e CI não tem humano para confirmar.

```json
{
  "_type": "psh-ci-report",
  "phase": "phase.5.build",
  "sandbox_mode": "ai-jail",
  "boundary": { "mode": "mount", "agents": 2, "detail": "escrita restrita pelo kernel via ai-jail" },
  "verify": { "ran": [{ "verifier": "coverage", "status": "ok", "value": 87.4 }] },
  "gate": { "passed": true },
  "advance": { "decision": "advanced", "to": "phase.6.ux-gate" },
  "audit_ok": true
}
```

`--gate-only` avalia sem mexer no estado.

`--skip-verify` reaproveita evidência existente em vez de reverificar.

---

## 08 · O que o psh não faz

Esta seção existe porque um harness que promete garantia que não tem é pior que
não ter harness nenhum.

- **Sem sandbox, não impede: detecta e reverte.**

  A fronteira só é aplicada pelo kernel quando há um sandbox operante.

  Fora disso o modo é `degraded`: snapshot antes, comparação depois, reversão do
  que saiu da fronteira.

  A diferença aparece no `psh status`, no `psh doctor` e em cada registro de
  evidência.

- **O mount não expressa arquivo novo em diretório gravável fora do escopo.**

  A raiz do projeto permanece gravável, então uma entrada criada ali durante a
  corrida escapa do kernel.

  É o snapshot que fecha esse resíduo, e por isso ele continua ligado também no
  modo enjaulado.

- **Detecção de comando destrutivo não é proteção.**

  `rm -rf`, `git reset --hard` e afins geram alerta na trilha, nunca bloqueio.

  Casamento por texto erra nos dois sentidos, e tratar isso como controle criaria
  confiança que o mecanismo não sustenta.

- **A memória não é fonte canônica.**

  A faixa em `.harness/memory/` é transitória e fica fora do repositório. O que
  precisa sobreviver com garantia sai dela por `psh memory promote` e vira
  arquivo versionado, que entra em revisão como qualquer outro.

- **A página de sessão não é narrativa escrita por modelo.**

  Ela é montada da trilha, com o número da entrada em cada linha. A reescrita
  como narrativa que o R5.2 pede é chamada de modelo e depende do Maestro, que é
  a v0.4.

- **O adapter não expõe as tools do núcleo por MCP.**

  O agente fala com o harness por linha de comando. O servidor MCP é marco
  posterior.

- **A atribuição de quem fez o quê é melhor esforço dentro da jaula.**

  `psh exec` marca a sessão com o id do agente, mas o agente roda com ambiente
  próprio e pode apagar a marca antes de chamar o `psh`. O que ele não apaga é a
  entrada `command.exec` da mesma execução na trilha, e é por ela que a
  correlação fecha.

- **Não gerencia modelo nem custo.**

  Maestro e contabilidade de token são marcos posteriores.

- **O verificador não declara toolchain nem credencial.**

  As flags da jaula são fixas e o `env` do verificador é mapa literal, sem
  interpolação. Toolchain instalado sob `$HOME` some lá dentro, e passar uma
  credencial exigiria escrever a chave em texto puro num arquivo versionado.

  No primeiro teste de campo isso custou vendorizar o binário do node dentro da
  árvore, e só funcionou porque o promptfoo lê o `.env` do diretório de trabalho
  por conta própria.

- **Cinco achados do primeiro teste de campo seguem abertos.**

  Estão em `DEVDOCS/CAMPO-01-multilingo.md`, com repro e gravidade. Nenhum deles
  produz valor de portão errado, que foi o critério para publicar a v0.3.0 com
  eles em aberto em vez de segurar a versão.

---

## 09 · Desenvolvimento

```sh
cd psh
bun run check      # typecheck + verificação estática + testes com cobertura
bun test           # 524 testes
bun run build      # binário único
```

```
┌──────────────────────────────────────────────────────────────────────────┐
│  psh/src/workflow    fases, portões, protocolo de falha, estado          │
│  psh/src/evidence    execução de verificador, extratores, frescor        │
│  psh/src/gate        avaliação de portão sobre evidência                 │
│  psh/src/audit       trilha encadeada por hash                           │
│  psh/src/memory      página, índice FTS5, handoff, consolidação          │
│  psh/src/adapters    ci (headless) e claude-code (cinco hooks)           │
│  psh/schemas         contratos de dados versionados                      │
└──────────────────────────────────────────────────────────────────────────┘
```

Regras da suíte de testes:

- Todo arquivo em `tests/` roda por glob, nunca por lista enumerada.
  
  Teste que não roda é pior que teste ausente, porque cria confiança.
- Nenhum teste escreve no diretório de trabalho nem toca no Git da árvore real.
- Cobertura de linha acima de 85% em `audit` e em `evidence`, acima de 70% no
  resto, com **todo** arquivo de `src/` entrando na medição.

---

## 10 · Roadmap

| Versão | Escopo                                                                        | Estado       |
|--------|-------------------------------------------------------------------------------|--------------|
| 0.1    | Núcleo verificável: workflow, evidência, auditoria, CLI, adapter CI           | **entregue** |
| 0.2    | Motor de fronteira, integração com ai-jail, modo degradado, suíte adversarial | **entregue** |
| 0.3    | Adapter Claude Code e memória entre sessões                                   | **entregue** |
| 0.4    | Roteamento de modelo, contabilidade de token e custo                          | planejado    |
| 0.5    | Adapter OpenCode, perfis por stack                                            | planejado    |
| 1.0    | Endurecimento, binários assinados, matriz de CI completa                      | planejado    |

---

## Licença

[AGPL-3.0](LICENSE), a mesma do `prostaff-api`.

O `ai-jail` é GPL-3.0 e entra como **dependência externa invocada como
processo**, nunca linkada: o `psh` monta um argv e executa o binário.

Não há obra derivada, e as duas licenças convivem.

---

## Créditos

- **Fabio Akita** ([@akitaonrails](https://github.com/akitaonrails)) - autor do
  [ai-jail](https://github.com/akitaonrails/ai-jail), consumido aqui como
  dependência externa para isolamento de execução.

---

<div align="center">

Parte do ecossistema **[ProStaff](https://github.com/prostaffgg/)**

</div>
