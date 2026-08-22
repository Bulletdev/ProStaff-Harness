import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/index.ts";
import { captureIo } from "../src/cli/io.ts";
import { EXIT } from "../src/util/errors.ts";
import { PSH_VERSION } from "../src/version.ts";
import { flagString, parseArgs, rejectUnknownFlags } from "../src/cli/args.ts";
import { PshError } from "../src/util/errors.ts";
import type { WorkflowContract } from "../src/workflow/types.ts";
import { cleanupTempProjects, harnessWith, tempProject, writeFile, LCOV_87, LCOV_50 } from "./helpers.ts";

afterAll(cleanupTempProjects);

let restaurar: (() => void) | null = null;
afterEach(() => {
  restaurar?.();
  restaurar = null;
});

/** Roda a CLI no proprio processo, capturando saida: e assim que ela entra na medicao de cobertura. */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const cap = captureIo();
  restaurar = cap.restore;
  const code = await runCli(argv);
  cap.restore();
  restaurar = null;
  return { code, out: cap.out.join(""), err: cap.err.join("") };
}

const CONTRATO: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
  profile: "lean",
  verifiers: [
    {
      id: "coverage",
      run: ["sh", "-c", "mkdir -p coverage && cp fixture.info coverage/lcov.info"],
      extract: { kind: "lcov", file: "coverage/lcov.info", metric: "lines.pct" },
      watch: ["src/**"],
      timeout_s: 60,
    },
  ],
  phases: [
    {
      id: "build",
      name: "Build",
      terminal: false,
      next: ["fim"],
      gate: {
        type: "all-of",
        checks: [{ kind: "verifier", verifier: "coverage", min: 85 }],
        on_fail: { action: "rework", loopback_to: "build", message: "cobertura abaixo do minimo" },
      },
      on_failure: { class: "quality", max_auto_retries: 1, loopback_to: "build" },
    },
    {
      id: "fim",
      name: "Fim",
      terminal: true,
      next: [],
      gate: { type: "none", checks: [], on_fail: { action: "block", message: "-" } },
      on_failure: { class: "quality", max_auto_retries: 0 },
    },
  ],
};

function projeto(lcov = LCOV_87) {
  const layout = tempProject();
  writeFile(layout, "src/a.ts", "export const a = 1;\n");
  writeFile(layout, "fixture.info", lcov);
  harnessWith(layout, CONTRATO).close();
  return layout;
}

describe("ajuda, versao e comando desconhecido", () => {
  test("sem argumento imprime uso e sai limpo", async () => {
    const r = await cli([]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("psh init");
    expect(r.out).toContain("Nenhum comando aceita metrica como argumento");
  });

  test("help e --help imprimem o mesmo uso", async () => {
    expect((await cli(["help"])).out).toBe((await cli(["--help"])).out);
  });

  test("--version imprime so a versao", async () => {
    expect((await cli(["--version"])).out.trim()).toBe(PSH_VERSION);
    expect((await cli(["version"])).out.trim()).toBe(PSH_VERSION);
  });

  test("comando desconhecido sai com falha e mostra o uso", async () => {
    const r = await cli(["deploy"]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("comando desconhecido: deploy");
  });
});

describe("init pela CLI", () => {
  test("--dry-run nao escreve nada", async () => {
    const layout = tempProject({ git: false });
    writeFile(layout, "package.json", "{}\n");
    const antes = existsSync(layout.workflowPath);
    const r = await cli(["init", "--profile", "lean", "--dry-run", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("nada foi escrito");
    expect(existsSync(layout.workflowPath)).toBe(antes);
  });

  test("--json entrega o plano legivel por maquina", async () => {
    const layout = tempProject({ git: false });
    writeFile(layout, "Gemfile", "source 'x'\n");
    const r = await cli(["init", "--profile", "strict", "--dry-run", "--json", "--root", layout.root]);
    const plano = JSON.parse(r.out) as { stack: string; checks_examined: number; profile: string };
    expect(plano.stack).toBe("ruby");
    expect(plano.profile).toBe("strict");
    expect(plano.checks_examined).toBeGreaterThan(0);
  });

  test("perfil desconhecido e erro de contrato", async () => {
    const layout = tempProject({ git: false });
    const r = await cli(["init", "--profile", "turbo", "--yes", "--root", layout.root]);
    expect(r.code).toBe(EXIT.CONTRACT_INVALID);
    expect(r.err).toContain("perfil desconhecido");
  });

  test("init duas vezes preserva o anterior em backup", async () => {
    const layout = tempProject({ git: false });
    writeFile(layout, "package.json", "{}\n");
    await cli(["init", "--profile", "lean", "--yes", "--root", layout.root]);
    await cli(["init", "--profile", "strict", "--yes", "--root", layout.root]);

    const backups = readFileSync(layout.workflowPath, "utf8");
    expect(JSON.parse(backups).profile).toBe("strict");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(layout.harness).some((f) => f.includes(".bak-"))).toBe(true);
  });

  test("workflow.json que nao e contrato psh bloqueia o init em vez de sobrescrever", async () => {
    const layout = tempProject({ git: false });
    writeFile(layout, ".harness/workflow.json", '{"_type":"harness-state-machine-v6"}\n');
    const r = await cli(["init", "--yes", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("Mova o arquivo");
  });
});

describe("ciclo verify/status/advance pela CLI", () => {
  test("verify --json descreve os registros gravados", async () => {
    const layout = projeto();
    const r = await cli(["verify", "--json", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    const saida = JSON.parse(r.out) as { records: { verifier: string; value: number; enumeration: string }[] };
    expect(saida.records[0]!.verifier).toBe("coverage");
    expect(saida.records[0]!.value).toBeCloseTo(87, 5);
    expect(["git", "walk", "walk-fallback"]).toContain(saida.records[0]!.enumeration);
  });

  test("verify nomeando verificador inexistente e erro de contrato", async () => {
    const layout = projeto();
    const r = await cli(["verify", "fantasma", "--root", layout.root]);
    expect(r.code).toBe(EXIT.CONTRACT_INVALID);
    expect(r.err).toContain("nao esta declarado");
  });

  test("verify --all roda tudo que o contrato declara", async () => {
    const layout = projeto();
    const r = await cli(["verify", "--all", "--json", "--root", layout.root]);
    const saida = JSON.parse(r.out) as { records: unknown[]; considered: number };
    expect(saida.records).toHaveLength(saida.considered);
  });

  test("status sai com codigo de portao quando o portao esta reprovado", async () => {
    const layout = projeto();
    const r = await cli(["status", "--root", layout.root]);
    expect(r.code).toBe(EXIT.GATE_FAILED);
    expect(r.out).toContain("portao all-of: REPROVADO");
    expect(r.out).toContain("MODO DEGRADADO");
  });

  test("advance com evidencia boa avanca e o historico registra", async () => {
    const layout = projeto();
    await cli(["verify", "--root", layout.root]);
    const r = await cli(["advance", "--json", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    const saida = JSON.parse(r.out) as { decision: string; state: { history: { verdict: string }[] } };
    expect(saida.decision).toBe("advanced");
    expect(saida.state.history.at(-1)!.verdict).toBe("passed");
  });

  test("advance com cobertura baixa devolve rework e mensagem do check reprovado", async () => {
    const layout = projeto(LCOV_50);
    await cli(["verify", "--root", layout.root]);
    const r = await cli(["advance", "--root", layout.root]);
    expect(r.code).toBe(EXIT.GATE_FAILED);
    expect(r.out).toContain("REWORK");
    expect(r.out).toContain("abaixo do minimo 85");
  });

  test("--force sem TTY e recusado em vez de passar calado", async () => {
    const layout = projeto(LCOV_50);
    await cli(["verify", "--root", layout.root]);
    const r = await cli(["advance", "--force", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("terminal");
  });

  test("--force --yes registra override permanente, nunca 'passed'", async () => {
    const layout = projeto(LCOV_50);
    await cli(["verify", "--root", layout.root]);
    const r = await cli(["advance", "--force", "--yes", "--reason", "prazo", "--json", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    const saida = JSON.parse(r.out) as { decision: string; state: { history: { verdict: string }[] } };
    expect(saida.decision).toBe("override");
    expect(saida.state.history.map((h) => h.verdict)).toContain("passed-with-override");
    expect(saida.state.history.map((h) => h.verdict)).not.toContain("passed");
  });
});

describe("approve e audit pela CLI", () => {
  test("approve grava aprovacao amarrada ao hash do arquivo", async () => {
    const layout = projeto();
    writeFile(layout, "brief.md", "conteudo do brief\n");
    const r = await cli(["approve", "brief.md", "--as", "michael", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("michael");

    const trilha = readFileSync(layout.chainPath, "utf8");
    expect(trilha).toContain("human.approval");
    expect(trilha).toContain("sha256:");
  });

  test("approve sem assunto explica o uso", async () => {
    const layout = projeto();
    const r = await cli(["approve", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("uso: psh approve");
  });

  test("audit log mostra as entradas em ordem", async () => {
    const layout = projeto();
    await cli(["verify", "--root", layout.root]);
    await cli(["advance", "--root", layout.root]);
    const r = await cli(["audit", "log", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("verifier.run");
    expect(r.out).toContain("phase.transition");
  });

  test("audit log --json e --n limitam e estruturam", async () => {
    const layout = projeto();
    await cli(["verify", "--root", layout.root]);
    await cli(["advance", "--root", layout.root]);
    const r = await cli(["audit", "log", "--json", "--n", "1", "--root", layout.root]);
    const entradas = JSON.parse(r.out) as { seq: number; hash: string }[];
    expect(entradas).toHaveLength(1);
    expect(entradas[0]!.hash).toStartWith("sha256:");
  });

  test("subcomando de audit desconhecido e recusado", async () => {
    const layout = projeto();
    const r = await cli(["audit", "limpar", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("subcomando desconhecido");
  });
});

describe("doctor e internal pela CLI", () => {
  test("doctor --json entrega o dump colavel em issue", async () => {
    const layout = projeto();
    const r = await cli(["doctor", "--json", "--root", layout.root]);
    const report = JSON.parse(r.out) as { psh_version: string; checks: { id: string }[] };
    expect(report.psh_version).toBe(PSH_VERSION);
    expect(report.checks.map((c) => c.id)).toContain("boundary");
    expect(report.checks.map((c) => c.id)).toContain("workspace-enum");
  });

  test("internal spec-coverage sem argumento obrigatorio explica o uso", async () => {
    const layout = projeto();
    const r = await cli(["internal", "spec-coverage", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("uso: psh internal spec-coverage");
  });

  test("internal desconhecido e recusado", async () => {
    const r = await cli(["internal", "limpar-tudo"]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("subcomando interno desconhecido");
  });

  test("internal spec-coverage grava o relatorio que o portao vai ler", async () => {
    const layout = projeto();
    writeFile(layout, ".harness/SPEC.md", "- REQ-1\n- REQ-2\n");
    writeFile(layout, ".harness/sprints/t1.md", "cobre REQ-1\n");
    const r = await cli([
      "internal", "spec-coverage",
      "--spec", ".harness/SPEC.md",
      "--tasks", ".harness/sprints/**/*.md",
      "--out", ".harness/evidence/tmp/sc.json",
      "--root", layout.root,
    ]);
    expect(r.code).toBe(EXIT.OK);
    const gravado = JSON.parse(readFileSync(join(layout.root, ".harness/evidence/tmp/sc.json"), "utf8"));
    expect(gravado.coverage_pct).toBe(50);
  });

  test("adapter ci roda em processo e devolve o relatorio", async () => {
    const layout = projeto();
    const r = await cli(["adapter", "ci", "--json", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out)._type).toBe("psh-ci-report");
  });
});

describe("parser de argumento", () => {
  test("--chave=valor e --chave valor", () => {
    const a = parseArgs(["--a=1", "--b", "2", "pos"]);
    expect(a.flags.get("a")).toBe("1");
    expect(a.flags.get("b")).toBe("2");
    expect(a.positional).toEqual(["pos"]);
  });

  test("flag booleana nao engole o token seguinte", () => {
    const a = parseArgs(["--json", "log", "--n", "5"]);
    expect(a.flags.get("json")).toBe(true);
    expect(a.flags.get("n")).toBe("5");
    expect(a.positional).toEqual(["log"]);
  });

  test("booleana no fim tambem fica true", () => {
    expect(parseArgs(["--force"]).flags.get("force")).toBe(true);
    expect(parseArgs(["--yes", "--json"]).flags.get("yes")).toBe(true);
  });

  test("-- encerra o parsing e o resto vira posicional", () => {
    const a = parseArgs(["--a", "1", "--", "--nao-e-flag", "x"]);
    expect(a.positional).toEqual(["--nao-e-flag", "x"]);
  });

  test("flag que exige valor recusa forma booleana", () => {
    const a = parseArgs(["--reason"]);
    expect(() => flagString(a, "reason")).toThrow(PshError);
    expect(flagString(a, "ausente")).toBeNull();
  });

  test("flag desconhecida lista as conhecidas", () => {
    const a = parseArgs(["--turbo"]);
    expect(() => rejectUnknownFlags(a, ["json", "root"], "verify")).toThrow(/--json/);
  });
});

describe("ordem de flag e subcomando (regressao do parser)", () => {
  test("audit --json log continua sendo 'log', nao cai no default 'verify'", async () => {
    const layout = projeto();
    await cli(["verify", "--root", layout.root]);
    const r = await cli(["audit", "--json", "log", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    const saida = JSON.parse(r.out) as unknown[];
    expect(Array.isArray(saida)).toBe(true);
    expect((saida[0] as { seq: number }).seq).toBe(1);
  });

  test("adapter --json ci continua sendo o adapter ci", async () => {
    const layout = projeto();
    const r = await cli(["adapter", "--json", "ci", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out)._type).toBe("psh-ci-report");
  });

  test("verify --all coverage nomeia o verificador em vez de virar valor da flag", async () => {
    const layout = projeto();
    const r = await cli(["verify", "--all", "coverage", "--json", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    const saida = JSON.parse(r.out) as { records: { verifier: string }[] };
    expect(saida.records.map((x) => x.verifier)).toEqual(["coverage"]);
  });
});
