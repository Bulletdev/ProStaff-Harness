import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/index.ts";
import { captureIo } from "../src/cli/io.ts";
import { AuditError, ContractError, EXIT } from "../src/util/errors.ts";
import { openProject } from "../src/cli/context.ts";
import { consolidate, remember } from "../src/cli/memory.ts";
import { buildHandoff } from "../src/memory/handoff.ts";
import { searchMemory } from "../src/memory/search.ts";
import {
  buildDigest,
  consolidationStatePath,
  entradasPendentes,
  narrarDaTrilha,
  readConsolidationState,
  tituloDoDigest,
} from "../src/memory/consolidate.ts";
import { advance } from "../src/workflow/advance.ts";
import type { AuditEntry } from "../src/audit/chain.ts";
import type { WorkflowContract } from "../src/workflow/types.ts";
import type { Layout } from "../src/util/paths.ts";
import { cleanupTempProjects, harnessWith, tempProject, writeFile } from "./helpers.ts";

afterAll(cleanupTempProjects);

let restaurar: (() => void) | null = null;
afterEach(() => {
  restaurar?.();
  restaurar = null;
});

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const cap = captureIo();
  restaurar = cap.restore;
  const code = await runCli(argv);
  cap.restore();
  restaurar = null;
  return { code, out: cap.out.join(""), err: cap.err.join("") };
}

const VAZIO: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
  profile: "gate-only",
  verifiers: [],
  phases: [],
};

function projeto(): Layout {
  const layout = tempProject({ git: false });
  harnessWith(layout, VAZIO).close();
  return layout;
}

function paginas(layout: Layout): string[] {
  return existsSync(layout.memoryPagesDir) ? readdirSync(layout.memoryPagesDir).sort() : [];
}

function entrada(seq: number, type: AuditEntry["type"], actor: string, payload: Record<string, unknown>): AuditEntry {
  return { seq, ts: "2026-08-23T10:00:00.000Z", type, actor, payload, prev_hash: "sha256:x", hash: "sha256:y" };
}

describe("digest: cada linha sai de uma entrada da trilha", () => {
  test("classifica fase, verificador, anotacao, violacao e decisao humana", () => {
    const digest = buildDigest([
      entrada(1, "harness.init", "human:cli", { profile: "lean", stack: "bun" }),
      entrada(2, "phase.transition", "core:psh", {
        from_phase: "build",
        to_phase: "review",
        attempt: 2,
        verdict: "passed",
        gate: { passed: true },
      }),
      entrada(3, "verifier.run", "core:psh", {
        verifier: "coverage",
        phase: "build",
        status: "ok",
        value: 87,
        exit_code: 0,
        error: null,
      }),
      entrada(4, "memory.write", "human:x", { slug: "fato", kind: "fact", pinned: true }),
      entrada(5, "boundary.decision", "agent:backend", { action: "violacao", path: "src/web/app.tsx" }),
      entrada(6, "human.approval", "human:michael", { subject: "docs/PRD.md" }),
      entrada(7, "command.exec", "agent:backend", { exit_code: 1, destructive_alerts: ["rm-rf"] }),
    ]);

    expect(digest.from_seq).toBe(1);
    expect(digest.to_seq).toBe(7);
    expect(digest.entries_examined).toBe(7);
    expect(digest.marcos[0]!.descricao).toContain("perfil lean");
    expect(digest.fases[0]).toMatchObject({ from: "build", to: "review", attempt: 2, verdict: "passed" });
    expect(digest.verificadores[0]).toMatchObject({ verifier: "coverage", value: 87, status: "ok" });
    expect(digest.anotacoes[0]).toMatchObject({ slug: "fato", pinned: true });
    expect(digest.violacoes[0]!.path).toBe("src/web/app.tsx");
    expect(digest.decisoes.map((d) => d.tipo)).toContain("aprovacao");
    expect(digest.comandos).toMatchObject({ total: 1, falharam: 1, alertas: ["rm-rf"] });
  });

  test("override entra como fase e como decisao humana, com o motivo declarado", () => {
    const digest = buildDigest([
      entrada(1, "human.override", "human:michael", {
        from_phase: "build",
        to_phase: "review",
        attempt: 1,
        verdict: "passed-with-override",
        reason: "prazo do cliente",
        gate: { passed: false },
      }),
    ]);
    expect(digest.fases[0]!.override).toBe(true);
    const decisao = digest.decisoes.find((d) => d.tipo === "override")!;
    expect(decisao.motivo).toBe("prazo do cliente");
  });

  test("promocao encosta na anotacao que ja estava na sessao", () => {
    const digest = buildDigest([
      entrada(1, "memory.write", "human:x", { slug: "decisao", kind: "decision", pinned: true }),
      entrada(2, "memory.promote", "human:x", { slug: "decisao", to: "docs/decisoes/decisao.md" }),
    ]);
    expect(digest.anotacoes).toHaveLength(1);
    expect(digest.anotacoes[0]!.promoted_to).toBe("docs/decisoes/decisao.md");
  });

  test("o pedido do usuario, capturado pelo adapter, vira secao da pagina (R5.1)", () => {
    const digest = buildDigest([
      entrada(1, "adapter.event", "adapter:claude-code", {
        event: "SessionStart",
        source: "startup",
        injected_chars: 900,
      }),
      entrada(2, "prompt.submit", "human:sessao", {
        text: "arruma o endpoint de login\ne roda os testes",
        chars: 42,
        truncated: false,
        redacted: false,
      }),
      entrada(3, "prompt.submit", "human:sessao", { text: null, chars: 55, truncated: false, redacted: true }),
      entrada(4, "adapter.event", "adapter:claude-code", { event: "SessionEnd", reason: "clear" }),
    ]);

    expect(digest.pedidos).toHaveLength(2);
    expect(digest.marcos).toHaveLength(2);
    // Evento do proprio adapter nao pode cair em "esta versao nao resume":
    // a consolidacao ficaria cega justo para o que o adapter acabou de gravar.
    expect(digest.nao_classificadas).toEqual({});

    const texto = narrarDaTrilha(digest);
    expect(texto).toContain("## Pedidos do usuario");
    expect(texto).toContain("arruma o endpoint de login");
    expect(texto).toContain("marcador de segredo");
    expect(texto).toContain("sessao aberta pelo adapter (startup)");
    expect(texto).toContain("sessao encerrada pelo adapter (clear)");
    expect(tituloDoDigest(digest)).toContain("2 pedido(s)");
  });

  test("pedido longo entra pela primeira linha, com o corte declarado", () => {
    const digest = buildDigest([
      entrada(1, "prompt.submit", "human:sessao", {
        text: "a".repeat(300),
        chars: 5000,
        truncated: true,
        redacted: false,
      }),
    ]);
    const texto = narrarDaTrilha(digest);
    expect(texto).toContain("...");
    expect(texto).toContain("(cortado)");
  });

  test("promocao de pagina antiga entra sozinha, sem inventar anotacao nova", () => {
    const digest = buildDigest([
      entrada(1, "memory.promote", "human:x", { slug: "de-outra-sessao", to: "docs/decisoes/x.md" }),
    ]);
    expect(digest.anotacoes).toEqual([
      { slug: "de-outra-sessao", kind: "promovida", pinned: false, promoted_to: "docs/decisoes/x.md", seq: 1 },
    ]);
  });

  test("tipo que esta versao nao resume e contado, nunca sumido (R2.13)", () => {
    const digest = buildDigest([
      entrada(1, "maestro.call", "core:psh", { model: "x" }),
      entrada(2, "maestro.call", "core:psh", { model: "y" }),
    ]);
    expect(digest.nao_classificadas).toEqual({ "maestro.call": 2 });
    expect(narrarDaTrilha(digest)).toContain("maestro.call: 2");
  });

  test("toda secao do digest chega ao texto da pagina", () => {
    const digest = buildDigest([
      entrada(1, "harness.init", "human:cli", { profile: "lean", stack: "bun" }),
      entrada(2, "phase.transition", "core:psh", {
        from_phase: "build",
        to_phase: "review",
        attempt: 1,
        verdict: "passed",
        gate: { passed: true },
      }),
      entrada(3, "verifier.run", "core:psh", {
        verifier: "coverage",
        status: "error",
        value: null,
        exit_code: 2,
        error: { message: "relatorio ausente" },
      }),
      entrada(4, "boundary.decision", "agent:backend", { action: "violacao", path: "src/web/a.tsx", result: "reverted" }),
      entrada(5, "boundary.decision", "human:michael", { action: "allowlist-add", glob: "src/api/**" }),
      entrada(6, "human.approval", "human:michael", { subject: "docs/PRD.md" }),
      entrada(7, "memory.write", "human:michael", { slug: "fato", kind: "fact", pinned: true }),
      entrada(8, "memory.promote", "human:michael", { slug: "fato", to: "docs/decisoes/fato.md" }),
      entrada(9, "command.exec", "agent:backend", { exit_code: 0, destructive_alerts: ["rm-rf"] }),
      entrada(10, "tool.call", "agent:backend", {}),
    ]);
    const texto = narrarDaTrilha(digest);

    for (const secao of [
      "## Marcos",
      "## Fases",
      "## Verificadores",
      "## Fronteira",
      "## Decisoes humanas",
      "## Anotacoes da sessao",
      "## Comandos sob fronteira",
      "## Entradas que esta versao nao resume",
    ]) {
      expect(texto).toContain(secao);
    }
    expect(texto).toContain("relatorio ausente");
    expect(texto).toContain("src/web/a.tsx");
    expect(texto).toContain("promovida para docs/decisoes/fato.md");
    expect(texto).toContain("Alertas de comando destrutivo: rm-rf");
    expect(texto).toContain("tool.call: 1");
    expect(tituloDoDigest(digest)).toContain("build para review");
  });

  test("sem fase, o titulo diz o que houve em vez de mentir", () => {
    const soVerificador = buildDigest([
      entrada(1, "verifier.run", "core:psh", { verifier: "lint", status: "ok", value: 0, exit_code: 0 }),
    ]);
    expect(tituloDoDigest(soVerificador)).toContain("1 verificacao(oes)");

    const soRuido = buildDigest([entrada(1, "tool.call", "agent:x", {})]);
    expect(tituloDoDigest(soRuido)).toContain("1 entrada(s) na trilha");
  });

  test("a narracao carrega o numero da entrada de origem em cada linha", () => {
    const texto = narrarDaTrilha(
      buildDigest([
        entrada(9, "verifier.run", "core:psh", { verifier: "lint", status: "error", value: null, exit_code: 2 }),
      ]),
    );
    expect(texto).toContain("`#9` lint: error");
    expect(texto).toContain("sem chamada de modelo");
  });
});

describe("psh memory consolidate", () => {
  test("a sessao vira pagina, e a pagina entra na busca", async () => {
    const layout = projeto();
    await cli(["remember", "nao mexer no gerador", "--root", layout.root]);

    const r = await cli(["memory", "consolidate", "--json", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    const resultado = JSON.parse(r.out) as { slug: string; entries_examined: number };
    expect(resultado.slug).toStartWith("sessao-");
    expect(resultado.entries_examined).toBeGreaterThan(0);

    const ctx = openProject(layout.root);
    try {
      const hits = searchMemory(ctx.db, ctx.layout, "trilha", 5).hits;
      expect(hits.map((h) => h.slug)).toContain(resultado.slug);
    } finally {
      ctx.close();
    }
  });

  test("rodar duas vezes nao gera pagina que so fala da anterior", async () => {
    const layout = projeto();
    await cli(["remember", "um fato", "--root", layout.root]);

    await cli(["memory", "consolidate", "--root", layout.root]);
    const segunda = await cli(["memory", "consolidate", "--root", layout.root]);
    const terceira = await cli(["memory", "consolidate", "--root", layout.root]);

    expect(segunda.out).toContain("nada a consolidar");
    expect(terceira.out).toContain("nada a consolidar");
    expect(paginas(layout).filter((p) => p.startsWith("sessao-"))).toHaveLength(1);
  });

  test("a marca d'agua avanca mesmo quando nao ha pagina, senao o bookkeeping se acumula", async () => {
    const layout = projeto();
    await cli(["remember", "um fato", "--root", layout.root]);
    await cli(["memory", "consolidate", "--root", layout.root]);

    const antes = readConsolidationState(layout).last_seq;
    await cli(["memory", "consolidate", "--root", layout.root]);
    expect(readConsolidationState(layout).last_seq).toBeGreaterThan(antes);
  });

  test("--dry-run nao escreve pagina, nem marca d'agua, nem trilha", async () => {
    const layout = projeto();
    await cli(["remember", "um fato", "--root", layout.root]);
    const antes = readFileSync(layout.chainPath, "utf8");

    const r = await cli(["memory", "consolidate", "--dry-run", "--root", layout.root]);
    expect(r.out).toContain("consolidaria");
    expect(paginas(layout).some((p) => p.startsWith("sessao-"))).toBe(false);
    expect(existsSync(consolidationStatePath(layout))).toBe(false);
    expect(readFileSync(layout.chainPath, "utf8")).toBe(antes);
  });

  test("a marca d'agua sobrevive a perda do indice de memoria", async () => {
    const layout = projeto();
    await cli(["remember", "um fato", "--root", layout.root]);
    await cli(["memory", "consolidate", "--root", layout.root]);

    // O indice de memoria e descartavel por construcao. Se a marca morasse
    // nele, joga-lo fora faria a proxima consolidacao varrer a trilha inteira
    // de novo e despejar tudo numa pagina so.
    const ctx = openProject(layout.root);
    try {
      for (const linha of ctx.db.listMemoryPages({ limit: 100 })) ctx.db.deleteMemoryPage(linha.slug);
      expect(ctx.db.listMemoryPages({ limit: 100 })).toHaveLength(0);
    } finally {
      ctx.close();
    }

    const r = await cli(["memory", "consolidate", "--root", layout.root]);
    expect(r.out).toContain("nada a consolidar");
    expect(paginas(layout).filter((p) => p.startsWith("sessao-"))).toHaveLength(1);
  });

  test("perder o banco leva a ancora junto, e isso e falha de auditoria", async () => {
    const layout = projeto();
    await cli(["remember", "um fato", "--root", layout.root]);

    // O banco nao e so indice: a ancora do topo da cadeia mora nele (R4.1).
    // Sem ela a trilha deixa de ser conferivel, e resumir o que nao se sustenta
    // seria assinar como memoria um relato sem prova.
    rmSync(layout.dbPath, { force: true });
    const r = await cli(["memory", "consolidate", "--root", layout.root]);
    expect(r.code).toBe(EXIT.AUDIT_BROKEN);
    expect(r.err).toContain("trilha comprometida");
    expect(paginas(layout).some((p) => p.startsWith("sessao-"))).toBe(false);
  });

  test("trilha comprometida nao vira memoria", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      remember(ctx, { fact: "um fato" });
    } finally {
      ctx.close();
    }
    const linhas = readFileSync(layout.chainPath, "utf8").split("\n").filter((l) => l !== "");
    writeFileSync(layout.chainPath, `${linhas.slice(0, -1).join("\n")}\n`);

    const ctx2 = openProject(layout.root);
    try {
      expect(() => consolidate(ctx2)).toThrow(AuditError);
      expect(paginas(layout).some((p) => p.startsWith("sessao-"))).toBe(false);
    } finally {
      ctx2.close();
    }
  });

  test("marca d'agua adiante do topo da trilha e problema de auditoria, nao de memoria", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      remember(ctx, { fact: "um fato" });
      writeFileSync(
        consolidationStatePath(layout),
        JSON.stringify({
          _type: "psh-memory-consolidation",
          version: 1,
          last_seq: 9999,
          last_slug: null,
          updated_at: "2026-08-23T10:00:00.000Z",
        }),
      );
      expect(() => entradasPendentes(ctx.chain, readConsolidationState(layout))).toThrow(ContractError);
      expect(() => entradasPendentes(ctx.chain, readConsolidationState(layout))).toThrow(/a trilha encolheu|trilha termina/i);
    } finally {
      ctx.close();
    }
  });

  test("marca d'agua corrompida para de vez, em vez de recomecar do zero", async () => {
    const layout = projeto();
    await cli(["remember", "um fato", "--root", layout.root]);
    await cli(["memory", "consolidate", "--root", layout.root]);
    writeFileSync(consolidationStatePath(layout), '{"_type":"outra-coisa"}');

    const r = await cli(["memory", "consolidate", "--root", layout.root]);
    expect(r.code).toBe(EXIT.CONTRACT_INVALID);
    expect(paginas(layout).filter((p) => p.startsWith("sessao-"))).toHaveLength(1);
  });
});

describe("a pagina de sessao no fluxo real", () => {
  test("uma transicao de fase de verdade aparece na consolidacao", () => {
    const layout = tempProject({ git: false });
    const h = harnessWith(layout, {
      profile: "lean",
      verifiers: [],
      phases: [
        {
          id: "build",
          name: "Build",
          terminal: false,
          next: ["fim"],
          gate: {
            type: "all-of",
            checks: [{ kind: "presence", file: "existe.md", min_lines: 1 }],
            on_fail: { action: "block", message: "artefato ausente" },
          },
          on_failure: { class: "quality", max_auto_retries: 1 },
        },
        {
          id: "fim",
          name: "Fim",
          terminal: true,
          next: [],
          gate: { type: "none", checks: [], on_fail: { action: "block", message: "-" } },
          on_failure: { class: "quality", max_auto_retries: 0 },
        },
      ],
    });
    writeFile(layout, "existe.md", "conteudo\n");
    const decisao = advance({ layout, workflow: h.workflow, db: h.db, chain: h.chain });
    expect(decisao.decision).toBe("advanced");
    h.close();

    const ctx = openProject(layout.root);
    try {
      const r = consolidate(ctx);
      expect(r.digest.fases).toHaveLength(1);
      expect(r.digest.fases[0]).toMatchObject({ from: "build", to: "fim" });
      // O payload real da transicao e o mesmo que o classificador espera.
      expect(r.digest.nao_classificadas["phase.transition"]).toBeUndefined();
      expect(readFileSync(r.path!, "utf8")).toContain("build -> fim");
    } finally {
      ctx.close();
    }
  });

  test("a pagina de sessao nasce solta e cai em 'memoria recente' do handoff", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      remember(ctx, { fact: "fato fixado" });
      const r = consolidate(ctx);
      const h = buildHandoff(ctx);

      // Fixada e o que o humano fixou; resumo de sessao nao vira permanente so
      // por ser recente (R5.5).
      expect(h.pinned.map((p) => p.slug)).toEqual(["fato-fixado"]);
      expect(h.recent.map((p) => p.slug)).toEqual([r.slug!]);
    } finally {
      ctx.close();
    }
  });
});
