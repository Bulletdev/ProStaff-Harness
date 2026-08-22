import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDoctor, renderDoctor, scanSecrets, type Check } from "../src/cli/doctor.ts";
import { openProject } from "../src/cli/context.ts";
import { resetSandboxCache } from "../src/evidence/sandbox.ts";
import type { WorkflowContract } from "../src/workflow/types.ts";
import { cleanupTempProjects, GIT_AVAILABLE, harnessWith, run, SANDBOX_DE_TESTE, tempProject, writeFile } from "./helpers.ts";

afterAll(cleanupTempProjects);

function acha(checks: Check[], id: string): Check {
  const found = checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`check '${id}' ausente: ${checks.map((c) => c.id).join(", ")}`);
  return found;
}

function projeto(over: Partial<WorkflowContract> = {}, opts: { git?: boolean } = {}) {
  const layout = tempProject({ git: opts.git });
  writeFile(layout, "src/a.ts", "export const a = 1;\n");
  const contrato: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
    profile: "lean",
    verifiers: [
      {
        id: "tests",
        run: ["sh", "-c", "exit 0"],
        extract: { kind: "exit-code" },
        watch: ["src/**"],
        timeout_s: 30,
      },
    ],
    phases: [
      {
        id: "build",
        name: "Build",
        terminal: true,
        next: [],
        gate: {
          type: "all-of",
          checks: [{ kind: "verifier-status", verifier: "tests" }],
          on_fail: { action: "block", message: "-" },
        },
        on_failure: { class: "quality", max_auto_retries: 0 },
      },
    ],
    ...over,
  };
  harnessWith(layout, contrato).close();
  writeFileSync(join(layout.harness, ".gitignore"), "harness.db\nevidence/\naudit/\n");
  writeFile(
    layout,
    ".harness/boundary.json",
    JSON.stringify({
      _type: "psh-boundary",
      version: 1,
      default_agent: "backend",
      agents: { backend: { write: ["src/**"] } },
    }),
  );
  return layout;
}

describe("psh doctor (R10.2, R10.2b)", () => {
  test("sem ai-jail o diagnostico declara modo degradado como aviso, nao como silencio", () => {
    process.env.PSH_SANDBOX = "off";
    resetSandboxCache();
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      const report = runDoctor(ctx);
      expect(acha(report.checks, "sandbox").level).toBe("warn");
      expect(acha(report.checks, "sandbox").message).toContain("DEGRADADO");
      expect(acha(report.checks, "boundary").message).toContain("modo degradado");
      expect(acha(report.checks, "boundary").detail).toContain("revertida");
      expect(renderDoctor(report)).toContain("avisos");
    } finally {
      ctx.close();
      // Volta ao padrao da suite em vez de apagar: apagar faria os arquivos
      // seguintes herdarem o ai-jail da maquina e reprovarem sem motivo.
      process.env.PSH_SANDBOX = SANDBOX_DE_TESTE;
      resetSandboxCache();
    }
  });

  test("verificador consultado por um portao com comando ausente e falha", () => {
    const layout = projeto({
      verifiers: [
        {
          id: "tests",
          run: ["ferramenta-que-nao-existe-psh"],
          extract: { kind: "exit-code" },
          watch: ["src/**"],
          timeout_s: 30,
        },
      ],
    });
    const ctx = openProject(layout.root);
    try {
      const report = runDoctor(ctx);
      expect(acha(report.checks, "verifier:tests").level).toBe("fail");
      expect(report.failed).toBeGreaterThan(0);
    } finally {
      ctx.close();
    }
  });

  test("caminho absoluto de outra maquina no contrato e falha", () => {
    const layout = projeto({
      verifiers: [
        {
          id: "tests",
          run: ["/opt/maquina-de-outra-pessoa/bin/tests"],
          extract: { kind: "exit-code" },
          watch: ["src/**"],
          timeout_s: 30,
        },
      ],
    });
    const ctx = openProject(layout.root);
    try {
      expect(acha(runDoctor(ctx).checks, "abs-paths").level).toBe("fail");
    } finally {
      ctx.close();
    }
  });

  test("G5/R10.5: a varredura acha chave literal e marcador de credencial", () => {
    const layout = projeto();
    writeFile(layout, "config.env", "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123\n");
    writeFile(layout, "deploy.sh", "export AWS_ID=AKIAIOSFODNN7EXAMPLE\n");
    writeFile(layout, "ok.env", "API_KEY=$FROM_ENVIRONMENT\n");
    writeFile(layout, "id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");

    const scan = scanSecrets(layout.root, ["config.env", "deploy.sh", "ok.env", "id_rsa", "sumiu.txt"]);
    expect(scan.examined).toBe(4);
    expect(scan.hits.join("\n")).toContain("config.env");
    expect(scan.hits.join("\n")).toContain("deploy.sh");
    expect(scan.hits.join("\n")).toContain("id_rsa");
    // Referencia a variavel de ambiente nao e segredo versionado.
    expect(scan.hits.join("\n")).not.toContain("ok.env");
  });

  // Sem Git o teste nao exercita nada; declarar 'skip' e honesto, passar nao e.
  test.skipIf(!GIT_AVAILABLE)("G5/R10.5: com Git disponivel, segredo rastreado reprova o diagnostico", () => {
    const layout = projeto();
    writeFile(layout, "config.env", "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123\n");
    run("git", ["add", "-A"], layout.root);

    const ctx = openProject(layout.root);
    try {
      const secrets = acha(runDoctor(ctx).checks, "secrets");
      expect(secrets.level).toBe("fail");
      expect(secrets.message).toContain("arquivos examinados");
      expect(secrets.detail).toContain("config.env");
    } finally {
      ctx.close();
    }
  });

  test("projeto fora do Git enumera por caminhada, e isso e resultado normal", () => {
    const layout = projeto({}, { git: false });
    const ctx = openProject(layout.root);
    try {
      const enumeracao = acha(runDoctor(ctx).checks, "workspace-enum");
      expect(enumeracao.level).toBe("ok");
      expect(enumeracao.message).toContain("caminhada");
    } finally {
      ctx.close();
    }
  });

  test("R2.4: '.git/' presente sem repositorio utilizavel e falha declarada, nao fallback silencioso", () => {
    // `.git` vazio nao e repositorio valido. O cenario precisa valer nos dois
    // ambientes: onde o git existe (ele recusa o diretorio) e onde nem existe
    // (o spawn falha). Amarrar o teste a um dos dois faz ele passar por acaso.
    const layout = projeto({}, { git: false });
    mkdirSync(join(layout.root, ".git"), { recursive: true });
    const ctx = openProject(layout.root);
    try {
      const enumeracao = acha(runDoctor(ctx).checks, "workspace-enum");
      expect(enumeracao.level).toBe("fail");
      expect(enumeracao.detail).toContain(".gitignore");
    } finally {
      ctx.close();
    }
  });

  test.skipIf(!GIT_AVAILABLE)("repositorio Git valido enumera por git, respeitando .gitignore", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      const enumeracao = acha(runDoctor(ctx).checks, "workspace-enum");
      expect(enumeracao.level).toBe("ok");
      expect(enumeracao.message).toContain("git");
    } finally {
      ctx.close();
    }
  });

  test("R2.13: projeto sem arquivo versionado nao reporta 'limpo', reporta falta de candidato", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      const secrets = acha(runDoctor(ctx).checks, "secrets");
      expect(secrets.level).toBe("warn");
      expect(secrets.detail).toContain("nao tem candidato");
    } finally {
      ctx.close();
    }
  });

  test("cadeia de auditoria adulterada aparece como falha no diagnostico", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      ctx.chain.append("audit.note", "core:psh", { a: 1 });
      ctx.chain.append("audit.note", "core:psh", { b: 2 });
      const linhas = readFileSync(layout.chainPath, "utf8");
      writeFileSync(layout.chainPath, linhas.split("\n").slice(1).join("\n"));
      const audit = acha(runDoctor(ctx).checks, "audit");
      expect(audit.level).toBe("fail");
    } finally {
      ctx.close();
    }
  });

  test(".harness/.gitignore incompleto vira aviso", () => {
    const layout = projeto();
    writeFileSync(join(layout.harness, ".gitignore"), "harness.db\n");
    const ctx = openProject(layout.root);
    try {
      expect(acha(runDoctor(ctx).checks, "evidence-ignore").level).toBe("warn");
    } finally {
      ctx.close();
    }
  });

  test(".harness/.gitignore ausente tambem vira aviso", () => {
    const layout = projeto();
    rmSync(join(layout.harness, ".gitignore"));
    const ctx = openProject(layout.root);
    try {
      expect(acha(runDoctor(ctx).checks, "evidence-ignore").message).toContain("ausente");
    } finally {
      ctx.close();
    }
  });

  test("arquivo declarado em portao de presenca que ainda nao existe e reportado", () => {
    const layout = projeto({
      phases: [
        {
          id: "build",
          name: "Build",
          terminal: true,
          next: [],
          gate: {
            type: "all-of",
            checks: [{ kind: "presence", file: "docs/ARQUITETURA.md", min_lines: 10 }],
            on_fail: { action: "block", message: "-" },
          },
          on_failure: { class: "quality", max_auto_retries: 0 },
        },
      ],
    });
    const ctx = openProject(layout.root);
    try {
      const report = runDoctor(ctx);
      expect(acha(report.checks, "declared:docs/ARQUITETURA.md").level).toBe("warn");
      expect(acha(report.checks, "declared").message).toContain("1 arquivos declarados examinados");
    } finally {
      ctx.close();
    }
  });
});
