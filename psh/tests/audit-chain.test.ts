import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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
    // O impedimento e estrutural, nao de permissao: o "diretorio" da trilha e
    // um arquivo comum, entao abrir a trilha dentro dele da ENOTDIR.
    //
    // Usar `chmod 0500` daria certo como usuario comum e falharia como root,
    // que ignora bits de permissao. Runner de CI costuma rodar como root, e um
    // teste que so reprova para alguns usuarios nao esta testando a regra.
    const naoEhDiretorio = join(layout.root, "isto-e-um-arquivo");
    writeFileSync(naoEhDiretorio, "conteudo\n");

    const chain = new AuditChain(join(naoEhDiretorio, "chain.jsonl"));
    expect(() => chain.append("audit.note", "core:psh", { x: 1 })).toThrow(AuditError);
    expect(() => chain.append("audit.note", "core:psh", { x: 1 })).toThrow(/trilha/);
  });

  test("R4.2: trilha que fica ilegivel no meio do caminho tambem e fatal", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 2);
    // Conteudo corrompido no fim: encadear em cima seria inventar continuidade.
    writeFileSync(layout.chainPath, `${readFileSync(layout.chainPath, "utf8")}{quebrado\n`);
    expect(() => chain.append("audit.note", "core:psh", {})).toThrow(AuditError);
    db.close();
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

describe("nao se escreve em cima de trilha adulterada", () => {
  test("append recusa quando o arquivo nao bate com a ancora", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 3);

    // Some com a ultima linha: a cadeia continua internamente consistente, e e
    // exatamente por isso que a ancora existe.
    const linhas = lines(layout.chainPath);
    writeFileSync(layout.chainPath, `${linhas.slice(0, -1).join("\n")}\n`);

    expect(() => chain.append("audit.note", "core:psh", {})).toThrow(AuditError);
    expect(() => chain.append("audit.note", "core:psh", {})).toThrow(/ancora/);
    db.close();
  });

  test("sem a recusa, uma escrita qualquer apagaria o estrago do relatorio", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 3);
    writeFileSync(layout.chainPath, `${lines(layout.chainPath).slice(0, -1).join("\n")}\n`);

    // O `append` regrava a ancora com o topo novo. Se ele nao conferisse antes,
    // a cadeia voltaria a fechar e `verify` diria "integra" para uma trilha de
    // onde uma entrada foi removida.
    expect(chain.verify().ok).toBe(false);
    try {
      chain.append("audit.note", "core:psh", {});
    } catch {
      /* esperado */
    }
    expect(chain.verify().ok).toBe(false);
    db.close();
  });

  test("trilha intacta continua aceitando escrita", () => {
    const { db, chain } = chainWithAnchor();
    seed(chain, 2);
    expect(() => chain.append("audit.note", "core:psh", {})).not.toThrow();
    expect(chain.verify().ok).toBe(true);
    db.close();
  });

  test("a recusa diz como sair, nao so que travou", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 3);
    writeFileSync(layout.chainPath, `${lines(layout.chainPath).slice(0, -1).join("\n")}\n`);

    // Travar sem saida deixa uma alternativa real so: apagar o `.harness` na
    // mao, que e como a evidencia de adulteracao desaparece.
    expect(() => chain.append("audit.note", "core:psh", {})).toThrow(/reanchor/);
    db.close();
  });
});

/**
 * Campo 01, achado 10: a protecao funcionava e nao tinha caminho de volta.
 *
 * Reancorar nao conserta a trilha nem finge que a divergencia nao houve. Ele
 * grava na propria trilha o que a ancora dizia, o que o arquivo diz e por que se
 * decidiu seguir, e so entao move a ancora. Divergencia vira cicatriz legivel em
 * vez de diretorio apagado no susto.
 */
describe("reancoragem e decisao humana registrada, nao conserto silencioso", () => {
  /** Trunca a trilha mantendo o banco intacto: o estado do campo, reproduzido. */
  function divergir(layout: { chainPath: string }, manter: number): void {
    writeFileSync(layout.chainPath, `${lines(layout.chainPath).slice(0, manter).join("\n")}\n`);
  }

  test("destrava o projeto e deixa a divergencia escrita na trilha", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 5);
    divergir(layout, 2);
    expect(chain.verify().ok).toBe(false);

    const { entry, anchorBefore } = chain.reanchor("trilha truncada por restauracao de backup", "human:mike");

    expect(anchorBefore?.count).toBe(5);
    expect(entry.type).toBe("audit.note");
    expect(entry.payload.reason).toBe("trilha truncada por restauracao de backup");
    expect(entry.payload.anchor_before).toEqual({ count: 5, head_hash: anchorBefore!.head_hash });
    expect(entry.payload.file_at_reanchor).toMatchObject({ count: 2 });

    // Destravou de verdade, e o registro da divergencia ficou.
    expect(chain.verify().ok).toBe(true);
    expect(() => chain.append("audit.note", "core:psh", {})).not.toThrow();
    expect(chain.read().some((e) => e.payload.note === "reancoragem da trilha por decisao humana")).toBe(true);
    db.close();
  });

  test("sem motivo escrito nao reancora", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 3);
    divergir(layout, 1);

    expect(() => chain.reanchor("", "human:mike")).toThrow(AuditError);
    expect(() => chain.reanchor("   ", "human:mike")).toThrow(/motivo/);
    expect(chain.verify().ok).toBe(false);
    db.close();
  });

  test("recusa quando o defeito esta dentro do arquivo, porque mover a ancora nao conserta isso", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 3);

    // Edicao de payload no meio: a linha deixa de fechar com o proprio hash.
    const linhas = lines(layout.chainPath);
    const adulterada = JSON.parse(linhas[1]!) as { payload: Record<string, unknown> };
    adulterada.payload = { i: 999 };
    linhas[1] = canonicalJson(adulterada);
    writeFileSync(layout.chainPath, `${linhas.join("\n")}\n`);

    expect(() => chain.reanchor("quero destravar", "human:mike")).toThrow(/nao conserta/);
    expect(chain.verify().ok).toBe(false);
    db.close();
  });

  test("a entrada de reancoragem encadeia no topo real e nao apaga o que sobrou", () => {
    const { layout, db, chain } = chainWithAnchor();
    seed(chain, 4);
    const antes = chain.read();
    divergir(layout, 2);

    const { entry } = chain.reanchor("disco cheio truncou a trilha", "human:mike");
    const depois = chain.read();

    expect(depois).toHaveLength(3);
    expect(depois.slice(0, 2)).toEqual(antes.slice(0, 2));
    expect(entry.prev_hash).toBe(antes[1]!.hash);
    expect(entry.seq).toBe(3);
    db.close();
  });
});
