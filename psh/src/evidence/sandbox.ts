import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type SandboxMode = "ai-jail" | "inherited" | "degraded";

export interface SandboxStatus {
  mode: SandboxMode;
  detail: string;
  jail_bin: string | null;
  jail_version: string | null;
}

export interface RunRequest {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeout_s: number;
  network: boolean;
}

export interface RunResult {
  /** Codigo de saida real do comando. `null` so quando o processo morreu por sinal. */
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  spawn_error: string | null;
  mode: SandboxMode;
}

let cached: SandboxStatus | null = null;

/**
 * O modo e declarado, nunca adivinhado. `inherited` depende de `PSH_IN_SANDBOX`,
 * porque o ai-jail nao deixa marca de ambiente propria dentro da jaula e um
 * palpite errado aqui viraria "sandbox ativo" falso em `psh status`.
 */
export function detectSandbox(force = false): SandboxStatus {
  if (cached !== null && !force) return cached;

  if (process.env.PSH_SANDBOX === "off") {
    cached = {
      mode: "degraded",
      detail: "PSH_SANDBOX=off: isolamento desligado explicitamente pelo operador",
      jail_bin: null,
      jail_version: null,
    };
    return cached;
  }

  if (process.env.PSH_IN_SANDBOX === "1") {
    cached = {
      mode: "inherited",
      detail: "sessao ja enjaulada (PSH_IN_SANDBOX=1): o verificador nao reenjaula",
      jail_bin: null,
      jail_version: null,
    };
    return cached;
  }

  const bin = findAiJail();
  if (bin === null) {
    cached = {
      mode: "degraded",
      detail: "ai-jail nao encontrado no PATH nem em PSH_AI_JAIL_BIN",
      jail_bin: null,
      jail_version: null,
    };
    return cached;
  }

  const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (probe.error || probe.status !== 0) {
    cached = {
      mode: "degraded",
      detail: `ai-jail em ${bin} nao respondeu ao probe: ${probe.error?.message ?? `exit ${probe.status}`}`,
      jail_bin: bin,
      jail_version: null,
    };
    return cached;
  }

  cached = {
    mode: "ai-jail",
    detail: `ai-jail operante em ${bin}`,
    jail_bin: bin,
    jail_version: probe.stdout.trim(),
  };
  return cached;
}

export function resetSandboxCache(): void {
  cached = null;
}

function findAiJail(): string | null {
  const override = process.env.PSH_AI_JAIL_BIN;
  if (override !== undefined && override !== "") {
    return existsSync(override) ? override : null;
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "ai-jail");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * R2.10: o codigo de saida real atravessa sandbox, wrapper e limpeza.
 * Nada aqui converte sinal em zero (R2.10b).
 */
export function runSandboxed(req: RunRequest, status: SandboxStatus = detectSandbox()): RunResult {
  const { argv, wrapped } = buildArgv(req, status);
  void wrapped;

  const res = spawnSync(argv[0]!, argv.slice(1), {
    cwd: req.cwd,
    env: req.env,
    encoding: "utf8",
    timeout: req.timeout_s * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
  });

  const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const spawnError =
    res.error !== undefined && !timedOut ? `${(res.error as Error).message}` : null;

  return {
    // `?? null`, jamais `?? 0`: ausencia de codigo de saida e ausencia, e quem
    // converte isso em sucesso e o bug do `prostaff-hooks` que este marco existe
    // para nao repetir (R2.10b).
    exit_code: res.status ?? null,
    signal: res.signal ?? null,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    timed_out: timedOut,
    spawn_error: spawnError,
    mode: status.mode,
  };
}

export function buildArgv(req: RunRequest, status: SandboxStatus): { argv: string[]; wrapped: boolean } {
  if (status.mode !== "ai-jail" || status.jail_bin === null) {
    return { argv: req.argv, wrapped: false };
  }
  // R3.4: defaults do ai-jail preservados. Credencial de agente nunca montada;
  // rede so quando o verificador declara que precisa (R2.7).
  //
  // `--clean` e `--no-save-config` nao sao preferencia, sao a diferenca entre o
  // contrato valer e nao valer. Sem eles o ai-jail grava a corrida atual no
  // `.ai-jail` do projeto e le esse arquivo na corrida seguinte, e como config
  // de projeto e politica monotonica (so restringe, nunca libera), o que a
  // corrida anterior gravou desliga capacidade que esta corrida declarou. Na
  // pratica o `--network` chegava uma corrida atrasado: o verificador com
  // `network: true` rodava sem rede logo depois de um sem rede, o comando
  // falhava por conexao em vez de por sandbox, e a metrica desse relatorio
  // quebrado ainda assim virava valor de portao. Achado no Campo 01.
  const jailArgs = ["--clean", "--no-save-config", "--no-agent-state", "--no-docker", "--no-ssh"];
  if (req.network) jailArgs.push("--network");
  else jailArgs.push("--no-network");
  return { argv: [status.jail_bin, ...jailArgs, "--", ...req.argv], wrapped: true };
}
