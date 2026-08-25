import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { BoundaryPolicy } from "../src/boundary/policy.ts";
import { execUnderBoundary } from "../src/boundary/execute.ts";
import { layoutFor, type Layout } from "../src/util/paths.ts";
import { runVerifier } from "../src/evidence/runner.ts";
import type { VerifierSpec } from "../src/workflow/types.ts";
import type { SandboxStatus } from "../src/evidence/sandbox.ts";

/**
 * Integracao com o `ai-jail` de verdade.
 *
 * O binario nao vem no repositorio, entao estes testes sao declarados `skip`
 * quando ele nao esta disponivel. Passar sem exercitar seria pior: a diferenca
 * entre "detecta e reverte" e "o kernel impede" e justamente o que este arquivo
 * existe para provar.
 *
 * Baixe com:
 *   gh release download -R akitaonrails/ai-jail -p 'ai-jail-linux-x86_64.tar.gz*'
 *   sha256sum -c ai-jail-linux-x86_64.tar.gz.sha256 && tar xzf ai-jail-linux-x86_64.tar.gz
 *   PSH_AI_JAIL_BIN=$PWD/ai-jail bun test
 */
const JAIL = process.env.PSH_AI_JAIL_BIN ?? null;

/**
 * Nao basta o binario existir: ele precisa conseguir enjaular a partir DESTE
 * processo.
 *
 * Um `bun` instalado por snap roda confinado e o ai-jail lancado por ele nao
 * acha o `bwrap` do sistema. Testar `--version` daria verde e o describe
 * inteiro reprovaria por motivo de ambiente, nao de codigo.
 */
const JAIL_OK = (() => {
  if (JAIL === null || !existsSync(JAIL)) return false;
  if (spawnSync(JAIL, ["--version"]).status !== 0) return false;
  const probe = spawnSync(JAIL, ["--no-agent-state", "--no-network", "--", "true"], {
    encoding: "utf8",
  });
  return probe.status === 0;
})();

const criados: string[] = [];
afterAll(() => {
  for (const d of criados) rmSync(d, { recursive: true, force: true });
});

/**
 * O ai-jail monta `/tmp` como tmpfs, entao um projeto ali fica invisivel dentro
 * da jaula. Estes testes moram fora de /tmp por isso.
 */
function projetoForaDoTmp(): { layout: Layout; policy: BoundaryPolicy } {
  const base = join(homedir(), ".cache", "psh-testes-aijail");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "proj-"));
  criados.push(root);

  const layout = layoutFor(root);
  mkdirSync(join(root, "src", "api"), { recursive: true });
  mkdirSync(join(root, "src", "web"), { recursive: true });
  mkdirSync(join(layout.evidenceDir), { recursive: true });
  writeFileSync(join(root, "src", "api", "users.ts"), "api original\n");
  writeFileSync(join(root, "src", "web", "app.tsx"), "web original\n");
  writeFileSync(join(layout.evidenceDir, "coverage.json"), '{"value":87}\n');

  const policy = new BoundaryPolicy(
    { _type: "psh-boundary", version: 1, agents: { backend: { write: ["src/api/**"] } } },
    layout,
    [],
  );
  return { layout, policy };
}

function comJaula(layout: Layout, policy: BoundaryPolicy, comando: string) {
  const sandbox: SandboxStatus = {
    mode: "ai-jail",
    detail: "binario real",
    jail_bin: JAIL!,
    jail_version: "real",
  };
  return execUnderBoundary({
    layout,
    policy,
    agentId: "backend",
    argv: ["sh", "-c", comando],
    sandbox,
    timeout_s: 60,
  });
}

const ler = (layout: Layout, rel: string) => readFileSync(join(layout.root, rel), "utf8");

describe.skipIf(!JAIL_OK)("fronteira aplicada pelo kernel, com ai-jail real", () => {
  test("escrita dentro do escopo acontece", () => {
    const { layout, policy } = projetoForaDoTmp();
    const r = comJaula(layout, policy, "echo novo > src/api/users.ts");
    expect(r.exit_code).toBe(0);
    expect(ler(layout, "src/api/users.ts")).toBe("novo\n");
    expect(r.violations).toEqual([]);
  });

  test("escrita fora do escopo e impedida pelo kernel, e nao ha o que reverter", () => {
    const { layout, policy } = projetoForaDoTmp();
    const r = comJaula(layout, policy, "echo invadido > src/web/app.tsx");

    // O comando falha porque o filesystem recusou, nao porque o psh desfez.
    expect(r.exit_code).not.toBe(0);
    expect(ler(layout, "src/web/app.tsx")).toBe("web original\n");
    expect(r.violations).toEqual([]);
  });

  test("artefato que decide portao continua fora de alcance", () => {
    const { layout, policy } = projetoForaDoTmp();
    const r = comJaula(layout, policy, 'echo \'{"value":100}\' > .harness/evidence/coverage.json');
    expect(r.exit_code).not.toBe(0);
    expect(ler(layout, ".harness/evidence/coverage.json")).toBe('{"value":87}\n');
  });

  test("apagar arquivo fora do escopo tambem e impedido", () => {
    const { layout, policy } = projetoForaDoTmp();
    const r = comJaula(layout, policy, "rm -f src/web/app.tsx");
    expect(r.exit_code).not.toBe(0);
    expect(existsSync(join(layout.root, "src/web/app.tsx"))).toBe(true);
  });

  test("o residuo que o mount nao expressa e pego pelo snapshot", () => {
    // A raiz do projeto continua gravavel, entao entrada nova criada ali nao e
    // barrada pelo kernel. E a segunda camada do R3.1 que fecha.
    const { layout, policy } = projetoForaDoTmp();
    const r = comJaula(layout, policy, "echo invasor > arquivo-novo.txt");

    expect(existsSync(join(layout.root, "arquivo-novo.txt"))).toBe(false);
    expect(r.violations.map((v) => v.path)).toContain("arquivo-novo.txt");
    expect(r.violations[0]!.action).toBe("deleted");
  });

  test("corrida limpa nao inventa violacao", () => {
    const { layout, policy } = projetoForaDoTmp();
    const r = comJaula(layout, policy, "true");
    expect(r.violations).toEqual([]);
  });

  test("rede desligada por padrao (R3.4)", () => {
    const { layout, policy } = projetoForaDoTmp();
    // Sem rede a resolucao de nome falha; o teste so exige que nao tenha sucesso.
    const r = comJaula(layout, policy, "getent hosts example.com >/dev/null 2>&1");
    expect(r.exit_code).not.toBe(0);
  });
});

describe.skipIf(!JAIL_OK)("a jaula e montada so a partir do contrato do psh", () => {
  test("nenhum arquivo de configuracao e deixado no projeto", () => {
    const { layout, policy } = projetoForaDoTmp();
    comJaula(layout, policy, "true");
    // Por padrao o ai-jail grava um `.ai-jail` na raiz e o le na proxima
    // corrida. O arquivo mora dentro da arvore que o agente edita, e a fronteira
    // nao pode depender, nem em parte, de algo que o enjaulado escreve.
    expect(existsSync(join(layout.root, ".ai-jail"))).toBe(false);
  });

  test("a segunda corrida enjaula igual a primeira", () => {
    const { layout, policy } = projetoForaDoTmp();
    for (const tentativa of [1, 2, 3]) {
      const r = comJaula(layout, policy, `echo invadido-${tentativa} > src/web/app.tsx`);
      expect(r.exit_code).not.toBe(0);
      expect(ler(layout, "src/web/app.tsx")).toBe("web original\n");
      expect(r.stderr).not.toContain("rule not applied");
    }
  });

  test("configuracao plantada na raiz nao muda a fronteira", () => {
    const { layout, policy } = projetoForaDoTmp();
    writeFileSync(
      join(layout.root, ".ai-jail"),
      'command = ["true"]\ndeny_paths = []\nnetwork = true\n',
    );
    const r = comJaula(layout, policy, "echo invadido > src/web/app.tsx");
    expect(r.exit_code).not.toBe(0);
    expect(ler(layout, "src/web/app.tsx")).toBe("web original\n");
  });

  test("a memoria fica fora de alcance do agente, pelo kernel (R5.4)", () => {
    const { layout, policy } = projetoForaDoTmp();
    mkdirSync(layout.memoryPagesDir, { recursive: true });
    writeFileSync(join(layout.memoryPagesDir, "fato.md"), "pagina original\n");

    const r = comJaula(layout, policy, "echo injetado > .harness/memory/pages/fato.md");

    // O bloco de handoff entra no inicio da sessao seguinte: memoria que o
    // agente escreve e texto que ele injeta em si mesmo depois.
    expect(r.exit_code).not.toBe(0);
    expect(ler(layout, ".harness/memory/pages/fato.md")).toBe("pagina original\n");
    expect(r.violations).toEqual([]);
  });

  test("o id do agente atravessa a jaula, que zera o ambiente do filho", () => {
    const { layout, policy } = projetoForaDoTmp();
    // Medido contra o 1.19.2: sem `--env` explicito no argv, `PSH_AGENT` chega
    // vazio la dentro e `psh remember` do agente nasceria assinado como humano.
    const r = comJaula(layout, policy, 'printf "[%s]" "$PSH_AGENT"');
    expect(r.stdout).toContain("[backend]");
  });
});

/**
 * Campo 01, achado 1 e 2.
 *
 * O `.ai-jail` de projeto e politica monotonica: ele so restringe, e a linha de
 * comando nao consegue reabrir o que ele fechou. Enquanto o `psh exec` ja
 * passava `--clean --no-save-config`, o caminho do verificador nao passava, e
 * era justamente o caminho que produz valor de portao.
 *
 * O sintoma media dinheiro: o proprio psh gravava `.ai-jail` com `network =
 * false` ao rodar um verificador sem rede, e o verificador seguinte, declarado
 * com `network: true`, rodava sem rede. O comando falhava por conexao, o
 * relatorio saia com zero acerto, e esse zero virava valor de portao.
 *
 * O teste usa `lockdown` em vez de rede porque o efeito e o mesmo (config de
 * projeto apertando a corrida) e nao depende de internet para ser observado.
 */
describe.skipIf(!JAIL_OK)("config de projeto do ai-jail nao alcanca o verificador", () => {
  const spec: VerifierSpec = {
    id: "escreve",
    run: ["/bin/sh", "-c", "echo gerado > src/api/gerado.txt"],
    extract: { kind: "exit-code" },
    watch: ["src/web/**"],
    timeout_s: 60,
  };

  const sandboxReal = (): SandboxStatus => ({
    mode: "ai-jail",
    detail: "binario real",
    jail_bin: JAIL!,
    jail_version: "real",
  });

  test("um .ai-jail hostil no projeto nao aperta a corrida do verificador", () => {
    const { layout } = projetoForaDoTmp();
    writeFileSync(join(layout.root, ".ai-jail"), "lockdown = true\n");

    const { record } = runVerifier({ layout, spec, phase: "f", attempt: 1, sandbox: sandboxReal() });

    // Sem `--clean`, o lockdown do arquivo deixaria a arvore somente leitura e
    // o `echo` morreria com "Read-only file system".
    expect(record.status).toBe("ok");
    expect(record.exit_code).toBe(0);
    expect(ler(layout, "src/api/gerado.txt")).toBe("gerado\n");
  });

  test("o verificador nao deixa .ai-jail para tras, nem reescreve o que existe", () => {
    const { layout } = projetoForaDoTmp();
    const alvo = join(layout.root, ".ai-jail");

    runVerifier({ layout, spec, phase: "f", attempt: 1, sandbox: sandboxReal() });
    expect(existsSync(alvo)).toBe(false);

    writeFileSync(alvo, "lockdown = true\n");
    runVerifier({ layout, spec, phase: "f", attempt: 2, sandbox: sandboxReal() });
    expect(readFileSync(alvo, "utf8")).toBe("lockdown = true\n");
  });
});

/**
 * Campo 01, achado 1: a invariante que o bug violava.
 *
 *   sandbox(corrida atual) nao depende de sandbox(corrida anterior)
 *
 * Aqui a rede e medida de verdade, porque era exatamente a capacidade que
 * chegava atrasada uma corrida. `curl` sem rede morre com 6 (host nao resolve) e
 * com rede alcanca o endpoint. O teste nao olha o corpo da resposta, so se o
 * processo chegou la, entao nao depende de status HTTP nem de credencial.
 *
 * Depende de internet, e por isso se declara `skip` quando ela nao existe:
 * passar sem exercitar seria pior do que nao existir.
 */
const CURL = "/usr/bin/curl";
const ALVO_HTTP = "https://example.com";
const INTERNET_OK = (() => {
  if (!existsSync(CURL)) return false;
  return spawnSync(CURL, ["-sS", "-m", "8", "-o", "/dev/null", ALVO_HTTP]).status === 0;
})();

describe.skipIf(!JAIL_OK || !INTERNET_OK)("a rede da corrida nao depende da corrida anterior", () => {
  const sandboxReal = (): SandboxStatus => ({
    mode: "ai-jail",
    detail: "binario real",
    jail_bin: JAIL!,
    jail_version: "real",
  });

  function specCurl(id: string, network: boolean): VerifierSpec {
    return {
      id,
      run: [CURL, "-sS", "-m", "15", "-o", "/dev/null", ALVO_HTTP],
      extract: { kind: "exit-code" },
      watch: ["src/web/**"],
      timeout_s: 60,
      network,
    };
  }

  /** Devolve o codigo de saida do curl dentro da jaula. */
  function corrida(layout: Layout, id: string, network: boolean, attempt: number): number | null {
    const { record } = runVerifier({
      layout,
      spec: specCurl(id, network),
      phase: "f",
      attempt,
      sandbox: sandboxReal(),
    });
    return record.exit_code;
  }

  test("sem rede primeiro, com rede depois: a segunda alcanca a rede", () => {
    const { layout } = projetoForaDoTmp();
    expect(corrida(layout, "sem-rede", false, 1)).not.toBe(0);
    expect(corrida(layout, "com-rede", true, 2)).toBe(0);
  });

  test("com rede primeiro, sem rede depois: a terceira ainda alcanca a rede", () => {
    const { layout } = projetoForaDoTmp();
    expect(corrida(layout, "com-rede", true, 1)).toBe(0);
    expect(corrida(layout, "sem-rede", false, 2)).not.toBe(0);
    expect(corrida(layout, "com-rede", true, 3)).toBe(0);
  });

  test("o resultado de uma corrida com rede e o mesmo em qualquer ordem", () => {
    const depoisDeSemRede = (() => {
      const { layout } = projetoForaDoTmp();
      corrida(layout, "sem-rede", false, 1);
      return corrida(layout, "com-rede", true, 2);
    })();
    const semPredecessor = (() => {
      const { layout } = projetoForaDoTmp();
      return corrida(layout, "com-rede", true, 1);
    })();
    expect(depoisDeSemRede).toBe(semPredecessor);
    expect(depoisDeSemRede).toBe(0);
  });
});
