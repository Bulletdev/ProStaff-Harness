#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { PSH_VERSION } from "./version.ts";
import { EXIT, PshError, type ExitCode } from "./util/errors.ts";
import { writeJsonAtomic } from "./util/json.ts";
import { sha256 } from "./util/hash.ts";
import { selfArgv } from "./util/self.ts";
import { flagBool, flagString, parseArgs, rejectUnknownFlags, type ParsedArgs } from "./cli/args.ts";
import { io } from "./cli/io.ts";
import { openProject } from "./cli/context.ts";
import { applyPlan, buildPlan, detectStack, ensureNotNested, renderPlan } from "./cli/init.ts";
import { renderVerify, runVerify } from "./cli/verify.ts";
import { buildStatus, renderStatus } from "./cli/status.ts";
import { renderDoctor, runDoctor } from "./cli/doctor.ts";
import { runSpecCoverage } from "./cli/spec-coverage.ts";
import { renderCi, runCi } from "./adapters/ci.ts";
import { addWriteGlob, boundaryOf, checkPath, renderBoundaryList, renderExec, runExec } from "./cli/boundary.ts";
import { advance } from "./workflow/advance.ts";
import { approvalPath, assertNoForgedMetrics, type ApprovalRecord } from "./gate/evaluate.ts";
import { DENY_ALWAYS } from "./boundary/policy.ts";
import type { ProfileName } from "./workflow/types.ts";

const USAGE = `psh ${PSH_VERSION} - ProStaff Harness (nucleo verificavel)

  psh init      [--profile strict|lean|gate-only] [--stack <nome>] [--yes] [--dry-run]
  psh status    [--json]
  psh verify    [<verificador>...] [--all] [--json]
  psh advance   [--force] [--reason <texto>] [--yes] [--json]
  psh approve   <assunto> [--as <nome>]
  psh audit     verify|log [-n <N>] [--json]
  psh doctor    [--json]
  psh boundary  list|check <caminho>|add <agente> <glob> [--agent <id>] [--json]
  psh exec      --agent <id> [--timeout <s>] -- <comando...>
  psh adapter   ci [--json] [--gate-only] [--skip-verify]
  psh internal  spec-coverage --spec <arquivo> --tasks <glob> [--out <arquivo>]

Valor de portao vem sempre de registro de evidencia produzido por 'psh verify'.
Nenhum comando aceita metrica como argumento (R2.1).`;

/** Nomes que so existem para serem recusados: injecao de metrica pelo chamador. */
const FORGED_METRIC_FLAGS = ["metric", "metrics", "set", "value", "score", "coverage", "vulnerabilities"];

export async function main(argv: string[]): Promise<ExitCode> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io().out(`${USAGE}\n`);
    return EXIT.OK;
  }
  if (command === "--version" || command === "version") {
    io().out(`${PSH_VERSION}\n`);
    return EXIT.OK;
  }

  const args = parseArgs(rest);
  guardForgedMetrics(args);

  switch (command) {
    case "init":
      return cmdInit(args);
    case "status":
      return cmdStatus(args);
    case "verify":
      return cmdVerify(args);
    case "advance":
      return cmdAdvance(args);
    case "approve":
      return cmdApprove(args);
    case "audit":
      return cmdAudit(args);
    case "doctor":
      return cmdDoctor(args);
    case "boundary":
      return cmdBoundary(args);
    case "exec":
      return cmdExec(args);
    case "adapter":
      return cmdAdapter(args);
    case "internal":
      return cmdInternal(args);
    default:
      throw new PshError(`comando desconhecido: ${command}\n\n${USAGE}`, { exitCode: EXIT.FAILURE });
  }
}

/**
 * R2.1: a recusa e explicita e nomeada. Uma flag de metrica precisa falhar
 * dizendo por que, e nao virar "flag desconhecida" - senao o caminho nunca
 * aparece em teste e ninguem sabe se a garantia existe.
 */
function guardForgedMetrics(args: ParsedArgs): void {
  const supplied: Record<string, unknown> = {};
  for (const name of FORGED_METRIC_FLAGS) {
    const value = args.flags.get(name);
    if (value !== undefined) supplied[name] = value;
  }
  assertNoForgedMetrics(supplied);
}

function cmdInit(args: ParsedArgs): ExitCode {
  rejectUnknownFlags(args, ["profile", "stack", "yes", "dry-run", "root", "json"], "init");
  const root = resolve(flagString(args, "root") ?? process.cwd());
  mkdirSync(root, { recursive: true });
  ensureNotNested(root);

  const profile = (flagString(args, "profile") ?? "lean") as ProfileName;
  if (!["strict", "lean", "gate-only"].includes(profile)) {
    throw new PshError(`perfil desconhecido: ${profile}. Use strict, lean ou gate-only.`, {
      exitCode: EXIT.CONTRACT_INVALID,
    });
  }
  const stack = flagString(args, "stack") ?? detectStack(root);
  const plan = buildPlan(root, profile, stack);

  if (flagBool(args, "json")) {
    io().out(`${JSON.stringify(plan, null, 2)}\n`);
    if (flagBool(args, "dry-run")) return EXIT.OK;
  } else {
    io().out(`${renderPlan(plan)}\n\n`);
    if (flagBool(args, "dry-run")) {
      io().out("--dry-run: nada foi escrito.\n");
      return EXIT.OK;
    }
    if (!flagBool(args, "yes") && !confirmTty("Aplicar? [s/N] ")) {
      io().out("cancelado.\n");
      return EXIT.OK;
    }
  }

  const layout = applyPlan(plan, { backup: true });
  io().out(`harness inicializado em ${layout.harness}\n`);
  return EXIT.OK;
}

function cmdStatus(args: ParsedArgs): ExitCode {
  rejectUnknownFlags(args, ["json", "root"], "status");
  const ctx = openProject(flagString(args, "root") ?? undefined);
  try {
    const report = buildStatus(ctx);
    io().out(
      flagBool(args, "json") ? `${JSON.stringify(report, null, 2)}\n` : `${renderStatus(report)}\n`,
    );
    if (!report.audit.ok) return EXIT.AUDIT_BROKEN;
    return report.gate === null || report.gate.passed ? EXIT.OK : EXIT.GATE_FAILED;
  } finally {
    ctx.close();
  }
}

function cmdVerify(args: ParsedArgs): ExitCode {
  rejectUnknownFlags(args, ["all", "json", "root"], "verify");
  const ctx = openProject(flagString(args, "root") ?? undefined);
  try {
    const outcome = runVerify({
      ctx,
      only: args.positional,
      all: flagBool(args, "all"),
      selfArgv: selfArgv(),
    });
    io().out(
      flagBool(args, "json") ? `${JSON.stringify(outcome, null, 2)}\n` : `${renderVerify(outcome)}\n`,
    );
    // Verificar nao e o mesmo que aprovar: o veredito do portao e de 'psh advance'.
    return outcome.records.some((r) => r.status === "error") ? EXIT.FAILURE : EXIT.OK;
  } finally {
    ctx.close();
  }
}

function cmdAdvance(args: ParsedArgs): ExitCode {
  rejectUnknownFlags(args, ["force", "reason", "yes", "json", "root"], "advance");
  const ctx = openProject(flagString(args, "root") ?? undefined);
  try {
    const force = flagBool(args, "force");
    const outcome = advance({
      layout: ctx.layout,
      workflow: ctx.workflow,
      db: ctx.db,
      chain: ctx.chain,
      force,
      forceReason: flagString(args, "reason") ?? undefined,
      confirm: force ? (question) => confirmTty(`${question} [s/N] `, flagBool(args, "yes")) : undefined,
    });

    if (flagBool(args, "json")) {
      io().out(`${JSON.stringify(outcome, null, 2)}\n`);
    } else {
      io().out(`${outcome.decision.toUpperCase()}: ${outcome.message}\n`);
    }

    switch (outcome.decision) {
      case "advanced":
      case "complete":
      case "override":
        return EXIT.OK;
      default:
        return EXIT.GATE_FAILED;
    }
  } finally {
    ctx.close();
  }
}

function cmdApprove(args: ParsedArgs): ExitCode {
  rejectUnknownFlags(args, ["as", "root", "json"], "approve");
  const subject = args.positional[0];
  if (subject === undefined) {
    throw new PshError("uso: psh approve <assunto>", { exitCode: EXIT.FAILURE });
  }
  const ctx = openProject(flagString(args, "root") ?? undefined);
  try {
    const target = resolve(ctx.layout.root, subject);
    const record: ApprovalRecord = {
      _type: "psh-approval",
      version: 1,
      subject,
      subject_sha256: existsSync(target) ? `sha256:${sha256(readFileSync(target))}` : null,
      approver: flagString(args, "as") ?? process.env.USER ?? "human",
      approved_at: new Date().toISOString(),
    };
    mkdirSync(ctx.layout.approvalsDir, { recursive: true });
    writeJsonAtomic(approvalPath(ctx.layout, subject), record);
    ctx.chain.append("human.approval", `human:${record.approver}`, {
      subject,
      subject_sha256: record.subject_sha256,
    });
    io().out(`aprovado: ${subject} por ${record.approver}\n`);
    return EXIT.OK;
  } finally {
    ctx.close();
  }
}

function cmdAudit(args: ParsedArgs): ExitCode {
  rejectUnknownFlags(args, ["json", "n", "root"], "audit");
  const sub = args.positional[0] ?? "verify";
  const ctx = openProject(flagString(args, "root") ?? undefined);
  try {
    if (sub === "verify") {
      const result = ctx.chain.verify();
      if (flagBool(args, "json")) {
        io().out(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        io().out(
          `${result.ok ? "cadeia integra" : "CADEIA COMPROMETIDA"}: ${result.entries} entradas, ` +
            `${result.candidates_examined} linhas examinadas, topo ${result.head_hash}\n`,
        );
        for (const problem of result.problems) {
          io().out(`  ! ${JSON.stringify(problem)}\n`);
        }
      }
      return result.ok ? EXIT.OK : EXIT.AUDIT_BROKEN;
    }
    if (sub === "log") {
      const limit = Number(flagString(args, "n") ?? "20");
      const entries = ctx.chain.read().slice(-limit);
      if (flagBool(args, "json")) {
        io().out(`${JSON.stringify(entries, null, 2)}\n`);
      } else {
        for (const entry of entries) {
          io().out(`${String(entry.seq).padStart(5)}  ${entry.ts}  ${entry.type.padEnd(18)} ${entry.actor}\n`);
        }
      }
      return EXIT.OK;
    }
    throw new PshError(`subcomando desconhecido: psh audit ${sub}. Use 'verify' ou 'log'.`, {
      exitCode: EXIT.FAILURE,
    });
  } finally {
    ctx.close();
  }
}

function cmdDoctor(args: ParsedArgs): ExitCode {
  rejectUnknownFlags(args, ["json", "root"], "doctor");
  const ctx = openProject(flagString(args, "root") ?? undefined);
  try {
    const report = runDoctor(ctx);
    io().out(
      flagBool(args, "json") ? `${JSON.stringify(report, null, 2)}\n` : `${renderDoctor(report)}\n`,
    );
    return report.failed > 0 ? EXIT.FAILURE : EXIT.OK;
  } finally {
    ctx.close();
  }
}

function cmdBoundary(args: ParsedArgs): ExitCode {
  rejectUnknownFlags(args, ["json", "root", "agent", "yes"], "boundary");
  const sub = args.positional[0] ?? "list";
  const ctx = openProject(flagString(args, "root") ?? undefined);
  try {
    const policy = boundaryOf(ctx);

    if (sub === "list") {
      io().out(
        flagBool(args, "json")
          ? `${JSON.stringify({ deny_always: DENY_ALWAYS, agents: policy.contract.agents, default_agent: policy.defaultAgent }, null, 2)}\n`
          : `${renderBoundaryList(policy)}\n`,
      );
      return EXIT.OK;
    }

    if (sub === "check") {
      const alvo = args.positional[1];
      if (alvo === undefined) throw new PshError("uso: psh boundary check <caminho> [--agent <id>]", { exitCode: EXIT.FAILURE });
      const agente = flagString(args, "agent") ?? policy.defaultAgent;
      if (agente === undefined) {
        throw new PshError("nenhum agente informado e o boundary.json nao declara default_agent", { exitCode: EXIT.CONTRACT_INVALID });
      }
      const r = checkPath(policy, agente, alvo);
      io().out(
        flagBool(args, "json")
          ? `${JSON.stringify(r, null, 2)}\n`
          : `${r.allowed ? "PERMITIDO" : "BLOQUEADO"}  ${r.path}\n  agente ${r.agent}, regra ${r.rule}\n  ${r.reason}\n`,
      );
      return r.allowed ? EXIT.OK : EXIT.BOUNDARY_VIOLATION;
    }

    if (sub === "add") {
      const agente = args.positional[1];
      const glob = args.positional[2];
      if (agente === undefined || glob === undefined) {
        throw new PshError("uso: psh boundary add <agente> <glob>", { exitCode: EXIT.FAILURE });
      }
      const novo = addWriteGlob(ctx, agente, glob, (q) => confirmTty(`${q} [s/N] `, flagBool(args, "yes")), `human:${process.env.USER ?? "operador"}`);
      io().out(`allowlist de '${agente}' agora: ${novo.agents[agente]!.write.join(", ")}\n`);
      return EXIT.OK;
    }

    throw new PshError(`subcomando desconhecido: psh boundary ${sub}. Use list, check ou add.`, { exitCode: EXIT.FAILURE });
  } finally {
    ctx.close();
  }
}

function cmdExec(args: ParsedArgs): ExitCode {
  rejectUnknownFlags(args, ["agent", "timeout", "json", "root"], "exec");
  const ctx = openProject(flagString(args, "root") ?? undefined);
  try {
    const policy = boundaryOf(ctx);
    const agente = flagString(args, "agent") ?? policy.defaultAgent;
    if (agente === undefined) {
      throw new PshError("informe --agent ou declare default_agent no boundary.json", { exitCode: EXIT.CONTRACT_INVALID });
    }
    if (args.positional.length === 0) {
      throw new PshError("uso: psh exec --agent <id> -- <comando...>", { exitCode: EXIT.FAILURE });
    }
    const timeout = flagString(args, "timeout");
    const outcome = runExec(ctx, agente, args.positional, {
      timeout_s: timeout === null ? undefined : Number(timeout),
    });

    io().out(
      flagBool(args, "json") ? `${JSON.stringify(outcome, null, 2)}\n` : `${renderExec(outcome)}\n`,
    );

    // Violacao ganha do codigo do comando: um comando que "passou" tentando
    // escapar da fronteira nao pode reportar sucesso.
    if (outcome.result.violations.length > 0) return EXIT.BOUNDARY_VIOLATION;
    if (outcome.result.spawn_error !== null || outcome.result.signal !== null) return EXIT.FAILURE;
    return (outcome.result.exit_code ?? EXIT.FAILURE) as ExitCode;
  } finally {
    ctx.close();
  }
}

function cmdAdapter(args: ParsedArgs): ExitCode {
  const sub = args.positional[0];
  if (sub !== "ci") {
    throw new PshError(`adapter desconhecido: ${sub ?? "(nenhum)"}. Disponivel na v0.1: ci`, {
      exitCode: EXIT.FAILURE,
    });
  }
  rejectUnknownFlags(args, ["json", "root", "gate-only", "skip-verify"], "adapter ci");
  const ctx = openProject(flagString(args, "root") ?? undefined);
  try {
    const report = runCi({
      ctx,
      gateOnly: flagBool(args, "gate-only"),
      skipVerify: flagBool(args, "skip-verify"),
    });
    io().out(
      flagBool(args, "json") ? `${JSON.stringify(report, null, 2)}\n` : `${renderCi(report)}\n`,
    );
    return report.exit_code;
  } finally {
    ctx.close();
  }
}

function cmdInternal(args: ParsedArgs): ExitCode {
  const sub = args.positional[0];
  if (sub !== "spec-coverage") {
    throw new PshError(`subcomando interno desconhecido: ${sub ?? "(nenhum)"}`, { exitCode: EXIT.FAILURE });
  }
  rejectUnknownFlags(args, ["spec", "tasks", "out", "root", "json"], "internal spec-coverage");
  const root = resolve(flagString(args, "root") ?? process.cwd());
  const spec = flagString(args, "spec");
  const tasks = flagString(args, "tasks");
  if (spec === null || tasks === null) {
    throw new PshError("uso: psh internal spec-coverage --spec <arquivo> --tasks <glob> [--out <arquivo>]", {
      exitCode: EXIT.FAILURE,
    });
  }
  const report = runSpecCoverage({ root, spec, tasksGlob: tasks, out: flagString(args, "out") });
  io().out(`${JSON.stringify(report, null, 2)}\n`);
  return EXIT.OK;
}

function confirmTty(prompt: string, autoYes = false): boolean {
  if (autoYes) return true;
  if (!process.stdin.isTTY) {
    throw new PshError(
      "confirmacao interativa exigida e stdin nao e um terminal. Rode num TTY ou passe --yes conscientemente.",
      { exitCode: EXIT.FAILURE },
    );
  }
  io().out(prompt);
  const line = readLineSync();
  return line.trim().toLowerCase() === "s" || line.trim().toLowerCase() === "sim";
}

function readLineSync(): string {
  const buffer = new Uint8Array(1024);
  const bytes = readSync(0, buffer, 0, buffer.length, null);
  return new TextDecoder().decode(buffer.subarray(0, bytes));
}

/** Traduz excecao em codigo de saida. Usado pelo bootstrap e pelos testes. */
export async function runCli(argv: string[]): Promise<ExitCode> {
  try {
    return await main(argv);
  } catch (error) {
    if (error instanceof PshError) {
      io().err(`psh: ${error.message}\n`);
      return error.exitCode;
    }
    io().err(`psh: erro inesperado: ${(error as Error).stack ?? String(error)}\n`);
    return EXIT.FAILURE;
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
