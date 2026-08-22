#!/usr/bin/env bun
/**
 * R2.14, verificacao estatica: `new RegExp` que recebe qualquer coisa que nao
 * seja um literal de string constante falha o build.
 *
 * O caso que motiva a regra: um diretorio de instalacao chamado `pro+staff`
 * vira quantificador dentro da expressao e a busca deixa de casar em silencio;
 * um colchete nao balanceado derruba o processo. Comparacao de caminho e por
 * string ou por API de path, nunca por regex montada em runtime.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export interface Offense {
  file: string;
  line: number;
  snippet: string;
  reason: string;
}

export interface ScanResult {
  offenses: Offense[];
  /** R2.13: quantos arquivos e quantas ocorrencias foram examinados. */
  files_examined: number;
  occurrences_examined: number;
}

const NEEDLE = "new RegExp(";

export function scanSource(root: string, globPattern = "**/*.ts"): ScanResult {
  const glob = new Bun.Glob(globPattern);
  const offenses: Offense[] = [];
  let filesExamined = 0;
  let occurrences = 0;

  for (const rel of glob.scanSync({ cwd: root, onlyFiles: true, dot: false })) {
    if (rel.includes("node_modules/")) continue;
    const abs = resolve(root, rel);
    const text = readFileSync(abs, "utf8");
    filesExamined += 1;

    let at = text.indexOf(NEEDLE);
    while (at >= 0) {
      occurrences += 1;
      const argStart = at + NEEDLE.length;
      const reason = classify(text.slice(argStart));
      if (reason !== null) {
        offenses.push({
          file: relative(root, abs),
          line: text.slice(0, at).split("\n").length,
          snippet: text.slice(at, text.indexOf("\n", at) < 0 ? undefined : text.indexOf("\n", at)).trim(),
          reason,
        });
      }
      at = text.indexOf(NEEDLE, argStart);
    }
  }

  return { offenses, files_examined: filesExamined, occurrences_examined: occurrences };
}

/** Devolve o motivo da recusa, ou null quando o argumento e literal constante. */
function classify(rest: string): string | null {
  const first = rest.trimStart()[0];
  if (first === undefined) return "argumento vazio";
  if (first !== '"' && first !== "'" && first !== "`") {
    return "primeiro argumento nao e literal de string: pode carregar caminho";
  }
  if (first === "`") {
    const end = rest.indexOf("`", rest.indexOf("`") + 1);
    const body = end < 0 ? rest : rest.slice(rest.indexOf("`") + 1, end);
    if (body.includes("${")) return "template com interpolacao: pode carregar caminho";
  }
  return null;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dir, "..", "src"));
  const result = scanSource(root);

  if (result.files_examined === 0) {
    process.stderr.write(
      `check-no-path-regex: nenhum arquivo examinado em ${root}. ` +
        "Varredura sem candidato e falha de configuracao, nao resultado limpo (R2.13).\n",
    );
    process.exit(1);
  }

  for (const o of result.offenses) {
    process.stderr.write(`${o.file}:${o.line}  ${o.reason}\n    ${o.snippet}\n`);
  }
  process.stdout.write(
    `check-no-path-regex: ${result.files_examined} arquivos e ${result.occurrences_examined} usos de new RegExp examinados, ` +
      `${result.offenses.length} reprovados\n`,
  );
  process.exit(result.offenses.length > 0 ? 1 : 0);
}
