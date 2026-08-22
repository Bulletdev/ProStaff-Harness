import { ContractError } from "./errors.ts";

/**
 * R2.14: caminho de arquivo nunca vira expressao regular.
 *
 * O casamento e feito por `Bun.Glob`, e o lado que varia (o caminho no disco)
 * entra sempre como *entrada relativa*, nunca como parte do padrao. Um diretorio
 * de instalacao chamado `pro+staff [1]` deixa de ser um problema porque o nome
 * dele nunca chega ao compilador de padrao.
 */
export function compileGlobs(patterns: readonly string[]): GlobSet {
  if (patterns.length === 0) {
    throw new ContractError("conjunto de globs vazio: nada seria observado");
  }
  const globs = patterns.map((pattern) => {
    const structural = structuralProblem(pattern);
    if (structural !== null) {
      throw new ContractError(`glob invalido ${JSON.stringify(pattern)}: ${structural}`, { pattern });
    }
    try {
      const glob = new Bun.Glob(pattern);
      glob.match("probe");
      return { pattern, glob };
    } catch (cause) {
      throw new ContractError(`glob invalido ${JSON.stringify(pattern)}: ${(cause as Error).message}`, {
        pattern,
      });
    }
  });
  return new GlobSet(globs);
}

/**
 * Bun.Glob aceita colchete e chave desbalanceados e simplesmente nao casa nada.
 * Silencio aqui e o pior resultado possivel: o portao passaria a observar zero
 * arquivo e o frescor viraria constante. Entao a estrutura e conferida antes.
 */
function structuralProblem(pattern: string): string | null {
  if (pattern === "") return "padrao vazio";
  let brackets = 0;
  let braces = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") brackets += 1;
    else if (ch === "]") brackets -= 1;
    else if (ch === "{") braces += 1;
    else if (ch === "}") braces -= 1;
    if (brackets < 0) return "']' sem '[' correspondente";
    if (braces < 0) return "'}' sem '{' correspondente";
  }
  if (brackets !== 0) return "'[' sem ']' correspondente";
  if (braces !== 0) return "'{' sem '}' correspondente";
  return null;
}

export class GlobSet {
  #globs: ReadonlyArray<{ pattern: string; glob: Bun.Glob }>;

  constructor(globs: ReadonlyArray<{ pattern: string; glob: Bun.Glob }>) {
    this.#globs = globs;
  }

  get patterns(): string[] {
    return this.#globs.map((g) => g.pattern);
  }

  /** `relPath` precisa ser relativo a raiz do projeto e usar `/`. */
  matches(relPath: string): boolean {
    return this.matchedBy(relPath) !== null;
  }

  matchedBy(relPath: string): string | null {
    const normalized = normalizeRel(relPath);
    for (const { pattern, glob } of this.#globs) {
      if (glob.match(normalized)) return pattern;
      // `src/**` deve casar `src/a.ts` alem de `src/`; Bun.Glob ja faz isso.
      // O caso extra e o padrao de diretorio puro (`src/`), tratado por prefixo.
      if (pattern.endsWith("/") && normalized.startsWith(pattern)) return pattern;
    }
    return null;
  }
}

export function normalizeRel(relPath: string): string {
  let out = relPath.replaceAll("\\", "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}
