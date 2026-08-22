import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoundaryPolicy, type BoundaryContract } from "../src/boundary/policy.ts";
import { diretorioBase, execUnderBoundary, montarArgvEnjaulado } from "../src/boundary/execute.ts";
import type { SandboxStatus } from "../src/evidence/sandbox.ts";
import { cleanupTempProjects, GIT_AVAILABLE, run, tempProject, writeFile } from "./helpers.ts";
import type { Layout } from "../src/util/paths.ts";

afterAll(cleanupTempProjects);

const DEGRADADO: SandboxStatus = {
  mode: "degraded",
  detail: "teste: sem ai-jail",
  jail_bin: null,
  jail_version: null,
};

const CONTRATO: BoundaryContract = {
  _type: "psh-boundary",
  version: 1,
  agents: { backend: { write: ["src/api/**"] } },
};

function cenario(): { layout: Layout; policy: BoundaryPolicy } {
  const layout = tempProject({ git: false });
  writeFile(layout, "src/api/users.ts", "api original\n");
  writeFile(layout, "src/web/app.tsx", "web original\n");
  writeFile(layout, "README.md", "leia original\n");
  writeFile(layout, ".harness/evidence/p/1/coverage.json", '{"value":87}\n');
  const policy = new BoundaryPolicy(CONTRATO, layout, [join(layout.root, "vendor")]);
  return { layout, policy };
}

function roda(layout: Layout, policy: BoundaryPolicy, comando: string) {
  return execUnderBoundary({
    layout,
    policy,
    agentId: "backend",
    argv: ["sh", "-c", comando],
    sandbox: DEGRADADO,
    timeout_s: 30,
  });
}

function conteudo(layout: Layout, rel: string): string {
  return readFileSync(join(layout.root, rel), "utf8");
}

/**
 * Aceite da v0.2: agente restrito a src/api nao escreve em src/web, por
 * nenhuma das vias. Cada via e um caso do R11.2 numero 1.
 */
describe("R11.2 caso 1: escrita fora da fronteira por cada via", () => {
  // BSD sed (macOS) exige sufixo de backup no -i; GNU sed nao aceita o sufixo
  // vazio da mesma forma. Testar a ferramenta de verdade em vez de trocar por
  // um equivalente portatil, porque `sed -i` e uma das vias nomeadas no criterio
  // de aceite.
  const SED_INPLACE = process.platform === "darwin" ? "sed -i ''" : "sed -i";

  const vias: [string, string][] = [
    ["redirecionamento", "echo invadido > src/web/app.tsx"],
    ["append por redirecionamento", "echo invadido >> src/web/app.tsx"],
    ["sed -i", `${SED_INPLACE} 's/web original/invadido/' src/web/app.tsx`],
    ["cp", "cp src/api/users.ts src/web/app.tsx"],
    ["mv", "mv src/api/users.ts src/web/app.tsx"],
    ["tee", "echo invadido | tee src/web/app.tsx >/dev/null"],
    ["dd", "printf invadido | dd of=src/web/app.tsx status=none"],
  ];

  test.each(vias)("por %s a escrita e revertida e registrada", (_nome, comando) => {
    const { layout, policy } = cenario();
    const r = roda(layout, policy, comando);

    expect(conteudo(layout, "src/web/app.tsx")).toBe("web original\n");
    expect(r.violations.map((v) => v.path)).toContain("src/web/app.tsx");
    const v = r.violations.find((x) => x.path === "src/web/app.tsx")!;
    expect(v.action).toBe("reverted");
    expect(v.reason).toContain("fora da fronteira de escrita");
  });

  test("apagar arquivo fora da fronteira tambem e violacao, e o arquivo volta", () => {
    const { layout, policy } = cenario();
    const r = roda(layout, policy, "rm src/web/app.tsx");

    expect(existsSync(join(layout.root, "src/web/app.tsx"))).toBe(true);
    expect(conteudo(layout, "src/web/app.tsx")).toBe("web original\n");
    const v = r.violations.find((x) => x.path === "src/web/app.tsx")!;
    expect(v.change).toBe("deleted");
    expect(v.action).toBe("reverted");
  });

  test("criar arquivo novo fora da fronteira e removido", () => {
    const { layout, policy } = cenario();
    const r = roda(layout, policy, "mkdir -p src/web/novo && echo x > src/web/novo/a.ts");

    expect(existsSync(join(layout.root, "src/web/novo/a.ts"))).toBe(false);
    const v = r.violations.find((x) => x.path === "src/web/novo/a.ts")!;
    expect(v.change).toBe("created");
    expect(v.action).toBe("deleted");
  });

  // Ultima via do criterio de aceite da v0.2. Precisa de Git de verdade: sem
  // ele o teste passaria sem exercitar nada, entao e declarado skip.
  test.skipIf(!GIT_AVAILABLE)("por git checkout a restauracao fora da fronteira e revertida", () => {
    const layout = tempProject();
    writeFile(layout, "src/api/users.ts", "api v1\n");
    writeFile(layout, "src/web/app.tsx", "web v1\n");
    run("git", ["add", "-A"], layout.root);
    run("git", ["commit", "-qm", "v1"], layout.root);

    // Estado atual difere do commit, nos dois lados da fronteira.
    writeFile(layout, "src/api/users.ts", "api v2\n");
    writeFile(layout, "src/web/app.tsx", "web v2\n");

    const policy = new BoundaryPolicy(CONTRATO, layout, [join(layout.root, "vendor")]);
    const r = execUnderBoundary({
      layout,
      policy,
      agentId: "backend",
      argv: ["git", "checkout", "--", "."],
      sandbox: DEGRADADO,
    });

    // Dentro da fronteira o checkout vale; fora dela e desfeito.
    expect(readFileSync(join(layout.root, "src/api/users.ts"), "utf8")).toBe("api v1\n");
    expect(readFileSync(join(layout.root, "src/web/app.tsx"), "utf8")).toBe("web v2\n");
    expect(r.violations.map((v) => v.path)).toContain("src/web/app.tsx");
  });

  test("escrita DENTRO da fronteira passa e nao vira violacao", () => {
    const { layout, policy } = cenario();
    const r = roda(layout, policy, "echo novo > src/api/users.ts && echo outro > src/api/novo.ts");

    expect(conteudo(layout, "src/api/users.ts")).toBe("novo\n");
    expect(conteudo(layout, "src/api/novo.ts")).toBe("outro\n");
    expect(r.violations).toEqual([]);
  });

  test("uma corrida que mexe dentro e fora reverte so o que estava fora", () => {
    const { layout, policy } = cenario();
    const r = roda(layout, policy, "echo ok > src/api/users.ts; echo mal > src/web/app.tsx; echo mal > README.md");

    expect(conteudo(layout, "src/api/users.ts")).toBe("ok\n");
    expect(conteudo(layout, "src/web/app.tsx")).toBe("web original\n");
    expect(conteudo(layout, "README.md")).toBe("leia original\n");
    expect(r.violations.map((v) => v.path).sort()).toEqual(["README.md", "src/web/app.tsx"]);
  });
});

describe("R11.2 caso 5 pela execucao: artefato de portao nao e alcancavel por comando", () => {
  test("sobrescrever evidencia por shell e revertido", () => {
    const { layout, policy } = cenario();
    const r = roda(layout, policy, 'echo \'{"value":100}\' > .harness/evidence/p/1/coverage.json');

    expect(conteudo(layout, ".harness/evidence/p/1/coverage.json")).toBe('{"value":87}\n');
    const v = r.violations.find((x) => x.path === ".harness/evidence/p/1/coverage.json")!;
    expect(v.action).toBe("reverted");
    expect(v.reason).toContain("deny duro");
  });

  test("apagar a trilha por shell e revertido", () => {
    const { layout, policy } = cenario();
    writeFile(layout, ".harness/audit/chain.jsonl", "linha1\n");
    const r = roda(layout, policy, "rm -f .harness/audit/chain.jsonl");

    expect(conteudo(layout, ".harness/audit/chain.jsonl")).toBe("linha1\n");
    expect(r.violations.some((v) => v.path === ".harness/audit/chain.jsonl")).toBe(true);
  });
});

describe("o executor nao decide veredito, so aplica fronteira", () => {
  test("codigo de saida do comando atravessa intacto", () => {
    const { layout, policy } = cenario();
    expect(roda(layout, policy, "exit 7").exit_code).toBe(7);
    expect(roda(layout, policy, "exit 0").exit_code).toBe(0);
  });

  test("comando que falha ainda tem a violacao revertida", () => {
    const { layout, policy } = cenario();
    const r = roda(layout, policy, "echo mal > src/web/app.tsx; exit 3");
    expect(r.exit_code).toBe(3);
    expect(conteudo(layout, "src/web/app.tsx")).toBe("web original\n");
    expect(r.violations).toHaveLength(1);
  });

  test("o modo fica declarado no resultado", () => {
    const { layout, policy } = cenario();
    const r = roda(layout, policy, "true");
    expect(r.mode).toBe("degraded");
    expect(r.snapshot).not.toBeNull();
    expect(r.snapshot!.examined).toBeGreaterThan(0);
  });

  test("R2.13: o snapshot conta o que examinou e o que nao coube no teto", () => {
    const { layout, policy } = cenario();
    const r = execUnderBoundary({
      layout,
      policy,
      agentId: "backend",
      argv: ["sh", "-c", "echo mal > src/web/app.tsx"],
      sandbox: DEGRADADO,
      backupBudgetBytes: 0,
    });
    expect(r.snapshot!.backed_up).toBe(0);
    expect(r.snapshot!.skipped_by_budget).toBeGreaterThan(0);
    // Sem copia nao ha reversao, e isso e declarado em vez de silenciado.
    const v = r.violations.find((x) => x.path === "src/web/app.tsx")!;
    expect(v.action).toBe("unrevertable");
    expect(v.reason).toContain("teto de bytes");
  });

  test("o diretorio temporario do snapshot nao sobra no projeto", () => {
    const { layout, policy } = cenario();
    roda(layout, policy, "true");
    const tmp = join(layout.root, ".harness", "tmp");
    if (existsSync(tmp)) expect(readdirSync(tmp)).toEqual([]);
  });
});

describe("montagem para o ai-jail (R3.1 camada 1, R3.4)", () => {
  test("projeto entra somente leitura e so o escopo do agente volta como rw", () => {
    const { layout, policy } = cenario();
    const argv = montarArgvEnjaulado(
      { layout, policy, agentId: "backend", argv: ["sh", "-c", "true"] },
      "/bin/ai-jail",
    );
    expect(argv[0]).toBe("/bin/ai-jail");
    expect(argv).toContain("--no-agent-state");
    expect(argv).toContain("--no-docker");
    expect(argv).toContain("--no-ssh");
    expect(argv).toContain("--no-network");

    const roMap = argv[argv.indexOf("--map") + 1];
    expect(roMap).toBe(layout.root);
    const rwMap = argv[argv.indexOf("--rw-map") + 1];
    expect(rwMap).toBe(join(layout.root, "src/api"));
  });

  test("o que decide portao entra como deny-path mesmo com glob amplo do agente", () => {
    const layout = tempProject({ git: false });
    const guloso = new BoundaryPolicy(
      { _type: "psh-boundary", version: 1, agents: { tudo: { write: ["**"] } } },
      layout,
      [join(layout.root, "vendor")],
    );
    const argv = montarArgvEnjaulado(
      { layout, policy: guloso, agentId: "tudo", argv: ["true"] },
      "/bin/ai-jail",
    );
    const denies = argv.reduce<string[]>((acc, a, i) => (a === "--deny-path" ? [...acc, argv[i + 1]!] : acc), []);
    expect(denies).toContain(join(layout.root, ".harness"));
    expect(denies).toContain(join(layout.root, ".git"));
  });

  test("rede so aparece quando o agente declara", () => {
    const layout = tempProject({ git: false });
    const comRede = new BoundaryPolicy(
      { _type: "psh-boundary", version: 1, agents: { net: { write: ["src/**"], network: true } } },
      layout,
      [],
    );
    const argv = montarArgvEnjaulado({ layout, policy: comRede, agentId: "net", argv: ["true"] }, "/bin/ai-jail");
    expect(argv).toContain("--network");
    expect(argv).not.toContain("--no-network");
  });

  test("glob vira diretorio base para o mount", () => {
    expect(diretorioBase("src/api/**")).toBe("src/api");
    expect(diretorioBase("src/**/*.ts")).toBe("src");
    expect(diretorioBase("**")).toBe(".");
    expect(diretorioBase("app/models/user.rb")).toBe("app/models/user.rb");
  });

  test("com wrapper falso, o codigo de saida atravessa a jaula", () => {
    const { layout, policy } = cenario();
    const bin = join(layout.root, "fake-ai-jail");
    writeFileSync(bin, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
    const r = execUnderBoundary({
      layout,
      policy,
      agentId: "backend",
      argv: ["sh", "-c", "exit 9"],
      sandbox: { mode: "ai-jail", detail: "falso", jail_bin: bin, jail_version: "1" },
    });
    expect(r.exit_code).toBe(9);
    expect(r.mode).toBe("ai-jail");
    // Com mount de verdade nao ha o que reverter: quem impede e o kernel.
    expect(r.violations).toEqual([]);
    expect(r.snapshot).toBeNull();
  });
});
