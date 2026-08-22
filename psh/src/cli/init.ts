import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import bunStack from "../workflow/stacks/bun.json" with { type: "json" };
import nodeStack from "../workflow/stacks/node.json" with { type: "json" };
import rubyStack from "../workflow/stacks/ruby.json" with { type: "json" };
import pythonStack from "../workflow/stacks/python.json" with { type: "json" };
import goStack from "../workflow/stacks/go.json" with { type: "json" };
import commonStack from "../workflow/stacks/common.json" with { type: "json" };
import strictProfile from "../workflow/profiles/strict.json" with { type: "json" };
import leanProfile from "../workflow/profiles/lean.json" with { type: "json" };
import gateOnlyProfile from "../workflow/profiles/gate-only.json" with { type: "json" };
import failureProtocol from "../workflow/profiles/failure-protocol.json" with { type: "json" };
import type { GateCheck, PhaseSpec, ProfileName, VerifierSpec, WorkflowContract } from "../workflow/types.ts";
import { parseWorkflow } from "../workflow/load.ts";
import { layoutFor, HARNESS_DIR, type Layout } from "../util/paths.ts";
import { writeJsonAtomic } from "../util/json.ts";
import { initialState, writeState } from "../workflow/state.ts";
import { AuditChain } from "../audit/chain.ts";
import { HarnessDb } from "../db/index.ts";
import { PshError, EXIT } from "../util/errors.ts";

interface StackPack {
  stack: string;
  detect: string[];
  verifiers: VerifierSpec[];
}

interface ProfilePack {
  profile: ProfileName;
  description: string;
  entry?: string;
  phases: PhaseSpec[];
}

const STACKS: StackPack[] = [
  bunStack as StackPack,
  nodeStack as StackPack,
  rubyStack as StackPack,
  pythonStack as StackPack,
  goStack as StackPack,
];

const PROFILES: Record<ProfileName, ProfilePack> = {
  strict: strictProfile as ProfilePack,
  lean: leanProfile as ProfilePack,
  "gate-only": gateOnlyProfile as ProfilePack,
};

export interface InitPlan {
  root: string;
  profile: ProfileName;
  stack: string;
  contract: WorkflowContract;
  /** R2.13: o que a composicao examinou e o que ela derrubou, contado. */
  verifiers_available: string[];
  checks_examined: number;
  checks_pruned: string[];
  phases_downgraded: string[];
  writes: { path: string; exists: boolean }[];
}

export function detectStack(root: string): string {
  for (const pack of STACKS) {
    if (pack.detect.some((file) => existsSync(join(root, file)))) return pack.stack;
  }
  return "generic";
}

/**
 * Perfis e stack packs sao modulos JSON, ou seja, singletons do processo.
 * Devolver o contrato apontando para eles faz qualquer mutacao a jusante
 * corromper todo `psh init` seguinte no mesmo processo. A copia isola isso na
 * fronteira, uma vez, em vez de exigir disciplina de quem consome.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildPlan(root: string, profileName: ProfileName, stackName: string): InitPlan {
  const profile = clone(PROFILES[profileName]);
  const stackPack = STACKS.find((s) => s.stack === stackName);
  const verifiers: VerifierSpec[] = clone([
    ...(stackPack?.verifiers ?? []),
    ...(commonStack as StackPack).verifiers,
  ]);
  const available = new Set(verifiers.map((v) => v.id));

  let checksExamined = 0;
  const pruned: string[] = [];
  const downgraded: string[] = [];

  const phases: PhaseSpec[] = profile.phases.map((phase) => {
    const keep: GateCheck[] = [];
    for (const check of phase.gate.checks) {
      checksExamined += 1;
      if ((check.kind === "verifier" || check.kind === "verifier-status") && !available.has(check.verifier)) {
        pruned.push(`${phase.id}: ${check.kind}:${check.verifier} (nao existe na stack ${stackName})`);
        continue;
      }
      keep.push(check);
    }
    if (keep.length > 0) return { ...phase, gate: { ...phase.gate, checks: keep } };

    // Portao que ficaria vazio nao vira portao aberto: vira aprovacao humana,
    // declarada, para nao passar por omissao (R2.12).
    downgraded.push(phase.id);
    return {
      ...phase,
      gate: {
        type: "all-of" as const,
        checks: [
          {
            kind: "user-approval" as const,
            subject: `phase:${phase.id}`,
            message: `nenhum verificador automatico se aplica a '${phase.id}' nesta stack; aprovacao humana obrigatoria`,
          },
        ],
        on_fail: { action: "block" as const, message: phase.gate.on_fail.message },
      },
    };
  });

  const usedVerifiers = new Set<string>();
  for (const phase of phases) {
    for (const check of phase.gate.checks) {
      if (check.kind === "verifier" || check.kind === "verifier-status") usedVerifiers.add(check.verifier);
    }
  }
  const keptVerifiers =
    profileName === "gate-only" ? verifiers : verifiers.filter((v) => usedVerifiers.has(v.id));

  const contract: WorkflowContract = {
    _type: "psh-workflow",
    version: 1,
    profile: profileName,
    description: `${profile.description} (stack detectada: ${stackName})`,
    ...(profile.entry !== undefined && phases.length > 0 ? { entry: profile.entry } : {}),
    verifiers: keptVerifiers,
    phases,
    failure_protocol: clone(failureProtocol) as WorkflowContract["failure_protocol"],
  };

  // R1.1: o contrato gerado passa pela mesma validacao do contrato escrito a mao.
  parseWorkflow(contract, "<psh init>");

  const layout = layoutFor(root);
  const writes = [
    layout.workflowPath,
    layout.statePath,
    layout.boundaryPath,
    join(layout.harness, ".gitignore"),
  ].map((path) => ({ path, exists: existsSync(path) }));

  return {
    root,
    profile: profileName,
    stack: stackName,
    contract,
    verifiers_available: [...available].sort(),
    checks_examined: checksExamined,
    checks_pruned: pruned,
    phases_downgraded: downgraded,
    writes,
  };
}

const HARNESS_GITIGNORE = `# Gerado por psh init. Artefato de execucao nao entra no repositorio.
harness.db
harness.db-wal
harness.db-shm
evidence/
audit/
approvals/
`;

const BOUNDARY_SEED = {
  _type: "psh-boundary",
  version: 1,
  description:
    "Allowlist do projeto. Escrita humana via 'psh boundary' (C3, v0.2). Ate la o motor de fronteira nao esta ativo e 'psh doctor' declara isso.",
  deny_always: [
    ".harness/evidence/**",
    ".harness/reviews/**",
    ".harness/audit/**",
    ".harness/state.json",
    ".harness/boundary.json",
    ".harness/harness.db",
  ],
  agents: {},
};

export function applyPlan(plan: InitPlan, opts: { backup: boolean }): Layout {
  const layout = layoutFor(plan.root);
  mkdirSync(layout.harness, { recursive: true });
  mkdirSync(layout.evidenceDir, { recursive: true });
  mkdirSync(layout.auditDir, { recursive: true });
  mkdirSync(layout.reviewsDir, { recursive: true });
  mkdirSync(layout.memoryDir, { recursive: true });
  mkdirSync(layout.approvalsDir, { recursive: true });

  if (opts.backup) {
    for (const { path, exists } of plan.writes) {
      if (exists) backup(path);
    }
  }

  writeJsonAtomic(layout.workflowPath, plan.contract);
  if (!existsSync(layout.boundaryPath)) writeJsonAtomic(layout.boundaryPath, BOUNDARY_SEED);
  writeFileSync(join(layout.harness, ".gitignore"), HARNESS_GITIGNORE, { mode: 0o644 });

  const entry = plan.contract.phases.length === 0 ? null : (plan.contract.entry ?? plan.contract.phases[0]!.id);
  writeState(layout, initialState(plan.profile, entry));

  const db = new HarnessDb(layout.dbPath);
  try {
    const chain = new AuditChain(layout.chainPath, { anchor: db });
    chain.append("harness.init", "human:cli", {
      profile: plan.profile,
      stack: plan.stack,
      entry_phase: entry,
      verifiers: plan.contract.verifiers?.map((v) => v.id) ?? [],
      checks_examined: plan.checks_examined,
      checks_pruned: plan.checks_pruned,
      phases_downgraded: plan.phases_downgraded,
    });
  } finally {
    db.close();
  }

  return layout;
}

function backup(path: string): void {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  copyFileSync(path, `${path}.bak-${stamp}`);
}

export function renderPlan(plan: InitPlan): string {
  const lines: string[] = [];
  lines.push(`projeto: ${plan.root}`);
  lines.push(`perfil:  ${plan.profile}`);
  lines.push(`stack:   ${plan.stack}`);
  lines.push(`fases:   ${plan.contract.phases.length}`);
  lines.push(`verificadores: ${(plan.contract.verifiers ?? []).map((v) => v.id).join(", ") || "(nenhum)"}`);
  lines.push(`checks examinados: ${plan.checks_examined}, podados: ${plan.checks_pruned.length}`);
  for (const item of plan.checks_pruned) lines.push(`  - podado ${item}`);
  for (const phase of plan.phases_downgraded) {
    lines.push(`  ! ${phase}: sem verificador automatico, portao vira aprovacao humana`);
  }
  lines.push("");
  lines.push("arquivos:");
  for (const { path, exists } of plan.writes) {
    lines.push(`  ${exists ? "sobrescreve (com backup)" : "cria"}  ${path}`);
  }
  return lines.join("\n");
}

export function ensureNotNested(root: string): void {
  const existing = join(root, HARNESS_DIR);
  if (existsSync(join(existing, "workflow.json"))) {
    const raw = readFileSync(join(existing, "workflow.json"), "utf8");
    if (raw.includes("psh-workflow")) return;
    throw new PshError(
      `${existing}/workflow.json existe e nao e um contrato psh. Mova o arquivo antes de rodar 'psh init'.`,
      { exitCode: EXIT.FAILURE },
    );
  }
}
