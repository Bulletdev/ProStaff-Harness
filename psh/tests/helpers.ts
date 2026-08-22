import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { AuditChain } from "../src/audit/chain.ts";
import { HarnessDb } from "../src/db/index.ts";
import { layoutFor, type Layout } from "../src/util/paths.ts";
import { parseWorkflow } from "../src/workflow/load.ts";
import { initialState, writeState } from "../src/workflow/state.ts";
import { Workflow, type WorkflowContract } from "../src/workflow/types.ts";
import failureProtocol from "../src/workflow/profiles/failure-protocol.json" with { type: "json" };

export const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.ts");

const created: string[] = [];

/**
 * Nem todo ambiente de teste enxerga o `git` (o bun instalado por snap, por
 * exemplo, roda confinado e nao acha `/usr/bin/git`). Descobrir isso uma vez e
 * declarar e melhor do que criar repositorios de mentira: teste que depende de
 * Git precisa saber que nao esta testando nada.
 */
export const GIT_AVAILABLE = spawnSync("git", ["--version"]).status === 0;

/**
 * R11.2b: nenhum teste escreve em process.cwd() nem toca no Git da arvore real.
 * Todo teste que precisa de repositorio cria um temporario.
 */
export function tempProject(opts: { git?: boolean } = {}): Layout {
  const root = mkdtempSync(join(tmpdir(), "psh-test-"));
  created.push(root);
  if (opts.git !== false && GIT_AVAILABLE) {
    run("git", ["init", "-q", "."], root);
    run("git", ["config", "user.email", "test@example.invalid"], root);
    run("git", ["config", "user.name", "psh test"], root);
  }
  const layout = layoutFor(root);
  mkdirSync(layout.harness, { recursive: true });
  mkdirSync(layout.evidenceDir, { recursive: true });
  mkdirSync(layout.auditDir, { recursive: true });
  mkdirSync(layout.reviewsDir, { recursive: true });
  mkdirSync(layout.approvalsDir, { recursive: true });
  return layout;
}

export function cleanupTempProjects(): void {
  while (created.length > 0) {
    const dir = created.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeFile(layout: Layout, rel: string, content: string): string {
  const path = join(layout.root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export function run(cmd: string, args: string[], cwd: string): { code: number; out: string; err: string } {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { code: res.status ?? -1, out: res.stdout ?? "", err: res.stderr ?? "" };
}

export function psh(layout: Layout, args: string[]): { code: number; out: string; err: string } {
  return run(process.execPath, [CLI_ENTRY, ...args, "--root", layout.root], layout.root);
}

export interface Harness {
  layout: Layout;
  workflow: Workflow;
  db: HarnessDb;
  chain: AuditChain;
  close(): void;
}

/** Monta um projeto com contrato feito a mao, ja validado pelo loader real. */
export function harnessWith(layout: Layout, contract: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] }): Harness {
  const full: WorkflowContract = {
    _type: "psh-workflow",
    version: 1,
    profile: "lean",
    failure_protocol: failureProtocol as WorkflowContract["failure_protocol"],
    ...contract,
  } as WorkflowContract;

  const workflow = parseWorkflow(full, "<test>");
  writeFileSync(layout.workflowPath, JSON.stringify(full, null, 2));
  writeState(layout, initialState(full.profile, workflow.entryPhase));

  const db = new HarnessDb(layout.dbPath);
  const chain = new AuditChain(layout.chainPath, { anchor: db });
  return { layout, workflow, db, chain, close: () => db.close() };
}

export const LCOV_87 = `TN:
SF:src/a.ts
DA:1,1
LF:100
LH:87
end_of_record
`;

export const LCOV_50 = `TN:
SF:src/a.ts
DA:1,1
LF:100
LH:50
end_of_record
`;

/** Script executavel usado como verificador de mentira nos testes. */
export function shellVerifier(layout: Layout, name: string, body: string): string {
  const path = join(layout.root, "bin", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}
