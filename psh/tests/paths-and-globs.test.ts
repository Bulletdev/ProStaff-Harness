import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GIT_AVAILABLE } from "./helpers.ts";
import { compileGlobs, normalizeRel } from "../src/util/globs.ts";
import { diffManifests, hashWorkspace, probeGit } from "../src/evidence/workspace.ts";
import {
  HARNESS_OBSERVABLE_PATHS,
  HARNESS_RUNTIME_PATHS,
  isInside,
  layoutFor,
  toRel,
} from "../src/util/paths.ts";
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

  /**
   * Campo 01, achado 4.
   *
   * `isGitRepo` era `existsSync(join(root, ".git"))`, que so acerta o projeto que
   * e a raiz do repositorio. Qualquer app dentro de um repositorio maior, que e o
   * layout de monorepo e foi o caso da cobaia, caia para caminhada: o `.gitignore`
   * parava de valer para o hash da arvore e entravam nele o `.env` com chave real,
   * o diretorio de relatorio e um binario de node vendorizado de 100 MB.
   *
   * O `psh doctor` ainda chamava isso de `[ok] enumeracao por caminhada`, com o
   * detalhe "projeto nao e repositorio Git", enquanto o `checkSecrets` do mesmo
   * doctor usava `git ls-files` no mesmo diretorio sem problema nenhum.
   */
  test.skipIf(!GIT_AVAILABLE)("app dentro de repositorio maior continua sob Git", () => {
    const repo = hostileDir();
    spawnSync("git", ["init", "-q", "."], { cwd: repo });
    const app = join(repo, "apps", "web");
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    writeFileSync(join(app, "src", "a.ts"), "x\n");
    writeFileSync(join(app, ".env"), "OPENAI_API_KEY=sk-real\n");

    // Sem `.git/` proprio, e ainda assim um projeto sob Git.
    expect(existsSync(join(app, ".git"))).toBe(false);
    const manifest = hashWorkspace(app, { watch: ["**"] });
    expect(manifest.enumeration).toBe("git");
    expect(Object.keys(manifest.files)).toEqual(["src/a.ts"]);
    expect(probeGit(app).available).toBe(true);
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

  /**
   * Campo 01, residuo do achado 2.
   *
   * A lista de exclusao cobria quatro caminhos enquanto o `Layout` ja tinha sete
   * diretorios de runtime, entao `memory/`, `approvals/`, `reviews/` e `tmp/`
   * entravam no hash. O efeito medido na cobaia: um `psh memory consolidate`
   * entre a medicao e o portao derrubava a evidencia de um verificador que
   * observa `**`, citando arquivo que nenhum verificador escreveu. E o `secrets`
   * que vem no `common.json` observa exatamente `**`.
   *
   * Num projeto Git o `.harness/.gitignore` mascarava parte disso. Fora do Git,
   * ou num app dentro de repositorio maior, aparecia inteiro.
   */
  test("operacao do proprio harness nao derruba evidencia de quem observa **", () => {
    const root = hostileDir();
    writeFileSync(join(root, "src", "a.ts"), "x\n");
    for (const sub of ["evidence", "audit", "memory/pages", "approvals", "reviews", "tmp"]) {
      mkdirSync(join(root, ".harness", ...sub.split("/")), { recursive: true });
    }
    const antes = hashWorkspace(root, { watch: ["**"] });

    // Tudo o que o nucleo escreve enquanto opera, de uma vez.
    writeFileSync(join(root, ".harness", "state.json"), '{"attempt":2}\n');
    writeFileSync(join(root, ".harness", "harness.db-wal"), "wal\n");
    writeFileSync(join(root, ".harness", "memory", "consolidation.json"), "{}\n");
    writeFileSync(join(root, ".harness", "memory", "pages", "sessao-0001.md"), "# pagina\n");
    writeFileSync(join(root, ".harness", "approvals", "abc.json"), "{}\n");
    writeFileSync(join(root, ".harness", "reviews", "r1.json"), "{}\n");
    writeFileSync(join(root, ".harness", "tmp", "boundary-1-x"), "rascunho\n");
    writeFileSync(join(root, ".harness", "audit", "chain.jsonl"), "{}\n");
    writeFileSync(join(root, ".harness", "evidence", "tudo.json"), "{}\n");

    expect(hashWorkspace(root, { watch: ["**"] }).hash).toBe(antes.hash);
  });

  test("contrato e documento de fase continuam observaveis dentro do .harness", () => {
    const root = hostileDir();
    writeFileSync(join(root, "src", "a.ts"), "x\n");
    mkdirSync(join(root, ".harness", "sprints"), { recursive: true });
    writeFileSync(join(root, ".harness", "workflow.json"), "{}\n");
    writeFileSync(join(root, ".harness", "SPEC.md"), "# spec\n");
    writeFileSync(join(root, ".harness", "sprints", "s1.md"), "# sprint\n");
    const antes = hashWorkspace(root, { watch: ["**"] });

    // Esconder isto seria pior que o bug: e material de portao.
    writeFileSync(join(root, ".harness", "SPEC.md"), "# spec editada\n");
    expect(hashWorkspace(root, { watch: ["**"] }).hash).not.toBe(antes.hash);
  });

  test("a exclusao aparece no manifesto, contada e nomeada", () => {
    const root = hostileDir();
    writeFileSync(join(root, "src", "a.ts"), "x\n");
    mkdirSync(join(root, ".harness", "memory"), { recursive: true });
    writeFileSync(join(root, ".harness", "memory", "consolidation.json"), "{}\n");
    writeFileSync(join(root, ".harness", "state.json"), "{}\n");

    // Exclusao silenciosa e como um arquivo deixa de ser visto sem ninguem
    // perceber. Ela decide medicao, entao mora no registro da medicao.
    const manifest = hashWorkspace(root, { watch: ["**"] });
    expect(manifest.harness_artifacts_skipped).toBe(2);
    expect(manifest.harness_artifacts_excluded).toContain(".harness/memory/");
  });

  /**
   * O defeito nao foi a lista estar errada, foi ela ter envelhecido calada
   * enquanto o `Layout` crescia. Este teste e o que cobra a sincronia: qualquer
   * caminho novo no `Layout` tem que ser classificado como artefato de runtime
   * ou como observavel, e a escolha fica explicita em vez de omitida.
   */
  test("todo caminho do Layout esta classificado como runtime ou observavel", () => {
    const layout = layoutFor("/proj");
    const declarados = [...HARNESS_RUNTIME_PATHS, ...HARNESS_OBSERVABLE_PATHS];
    const cobre = (prefixo: string, rel: string): boolean => {
      const semBarra = prefixo.endsWith("/") ? prefixo.slice(0, -1) : prefixo;
      return rel === prefixo || rel === semBarra || rel.startsWith(prefixo);
    };
    const naoClassificados = Object.entries(layout)
      .filter(([chave]) => chave !== "root" && chave !== "harness")
      .map(([, abs]) => toRel("/proj", abs))
      .filter((rel) => !declarados.some((p) => cobre(p, rel)));

    expect(naoClassificados).toEqual([]);
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
