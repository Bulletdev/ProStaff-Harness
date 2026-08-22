import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256File } from "../util/hash.ts";
import { normalizeRel } from "../util/globs.ts";
import type { Layout } from "../util/paths.ts";
import { detectSandbox, type SandboxStatus } from "../evidence/sandbox.ts";
import type { BoundaryPolicy, Decision } from "./policy.ts";

export type ViolationAction = "reverted" | "deleted" | "unrevertable";

export interface Violation {
  path: string;
  change: "modified" | "created" | "deleted";
  action: ViolationAction;
  reason: string;
}

export interface ExecResult {
  mode: SandboxStatus["mode"];
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  spawn_error: string | null;
  violations: Violation[];
  /** R2.13: quantos arquivos o snapshot examinou e quantos conseguiu preservar. */
  snapshot: { examined: number; backed_up: number; skipped_by_budget: number } | null;
}

export interface ExecOptions {
  layout: Layout;
  policy: BoundaryPolicy;
  agentId: string;
  argv: string[];
  cwd?: string;
  timeout_s?: number;
  env?: Record<string, string>;
  sandbox?: SandboxStatus;
  /** Teto de bytes copiados no snapshot do modo degradado. */
  backupBudgetBytes?: number;
}

const DEFAULT_BUDGET = 64 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "target", "dist"]);

/**
 * Executa um comando sob a fronteira do agente.
 *
 * R3.1 camada 1, quando o ai-jail existe: montagem de escrita restrita aos
 * paths do agente, resto somente leitura. Quem impede a escrita e o kernel, e
 * nao ha o que reverter.
 *
 * R3.2, quando nao existe: modo degradado declarado. Snapshot antes, comparacao
 * depois, e todo arquivo alterado fora da allowlist e revertido e registrado
 * como violacao. Nunca silencioso.
 */
export function execUnderBoundary(opts: ExecOptions): ExecResult {
  const sandbox = opts.sandbox ?? detectSandbox();
  const cwd = opts.cwd ?? opts.layout.root;
  const timeout = (opts.timeout_s ?? 900) * 1000;
  const env = opts.env ?? herdarAmbiente();

  if (sandbox.mode === "ai-jail" && sandbox.jail_bin !== null) {
    const argv = montarArgvEnjaulado(opts, sandbox.jail_bin);
    const r = spawnSync(argv[0]!, argv.slice(1), {
      cwd,
      env,
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      mode: "ai-jail",
      exit_code: r.status ?? null,
      signal: r.signal ?? null,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      timed_out: erroDeTimeout(r.error),
      spawn_error: erroDeSpawn(r.error),
      violations: [],
      snapshot: null,
    };
  }

  // Modo degradado (ou sessao ja enjaulada, que tambem nao remonta nada).
  const snapshot = tirarSnapshot(opts, opts.backupBudgetBytes ?? DEFAULT_BUDGET);
  try {
    const r = spawnSync(opts.argv[0]!, opts.argv.slice(1), {
      cwd,
      env,
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
    });
    const violations = reverterForaDaFronteira(opts, snapshot);
    return {
      mode: sandbox.mode,
      exit_code: r.status ?? null,
      signal: r.signal ?? null,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      timed_out: erroDeTimeout(r.error),
      spawn_error: erroDeSpawn(r.error),
      violations,
      snapshot: {
        examined: snapshot.hashes.size,
        backed_up: snapshot.backups.size,
        skipped_by_budget: snapshot.skipped,
      },
    };
  } finally {
    rmSync(snapshot.dir, { recursive: true, force: true });
  }
}

interface Snapshot {
  dir: string;
  hashes: Map<string, string>;
  backups: Map<string, string>;
  skipped: number;
}

function tirarSnapshot(opts: ExecOptions, budget: number): Snapshot {
  const dir = join(opts.layout.harness, "tmp", `boundary-${process.pid}-${opts.agentId}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const hashes = new Map<string, string>();
  const backups = new Map<string, string>();
  let usado = 0;
  let skipped = 0;

  for (const rel of caminhar(opts.layout.root)) {
    const abs = join(opts.layout.root, rel);
    let tamanho: number;
    try {
      tamanho = statSync(abs).size;
      hashes.set(rel, sha256File(abs));
    } catch {
      continue;
    }
    // So faz backup do que o agente NAO pode escrever: o resto ele pode mudar
    // a vontade, e copiar seria desperdicio.
    if (opts.policy.canWrite(opts.agentId, rel).allowed) continue;
    if (usado + tamanho > budget) {
      skipped += 1;
      continue;
    }
    const destino = join(dir, rel);
    try {
      mkdirSync(dirname(destino), { recursive: true });
      copyFileSync(abs, destino);
      backups.set(rel, destino);
      usado += tamanho;
    } catch {
      skipped += 1;
    }
  }
  return { dir, hashes, backups, skipped };
}

function reverterForaDaFronteira(opts: ExecOptions, snapshot: Snapshot): Violation[] {
  const violations: Violation[] = [];
  const agora = new Set(caminhar(opts.layout.root));

  for (const rel of agora) {
    const abs = join(opts.layout.root, rel);
    const antes = snapshot.hashes.get(rel);
    let depois: string;
    try {
      depois = sha256File(abs);
    } catch {
      continue;
    }
    if (antes === depois) continue;

    const decisao = opts.policy.canWrite(opts.agentId, rel);
    if (decisao.allowed) continue;

    violations.push(
      antes === undefined
        ? aplicarCriacao(abs, rel, decisao)
        : aplicarModificacao(abs, rel, decisao, snapshot),
    );
  }

  // Arquivo que existia e sumiu tambem e violacao quando estava fora da fronteira.
  for (const rel of snapshot.hashes.keys()) {
    if (agora.has(rel)) continue;
    const decisao = opts.policy.canWrite(opts.agentId, rel);
    if (decisao.allowed) continue;
    const backup = snapshot.backups.get(rel);
    if (backup === undefined) {
      violations.push({
        path: rel,
        change: "deleted",
        action: "unrevertable",
        reason: `${decisao.reason}. Arquivo apagado e sem copia no snapshot, entao a reversao nao foi possivel`,
      });
      continue;
    }
    const abs = join(opts.layout.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    copyFileSync(backup, abs);
    violations.push({
      path: rel,
      change: "deleted",
      action: "reverted",
      reason: `${decisao.reason}. Arquivo apagado foi restaurado do snapshot`,
    });
  }

  return violations.sort((a, b) => a.path.localeCompare(b.path));
}

function aplicarCriacao(abs: string, rel: string, decisao: Decision): Violation {
  try {
    unlinkSync(abs);
    return {
      path: rel,
      change: "created",
      action: "deleted",
      reason: `${decisao.reason}. Arquivo criado fora da fronteira foi removido`,
    };
  } catch (cause) {
    return {
      path: rel,
      change: "created",
      action: "unrevertable",
      reason: `${decisao.reason}. Nao foi possivel remover: ${(cause as Error).message}`,
    };
  }
}

function aplicarModificacao(abs: string, rel: string, decisao: Decision, snapshot: Snapshot): Violation {
  const backup = snapshot.backups.get(rel);
  if (backup === undefined) {
    return {
      path: rel,
      change: "modified",
      action: "unrevertable",
      reason: `${decisao.reason}. Sem copia no snapshot (teto de bytes atingido), entao a reversao nao foi possivel`,
    };
  }
  try {
    copyFileSync(backup, abs);
    return {
      path: rel,
      change: "modified",
      action: "reverted",
      reason: `${decisao.reason}. Conteudo anterior restaurado do snapshot`,
    };
  } catch (cause) {
    return {
      path: rel,
      change: "modified",
      action: "unrevertable",
      reason: `${decisao.reason}. Falha ao restaurar: ${(cause as Error).message}`,
    };
  }
}

/**
 * R3.1 camada 1: escrita liberada exatamente nos paths do agente, resto
 * somente leitura. Os defaults do R3.4 vao junto e nao sao negociaveis aqui.
 */
export function montarArgvEnjaulado(opts: ExecOptions, jailBin: string): string[] {
  const agente = opts.policy.agent(opts.agentId);
  const args = [jailBin, "--no-agent-state", "--no-docker", "--no-ssh"];
  args.push(agente?.network === true ? "--network" : "--no-network");

  // Projeto inteiro somente leitura, e so os paths do agente voltam como rw.
  args.push("--map", opts.layout.root);
  for (const padrao of agente?.write?.patterns ?? []) {
    args.push("--rw-map", join(opts.layout.root, diretorioBase(padrao)));
  }
  // O que decide portao nunca e montado como escrita, mesmo que um glob amplo
  // do agente cubra o caminho.
  for (const proibido of [".harness", ".git"]) {
    args.push("--deny-path", join(opts.layout.root, proibido));
  }
  args.push("--", ...opts.argv);
  return args;
}

/** `src/api/**` vira `src/api`: mount trabalha com diretorio, nao com glob. */
export function diretorioBase(padrao: string): string {
  const partes = normalizeRel(padrao).split("/");
  const limpas: string[] = [];
  for (const parte of partes) {
    if (parte.includes("*") || parte.includes("?") || parte.includes("[") || parte.includes("{")) break;
    limpas.push(parte);
  }
  return limpas.join("/") || ".";
}

function caminhar(root: string): string[] {
  const out: string[] = [];
  const pilha = [""];
  while (pilha.length > 0) {
    const relDir = pilha.pop()!;
    const absDir = relDir === "" ? root : join(root, relDir);
    let entradas;
    try {
      entradas = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entradas) {
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (rel === ".harness/tmp") continue;
        pilha.push(rel);
        continue;
      }
      if (e.isSymbolicLink()) continue;
      out.push(rel);
    }
  }
  return out;
}

function herdarAmbiente(): Record<string, string> {
  const passar = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "SHELL", "USER"];
  const env: Record<string, string> = {};
  for (const k of passar) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function erroDeTimeout(error: unknown): boolean {
  return error !== undefined && (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
}

function erroDeSpawn(error: unknown): string | null {
  if (error === undefined) return null;
  return erroDeTimeout(error) ? null : (error as Error).message;
}
