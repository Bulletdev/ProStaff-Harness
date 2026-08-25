import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/index.ts";
import { captureIo } from "../src/cli/io.ts";
import { EXIT } from "../src/util/errors.ts";
import { AuditChain } from "../src/audit/chain.ts";
import { DENY_ALWAYS } from "../src/boundary/policy.ts";
import { buildHandoff, renderHandoff, MAX_PINNED_NO_BLOCO } from "../src/memory/handoff.ts";
import { openProject } from "../src/cli/context.ts";
import { remember } from "../src/cli/memory.ts";
import { boundaryOf } from "../src/cli/boundary.ts";
import { execUnderBoundary } from "../src/boundary/execute.ts";
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

const CONTRATO: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
  profile: "gate-only",
  verifiers: [],
  phases: [],
};

function projeto(): Layout {
  const layout = tempProject({ git: false });
  harnessWith(layout, CONTRATO).close();
  return layout;
}

function trilha(layout: Layout) {
  return new AuditChain(layout.chainPath).read();
}

describe("psh remember (R5.5)", () => {
  test("anota, fixa e deixa a pagina em disco", async () => {
    const layout = projeto();
    const r = await cli(["remember", "o ai-jail recusa rw-map sobreposto", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);

    const pagina = join(layout.memoryPagesDir, "o-ai-jail-recusa-rw-map-sobreposto.md");
    expect(existsSync(pagina)).toBe(true);
    const texto = readFileSync(pagina, "utf8");
    expect(texto).toContain("pinned: true");
    expect(texto).toContain("kind: fact");
    expect(texto).toContain("o ai-jail recusa rw-map sobreposto");
  });

  test("a escrita entra na trilha, com o hash do que foi escrito (R4.3)", async () => {
    const layout = projeto();
    await cli(["remember", "fato auditado", "--root", layout.root]);
    const entrada = trilha(layout).at(-1)!;
    expect(entrada.type).toBe("memory.write");
    expect(entrada.payload.slug).toBe("fato-auditado");
    expect(String(entrada.payload.content_sha256)).toStartWith("");
    expect(entrada.payload.pinned).toBe(true);
  });

  test("fato vazio e uso errado, nao pagina vazia", async () => {
    const layout = projeto();
    const r = await cli(["remember", "   ", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("psh remember");
  });

  test("tipo desconhecido para de vez, em vez de virar 'note'", async () => {
    const layout = projeto();
    const r = await cli(["remember", "x", "--kind", "inventado", "--root", layout.root]);
    expect(r.code).toBe(EXIT.CONTRACT_INVALID);
    expect(r.err).toContain("tipo de memoria desconhecido");
  });

  test("titulo e tags explicitos chegam ao arquivo", async () => {
    const layout = projeto();
    await cli([
      "remember",
      "corpo longo do fato",
      "--title",
      "titulo curto",
      "--tags",
      "fronteira, ai-jail,",
      "--kind",
      "decision",
      "--root",
      layout.root,
    ]);
    const texto = readFileSync(join(layout.memoryPagesDir, "titulo-curto.md"), "utf8");
    expect(texto).toContain("title: titulo curto");
    expect(texto).toContain("tags: fronteira, ai-jail");
    expect(texto).toContain("kind: decision");
  });
});

describe("psh memory", () => {
  test("search acha o que remember gravou, e diz por qual modo", async () => {
    const layout = projeto();
    await cli(["remember", "a fronteira monta por complemento", "--root", layout.root]);
    const r = await cli(["memory", "search", "complemento", "--json", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    const resultado = JSON.parse(r.out) as { mode: string; hits: { slug: string }[] };
    expect(resultado.mode).toBe("fts5");
    expect(resultado.hits.map((h) => h.slug)).toEqual(["a-fronteira-monta-por-complemento"]);
  });

  test("busca sem resultado e resposta, nao erro", async () => {
    const layout = projeto();
    await cli(["remember", "qualquer coisa", "--root", layout.root]);
    const r = await cli(["memory", "search", "sagitario", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("nenhum resultado");
  });

  test("list separa fixada de solta e conta o que examinou", async () => {
    const layout = projeto();
    await cli(["remember", "fato fixado", "--root", layout.root]);
    const r = await cli(["memory", "list", "--json", "--root", layout.root]);
    const resultado = JSON.parse(r.out) as { pages: { slug: string; pinned: boolean }[]; sync: { pages_examined: number } };
    expect(resultado.pages).toHaveLength(1);
    expect(resultado.pages[0]!.pinned).toBe(true);
    expect(resultado.sync.pages_examined).toBe(1);
  });

  test("get devolve a pagina como ela esta no disco", async () => {
    const layout = projeto();
    await cli(["remember", "fato para ler", "--root", layout.root]);
    const r = await cli(["memory", "get", "fato-para-ler", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("slug: fato-para-ler");
  });

  test("get de slug inexistente falha dizendo o slug", async () => {
    const layout = projeto();
    const r = await cli(["memory", "get", "nao-existe", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("nao-existe");
  });

  test("get de slug com caminho e recusado antes de tocar no disco", async () => {
    const layout = projeto();
    const r = await cli(["memory", "get", "../../etc/passwd", "--root", layout.root]);
    expect(r.code).toBe(EXIT.CONTRACT_INVALID);
    expect(r.err).toContain("slug de memoria invalido");
  });

  test("reindex reporta pagina corrompida e falha (R2.13)", async () => {
    const layout = projeto();
    await cli(["remember", "fato bom", "--root", layout.root]);
    writeFileSync(join(layout.memoryPagesDir, "fato-bom.md"), "isto nao e pagina\n");
    const r = await cli(["memory", "reindex", "--json", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    const sync = JSON.parse(r.out) as { unreadable: { slug: string }[] };
    expect(sync.unreadable[0]!.slug).toBe("fato-bom");
  });

  test("subcomando desconhecido nao vira list em silencio", async () => {
    const layout = projeto();
    const r = await cli(["memory", "esquecer", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("subcomando desconhecido");
  });
});

describe("psh memory promote (R5.7)", () => {
  test("promove para o repositorio e deixa a pagina apontando para o destino", async () => {
    const layout = projeto();
    await cli(["remember", "decisao que precisa sobreviver", "--root", layout.root]);
    const r = await cli(["memory", "promote", "decisao-que-precisa-sobreviver", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);

    const destino = join(layout.root, "docs", "decisoes", "decisao-que-precisa-sobreviver.md");
    expect(existsSync(destino)).toBe(true);
    const promovido = readFileSync(destino, "utf8");
    expect(promovido).toContain("# decisao que precisa sobreviver");
    expect(promovido).toContain("Promovido de `.harness/memory/pages/decisao-que-precisa-sobreviver.md`");

    const pagina = readFileSync(join(layout.memoryPagesDir, "decisao-que-precisa-sobreviver.md"), "utf8");
    expect(pagina).toContain("promoted_to: docs/decisoes/decisao-que-precisa-sobreviver.md");
  });

  test("a promocao entra na trilha", async () => {
    const layout = projeto();
    await cli(["remember", "fato promovido", "--root", layout.root]);
    await cli(["memory", "promote", "fato-promovido", "--root", layout.root]);
    const entrada = trilha(layout).at(-1)!;
    expect(entrada.type).toBe("memory.promote");
    expect(entrada.payload.to).toBe("docs/decisoes/fato-promovido.md");
  });

  test("nao sobrescreve destino existente sem --force", async () => {
    const layout = projeto();
    await cli(["remember", "fato repetido", "--root", layout.root]);
    writeFile(layout, "docs/decisoes/fato-repetido.md", "conteudo humano que nao pode sumir\n");

    const r = await cli(["memory", "promote", "fato-repetido", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(readFileSync(join(layout.root, "docs/decisoes/fato-repetido.md"), "utf8")).toContain("conteudo humano");

    const forcado = await cli(["memory", "promote", "fato-repetido", "--force", "--root", layout.root]);
    expect(forcado.code).toBe(EXIT.OK);
    expect(readFileSync(join(layout.root, "docs/decisoes/fato-repetido.md"), "utf8")).toContain("# fato repetido");
  });

  test("destino fora do projeto e violacao de fronteira", async () => {
    const layout = projeto();
    await cli(["remember", "fato viajante", "--root", layout.root]);
    const r = await cli([
      "memory",
      "promote",
      "fato-viajante",
      "--to",
      "../fora-do-projeto.md",
      "--root",
      layout.root,
    ]);
    expect(r.code).toBe(EXIT.BOUNDARY_VIOLATION);
    expect(existsSync(join(layout.root, "..", "fora-do-projeto.md"))).toBe(false);
  });

  test("destino dentro de .harness/ e recusado: promover e sair da faixa transitoria", async () => {
    const layout = projeto();
    await cli(["remember", "fato interno", "--root", layout.root]);
    const r = await cli([
      "memory",
      "promote",
      "fato-interno",
      "--to",
      ".harness/evidence/forjado.md",
      "--root",
      layout.root,
    ]);
    expect(r.code).toBe(EXIT.BOUNDARY_VIOLATION);
    expect(existsSync(join(layout.harness, "evidence", "forjado.md"))).toBe(false);
  });

  test("destino absoluto e recusado", async () => {
    const layout = projeto();
    await cli(["remember", "fato absoluto", "--root", layout.root]);
    const r = await cli(["memory", "promote", "fato-absoluto", "--to", "/tmp/x.md", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("relativo a raiz");
  });
});

describe("memoria fora do alcance do agente", () => {
  test("o deny duro cobre .harness/memory/ (R5.4)", () => {
    expect(DENY_ALWAYS).toContain(".harness/memory/**");
    expect(DENY_ALWAYS).toContain(".harness/memory");
  });

  test("boundary check bloqueia escrita de pagina mesmo com write ['**']", async () => {
    const layout = projeto();
    const r = await cli([
      "boundary",
      "check",
      ".harness/memory/pages/injetada.md",
      "--json",
      "--root",
      layout.root,
    ]);
    expect(r.code).toBe(EXIT.BOUNDARY_VIOLATION);
    const decisao = JSON.parse(r.out) as { allowed: boolean; rule: string; reason: string };
    expect(decisao.allowed).toBe(false);
    expect(decisao.rule).toBe("deny-always");
    expect(decisao.reason).toContain(".harness/memory/**");
  });
});

describe("psh handoff (R5.4)", () => {
  test("o bloco carrega fase, pendencia e memoria fixada", async () => {
    const layout = tempProject({ git: false });
    harnessWith(layout, {
      profile: "lean",
      verifiers: [],
      phases: [
        {
          id: "build",
          name: "Build",
          terminal: true,
          next: [],
          gate: {
            type: "all-of",
            checks: [{ kind: "presence", file: "docs/spec.md", min_lines: 5 }],
            on_fail: { action: "block", message: "spec ausente" },
          },
          on_failure: { class: "quality", max_auto_retries: 1 },
        },
      ],
    }).close();

    await cli(["remember", "nao mexer no gerador de migration", "--root", layout.root]);

    const r = await cli(["handoff", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("Retomada de sessao");
    expect(r.out).toContain("build");
    expect(r.out).toContain("nao mexer no gerador de migration");
    expect(r.out).toContain("docs/spec.md");
    expect(r.out).toContain("psh verify --all");
  });

  test("o json diz o que a pendencia observou e o que esperava", async () => {
    const layout = tempProject({ git: false });
    harnessWith(layout, {
      profile: "lean",
      verifiers: [],
      phases: [
        {
          id: "build",
          name: "Build",
          terminal: true,
          next: [],
          gate: {
            type: "all-of",
            checks: [{ kind: "presence", file: "docs/spec.md", min_lines: 5 }],
            on_fail: { action: "block", message: "spec ausente" },
          },
          on_failure: { class: "quality", max_auto_retries: 1 },
        },
      ],
    }).close();

    const r = await cli(["handoff", "--json", "--root", layout.root]);
    const h = JSON.parse(r.out) as {
      _type: string;
      phase: string;
      pending: { label: string; observed: string }[];
      next_commands: string[];
    };
    expect(h._type).toBe("psh-handoff");
    expect(h.phase).toBe("build");
    expect(h.pending[0]!.observed).toBe("sem evidencia");
    expect(h.next_commands).toContain("psh verify --all");
  });

  test("sem pendencia o proximo passo e avancar", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      const h = buildHandoff(ctx);
      expect(h.pending).toEqual([]);
      expect(h.next_commands).toEqual(["psh status"]);
      expect(renderHandoff(h)).toContain("Nenhum check do portao esta reprovado agora");
    } finally {
      ctx.close();
    }
  });

  test("trilha comprometida vira o unico proximo passo", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      remember(ctx, { fact: "algo" });
    } finally {
      ctx.close();
    }
    const linhas = readFileSync(layout.chainPath, "utf8").split("\n").filter((l) => l !== "");
    writeFileSync(layout.chainPath, `${linhas.slice(0, -1).join("\n")}\n`);

    const ctx2 = openProject(layout.root);
    try {
      const h = buildHandoff(ctx2);
      expect(h.audit_ok).toBe(false);
      expect(h.next_commands).toEqual(["psh audit verify"]);
    } finally {
      ctx2.close();
    }
  });

  test("a fixada aparece em 'fixada' e nao se repete em 'recente'", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      remember(ctx, { fact: "fixada de verdade" });
      remember(ctx, { fact: "solta", pinned: false });
      const h = buildHandoff(ctx);
      expect(h.pinned.map((p) => p.slug)).toEqual(["fixada-de-verdade"]);
      expect(h.recent.map((p) => p.slug)).toEqual(["solta"]);
    } finally {
      ctx.close();
    }
  });
});

describe("psh doctor: estado da memoria", () => {
  test("reporta o mecanismo de busca e quantas paginas examinou", async () => {
    const layout = projeto();
    await cli(["remember", "fato diagnosticado", "--root", layout.root]);
    const r = await cli(["doctor", "--json", "--root", layout.root]);
    const report = JSON.parse(r.out) as { checks: { id: string; level: string; message: string }[] };
    const fts = report.checks.find((c) => c.id === "memory-fts")!;
    const pages = report.checks.find((c) => c.id === "memory-pages")!;
    expect(fts.level).toBe("ok");
    expect(fts.message).toContain("FTS5");
    expect(pages.level).toBe("ok");
    expect(pages.message).toContain("1 pagina(s)");
  });

  test("pagina ilegivel derruba o diagnostico, em vez de sumir da busca em silencio", async () => {
    const layout = projeto();
    await cli(["remember", "fato que vai corromper", "--root", layout.root]);
    writeFileSync(join(layout.memoryPagesDir, "fato-que-vai-corromper.md"), "lixo\n");

    const r = await cli(["doctor", "--json", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    const report = JSON.parse(r.out) as { checks: { id: string; level: string; detail?: string }[] };
    const pages = report.checks.find((c) => c.id === "memory-pages")!;
    expect(pages.level).toBe("fail");
    expect(pages.detail).toContain("fato-que-vai-corromper");
  });
});

describe("psh init prepara a faixa de memoria", () => {
  test("cria o diretorio de paginas e mantem a memoria fora do repositorio (R5.7)", () => {
    const layout = tempProject({ git: false });
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "index.ts"), "init", "--profile", "gate-only", "--yes", "--root", layout.root], {
      env: { ...process.env, PSH_SANDBOX: "off" },
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(layout.memoryPagesDir)).toBe(true);
    expect(readFileSync(join(layout.harness, ".gitignore"), "utf8")).toContain("memory/");
  });
});

describe("saida para humano", () => {
  test("list e search mostram a pagina, a fixacao e a contagem", async () => {
    const layout = projeto();
    await cli(["remember", "a fronteira monta por complemento", "--tags", "fronteira", "--root", layout.root]);

    const lista = await cli(["memory", "list", "--root", layout.root]);
    expect(lista.out).toContain("a-fronteira-monta-por-complemento");
    expect(lista.out).toContain("1 pagina(s)");

    const busca = await cli(["memory", "search", "complemento", "--root", layout.root]);
    expect(busca.out).toContain("a-fronteira-monta-por-complemento");
    expect(busca.out).toContain("1 resultado(s) por fts5");
  });

  test("lista vazia diz que examinou zero, em vez de nao dizer nada", async () => {
    const layout = projeto();
    const r = await cli(["memory", "list", "--root", layout.root]);
    expect(r.out).toContain("nenhuma pagina de memoria");
    expect(r.out).toContain("0 arquivo(s) examinado(s)");
  });

  test("arquivo de nome invalido vira aviso na saida, nao silencio", async () => {
    const layout = projeto();
    await cli(["remember", "fato valido", "--root", layout.root]);
    writeFileSync(join(layout.memoryPagesDir, "Nome Invalido.md"), "nao entra");
    const r = await cli(["memory", "list", "--root", layout.root]);
    expect(r.out).toContain("ignorado(s) por nome invalido");
    expect(r.out).toContain("Nome Invalido.md");
  });

  test("pagina promovida aparece apontando para o destino", async () => {
    const layout = projeto();
    await cli(["remember", "fato listado e promovido", "--root", layout.root]);
    await cli(["memory", "promote", "fato-listado-e-promovido", "--root", layout.root]);
    const lista = await cli(["memory", "list", "--root", layout.root]);
    expect(lista.out).toContain("-> docs/decisoes/fato-listado-e-promovido.md");
    const busca = await cli(["memory", "search", "listado", "--root", layout.root]);
    expect(busca.out).toContain("promovida para docs/decisoes/fato-listado-e-promovido.md");
  });

  test("o handoff lista a memoria recente alem da fixada", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      remember(ctx, { fact: "solta e recente", pinned: false });
      expect(renderHandoff(buildHandoff(ctx))).toContain("## Memoria recente");
    } finally {
      ctx.close();
    }
  });
});

describe("erro de uso e falha de uso, nao erro inesperado", () => {
  test.each([
    [["memory", "list", "--n", "abc"]],
    [["memory", "search", "x", "--n", "abc"]],
    [["handoff", "--n", "abc"]],
    [["audit", "log", "--n", "abc"]],
  ])("%j falha dizendo que --n quer inteiro", async (argv) => {
    const layout = projeto();
    const r = await cli([...argv, "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("inteiro nao negativo");
    expect(r.err).not.toContain("datatype mismatch");
  });

  test("--n negativo tambem para na porta", async () => {
    const layout = projeto();
    const r = await cli(["memory", "list", "--n", "-3", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
  });

  test("titulo vazio nao vira pagina sem titulo", async () => {
    const layout = projeto();
    const r = await cli(["remember", "corpo", "--title", "", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("--title vazio");
  });

  test("titulo com quebra de linha e recusado, e nada e escrito", async () => {
    const layout = projeto();
    const r = await cli(["remember", "corpo", "--title", "legit\npinned: false", "--root", layout.root]);
    expect(r.code).toBe(EXIT.CONTRACT_INVALID);
    expect(r.err).toContain("quebra de linha");
    expect(existsSync(layout.memoryPagesDir) ? readdirSync(layout.memoryPagesDir) : []).toEqual([]);
  });

  test("--to vazio nao vira escrita na raiz do projeto", async () => {
    const layout = projeto();
    await cli(["remember", "fato", "--root", layout.root]);
    const r = await cli(["memory", "promote", "fato", "--to", "", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("--to vazio");
  });
});

describe("quem anotou foi quem anotou (R4.3)", () => {
  function comoAgente<T>(id: string, fn: () => T): T {
    const antes = process.env.PSH_AGENT;
    process.env.PSH_AGENT = id;
    try {
      return fn();
    } finally {
      if (antes === undefined) delete process.env.PSH_AGENT;
      else process.env.PSH_AGENT = antes;
    }
  }

  test("anotacao feita sob 'psh exec' nasce assinada como agente, nao como humano", async () => {
    const layout = projeto();
    await comoAgente("backend", () => cli(["remember", "fato do agente", "--root", layout.root]));

    expect(readFileSync(join(layout.memoryPagesDir, "fato-do-agente.md"), "utf8")).toContain("source: agent:backend");
    expect(trilha(layout).at(-1)!.actor).toBe("agent:backend");
  });

  test("sem marca de agente a origem continua sendo o operador", async () => {
    const layout = projeto();
    await cli(["remember", "fato do humano", "--root", layout.root]);
    expect(readFileSync(join(layout.memoryPagesDir, "fato-do-humano.md"), "utf8")).toContain("source: human:");
  });

  test("psh exec marca a sessao com o id do agente", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      const r = execUnderBoundary({
        layout,
        policy: boundaryOf(ctx),
        agentId: "default",
        argv: [process.execPath, "-e", "process.stdout.write(process.env.PSH_AGENT ?? 'ausente')"],
        sandbox: { mode: "degraded", detail: "teste", jail_bin: null, jail_version: null },
      });
      expect(r.stdout).toBe("default");
    } finally {
      ctx.close();
    }
  });
});

describe("promover nao contorna a fronteira de quem promove (R3.5b)", () => {
  function projetoComAgenteEstreito(): Layout {
    const layout = tempProject({ git: false });
    writeFile(layout, "src/api/users.ts", "api\n");
    writeFile(layout, "src/web/app.tsx", "web original\n");
    writeFile(
      layout,
      ".harness/boundary.json",
      JSON.stringify({
        _type: "psh-boundary",
        version: 1,
        default_agent: "backend",
        agents: { backend: { write: ["src/api/**"] } },
      }),
    );
    harnessWith(layout, CONTRATO).close();
    return layout;
  }

  test("agente nao promove para fora da propria allowlist", async () => {
    const layout = projetoComAgenteEstreito();
    await cli(["remember", "fato do backend", "--root", layout.root]);

    const antes = process.env.PSH_AGENT;
    process.env.PSH_AGENT = "backend";
    try {
      const r = await cli([
        "memory",
        "promote",
        "fato-do-backend",
        "--to",
        "src/web/app.tsx",
        "--force",
        "--root",
        layout.root,
      ]);
      expect(r.code).toBe(EXIT.BOUNDARY_VIOLATION);
      expect(r.err).toContain("nao contorna a fronteira");
      expect(readFileSync(join(layout.root, "src/web/app.tsx"), "utf8")).toBe("web original\n");
    } finally {
      if (antes === undefined) delete process.env.PSH_AGENT;
      else process.env.PSH_AGENT = antes;
    }
  });

  test("dentro da allowlist o mesmo agente promove", async () => {
    const layout = projetoComAgenteEstreito();
    await cli(["remember", "fato permitido", "--root", layout.root]);

    const antes = process.env.PSH_AGENT;
    process.env.PSH_AGENT = "backend";
    try {
      const r = await cli([
        "memory",
        "promote",
        "fato-permitido",
        "--to",
        "src/api/DECISAO.md",
        "--root",
        layout.root,
      ]);
      expect(r.code).toBe(EXIT.OK);
      expect(existsSync(join(layout.root, "src/api/DECISAO.md"))).toBe(true);
    } finally {
      if (antes === undefined) delete process.env.PSH_AGENT;
      else process.env.PSH_AGENT = antes;
    }
  });

  test("o humano promove para onde a allowlist do agente nao alcanca", async () => {
    const layout = projetoComAgenteEstreito();
    await cli(["remember", "fato do humano", "--root", layout.root]);
    const r = await cli(["memory", "promote", "fato-do-humano", "--root", layout.root]);
    expect(r.code).toBe(EXIT.OK);
    expect(existsSync(join(layout.root, "docs/decisoes/fato-do-humano.md"))).toBe(true);
  });
});

describe("o bloco de retomada tem teto declarado", () => {
  test("corpo longo entra cortado, e o corte diz como recuperar o resto", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      remember(ctx, { fact: `fato longo. ${"palavra ".repeat(200)}`, title: "fato longo" });
      const h = buildHandoff(ctx);
      expect(h.pinned[0]!.body_truncated).toBe(true);
      expect(h.pinned[0]!.body.length).toBeLessThan(500);
      expect(renderHandoff(h)).toContain("psh memory get fato-longo");
    } finally {
      ctx.close();
    }
  });

  test("fixada demais nao some do bloco em silencio", () => {
    const layout = projeto();
    const ctx = openProject(layout.root);
    try {
      for (let i = 0; i < MAX_PINNED_NO_BLOCO + 3; i += 1) {
        remember(ctx, { fact: `fato numero ${i}`, title: `fato numero ${i}` });
      }
      const h = buildHandoff(ctx);
      expect(h.pinned).toHaveLength(MAX_PINNED_NO_BLOCO);
      expect(h.pinned_omitted).toBe(3);
      expect(renderHandoff(h)).toContain("mais 3 pagina(s) fixada(s) fora do bloco");
    } finally {
      ctx.close();
    }
  });
});
