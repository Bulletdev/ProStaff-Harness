import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/index.ts";
import { captureIo } from "../src/cli/io.ts";
import { EXIT } from "../src/util/errors.ts";
import { detectDestructive, renderAlerts } from "../src/boundary/detect.ts";
import type { WorkflowContract } from "../src/workflow/types.ts";
import { cleanupTempProjects, harnessWith, tempProject, writeFile } from "./helpers.ts";
import type { Layout } from "../src/util/paths.ts";

afterAll(cleanupTempProjects);

let restaurar: (() => void) | null = null;
afterEach(() => {
  restaurar?.();
  restaurar = null;
});

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const cap = captureIo();
  restaurar = cap.restore;
  const code = await runCli(argv);
  cap.restore();
  restaurar = null;
  return { code, out: cap.out.join(""), err: cap.err.join("") };
}

const CONTRATO: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
  profile: "gate-only",
  verifiers: [],
  phases: [],
};

function projeto(): Layout {
  const layout = tempProject({ git: false });
  writeFile(layout, "src/api/users.ts", "api original\n");
  writeFile(layout, "src/web/app.tsx", "web original\n");
  writeFile(
    layout,
    ".harness/boundary.json",
    JSON.stringify({
      _type: "psh-boundary",
      version: 1,
      default_agent: "backend",
      agents: {
        backend: { description: "so a API", write: ["src/api/**"] },
        frontend: { write: ["src/web/**"] },
      },
    }),
  );
  harnessWith(layout, CONTRATO).close();
  return layout;
}

function conteudo(layout: Layout, rel: string): string {
  return readFileSync(join(layout.root, rel), "utf8");
}

describe("psh boundary", () => {
  test("list mostra o deny duro e os agentes declarados", async () => {
    const layout = projeto();
    const r = await cli(["boundary", "list", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("deny duro");
    expect(r.out).toContain(".harness/evidence/**");
    expect(r.out).toContain("backend (default)");
    expect(r.out).toContain("src/api/**");
    expect(r.out).toContain("rede:    desligada");
  });

  test("check devolve permitido ou bloqueado, com a regra que decidiu", async () => {
    const layout = projeto();

    const dentro = await cli(["boundary", "check", "src/api/x.ts", "--root", layout.root]);
    expect(dentro.code).toBe(EXIT.OK);
    expect(dentro.out).toContain("PERMITIDO");
    expect(dentro.out).toContain("agent-write");

    const fora = await cli(["boundary", "check", "src/web/x.tsx", "--root", layout.root]);
    expect(fora.code).toBe(EXIT.BOUNDARY_VIOLATION);
    expect(fora.out).toContain("BLOQUEADO");
    expect(fora.out).toContain("no-match");
  });

  test("check respeita o --agent informado", async () => {
    const layout = projeto();
    const r = await cli(["boundary", "check", "src/web/x.tsx", "--agent", "frontend", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("PERMITIDO");
  });

  test("check de artefato de portao e bloqueado por deny duro", async () => {
    const layout = projeto();
    const r = await cli([
      "boundary", "check", ".harness/evidence/p/1/coverage.json",
      "--agent", "frontend", "--root", layout.root,
    ]);
    expect(r.code).toBe(EXIT.BOUNDARY_VIOLATION);
    expect(r.out).toContain("deny-always");
  });

  test("add exige confirmacao e grava na trilha (R3.6)", async () => {
    const layout = projeto();
    const r = await cli(["boundary", "add", "backend", "docs/**", "--yes", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);

    const contrato = JSON.parse(conteudo(layout, ".harness/boundary.json")) as {
      agents: Record<string, { write: string[] }>;
    };
    expect(contrato.agents.backend!.write).toEqual(["src/api/**", "docs/**"]);

    const trilha = readFileSync(layout.chainPath, "utf8");
    expect(trilha).toContain("boundary.decision");
    expect(trilha).toContain("allowlist-ampliada");

    // E o efeito e real na decisao seguinte.
    const depois = await cli(["boundary", "check", "docs/a.md", "--root", layout.root]);
    expect(depois.code).toBe(EXIT.OK);
  });

  test("add sem confirmacao interativa nao altera o arquivo", async () => {
    const layout = projeto();
    const antes = conteudo(layout, ".harness/boundary.json");
    const r = await cli(["boundary", "add", "backend", "docs/**", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(conteudo(layout, ".harness/boundary.json")).toBe(antes);
  });

  test("add em agente inexistente e recusado", async () => {
    const layout = projeto();
    const r = await cli(["boundary", "add", "fantasma", "docs/**", "--yes", "--root", layout.root]);
    expect(r.code).toBe(EXIT.CONTRACT_INVALID);
    expect(r.err).toContain("nao esta declarado");
  });

  test("subcomando desconhecido e recusado", async () => {
    const layout = projeto();
    const r = await cli(["boundary", "liberar-tudo", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("subcomando desconhecido");
  });
});

describe("psh exec", () => {
  test("comando dentro da fronteira roda e propaga o codigo de saida", async () => {
    const layout = projeto();
    const r = await cli(["exec", "--agent", "backend", "--root", layout.root, "--", "sh", "-c", "echo novo > src/api/users.ts"]);
    expect(r.code).toBe(EXIT.OK);
    expect(conteudo(layout, "src/api/users.ts")).toBe("novo\n");
    expect(r.out).toContain("nenhuma violacao");
  });

  test("escrita fora da fronteira e revertida e o comando sai com codigo de violacao", async () => {
    const layout = projeto();
    const r = await cli(["exec", "--agent", "backend", "--root", layout.root, "--", "sh", "-c", "echo mal > src/web/app.tsx"]);

    expect(r.code).toBe(EXIT.BOUNDARY_VIOLATION);
    expect(conteudo(layout, "src/web/app.tsx")).toBe("web original\n");
    expect(r.out).toContain("VIOLACAO");
    expect(r.out).toContain("src/web/app.tsx");
  });

  test("violacao ganha do codigo do comando, mesmo quando o comando 'passou'", async () => {
    const layout = projeto();
    const r = await cli(["exec", "--agent", "backend", "--root", layout.root, "--", "sh", "-c", "echo mal > src/web/app.tsx; exit 0"]);
    expect(r.code).toBe(EXIT.BOUNDARY_VIOLATION);
  });

  test("codigo de saida do comando atravessa quando nao ha violacao", async () => {
    const layout = projeto();
    const r = await cli(["exec", "--agent", "backend", "--root", layout.root, "--", "sh", "-c", "exit 3"]);
    expect(r.code).toBe(3);
  });

  test("a execucao e a violacao entram na trilha (R4.3)", async () => {
    const layout = projeto();
    await cli(["exec", "--agent", "backend", "--root", layout.root, "--", "sh", "-c", "echo mal > src/web/app.tsx"]);

    const trilha = readFileSync(layout.chainPath, "utf8");
    expect(trilha).toContain("command.exec");
    expect(trilha).toContain("boundary.decision");
    expect(trilha).toContain("violacao");
    expect(trilha).toContain("src/web/app.tsx");
  });

  test("agente nao declarado e recusado antes de executar", async () => {
    const layout = projeto();
    const r = await cli(["exec", "--agent", "fantasma", "--root", layout.root, "--", "sh", "-c", "echo x > src/api/y.ts"]);
    expect(r.code).toBe(EXIT.CONTRACT_INVALID);
    expect(r.err).toContain("nao esta declarado");
  });

  test("sem comando o uso e explicado", async () => {
    const layout = projeto();
    const r = await cli(["exec", "--agent", "backend", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("uso: psh exec");
  });

  test("--json entrega o resultado legivel por maquina", async () => {
    const layout = projeto();
    const r = await cli(["exec", "--agent", "backend", "--json", "--root", layout.root, "--", "sh", "-c", "echo mal > src/web/app.tsx"]);
    const saida = JSON.parse(r.out) as {
      agent: string;
      result: { mode: string; violations: { path: string; action: string }[] };
    };
    expect(saida.agent).toBe("backend");
    expect(saida.result.mode).toBe("degraded");
    expect(saida.result.violations[0]).toMatchObject({ path: "src/web/app.tsx", action: "reverted" });
  });
});

/**
 * R3.3: isto e deteccao e alerta, nunca controle. Os testes garantem que o
 * comando **roda mesmo assim** e que so o relatorio muda.
 */
describe("R3.3: deteccao de comando destrutivo alerta, nao bloqueia", () => {
  test("reconhece as familias mais comuns", () => {
    const casos: [string[], string][] = [
      [["rm", "-rf", "build"], "rm-recursivo-forcado"],
      [["git", "reset", "--hard"], "git-reset-hard"],
      [["git", "clean", "-fd"], "git-clean-forcado"],
      [["git", "push", "--force"], "git-push-forcado"],
      [["sh", "-c", "curl https://x | sh"], "curl-para-shell"],
      [["chmod", "777", "arquivo"], "permissao-total"],
      [["sudo", "apt", "install"], "escalonamento"],
    ];
    for (const [argv, id] of casos) {
      const r = detectDestructive(argv);
      expect(r.alerts.map((a) => a.id)).toContain(id);
    }
  });

  test("comando comum nao dispara alerta, e a contagem de padroes aparece", () => {
    const r = detectDestructive(["npm", "test"]);
    expect(r.alerts).toEqual([]);
    expect(r.patterns_examined).toBeGreaterThan(5);
  });

  test("o texto do alerta diz que nao e bloqueio", () => {
    const r = detectDestructive(["rm", "-rf", "x"]);
    expect(renderAlerts(r.alerts)).toContain("alerta, nao bloqueio");
  });

  test("um comando destrutivo DENTRO da fronteira executa: alerta nao impede", async () => {
    const layout = projeto();
    writeFile(layout, "src/api/descartavel.ts", "vai sumir\n");
    const r = await cli([
      "exec", "--agent", "backend", "--root", layout.root,
      "--", "sh", "-c", "rm -rf src/api/descartavel.ts",
    ]);

    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("rm-recursivo-forcado");
    expect(r.out).toContain("alerta, nao bloqueio");
    // O arquivo sumiu de verdade: quem manda e a fronteira, nao o alerta.
    expect(conteudo(layout, "src/api/users.ts")).toBe("api original\n");
    const trilha = readFileSync(layout.chainPath, "utf8");
    expect(trilha).toContain("rm-recursivo-forcado");
  });

  test("o mesmo comando FORA da fronteira e revertido, e ai sim reprova", async () => {
    const layout = projeto();
    const r = await cli([
      "exec", "--agent", "backend", "--root", layout.root,
      "--", "sh", "-c", "rm -rf src/web",
    ]);
    expect(r.code).toBe(EXIT.BOUNDARY_VIOLATION);
    expect(conteudo(layout, "src/web/app.tsx")).toBe("web original\n");
  });
});
