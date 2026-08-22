import { existsSync } from "node:fs";
import { AuditChain } from "../audit/chain.ts";
import { ContractError } from "../util/errors.ts";
import { HarnessDb } from "../db/index.ts";
import { loadWorkflow } from "../workflow/load.ts";
import type { Workflow } from "../workflow/types.ts";
import { readState, type State } from "../workflow/state.ts";
import { requireLayout, type Layout } from "../util/paths.ts";

export interface ProjectContext {
  layout: Layout;
  workflow: Workflow;
  db: HarnessDb;
  chain: AuditChain;
  state: State;
  close(): void;
}

export function openProject(start?: string): ProjectContext {
  const layout = requireLayout(start);
  if (!existsSync(layout.workflowPath)) {
    throw new ContractError(
      `${layout.workflowPath} nao existe: o diretorio .harness/ esta presente mas o contrato nao. Rode 'psh init'.`,
      { path: layout.workflowPath },
    );
  }
  const workflow = loadWorkflow(layout.workflowPath);
  const db = new HarnessDb(layout.dbPath);
  const chain = new AuditChain(layout.chainPath, { anchor: db });
  const state = readState(layout);
  return { layout, workflow, db, chain, state, close: () => db.close() };
}

/** Tentativa corrente da fase, sempre lida do disco (R1.5 / R1.7). */
export function currentAttempt(ctx: ProjectContext, phase: string | null): number {
  if (phase === null) return 1;
  return ctx.db.getAttempt(phase)?.attempt ?? ctx.state.attempt;
}
