import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileGlobs, normalizeRel } from "../src/util/globs.ts";
import { diffManifests, hashWorkspace, probeGit } from "../src/evidence/workspace.ts";
import { isInside, toRel } from "../src/util/paths.ts";
import { ContractError } from "../src/util/errors.ts";
import { jsonPointer } from "../src/util/json.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * R2.14: um diretorio de instalacao com `+`, `[` e espaco no nome nao pode virar
 * quantificador nem derrubar o processo. Este e o caso 15 da suite adversarial.
 */
function hostileDir(): string {
  const base = mkdtempSync(join(tmpdir(), "psh-hostile-"));
  dirs.push(base);
  const root = join(base, "pro+staff [1] com espaco");
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

describe("caminho nunca vira expressao regular (R2.14)", () => {
  test("diretorio com +, [ e espaco no nome ainda casa os globs do contrato", () => {
    const root = hostileDir();
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "b+c[1].ts"), "export const b = 2;\n");

    const manifest = hashWorkspace(root, { watch: ["src/**"] });
    expect(manifest.matched).toBe(2);
    expect(Object.keys(manifest.files).sort()).toEqual(["src/a.ts", "src/b+c[1].ts"]);
    expect(manifest.empty_patterns).toHaveLength(0);
    expect(manifest.hash).toStartWith("sha256:");
  });

  test("o hash muda quando o conteudo muda e nao muda quando nada muda", () => {
    const root = hostileDir();
    writeFileSync(join(root, "src", "a.ts"), "um\n");
    const antes = hashWorkspace(root, { watch: ["src/**"] });
    const igual = hashWorkspace(root, { watch: ["src/**"] });
    expect(igual.hash).toBe(antes.hash);

    writeFileSync(join(root, "src", "a.ts"), "dois\n");
    expect(hashWorkspace(root, { watch: ["src/**"] }).hash).not.toBe(antes.hash);
  });

  test("watch_exclude tira o arquivo do calculo de frescor", () => {
    const root = hostileDir();
    writeFileSync(join(root, "src", "a.ts"), "fonte\n");
    mkdirSync(join(root, "src", "gerado"), { recursive: true });
    writeFileSync(join(root, "src", "gerado", "g.ts"), "v1\n");

    const antes = hashWorkspace(root, { watch: ["src/**"], exclude: ["src/gerado/**"] });
    writeFileSync(join(root, "src", "gerado", "g.ts"), "v2\n");
    const depois = hashWorkspace(root, { watch: ["src/**"], exclude: ["src/gerado/**"] });
    expect(depois.hash).toBe(antes.hash);
  });

  test("glob estruturalmente quebrado e recusado em vez de casar nada em silencio", () => {
    expect(() => compileGlobs(["src/[aberto"])).toThrow(ContractError);
    expect(() => compileGlobs(["src/{a,b"])).toThrow(ContractError);
    expect(() => compileGlobs(["src/fechado]"])).toThrow(ContractError);
    expect(() => compileGlobs([])).toThrow(ContractError);
    expect(() => compileGlobs([""])).toThrow(ContractError);
  });

  test("padrao com colchete escapado continua valido", () => {
    const set = compileGlobs(["src/**"]);
    expect(set.matches("src/b+c[1].ts")).toBe(true);
    expect(set.matches("outro/a.ts")).toBe(false);
  });

  test("normalizacao de caminho relativo e comparacao por segmento", () => {
    expect(normalizeRel("./src/a.ts")).toBe("src/a.ts");
    expect(toRel("/tmp/p", "/tmp/p/src/a.ts")).toBe("src/a.ts");
    expect(isInside("/tmp/a/b", "/tmp/a/b/c")).toBe(true);
    expect(isInside("/tmp/a/b", "/tmp/a/bc")).toBe(false);
  });
});

describe("JSON Pointer em vez de regex sobre relatorio", () => {
  test("resolve caminho aninhado, indice de array e escapes", () => {
    const doc = { a: { "b/c": [10, 20] }, "~x": 1 };
    expect(jsonPointer(doc, "/a/b~1c/1")).toBe(20);
    expect(jsonPointer(doc, "/~0x")).toBe(1);
    expect(jsonPointer(doc, "")).toBe(doc);
  });

  test("ponteiro que nao resolve devolve undefined, nunca zero", () => {
    expect(jsonPointer({ a: 1 }, "/b")).toBeUndefined();
    expect(jsonPointer({ a: [1] }, "/a/9")).toBeUndefined();
  });

  test("ponteiro malformado e erro de contrato", () => {
    expect(() => jsonPointer({}, "a/b")).toThrow(ContractError);
  });
});

describe("enumeracao da arvore observada e declarada (R2.4)", () => {
  test("projeto fora do Git enumera por caminhada, e diz isso", () => {
    const root = hostileDir();
    writeFileSync(join(root, "src", "a.ts"), "x\n");
    expect(hashWorkspace(root, { watch: ["src/**"] }).enumeration).toBe("walk");

    const probe = probeGit(root);
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain("nao e repositorio Git");
  });

  test("com .git presente mas git inutilizavel, o modo vira walk-fallback em vez de mentir", () => {
    const root = hostileDir();
    writeFileSync(join(root, "src", "a.ts"), "x\n");
    mkdirSync(join(root, ".git"), { recursive: true });

    const manifest = hashWorkspace(root, { watch: ["src/**"] });
    expect(manifest.enumeration).toBe("walk-fallback");
    expect(manifest.matched).toBe(1);

    const probe = probeGit(root);
    expect(probe.available).toBe(false);
    expect(probe.detail.length).toBeGreaterThan(0);
  });

  test("diretorios de build pesados nao entram na caminhada", () => {
    const root = hostileDir();
    writeFileSync(join(root, "src", "a.ts"), "x\n");
    mkdirSync(join(root, "src", "node_modules", "pacote"), { recursive: true });
    writeFileSync(join(root, "src", "node_modules", "pacote", "index.js"), "muito grande\n");

    const manifest = hashWorkspace(root, { watch: ["src/**"] });
    expect(Object.keys(manifest.files)).toEqual(["src/a.ts"]);
  });

  test("artefato interno do harness nunca entra no hash da arvore", () => {
    const root = hostileDir();
    writeFileSync(join(root, "src", "a.ts"), "x\n");
    mkdirSync(join(root, ".harness", "evidence", "p", "1"), { recursive: true });
    writeFileSync(join(root, ".harness", "evidence", "p", "1", "coverage.json"), "{}\n");
    writeFileSync(join(root, ".harness", "state.json"), "{}\n");

    const manifest = hashWorkspace(root, { watch: ["**"] });
    const chaves = Object.keys(manifest.files);
    expect(chaves).toContain("src/a.ts");
    expect(chaves.some((k) => k.startsWith(".harness/evidence/"))).toBe(false);
    expect(chaves).not.toContain(".harness/state.json");
  });

  test("diff nomeia modificado, criado e removido separadamente", () => {
    const antes = { "a.ts": "h1", "b.ts": "h2" };
    const depois = { "a.ts": "h1-mudou", "c.ts": "h3" };
    expect(diffManifests(antes, depois)).toEqual({
      changed: ["a.ts"],
      added: ["c.ts"],
      removed: ["b.ts"],
    });
  });
});
