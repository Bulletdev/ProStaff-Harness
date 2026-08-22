import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { BoundaryPolicy } from "../src/boundary/policy.ts";
import { execUnderBoundary } from "../src/boundary/execute.ts";
import { layoutFor, type Layout } from "../src/util/paths.ts";
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

  test("o .ai-jail que o proprio sandbox grava nao vira violacao do agente", () => {
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
