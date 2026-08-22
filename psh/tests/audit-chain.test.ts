import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditChain, entryHash, GENESIS_HASH, type AuditAnchor } from "../src/audit/chain.ts";
import { HarnessDb } from "../src/db/index.ts";
import { AuditError } from "../src/util/errors.ts";
import { canonicalJson } from "../src/util/json.ts";
import { cleanupTempProjects, tempProject } from "./helpers.ts";

afterAll(cleanupTempProjects);

function chainWithAnchor() {
  const layout = tempProject({ git: false });
  const db = new HarnessDb(layout.dbPath);
  const chain = new AuditChain(layout.chainPath, { anchor: db });
  return { layout, db, chain };
}

function seed(chain: AuditChain, n: number): void {
  for (let i = 0; i < n; i += 1) {
    chain.append("audit.note", "core:psh", { i });
  }
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
}

describe("trilha encadeada por hash (R4.1, R4.2)", () => {
  test("entradas encadeiam a partir do genesis e a cadeia verifica", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 3);
    const entries = chain.read();
    expect(entries[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(entries[1]!.prev_hash).toBe(entries[0]!.hash);
    expect(entries[2]!.seq).toBe(3);

    const result = chain.verify();
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(3);
    expect(result.candidates_examined).toBe(3);
    db.close();
    void layout;
  });

  test("remover uma linha do meio e detectado", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 4);
    const all = lines(layout.chainPath);
    writeFileSync(layout.chainPath, `${[all[0], all[2], all[3]].join("\n")}\n`);

    const result = chain.verify();
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.kind)).toContain("link-broken");
    expect(result.problems.map((p) => p.kind)).toContain("seq-mismatch");
    db.close();
  });

  test("remover a ultima linha e detectado pela ancora, mesmo com a cadeia internamente coerente", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 3);
    const all = lines(layout.chainPath);
    writeFileSync(layout.chainPath, `${all.slice(0, 2).join("\n")}\n`);

    const result = chain.verify();
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.kind)).toContain("anchor-count-mismatch");
    expect(result.problems.map((p) => p.kind)).toContain("anchor-head-mismatch");
    db.close();
  });

  test("editar o payload de uma entrada quebra o hash daquela linha", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 3);
    const all = lines(layout.chainPath);
    const alvo = JSON.parse(all[1]!) as { payload: Record<string, unknown> };
    alvo.payload = { i: 999 };
    all[1] = canonicalJson(alvo);
    writeFileSync(layout.chainPath, `${all.join("\n")}\n`);

    const result = chain.verify();
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.kind)).toContain("hash-mismatch");
    db.close();
  });

  test("reordenar duas entradas e detectado", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 3);
    const all = lines(layout.chainPath);
    writeFileSync(layout.chainPath, `${[all[0], all[2], all[1]].join("\n")}\n`);

    const result = chain.verify();
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.kind)).toContain("seq-mismatch");
    db.close();
  });

  test("reescrita coordenada da cadeia inteira e pega pela ancora fora do arquivo", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 3);

    // Adversario refaz a trilha do zero, com hashes internamente perfeitos,
    // escondendo a segunda entrada.
    let prev = GENESIS_HASH;
    const forjadas: string[] = [];
    for (let seq = 1; seq <= 2; seq += 1) {
      const base = {
        seq,
        ts: `2026-01-0${seq}T00:00:00.000Z`,
        type: "audit.note" as const,
        actor: "core:psh",
        payload: { i: seq },
        prev_hash: prev,
      };
      const hash = entryHash(base);
      forjadas.push(canonicalJson({ ...base, hash }));
      prev = hash;
    }
    writeFileSync(layout.chainPath, `${forjadas.join("\n")}\n`);

    const semAncora = new AuditChain(layout.chainPath).verify();
    expect(semAncora.ok).toBe(true); // internamente coerente: so o elo nao basta

    const result = chain.verify();
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.kind)).toContain("anchor-head-mismatch");
    db.close();
  });

  test("linha corrompida no fim impede encadear em cima, em vez de continuar em silencio", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 2);
    writeFileSync(layout.chainPath, `${readFileSync(layout.chainPath, "utf8")}{lixo\n`);
    expect(() => chain.append("audit.note", "core:psh", {})).toThrow(AuditError);
    db.close();
  });

  test("R4.2: falha de escrita na trilha e erro fatal, nunca aviso", () => {
    const layout = tempProject({ git: false });
    const dir = join(layout.root, "somente-leitura");
    mkdirSync(dir, { recursive: true });
    const chain = new AuditChain(join(dir, "chain.jsonl"));
    chain.append("audit.note", "core:psh", { primeiro: true });
    chmodSync(dir, 0o500);
    try {
      expect(() => chain.append("audit.note", "core:psh", { segundo: true })).toThrow(AuditError);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("cadeia vazia com ancora ausente e valida; ancora sem cadeia e denunciada", () => {
    const { layout, db, chain } = chainWithAnchor();
    expect(chain.verify().ok).toBe(true);

    const mentira: AuditAnchor = { count: 5, head_hash: "sha256:deadbeef" };
    db.writeAnchor(mentira);
    const result = chain.verify();
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.kind)).toContain("anchor-count-mismatch");
    void layout;
    db.close();
  });
});
