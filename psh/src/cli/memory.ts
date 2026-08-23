import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProjectContext } from "./context.ts";
import { boundaryOf } from "./boundary.ts";
import { EXIT, PshError } from "../util/errors.ts";
import { isInside, toRel } from "../util/paths.ts";
import { buildPage, readPage, writePage, type NewPageInput, type StoredPage } from "../memory/store.ts";
import { searchMemory, syncIndex, type SearchResult } from "../memory/search.ts";
import { serializePage, type PageKind } from "../memory/page.ts";

/** Onde `psh memory promote` deposita, quando o chamador nao diz (R5.7). */
export const PROMOTE_DIR = join("docs", "decisoes");

export interface RememberOptions {
  fact: string;
  title?: string;
  tags?: string[];
  kind?: PageKind;
  pinned?: boolean;
  source?: string;
  now?: Date;
}

/**
 * R5.5: anotacao explicita.
 *
 * Nasce fixada por definicao - o ponto do comando e justamente ser o item que a
 * consolidacao nao pode descartar.
 */
export function remember(ctx: ProjectContext, opts: RememberOptions): StoredPage {
  const fato = opts.fact.trim();
  if (fato === "") {
    throw new PshError("uso: psh remember \"<fato>\"", { exitCode: EXIT.FAILURE });
  }
  const titulo = (opts.title ?? primeiraLinha(fato)).trim();
  if (titulo === "") {
    throw new PshError("--title vazio: a pagina precisa de um titulo para ser encontrada depois", {
      exitCode: EXIT.FAILURE,
    });
  }
  const input: NewPageInput = {
    title: titulo,
    body: fato,
    kind: opts.kind ?? "fact",
    pinned: opts.pinned ?? true,
    source: opts.source ?? origemDaSessao(),
    phase: ctx.state.phase,
    tags: opts.tags ?? [],
    now: opts.now,
  };
  const stored = writePage(ctx.layout, buildPage(ctx.layout, input));

  ctx.chain.append("memory.write", input.source, {
    slug: stored.page.slug,
    kind: stored.page.kind,
    pinned: stored.page.pinned,
    phase: stored.page.phase,
    content_sha256: stored.content_sha256,
  });
  syncIndex(ctx.db, ctx.layout);
  return stored;
}

/**
 * Quem esta anotando.
 *
 * `psh exec` marca a sessao com `PSH_AGENT`, entao uma anotacao feita por
 * comando do agente nasce assinada como agente. A atribuicao e **melhor
 * esforco**: o agente roda dentro da jaula com ambiente proprio e pode apagar a
 * variavel antes de chamar o `psh`. O que ele nao consegue apagar e a entrada
 * `command.exec` da mesma execucao na trilha, e e por ela que a correlacao
 * fecha. Identidade por canal fora do alcance do agente e trabalho do contrato
 * de adapter (R8.1).
 */
function origemDaSessao(): string {
  const agente = process.env.PSH_AGENT;
  if (agente !== undefined && agente.trim() !== "") return `agent:${agente.trim()}`;
  return `human:${process.env.USER ?? "operador"}`;
}

function primeiraLinha(texto: string, limite = 80): string {
  const linha = texto.split("\n")[0]!.trim();
  return linha.length <= limite ? linha : `${linha.slice(0, limite - 3).trimEnd()}...`;
}

export interface PromoteResult {
  slug: string;
  from: string;
  /** Caminho relativo a raiz do projeto: e ele que fica gravado na pagina. */
  to: string;
  bytes: number;
}

/**
 * R5.7: a passagem de faixa transitoria para fonte canonica.
 *
 * O arquivo promovido vive no repositorio e entra em revisao como qualquer
 * outro. A pagina de memoria continua existindo, mas passa a apontar para o
 * destino: duas copias sem ponteiro seriam duas verdades.
 */
export function promote(
  ctx: ProjectContext,
  slug: string,
  opts: { to?: string | null; force?: boolean; now?: Date } = {},
): PromoteResult {
  const stored = readPage(ctx.layout, slug);
  const destinoRel = opts.to ?? join(PROMOTE_DIR, `${stored.page.slug}.md`);
  if (destinoRel.trim() === "") {
    throw new PshError("--to vazio: informe o arquivo de destino", { exitCode: EXIT.FAILURE });
  }
  if (isAbsolute(destinoRel)) {
    throw new PshError(`--to precisa ser relativo a raiz do projeto: ${destinoRel}`, { exitCode: EXIT.FAILURE });
  }
  const destino = resolve(ctx.layout.root, destinoRel);

  if (!isInside(ctx.layout.root, destino)) {
    throw new PshError(`destino fora do projeto: ${destinoRel}`, { exitCode: EXIT.BOUNDARY_VIOLATION });
  }
  if (isInside(ctx.layout.harness, destino)) {
    throw new PshError(
      `destino dentro de .harness/: ${destinoRel}. Promover e sair da faixa transitoria, nao mudar de gaveta dentro dela.`,
      { exitCode: EXIT.BOUNDARY_VIOLATION },
    );
  }
  if (existsSync(destino) && opts.force !== true) {
    throw new PshError(
      `${destinoRel} ja existe. Escolha outro --to ou repita com --force para sobrescrever.`,
      { exitCode: EXIT.FAILURE },
    );
  }
  assertDestinoDentroDaFronteira(ctx, destinoRel, destino);

  const conteudo = renderPromovido(stored, opts.now ?? new Date());
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, conteudo, { mode: 0o644 });

  const relFinal = toRel(ctx.layout.root, destino);
  const atualizada = writePage(ctx.layout, {
    ...stored.page,
    promoted_to: relFinal,
    updated_at: (opts.now ?? new Date()).toISOString(),
  });

  ctx.chain.append("memory.promote", origemDaSessao(), {
    slug: stored.page.slug,
    to: relFinal,
    bytes: conteudo.length,
    content_sha256: atualizada.content_sha256,
  });
  syncIndex(ctx.db, ctx.layout);

  return { slug: stored.page.slug, from: toRel(ctx.layout.root, stored.path), to: relFinal, bytes: conteudo.length };
}

/**
 * R3.5b: promover escreve no repositorio, e quem escreve e o nucleo.
 *
 * Sem esta conferencia o comando vira lavanderia de escrita: um agente com
 * allowlist `src/api/**` chamaria
 * `psh memory promote x --to src/web/app.tsx --force` e o arquivo sairia
 * alterado com a assinatura do nucleo, sem passar pela fronteira dele.
 *
 * O humano nao passa por aqui: ele e a autoridade que define a allowlist, e o
 * deny duro do `.harness/` continua valendo para os dois, logo acima.
 */
function assertDestinoDentroDaFronteira(ctx: ProjectContext, destinoRel: string, destino: string): void {
  const agente = process.env.PSH_AGENT?.trim();
  if (agente === undefined || agente === "") return;

  const decisao = boundaryOf(ctx).canWrite(agente, destino);
  if (!decisao.allowed) {
    throw new PshError(
      `agente '${agente}' nao pode escrever em ${destinoRel}: ${decisao.reason}. ` +
        "Promover nao contorna a fronteira de quem promove.",
      { exitCode: EXIT.BOUNDARY_VIOLATION, detail: { agent: agente, path: destinoRel, rule: decisao.rule.kind } },
    );
  }
}

function renderPromovido(stored: StoredPage, now: Date): string {
  const p = stored.page;
  const linhas = [
    `# ${p.title}`,
    "",
    `> Promovido de \`.harness/memory/pages/${p.slug}.md\` em ${now.toISOString()}.`,
    `> Origem ${p.source}, registrado em ${p.created_at}${p.phase === null ? "" : `, fase ${p.phase}`}.`,
    "",
    p.body.trim(),
    "",
  ];
  if (p.tags.length > 0) {
    linhas.push("", `Tags: ${p.tags.join(", ")}`, "");
  }
  return linhas.join("\n");
}

export function search(ctx: ProjectContext, query: string, limit: number): SearchResult {
  return searchMemory(ctx.db, ctx.layout, query, limit);
}

export interface ListResult {
  pages: {
    slug: string;
    title: string;
    kind: string;
    pinned: boolean;
    phase: string | null;
    tags: string[];
    updated_at: string;
    promoted_to: string | null;
  }[];
  sync: ReturnType<typeof syncIndex>;
}

export function list(ctx: ProjectContext, opts: { pinnedOnly?: boolean; limit?: number } = {}): ListResult {
  const sync = syncIndex(ctx.db, ctx.layout);
  const pages = ctx.db.listMemoryPages(opts).map((row) => ({
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    pinned: row.pinned === 1,
    phase: row.phase,
    tags: JSON.parse(row.tags) as string[],
    updated_at: row.updated_at,
    promoted_to: row.promoted_to,
  }));
  return { pages, sync };
}

export function get(ctx: ProjectContext, slug: string): StoredPage {
  return readPage(ctx.layout, slug);
}

// --- renderizacao ---------------------------------------------------------

export function renderList(result: ListResult): string {
  if (result.pages.length === 0) {
    return `nenhuma pagina de memoria (${result.sync.pages_examined} arquivo(s) examinado(s) em .harness/memory/pages/)`;
  }
  const linhas = result.pages.map((p) => {
    const marca = p.pinned ? "*" : " ";
    const promovida = p.promoted_to === null ? "" : `  -> ${p.promoted_to}`;
    return `${marca} ${p.slug.padEnd(38)} ${p.kind.padEnd(9)} ${p.updated_at}  ${p.title}${promovida}`;
  });
  linhas.push("");
  linhas.push(
    `${result.pages.length} pagina(s); indice: ${result.sync.indexed} reindexada(s), ${result.sync.unchanged} inalterada(s), ${result.sync.removed} removida(s), ${result.sync.pages_examined} arquivo(s) examinado(s)`,
  );
  linhas.push(...avisosDeSync(result.sync));
  return linhas.join("\n");
}

export function renderSearch(result: SearchResult): string {
  const linhas: string[] = [];
  if (result.mode === "scan") {
    linhas.push(
      "MODO DEGRADADO: SQLite sem FTS5, busca por substring (sem ranking nem prefixo).",
      "",
    );
  }
  if (result.hits.length === 0) {
    linhas.push(
      `nenhum resultado para ${JSON.stringify(result.query)} (${result.sync.pages_examined} pagina(s) examinada(s))`,
    );
    linhas.push(...avisosDeSync(result.sync));
    return linhas.join("\n");
  }
  for (const hit of result.hits) {
    linhas.push(`${hit.pinned ? "*" : " "} ${hit.slug}  [${hit.kind}]  ${hit.updated_at}`);
    linhas.push(`  ${hit.title}`);
    if (hit.snippet !== "") linhas.push(`  ${hit.snippet}`);
    if (hit.promoted_to !== null) linhas.push(`  promovida para ${hit.promoted_to}`);
    linhas.push("");
  }
  linhas.push(
    `${result.hits.length} resultado(s) por ${result.mode}; ${result.sync.pages_examined} pagina(s) examinada(s)`,
  );
  linhas.push(...avisosDeSync(result.sync));
  return linhas.join("\n");
}

/** Pagina ilegivel some da busca: some com aviso, nunca em silencio. */
function avisosDeSync(sync: ReturnType<typeof syncIndex>): string[] {
  const linhas: string[] = [];
  for (const problema of sync.unreadable) {
    linhas.push(`  ! pagina ${problema.slug} fora do indice: ${problema.message}`);
  }
  if (sync.skipped.length > 0) {
    linhas.push(`  ! ${sync.skipped.length} arquivo(s) ignorado(s) por nome invalido: ${sync.skipped.join(", ")}`);
  }
  return linhas;
}

export function renderPage(stored: StoredPage): string {
  return serializePage(stored.page).trimEnd();
}
