import { PshError, EXIT } from "../util/errors.ts";

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

/**
 * Flags que nunca consomem o token seguinte.
 *
 * Sem esta lista, `psh audit --json log` faz `--json` engolir `log`, o
 * subcomando some e o comando cai no default silenciosamente. Um parser que
 * adivinha pela forma do proximo token erra exatamente onde o usuario escreve
 * a ordem natural.
 */
const BOOLEAN_FLAGS = new Set([
  "json",
  "all",
  "yes",
  "dry-run",
  "force",
  "gate-only",
  "skip-verify",
  "help",
  "version",
]);

/**
 * Parser minimo e explicito. Nao inventa flag: o que nao esta declarado no
 * comando e recusado, para que `--coverage=99` nao passe despercebido como
 * argumento ignorado (R2.1).
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags.set(body, true);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      i += 1;
    } else {
      flags.set(body, true);
    }
  }

  return { positional, flags };
}

export function rejectUnknownFlags(args: ParsedArgs, allowed: readonly string[], command: string): void {
  const unknown = [...args.flags.keys()].filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new PshError(
      `flag desconhecida em 'psh ${command}': ${unknown.map((u) => `--${u}`).join(", ")}. Conhecidas: ${allowed
        .map((a) => `--${a}`)
        .join(", ")}`,
      { exitCode: EXIT.FAILURE },
    );
  }
}

export function flagString(args: ParsedArgs, name: string): string | null {
  const value = args.flags.get(name);
  if (value === undefined) return null;
  if (value === true) {
    throw new PshError(`--${name} exige um valor`, { exitCode: EXIT.FAILURE });
  }
  return value;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}
