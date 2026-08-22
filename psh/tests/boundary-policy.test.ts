import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoundaryPolicy, DENY_ALWAYS, loadBoundary, type BoundaryContract } from "../src/boundary/policy.ts";
import { ContractError } from "../src/util/errors.ts";
import { cleanupTempProjects, tempProject, writeFile } from "./helpers.ts";
import type { Layout } from "../src/util/paths.ts";

afterAll(cleanupTempProjects);

const CONTRATO: BoundaryContract = {
  _type: "psh-boundary",
  version: 1,
  default_agent: "backend",
  agents: {
    backend: {
      description: "so a API",
      write: ["src/api/**", "spec/api/**"],
      deny: ["src/api/secrets/**"],
    },
    frontend: { write: ["src/web/**"] },
    leitor: { write: [] },
  },
};

function politica(layout: Layout, contrato: BoundaryContract = CONTRATO): BoundaryPolicy {
  // Diretorio de instalacao fixo no teste, para nao depender de onde o bun mora.
  return new BoundaryPolicy(contrato, layout, [join(layout.root, "vendor", "psh-install")]);
}

function projeto(): Layout {
  const layout = tempProject({ git: false });
  writeFile(layout, "src/api/users.ts", "export const a = 1;\n");
  writeFile(layout, "src/web/app.tsx", "export const b = 2;\n");
  writeFile(layout, "vendor/psh-install/psh", "binario\n");
  return layout;
}

describe("fronteira de escrita por agente (R3.1, aceite da v0.2)", () => {
  test("o agente escreve dentro do proprio escopo", () => {
    const p = politica(projeto());
    const d = p.canWrite("backend", "src/api/users.ts");
    expect(d.allowed).toBe(true);
    expect(d.rule).toEqual({ kind: "agent-write", pattern: "src/api/**" });
  });

  test("agente restrito a src/api nao escreve em src/web", () => {
    const p = politica(projeto());
    const d = p.canWrite("backend", "src/web/app.tsx");
    expect(d.allowed).toBe(false);
    expect(d.rule.kind).toBe("no-match");
    expect(d.reason).toContain("fora da fronteira de escrita");
  });

  test("arquivo que ainda nao existe segue a mesma regra", () => {
    const p = politica(projeto());
    expect(p.canWrite("backend", "src/api/novo.ts").allowed).toBe(true);
    expect(p.canWrite("backend", "src/web/novo.tsx").allowed).toBe(false);
  });

  test("deny do agente tem precedencia sobre a propria allowlist", () => {
    const p = politica(projeto());
    const d = p.canWrite("backend", "src/api/secrets/token.ts");
    expect(d.allowed).toBe(false);
    expect(d.rule).toEqual({ kind: "agent-deny", pattern: "src/api/secrets/**" });
  });

  test("agente com allowlist vazia nao escreve em lugar nenhum", () => {
    const p = politica(projeto());
    expect(p.canWrite("leitor", "src/api/users.ts").allowed).toBe(false);
    expect(p.canWrite("leitor", "qualquer.txt").allowed).toBe(false);
  });

  test("agente nao declarado bloqueia, em vez de virar curinga", () => {
    const p = politica(projeto());
    const d = p.canWrite("fantasma", "src/api/users.ts");
    expect(d.allowed).toBe(false);
    expect(d.rule).toEqual({ kind: "unknown-agent", agent: "fantasma" });
  });

  test("caminho absoluto e caminho relativo levam a mesma decisao", () => {
    const layout = projeto();
    const p = politica(layout);
    expect(p.canWrite("backend", join(layout.root, "src/api/x.ts")).allowed).toBe(true);
    expect(p.canWrite("backend", join(layout.root, "src/web/x.tsx")).allowed).toBe(false);
  });

  test("subir de mais com .. sai do projeto e e recusado", () => {
    const p = politica(projeto());
    const d = p.canWrite("backend", "src/api/../../../fora.txt");
    expect(d.allowed).toBe(false);
    expect(d.rule.kind).toBe("outside-project");
  });

  test("subir e voltar continua dentro, e a allowlist e que decide", () => {
    const p = politica(projeto());
    // src/api/../../ volta para a raiz: esta dentro, mas fora do escopo.
    expect(p.canWrite("backend", "src/api/../../fora.txt").rule.kind).toBe("no-match");
    // E o caminho tortuoso nao ganha nada em relacao ao direto.
    expect(p.canWrite("backend", "src/web/../api/x.ts").allowed).toBe(true);
  });

  test("caminho fora da raiz do projeto e recusado", () => {
    const p = politica(projeto());
    expect(p.canWrite("backend", "/etc/passwd").allowed).toBe(false);
    expect(p.canWrite("backend", "/tmp/qualquer.txt").allowed).toBe(false);
  });
});

describe("R11.2 caso 5: artefato que decide portao e inalcancavel por agente", () => {
  const alvos = [
    ".harness/evidence/phase.5.build/1/coverage.json",
    ".harness/reviews/prd.review.json",
    ".harness/state.json",
    ".harness/boundary.json",
    ".harness/workflow.json",
    ".harness/harness.db",
    ".harness/audit/chain.jsonl",
    ".harness/approvals/abc.json",
  ];

  test.each(alvos)("agente nao escreve em %s", (alvo) => {
    const p = politica(projeto());
    const d = p.canWrite("backend", alvo);
    expect(d.allowed).toBe(false);
    expect(d.rule.kind).toBe("deny-always");
  });

  test("nem mesmo uma allowlist que pede explicitamente libera", () => {
    const guloso: BoundaryContract = {
      _type: "psh-boundary",
      version: 1,
      agents: { guloso: { write: ["**", ".harness/**", ".harness/evidence/**"] } },
    };
    const p = politica(projeto(), guloso);
    for (const alvo of alvos) {
      const d = p.canWrite("guloso", alvo);
      expect(d.allowed).toBe(false);
      expect(d.rule.kind).toBe("deny-always");
    }
    // O curinga continua valendo para o que nao esta no deny duro.
    expect(p.canWrite("guloso", "src/api/x.ts").allowed).toBe(true);
  });

  test("o deny duro cobre o diretorio, nao so os arquivos dentro dele", () => {
    const p = politica(projeto());
    expect(p.canWrite("backend", ".harness/evidence").allowed).toBe(false);
    expect(p.canWrite("backend", ".git").allowed).toBe(false);
  });

  test("o deny duro esta no binario, nao no arquivo de allowlist", () => {
    // Se estivesse no arquivo, bastaria editar o arquivo para removê-lo, e o
    // arquivo e justamente um dos caminhos protegidos.
    expect(DENY_ALWAYS).toContain(".harness/evidence/**");
    expect(DENY_ALWAYS).toContain(".harness/boundary.json");
    const p = politica(projeto());
    expect(JSON.stringify(p.contract)).not.toContain("deny_always");
  });
});

describe("R11.2 caso 6: agente nao altera o mecanismo que o restringe", () => {
  test("o diretorio de instalacao do harness e somente leitura (R3.5b)", () => {
    const layout = projeto();
    const p = politica(layout);
    for (const alvo of ["vendor/psh-install/psh", "vendor/psh-install/perfis/strict.json"]) {
      const d = p.canWrite("backend", alvo);
      expect(d.allowed).toBe(false);
      expect(d.rule.kind).toBe("install-dir");
      expect(d.reason).toContain("nunca reescreve o mecanismo");
    }
  });

  test("a allowlist do projeto nao e gravavel nem pelo agente mais permissivo (R3.6)", () => {
    const total: BoundaryContract = {
      _type: "psh-boundary",
      version: 1,
      agents: { tudo: { write: ["**"] } },
    };
    const p = politica(projeto(), total);
    expect(p.canWrite("tudo", ".harness/boundary.json").allowed).toBe(false);
  });
});

describe("R11.2 caso 2: symlink e caixa alterada", () => {
  test("symlink dentro do escopo apontando para fora nao vira porta de saida", () => {
    const layout = projeto();
    mkdirSync(join(layout.root, "src", "api"), { recursive: true });
    const fora = join(layout.root, "..", `fuga-${process.pid}`);
    mkdirSync(fora, { recursive: true });
    writeFileSync(join(fora, "alvo.txt"), "fora\n");
    symlinkSync(fora, join(layout.root, "src", "api", "atalho"));

    const p = politica(layout);
    const d = p.canWrite("backend", "src/api/atalho/alvo.txt");
    expect(d.allowed).toBe(false);
    expect(d.rule.kind).toBe("outside-project");
  });

  test("symlink que aponta para o proprio escopo continua valendo", () => {
    const layout = projeto();
    mkdirSync(join(layout.root, "src", "api", "interno"), { recursive: true });
    symlinkSync(join(layout.root, "src", "api", "interno"), join(layout.root, "src", "api", "atalho-ok"));
    const p = politica(layout);
    expect(p.canWrite("backend", "src/api/atalho-ok/x.ts").allowed).toBe(true);
  });

  test("symlink para dentro de .harness/evidence continua bloqueado", () => {
    const layout = projeto();
    mkdirSync(join(layout.root, ".harness", "evidence"), { recursive: true });
    mkdirSync(join(layout.root, "src", "api"), { recursive: true });
    symlinkSync(join(layout.root, ".harness", "evidence"), join(layout.root, "src", "api", "ev"));
    const p = politica(layout);
    expect(p.canWrite("backend", "src/api/ev/coverage.json").allowed).toBe(false);
  });
});

describe("R11.2 caso 9: allowlist ausente, vazia e corrompida bloqueiam", () => {
  test("ausente e erro de contrato, nao permissao total", () => {
    const layout = tempProject({ git: false });
    expect(() => loadBoundary(layout)).toThrow(ContractError);
    expect(() => loadBoundary(layout)).toThrow(/bloqueia toda escrita/);
  });

  test("JSON corrompido e erro de contrato", () => {
    const layout = tempProject({ git: false });
    writeFile(layout, ".harness/boundary.json", "{ isso nao e json");
    expect(() => loadBoundary(layout)).toThrow(ContractError);
  });

  test("estrutura invalida e recusada pelo schema", () => {
    const layout = tempProject({ git: false });
    writeFile(layout, ".harness/boundary.json", JSON.stringify({ _type: "psh-boundary", version: 1 }));
    expect(() => loadBoundary(layout)).toThrow(/agents/);
  });

  test("agents vazio e recusado: sem agente declarado nao ha escrita", () => {
    const layout = tempProject({ git: false });
    writeFile(
      layout,
      ".harness/boundary.json",
      JSON.stringify({ _type: "psh-boundary", version: 1, agents: {} }),
    );
    expect(() => loadBoundary(layout)).toThrow(ContractError);
  });

  test("default_agent apontando para agente inexistente e recusado", () => {
    const layout = tempProject({ git: false });
    writeFile(
      layout,
      ".harness/boundary.json",
      JSON.stringify({
        _type: "psh-boundary",
        version: 1,
        default_agent: "fantasma",
        agents: { real: { write: ["src/**"] } },
      }),
    );
    expect(() => loadBoundary(layout)).toThrow(/fantasma/);
  });

  test("contrato valido carrega e expoe os agentes", () => {
    const layout = tempProject({ git: false });
    writeFile(layout, ".harness/boundary.json", JSON.stringify(CONTRATO));
    const p = loadBoundary(layout, [join(layout.root, "vendor")]);
    expect(p.agentIds).toEqual(["backend", "frontend", "leitor"]);
    expect(p.defaultAgent).toBe("backend");
    expect(p.agent("backend")?.network).toBe(false);
  });
});
