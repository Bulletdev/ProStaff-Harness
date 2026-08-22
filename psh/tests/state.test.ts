import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { initialState, readState, writeState, type State } from "../src/workflow/state.ts";
import { ContractError } from "../src/util/errors.ts";
import { cleanupTempProjects, tempProject } from "./helpers.ts";

afterAll(cleanupTempProjects);

describe("state.json e escrito somente pelo nucleo e sempre validado (R1.3)", () => {
  test("estado inicial de perfil com fases comeca em progresso na fase de entrada", () => {
    const state = initialState("strict", "phase.0.briefing");
    expect(state).toMatchObject({ phase: "phase.0.briefing", attempt: 1, retries_used: 0, status: "in-progress" });
  });

  test("perfil gate-only nasce completo e sem fase", () => {
    expect(initialState("gate-only", null)).toMatchObject({ phase: null, status: "complete" });
  });

  test("ida e volta pelo disco preserva o estado", () => {
    const layout = tempProject({ git: false });
    const escrito = writeState(layout, initialState("lean", "build"));
    expect(readState(layout)).toEqual(escrito);
  });

  test("estado invalido nao chega ao disco", () => {
    const layout = tempProject({ git: false });
    writeState(layout, initialState("lean", "build"));
    const antes = readState(layout);

    const invalido = { ...antes, status: "quase-passou" } as unknown as State;
    expect(() => writeState(layout, invalido)).toThrow(ContractError);
    expect(readState(layout)).toEqual(antes);
  });

  test("status desconhecido gravado por fora e recusado na leitura", () => {
    const layout = tempProject({ git: false });
    writeState(layout, initialState("lean", "build"));
    writeFileSync(
      layout.statePath,
      JSON.stringify({ ...readState(layout), status: "passed-por-agente" }),
    );
    expect(() => readState(layout)).toThrow(ContractError);
  });

  test("campo extra injetado no state.json e recusado", () => {
    const layout = tempProject({ git: false });
    writeState(layout, initialState("lean", "build"));
    writeFileSync(layout.statePath, JSON.stringify({ ...readState(layout), coverage: 99 }));
    expect(() => readState(layout)).toThrow(ContractError);
  });

  test("state.json ausente e erro de contrato com instrucao, nao stack trace", () => {
    const layout = tempProject({ git: false });
    expect(() => readState(layout)).toThrow(/psh init/);
  });
});
