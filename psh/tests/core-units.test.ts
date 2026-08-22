import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessDb } from "../src/db/index.ts";
import { findProjectRoot, layoutFor, requireLayout, toRel } from "../src/util/paths.ts";
import { PshError } from "../src/util/errors.ts";
import { sha256, sha256Canonical, sha256File, sha256FilePrefixed, sha256Prefixed } from "../src/util/hash.ts";
import { canonicalJson, writeJsonAtomic, readJsonFile } from "../src/util/json.ts";
import { parseWorkflow } from "../src/workflow/load.ts";
import failureProtocol from "../src/workflow/profiles/failure-protocol.json" with { type: "json" };
import { cleanupTempProjects, tempProject } from "./helpers.ts";

afterAll(cleanupTempProjects);

describe("indice em SQLite", () => {
  test("eventos entram e saem em ordem, com o mais recente primeiro", () => {
    const db = new HarnessDb(":memory:");
    for (const [i, ts] of ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"].entries()) {
      db.insertEvent({
        id: `ev${i}`,
        ts,
        kind: "phase.transition",
        from_phase: "a",
        to_phase: "b",
        attempt: 1,
        verdict: "passed",
        failure_class: null,
        evidence_ids: "[]",
        audit_seq: i + 1,
        detail: "{}",
      });
    }
    const events = db.listEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe("ev1");
    expect(db.listEvents(1)).toHaveLength(1);
    db.close();
  });

  test("a evidencia mais recente de um verificador e a que o indice devolve", () => {
    const db = new HarnessDb(":memory:");
    const base = {
      verifier: "coverage",
      phase: "build",
      attempt: 1,
      status: "ok",
      exit_code: 0,
      signal: null,
      workspace_hash: "sha256:x",
      candidates_examined: 3,
      artifact: null,
      sandbox_mode: "degraded",
    };
    db.insertEvidence({ ...base, id: "e1", value: 70, started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:01:00Z" });
    db.insertEvidence({ ...base, id: "e2", value: 90, started_at: "2026-01-02T00:00:00Z", finished_at: "2026-01-02T00:01:00Z" });

    expect(db.latestEvidence("coverage")).toMatchObject({ id: "e2", value: 90 });
    expect(db.latestEvidence("inexistente")).toBeNull();
    db.close();
  });

  test("o contador de tentativa e sobrescrito no lugar, sem duplicar a fase", () => {
    const db = new HarnessDb(":memory:");
    expect(db.getAttempt("build")).toBeNull();
    db.putAttempt({ phase: "build", attempt: 1, retries_used: 0, updated_at: "t0" });
    db.putAttempt({ phase: "build", attempt: 2, retries_used: 1, updated_at: "t1" });
    expect(db.getAttempt("build")).toMatchObject({ attempt: 2, retries_used: 1, updated_at: "t1" });
    db.close();
  });

  test("a ancora comeca ausente e passa a refletir a ultima escrita", () => {
    const db = new HarnessDb(":memory:");
    expect(db.readAnchor()).toBeNull();
    db.writeAnchor({ count: 2, head_hash: "sha256:aa" });
    db.writeAnchor({ count: 3, head_hash: "sha256:bb" });
    expect(db.readAnchor()).toEqual({ count: 3, head_hash: "sha256:bb" });
    db.close();
  });
});

describe("resolucao de raiz de projeto", () => {
  test("a raiz e encontrada a partir de um subdiretorio profundo", () => {
    const layout = tempProject({ git: false });
    const fundo = join(layout.root, "a", "b", "c");
    mkdirSync(fundo, { recursive: true });
    expect(findProjectRoot(fundo)).toBe(layout.root);
    expect(requireLayout(fundo).harness).toBe(layout.harness);
  });

  test("sem .harness em nenhum ancestral, a mensagem manda rodar init", () => {
    // A raiz do sistema nunca tem .harness/, entao a busca chega ao topo.
    expect(() => findProjectRoot("/")).toThrow(PshError);
    expect(() => findProjectRoot("/")).toThrow(/psh init/);
  });

  test("o layout deriva todos os caminhos da mesma raiz", () => {
    const layout = layoutFor("/tmp/exemplo");
    expect(layout.chainPath).toBe("/tmp/exemplo/.harness/audit/chain.jsonl");
    expect(layout.dbPath).toBe("/tmp/exemplo/.harness/harness.db");
    expect(toRel("/tmp/exemplo", "/tmp/exemplo/src/a.ts")).toBe("src/a.ts");
  });
});

describe("hash e serializacao canonica", () => {
  test("a ordem das chaves nao muda o hash canonico", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(sha256Canonical({ b: 1, a: 2 })).toBe(sha256Canonical({ a: 2, b: 1 }));
  });

  test("chave com valor undefined e omitida, e arrays preservam a ordem", () => {
    expect(canonicalJson({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });

  test("hash de arquivo e de string batem para o mesmo conteudo", () => {
    const layout = tempProject({ git: false });
    const path = join(layout.root, "x.txt");
    writeFileSync(path, "conteudo");
    expect(sha256File(path)).toBe(sha256("conteudo"));
    expect(sha256FilePrefixed(path)).toBe(sha256Prefixed("conteudo"));
  });

  test("escrita atomica sobrevive a leitura imediata e recusa JSON quebrado depois", () => {
    const layout = tempProject({ git: false });
    const path = join(layout.root, "d.json");
    writeJsonAtomic(path, { a: 1 });
    expect(readJsonFile<{ a: number }>(path)).toEqual({ a: 1 });

    writeFileSync(path, "{quebrado");
    expect(() => readJsonFile(path)).toThrow(/JSON invalido/);
    expect(() => readJsonFile(join(layout.root, "nao-existe.json"))).toThrow(/nao foi possivel ler/);
  });
});

describe("indices do contrato carregado", () => {
  const contrato = {
    _type: "psh-workflow",
    version: 1,
    profile: "strict",
    entry: "b",
    verifiers: [
      { id: "tests", run: ["true"], extract: { kind: "exit-code" }, watch: ["src/**"], timeout_s: 10 },
    ],
    phases: [
      {
        id: "a",
        name: "A",
        terminal: true,
        next: [],
        gate: { type: "none", checks: [], on_fail: { action: "block", message: "-" } },
        on_failure: { class: "quality", max_auto_retries: 0 },
      },
      {
        id: "b",
        name: "B",
        terminal: false,
        next: ["a"],
        gate: {
          type: "all-of",
          checks: [{ kind: "verifier-status", verifier: "tests" }],
          on_fail: { action: "block", message: "-" },
        },
        on_failure: { class: "transient", max_auto_retries: 3 },
      },
    ],
    failure_protocol: failureProtocol,
  };

  test("entry declarado ganha da ordem das fases", () => {
    const wf = parseWorkflow(contrato, "<t>");
    expect(wf.entryPhase).toBe("b");
    expect(wf.profile).toBe("strict");
    expect(wf.phases).toHaveLength(2);
    expect(wf.verifiers.map((v) => v.id)).toEqual(["tests"]);
    expect(wf.phase("z")).toBeUndefined();
    expect(wf.verifier("z")).toBeUndefined();
  });

  test("os defaults de retry vem do protocolo de falha portado", () => {
    const wf = parseWorkflow(contrato, "<t>");
    expect(wf.failureClass("transient")).toMatchObject({
      max_auto_retries: 3,
      backoff: "exponential",
      delays_ms: [1000, 3000, 9000],
      on_exhaustion: "escalate",
    });
    expect(wf.failureClass("user-action").on_exhaustion).toBe("block");
    expect(wf.failureClass("fatal").on_exhaustion).toBe("halt");
  });
});
