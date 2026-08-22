import { existsSync } from "node:fs";
import type { Layout } from "../util/paths.ts";
import { ContractError } from "../util/errors.ts";
import { readJsonFile, writeJsonAtomic } from "../util/json.ts";
import { formatAjvErrors, validateStateSchema } from "./load.ts";
import type { ProfileName } from "./types.ts";

export type StateStatus =
  | "in-progress"
  | "blocked"
  | "escalated"
  | "passed"
  | "passed-with-override"
  | "complete";

export type HistoryVerdict = "passed" | "passed-with-override" | "failed" | "escalated" | "blocked";

export interface HistoryEntry {
  phase: string;
  attempt: number;
  verdict: HistoryVerdict;
  event_id?: string;
  at: string;
}

export interface State {
  _type: "psh-state";
  version: 1;
  profile: ProfileName;
  phase: string | null;
  attempt: number;
  retries_used: number;
  status: StateStatus;
  sprint?: string | null;
  sandbox_mode?: "ai-jail" | "inherited" | "degraded";
  updated_at: string;
  history: HistoryEntry[];
}

export function initialState(profile: ProfileName, phase: string | null, now = new Date()): State {
  return {
    _type: "psh-state",
    version: 1,
    profile,
    phase,
    attempt: 1,
    retries_used: 0,
    status: profile === "gate-only" ? "complete" : "in-progress",
    sprint: null,
    updated_at: now.toISOString(),
    history: [],
  };
}

export function readState(layout: Layout): State {
  if (!existsSync(layout.statePath)) {
    throw new ContractError(`state.json ausente em ${layout.statePath}. Rode 'psh init'.`, {
      path: layout.statePath,
    });
  }
  const raw = readJsonFile(layout.statePath);
  if (!validateStateSchema(raw)) {
    throw new ContractError(
      `state.json invalido:\n  - ${formatAjvErrors(validateStateSchema.errors).join("\n  - ")}`,
      { path: layout.statePath },
    );
  }
  return raw as State;
}

/**
 * R1.3: somente o nucleo escreve `state.json`. Esta funcao e a unica porta de
 * escrita do arquivo em todo o codigo, e valida contra o schema antes de gravar
 * para que um estado impossivel nao chegue ao disco.
 */
export function writeState(layout: Layout, state: State): State {
  if (!validateStateSchema(state)) {
    throw new ContractError(
      `recusando gravar state.json invalido:\n  - ${formatAjvErrors(validateStateSchema.errors).join("\n  - ")}`,
      { path: layout.statePath },
    );
  }
  writeJsonAtomic(layout.statePath, state);
  return state;
}

export function appendHistory(state: State, entry: HistoryEntry): State {
  return { ...state, history: [...state.history, entry] };
}
