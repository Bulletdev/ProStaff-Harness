import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import Ajv from "ajv";
import boundarySchema from "../../schemas/boundary.schema.json" with { type: "json" };
import { ContractError } from "../util/errors.ts";
import { readJsonFile } from "../util/json.ts";
import { compileGlobs, normalizeRel, type GlobSet } from "../util/globs.ts";
import { toRel, type Layout } from "../util/paths.ts";
import { formatAjvErrors } from "../workflow/load.ts";

const ajv = new Ajv({ allErrors: true, strict: false });
export const validateBoundarySchema = ajv.compile(boundarySchema);

export interface AgentPolicy {
  description?: string;
  write: string[];
  deny?: string[];
  network?: boolean;
}

export interface BoundaryContract {
  _type: "psh-boundary";
  version: 1;
  description?: string;
  default_agent?: string;
  agents: Record<string, AgentPolicy>;
}

/**
 * R2.6b / R3.5b / R3.6: o deny duro mora no binario, nunca no arquivo.
 *
 * Se morasse no `boundary.json`, bastaria editar o arquivo para removê-lo, e o
 * arquivo esta justamente entre os caminhos protegidos. Regra que se apaga
 * sozinha nao e regra.
 */
export const DENY_ALWAYS: readonly string[] = [
  ".harness/evidence/**",
  ".harness/evidence",
  ".harness/reviews/**",
  ".harness/reviews",
  ".harness/audit/**",
  ".harness/audit",
  ".harness/approvals/**",
  ".harness/approvals",
  ".harness/state.json",
  ".harness/boundary.json",
  ".harness/workflow.json",
  ".harness/harness.db",
  ".harness/harness.db-wal",
  ".harness/harness.db-shm",
  ".git/**",
  ".git",
];

export type DecisionRule =
  | { kind: "deny-always"; pattern: string }
  | { kind: "outside-project" }
  | { kind: "install-dir" }
  | { kind: "agent-deny"; pattern: string }
  | { kind: "agent-write"; pattern: string }
  | { kind: "no-match" }
  | { kind: "unknown-agent"; agent: string };

export interface Decision {
  allowed: boolean;
  /** Caminho relativo a raiz, normalizado. `null` quando fora do projeto. */
  rel: string | null;
  rule: DecisionRule;
  reason: string;
}

export interface CompiledAgent {
  id: string;
  write: GlobSet | null;
  deny: GlobSet | null;
  network: boolean;
}

export class BoundaryPolicy {
  readonly contract: BoundaryContract;
  readonly layout: Layout;
  readonly #agents = new Map<string, CompiledAgent>();
  readonly #denyAlways: GlobSet;
  readonly #installDirs: string[];
  readonly #realRoot: string;

  constructor(contract: BoundaryContract, layout: Layout, installDirs: readonly string[] = defaultInstallDirs()) {
    this.contract = contract;
    this.layout = layout;
    this.#denyAlways = compileGlobs(DENY_ALWAYS);
    this.#installDirs = installDirs.map((d) => resolveReal(d));
    this.#realRoot = resolveReal(layout.root);

    for (const [id, agent] of Object.entries(contract.agents)) {
      this.#agents.set(id, {
        id,
        write: agent.write.length > 0 ? compileGlobs(agent.write) : null,
        deny: agent.deny && agent.deny.length > 0 ? compileGlobs(agent.deny) : null,
        network: agent.network === true,
      });
    }
  }

  get agentIds(): string[] {
    return [...this.#agents.keys()].sort();
  }

  agent(id: string): CompiledAgent | undefined {
    return this.#agents.get(id);
  }

  get defaultAgent(): string | undefined {
    return this.contract.default_agent;
  }

  /**
   * Decide se `agentId` pode escrever em `target`.
   *
   * A ordem importa e e sempre a mesma: deny duro, fora do projeto, diretorio
   * de instalacao, deny do agente, allowlist do agente. Nada depois disso
   * libera o que veio antes.
   */
  canWrite(agentId: string, target: string): Decision {
    const abs = isAbsolute(target) ? resolve(target) : resolve(this.layout.root, target);

    // Symlink e resolvido ANTES de qualquer decisao, e o caminho real e o que
    // vale dali em diante. Decidir pelo nome deixaria um link dentro do escopo
    // do agente apontando para .harness/evidence/ passar pelo deny duro
    // (R11.2 caso 2).
    const real = resolveReal(abs);

    // R3.5b: o codigo que restringe nunca e gravavel por quem e restringido.
    for (const dir of this.#installDirs) {
      if (isWithin(dir, real)) {
        return {
          allowed: false,
          rel: null,
          rule: { kind: "install-dir" },
          reason: `'${target}' esta no diretorio de instalacao do harness (${dir}); um agente nunca reescreve o mecanismo que o restringe`,
        };
      }
    }

    if (!isWithin(this.#realRoot, real)) {
      return {
        allowed: false,
        rel: null,
        rule: { kind: "outside-project" },
        reason:
          real === abs
            ? `'${target}' esta fora da raiz do projeto (${this.layout.root})`
            : `'${target}' resolve para '${real}', fora da raiz do projeto (${this.layout.root})`,
      };
    }

    const rel = normalizeRel(toRel(this.#realRoot, real));

    const duro = this.#denyAlways.matchedBy(rel);
    if (duro !== null) {
      return {
        allowed: false,
        rel,
        rule: { kind: "deny-always", pattern: duro },
        reason: `'${rel}' esta no deny duro do harness (${duro}) e nenhuma allowlist libera`,
      };
    }

    const agent = this.#agents.get(agentId);
    if (agent === undefined) {
      return {
        allowed: false,
        rel,
        rule: { kind: "unknown-agent", agent: agentId },
        reason: `agente '${agentId}' nao esta declarado no boundary.json; sem agente nao ha escrita permitida`,
      };
    }

    const negado = agent.deny?.matchedBy(rel) ?? null;
    if (negado !== null) {
      return {
        allowed: false,
        rel,
        rule: { kind: "agent-deny", pattern: negado },
        reason: `'${rel}' cai no deny do agente '${agentId}' (${negado})`,
      };
    }

    const permitido = agent.write?.matchedBy(rel) ?? null;
    if (permitido === null) {
      return {
        allowed: false,
        rel,
        rule: { kind: "no-match" },
        reason: `'${rel}' esta fora da fronteira de escrita do agente '${agentId}'`,
      };
    }

    return {
      allowed: true,
      rel,
      rule: { kind: "agent-write", pattern: permitido },
      reason: `'${rel}' liberado por ${permitido} para o agente '${agentId}'`,
    };
  }
}

/**
 * R11.2 caso 9: allowlist ausente, vazia ou corrompida.
 * Nos tres casos o boundary bloqueia, em vez de abrir por falta de regra.
 */
export function loadBoundary(layout: Layout, installDirs?: readonly string[]): BoundaryPolicy {
  if (!existsSync(layout.boundaryPath)) {
    throw new ContractError(
      `${layout.boundaryPath} ausente. Sem allowlist o harness bloqueia toda escrita de agente, em vez de liberar por falta de regra. Rode 'psh init' ou 'psh boundary add'.`,
      { path: layout.boundaryPath },
    );
  }
  const raw = readJsonFile(layout.boundaryPath);
  if (!validateBoundarySchema(raw)) {
    throw new ContractError(
      `boundary.json invalido:\n  - ${formatAjvErrors(validateBoundarySchema.errors).join("\n  - ")}`,
      { path: layout.boundaryPath },
    );
  }
  const contract = raw as unknown as BoundaryContract;

  if (contract.default_agent !== undefined && contract.agents[contract.default_agent] === undefined) {
    throw new ContractError(
      `boundary.json: default_agent '${contract.default_agent}' nao esta declarado em agents`,
      { path: layout.boundaryPath },
    );
  }
  return new BoundaryPolicy(contract, layout, installDirs);
}

/**
 * Contencao por segmento de path, depois de resolver symlink.
 *
 * R11.2 caso 2: um symlink dentro do escopo apontando para fora nao pode virar
 * porta de saida. Quem decide e o destino real, nao o nome.
 */
export function isWithin(parent: string, child: string): boolean {
  const p = resolveReal(parent);
  const c = resolveReal(child);
  if (c === p) return true;
  return c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

export function resolveReal(path: string): string {
  // O alvo pode ainda nao existir (escrita de arquivo novo). Nesse caso o
  // ancestral existente e que precisa ser resolvido.
  let atual = path;
  const restos: string[] = [];
  for (;;) {
    if (existsSync(atual)) {
      const real = safeRealpath(atual);
      return restos.length === 0 ? real : `${real}/${restos.reverse().join("/")}`;
    }
    const barra = atual.lastIndexOf("/");
    if (barra <= 0) return path;
    restos.push(atual.slice(barra + 1));
    atual = atual.slice(0, barra);
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function defaultInstallDirs(): string[] {
  const dirs = new Set<string>();
  const exec = process.execPath;
  const barra = exec.lastIndexOf("/");
  if (barra > 0) dirs.add(exec.slice(0, barra));
  const home = process.env.HOME;
  if (home !== undefined && home !== "") dirs.add(`${home}/.config/prostaff-harness`);
  return [...dirs];
}
