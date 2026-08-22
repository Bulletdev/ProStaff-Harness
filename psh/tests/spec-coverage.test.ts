import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeSpecCoverage, runSpecCoverage } from "../src/cli/spec-coverage.ts";
import { PshError } from "../src/util/errors.ts";
import { cleanupTempProjects, tempProject, writeFile } from "./helpers.ts";

afterAll(cleanupTempProjects);

describe("spec-coverage e calculado por parse dos artefatos (R2.5, R2.13)", () => {
  test("cobertura total quando toda tarefa referencia um item do SPEC", () => {
    const layout = tempProject({ git: false });
    writeFile(layout, ".harness/SPEC.md", "- SPEC-1 login\n- SPEC-2 logout\n");
    writeFile(layout, ".harness/sprints/S01/t1.md", "implementa SPEC-1\n");
    writeFile(layout, ".harness/sprints/S01/t2.md", "implementa SPEC-2\n");

    const report = computeSpecCoverage({
      root: layout.root,
      spec: ".harness/SPEC.md",
      tasksGlob: ".harness/sprints/**/*.md",
      out: null,
    });
    expect(report.coverage_pct).toBe(100);
    expect(report.uncovered).toEqual([]);
    expect(report.candidates_examined.task_files).toBe(2);
  });

  test("item sem tarefa aparece como descoberto e derruba a porcentagem", () => {
    const layout = tempProject({ git: false });
    writeFile(layout, ".harness/SPEC.md", "- SPEC-1\n- SPEC-2\n- SPEC-3\n");
    writeFile(layout, ".harness/sprints/S01/t1.md", "cobre SPEC-1 e SPEC-3\n");

    const report = computeSpecCoverage({
      root: layout.root,
      spec: ".harness/SPEC.md",
      tasksGlob: ".harness/sprints/**/*.md",
      out: null,
    });
    expect(report.uncovered).toEqual(["SPEC-2"]);
    expect(report.coverage_pct).toBeCloseTo(66.67, 1);
  });

  test("R2.13: SPEC sem nenhum item identificavel e falha de configuracao, nao cobertura limpa", () => {
    const layout = tempProject({ git: false });
    writeFile(layout, ".harness/SPEC.md", "texto sem nenhum identificador de requisito\n");
    writeFile(layout, ".harness/sprints/S01/t1.md", "nada\n");

    expect(() =>
      computeSpecCoverage({
        root: layout.root,
        spec: ".harness/SPEC.md",
        tasksGlob: ".harness/sprints/**/*.md",
        out: null,
      }),
    ).toThrow(PshError);
  });

  test("nenhuma tarefa encontrada deixa a cobertura em zero, com os itens listados", () => {
    const layout = tempProject({ git: false });
    writeFile(layout, ".harness/SPEC.md", "- SPEC-1\n");
    const report = computeSpecCoverage({
      root: layout.root,
      spec: ".harness/SPEC.md",
      tasksGlob: ".harness/sprints/**/*.md",
      out: null,
    });
    expect(report.coverage_pct).toBe(0);
    expect(report.uncovered).toEqual(["SPEC-1"]);
    expect(report.candidates_examined.task_files).toBe(0);
  });

  test("SPEC ausente e erro de contrato", () => {
    const layout = tempProject({ git: false });
    expect(() =>
      computeSpecCoverage({ root: layout.root, spec: ".harness/SPEC.md", tasksGlob: "**/*.md", out: null }),
    ).toThrow(/SPEC ausente/);
  });

  test("o relatorio e gravado quando --out e passado, com o valor que o portao vai ler", () => {
    const layout = tempProject({ git: false });
    writeFile(layout, ".harness/SPEC.md", "- REQ-1\n- REQ-2\n");
    writeFile(layout, ".harness/sprints/S01/t1.md", "cobre REQ-1\n");

    runSpecCoverage({
      root: layout.root,
      spec: ".harness/SPEC.md",
      tasksGlob: ".harness/sprints/**/*.md",
      out: ".harness/evidence/tmp/spec-coverage.json",
    });

    const gravado = JSON.parse(
      readFileSync(join(layout.root, ".harness/evidence/tmp/spec-coverage.json"), "utf8"),
    ) as { coverage_pct: number; spec_items: string[] };
    expect(gravado.spec_items).toEqual(["REQ-1", "REQ-2"]);
    expect(gravado.coverage_pct).toBe(50);
  });
});
