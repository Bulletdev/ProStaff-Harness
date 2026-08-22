import { writeJsonAtomic } from "../util/json.ts";
import { EXIT, PshError } from "../util/errors.ts";
import type { ProjectContext } from "./context.ts";
import { DENY_ALWAYS, loadBoundary, type BoundaryContract, type BoundaryPolicy } from "../boundary/policy.ts";
import { execUnderBoundary, type ExecResult } from "../boundary/execute.ts";
import { detectDestructive, renderAlerts } from "../boundary/detect.ts";
import { detectSandbox } from "../evidence/sandbox.ts";
import { readJsonFile } from "../util/json.ts";

export function boundaryOf(ctx: ProjectContext): BoundaryPolicy {
  return loadBoundary(ctx.layout);
}

export function renderBoundaryList(policy: BoundaryPolicy): string {
  const linhas: string[] = [];
  linhas.push("deny duro (do binario, nenhuma allowlist libera):");
  for (const p of DENY_ALWAYS) linhas.push(`  ${p}`);
  linhas.push("");
  linhas.push(`agentes declarados (${policy.agentIds.length}):`);
  for (const id of policy.agentIds) {
    const a = policy.contract.agents[id]!;
    const marca = id === policy.defaultAgent ? " (default)" : "";
    linhas.push(`  ${id}${marca}`);
    if (a.description !== undefined) linhas.push(`    ${a.description}`);
    linhas.push(`    escreve: ${a.write.length === 0 ? "(nada)" : a.write.join(", ")}`);
    if (a.deny !== undefined && a.deny.length > 0) linhas.push(`    nega:    ${a.deny.join(", ")}`);
    linhas.push(`    rede:    ${a.network === true ? "ligada (relaxamento declarado)" : "desligada"}`);
  }
  return linhas.join("\n");
}

export interface CheckOutcome {
  agent: string;
  path: string;
  allowed: boolean;
  rule: string;
  reason: string;
}

export function checkPath(policy: BoundaryPolicy, agentId: string, path: string): CheckOutcome {
  const d = policy.canWrite(agentId, path);
  return { agent: agentId, path, allowed: d.allowed, rule: d.rule.kind, reason: d.reason };
}

/**
 * R3.6: alterar allowlist e acao humana. Pede confirmacao e registra na trilha.
 * O agente nunca chega aqui: `boundary.json` esta no deny duro.
 */
export function addWriteGlob(
  ctx: ProjectContext,
  agentId: string,
  glob: string,
  confirm: (pergunta: string) => boolean,
  actor: string,
): BoundaryContract {
  const contract = readJsonFile<BoundaryContract>(ctx.layout.boundaryPath);
  const agente = contract.agents[agentId];
  if (agente === undefined) {
    throw new PshError(
      `agente '${agentId}' nao esta declarado. Declarados: ${Object.keys(contract.agents).join(", ") || "(nenhum)"}`,
      { exitCode: EXIT.CONTRACT_INVALID },
    );
  }
  if (agente.write.includes(glob)) {
    throw new PshError(`'${glob}' ja esta na allowlist de '${agentId}'`, { exitCode: EXIT.FAILURE });
  }

  const pergunta = [
    `Ampliar a fronteira de escrita do agente '${agentId}' com '${glob}'.`,
    "Isto alarga o que o agente pode alterar e fica registrado na trilha.",
    "Confirma?",
  ].join("\n");
  if (!confirm(pergunta)) {
    throw new PshError("alteracao de allowlist cancelada pelo operador", { exitCode: EXIT.FAILURE });
  }

  const novo: BoundaryContract = {
    ...contract,
    agents: { ...contract.agents, [agentId]: { ...agente, write: [...agente.write, glob] } },
  };
  // Recusa contrato invalido antes de gravar, pelo mesmo caminho do load.
  writeJsonAtomic(ctx.layout.boundaryPath, novo);
  try {
    loadBoundary(ctx.layout);
  } catch (cause) {
    writeJsonAtomic(ctx.layout.boundaryPath, contract);
    throw cause;
  }

  ctx.chain.append("boundary.decision", actor, {
    action: "allowlist-ampliada",
    agent: agentId,
    glob,
    write_depois: novo.agents[agentId]!.write,
  });
  return novo;
}

export interface ExecOutcome {
  agent: string;
  argv: string[];
  result: ExecResult;
  alerts: ReturnType<typeof detectDestructive>;
}

/**
 * Superficie de execucao sob fronteira. Os hooks de tool do adapter de runtime
 * (v0.3) chamam por aqui; ate la o caminho existe e e testavel pela CLI.
 */
export function runExec(
  ctx: ProjectContext,
  agentId: string,
  argv: string[],
  opts: { timeout_s?: number } = {},
): ExecOutcome {
  const policy = boundaryOf(ctx);
  if (policy.agent(agentId) === undefined) {
    throw new PshError(
      `agente '${agentId}' nao esta declarado no boundary.json. Declarados: ${policy.agentIds.join(", ")}`,
      { exitCode: EXIT.CONTRACT_INVALID },
    );
  }

  const alerts = detectDestructive(argv);
  const sandbox = detectSandbox();
  const result = execUnderBoundary({
    layout: ctx.layout,
    policy,
    agentId,
    argv,
    sandbox,
    timeout_s: opts.timeout_s,
  });

  // R4.3: comando executado, codigo de saida e decisao de fronteira na trilha.
  ctx.chain.append("command.exec", `agent:${agentId}`, {
    argv,
    exit_code: result.exit_code,
    signal: result.signal,
    sandbox_mode: result.mode,
    boundary_violations: result.violations.length,
    destructive_alerts: alerts.alerts.map((a) => a.id),
    patterns_examined: alerts.patterns_examined,
    snapshot: result.snapshot,
  });

  for (const v of result.violations) {
    ctx.chain.append("boundary.decision", `agent:${agentId}`, {
      action: "violacao",
      path: v.path,
      change: v.change,
      applied: v.action,
      reason: v.reason,
      sandbox_mode: result.mode,
    });
  }

  return { agent: agentId, argv, result, alerts };
}

export function renderExec(outcome: ExecOutcome): string {
  const { result } = outcome;
  const linhas: string[] = [];
  linhas.push(
    `agente ${outcome.agent} | sandbox ${result.mode}` +
      (result.mode === "degraded" ? "  <-- MODO DEGRADADO, reversao por snapshot" : ""),
  );
  if (result.snapshot !== null) {
    linhas.push(
      `snapshot: ${result.snapshot.examined} arquivos examinados, ${result.snapshot.backed_up} preservados` +
        (result.snapshot.skipped_by_budget > 0
          ? `, ${result.snapshot.skipped_by_budget} fora do teto de bytes`
          : ""),
    );
  }
  if (outcome.alerts.alerts.length > 0) linhas.push(renderAlerts(outcome.alerts.alerts));

  if (result.violations.length === 0) {
    linhas.push("fronteira: nenhuma violacao");
  } else {
    linhas.push(`fronteira: ${result.violations.length} VIOLACAO(OES)`);
    for (const v of result.violations) {
      linhas.push(`  ${v.action.padEnd(12)} ${v.change.padEnd(9)} ${v.path}`);
      linhas.push(`               ${v.reason}`);
    }
  }
  linhas.push(`exit ${result.exit_code ?? `sinal ${result.signal}`}`);
  return linhas.join("\n");
}
