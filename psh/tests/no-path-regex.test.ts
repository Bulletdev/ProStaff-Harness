import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scanSource } from "../scripts/check-no-path-regex.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fonteTemporaria(conteudo: string): string {
  const dir = mkdtempSync(join(tmpdir(), "psh-regex-"));
  dirs.push(dir);
  writeFileSync(join(dir, "a.ts"), conteudo);
  return dir;
}

describe("verificacao estatica de R2.14", () => {
  test("o proprio nucleo passa na regra", () => {
    const result = scanSource(resolve(import.meta.dir, "..", "src"));
    expect(result.files_examined).toBeGreaterThan(10);
    expect(result.offenses).toEqual([]);
  });

  test("new RegExp recebendo variavel e reprovado", () => {
    const dir = fonteTemporaria("const p = getPath();\nconst re = new RegExp(p);\n");
    const result = scanSource(dir);
    expect(result.offenses).toHaveLength(1);
    expect(result.offenses[0]!.reason).toContain("nao e literal");
    expect(result.offenses[0]!.line).toBe(2);
  });

  test("template com interpolacao e reprovado", () => {
    const dir = fonteTemporaria("const re = new RegExp(`^${dir}/`);\n");
    expect(scanSource(dir).offenses).toHaveLength(1);
  });

  test("concatenacao de string tambem cai, porque comeca por identificador", () => {
    const dir = fonteTemporaria("const re = new RegExp(prefix + '/x');\n");
    expect(scanSource(dir).offenses).toHaveLength(1);
  });

  test("literal constante passa", () => {
    const dir = fonteTemporaria("const re = new RegExp('^[a-z]+$');\nconst re2 = new RegExp(`^abc$`);\n");
    const result = scanSource(dir);
    expect(result.offenses).toEqual([]);
    expect(result.occurrences_examined).toBe(2);
  });

  test("R2.13: a varredura conta quantos arquivos examinou", () => {
    const dir = fonteTemporaria("export const nada = 1;\n");
    const result = scanSource(dir);
    expect(result.files_examined).toBe(1);
    expect(result.occurrences_examined).toBe(0);
  });
});
