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
import { DENY_ALWAYS, type BoundaryPolicy, type Decision } from "./policy.ts";

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
 * Arquivos que o proprio sandbox cria ou reescreve durante o setup.
 *
 * O conjunto esta vazio desde que o argv passou a levar `--no-save-config`: o
 * ai-jail nao grava mais o `.ai-jail` na raiz, entao nao ha o que perdoar. E
 * bom que esteja vazio - enquanto o arquivo era escrito pelo sandbox, uma
 * copia dele feita pelo agente tambem passava sem virar violacao.
 */
const ARQUIVOS_DO_SANDBOX = new Set<string>();

/**
 * Marca de quem esta rodando o comando.
 *
 * Acao tomada por comando do agente precisa nascer assinada como agente, e nao
 * como o operador dono do terminal (R4.3).
 */
export const PSH_AGENT_ENV = "PSH_AGENT";

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
  // Quem chama o psh de dentro daqui e o agente, nao o operador. Sem esta marca
  // a trilha passaria a afirmar que um humano fez o que o agente fez.
  // No modo enjaulado ela vai tambem no argv, porque a jaula zera o ambiente.
  const env = { ...(opts.env ?? herdarAmbiente()), [PSH_AGENT_ENV]: opts.agentId };

  const enjaulado = sandbox.mode === "ai-jail" && sandbox.jail_bin !== null;
  const argv = enjaulado ? montarArgvEnjaulado(opts, sandbox.jail_bin!) : opts.argv;

  // O snapshot roda nos dois modos. Com mount, ele so encontra o residuo que a
  // montagem por complemento nao consegue expressar; sem mount, ele e o unico
  // controle. Em nenhum dos dois o resultado e silencioso.
  const snapshot = tirarSnapshot(opts, opts.backupBudgetBytes ?? DEFAULT_BUDGET);
  try {
    const r = spawnSync(argv[0]!, argv.slice(1), {
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
  const dir = join(opts.layout.tmpDir, `boundary-${process.pid}-${opts.agentId}`);
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
 * R3.1 camada 1: montagem.
 *
 * O ai-jail entrega o projeto gravavel e restringe por `--deny-path`. Nao da
 * para montar a raiz somente leitura e reabrir o escopo por cima: ele recusa
 * `--rw-map` que se sobrepoe a um `--map` read-only, e negar a raiz inteira
 * quebra o proprio setup do bwrap. Medido contra o binario 1.19.2.
 *
 * Entao a montagem e por complemento: nega tudo que existe e nao esta na
 * allowlist do agente, descendo so por onde a allowlist aponta.
 *
 * O que o mount nao alcanca: entrada criada durante a corrida dentro de um
 * diretorio gravavel que nao estava na allowlist. Por isso o snapshot continua
 * ligado tambem no modo enjaulado (R3.1 camada 2).
 */
export function montarArgvEnjaulado(opts: ExecOptions, jailBin: string): string[] {
  const agente = opts.policy.agent(opts.agentId);
  // `--clean --no-save-config`, medido contra o ai-jail 1.19.2.
  //
  // Por padrao o ai-jail grava um `.ai-jail` na raiz do projeto e o le na
  // execucao seguinte. O arquivo fica dentro da arvore que o agente edita, e a
  // fronteira passaria a depender, em parte, de um arquivo que o proprio
  // enjaulado escreve - o mesmo erro que o G4 aponta no harness de referencia.
  //
  // Na pratica ele tambem acumulava lixo: cada corrida somava os deny paths de
  // novo, guardados na forma `~/...`, e o ai-jail os reabria como
  // `<raiz>/~/...`, avisando "rule not applied" para regra que nao existia. A
  // regra que vale continua sendo a do argv, mas o ruido escondia o aviso de
  // verdade.
  //
  // Com as duas flags a jaula e montada so a partir do contrato do psh.
  const args = [jailBin, "--clean", "--no-save-config", "--no-agent-state", "--no-docker", "--no-ssh"];
  args.push(agente?.network === true ? "--network" : "--no-network");
  // Medido contra o ai-jail 1.19.2: a jaula zera o ambiente do filho, entao
  // `PSH_AGENT` no env do spawn chega vazio la dentro e a acao do agente
  // voltaria a ser registrada como acao de humano. O valor vai explicito no
  // argv, e nao por heranca, para nao depender do ambiente de fora.
  args.push("--env", `${PSH_AGENT_ENV}=${opts.agentId}`);

  for (const abs of caminhosNegados(opts)) args.push("--deny-path", abs);
  args.push("--", ...opts.argv);
  return args;
}

/** Complemento da allowlist: o que existe hoje e o agente nao pode escrever. */
export function caminhosNegados(opts: ExecOptions): string[] {
  const agente = opts.policy.agent(opts.agentId);
  // Base "." vem de allowlist `**` e nao delimita nada, entao sai da conta.
  const escopo = (agente?.write?.patterns ?? []).map(diretorioBase).filter((b) => b !== ".");
  const duro = DENY_ALWAYS.map(diretorioBase);
  const abaixo = (bases: string[], rel: string) => bases.some((b) => b.startsWith(`${rel}/`));
  const negados: string[] = [];

  const visita = (rel: string): void => {
    const abs = rel === "" ? opts.layout.root : join(opts.layout.root, rel);
    let entradas;
    try {
      entradas = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      const filho = rel === "" ? e.name : `${rel}/${e.name}`;
      const permitido = opts.policy.canWrite(opts.agentId, filho).allowed;

      if (e.isDirectory()) {
        // Ha escopo do agente aqui dentro: precisa descer para nao negar junto.
        if (abaixo(escopo, filho)) {
          visita(filho);
          continue;
        }
        // Diretorio liberado, mas pode guardar deny duro mais fundo.
        if (permitido || escopo.includes(filho)) {
          if (abaixo(duro, filho)) visita(filho);
          continue;
        }
        // Nada do escopo aqui: nega a subarvore inteira, de uma vez.
        negados.push(join(opts.layout.root, filho));
        continue;
      }

      if (permitido) continue;
      negados.push(join(opts.layout.root, filho));
    }
  };

  visita("");
  return negados.sort();
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
      if (ARQUIVOS_DO_SANDBOX.has(rel)) continue;
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
