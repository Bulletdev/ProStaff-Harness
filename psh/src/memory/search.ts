import type { HarnessDb } from "../db/index.ts";
import type { Layout } from "../util/paths.ts";
import { indexableText } from "./page.ts";
import { listPageFiles, readPageIfPresent, type StoredPage } from "./store.ts";

export type SearchMode = "fts5" | "scan";

export interface IndexSync {
  /** R2.13: quantas paginas o mecanismo olhou, nao quantas mudaram. */
  pages_examined: number;
  indexed: number;
  unchanged: number;
  removed: number;
  /** Arquivos ignorados por nome fora do alfabeto de slug. */
  skipped: string[];
  unreadable: { slug: string; message: string }[];
}

export interface SearchHit {
  slug: string;
  title: string;
  kind: string;
  pinned: boolean;
  phase: string | null;
  tags: string[];
  updated_at: string;
  promoted_to: string | null;
  snippet: string;
}

export interface SearchResult {
  query: string;
  mode: SearchMode;
  hits: SearchHit[];
  sync: IndexSync;
}

/**
 * Sincroniza o indice com o disco antes de qualquer consulta.
 *
 * O indice nunca e autoridade: o mesmo principio do frescor de evidencia
 * (R2.4). Pagina editada fora do `psh` ainda e pagina, e o hash do arquivo e o
 * que decide se a linha indexada vale. Sem esta passagem, uma busca responderia
 * com o texto de ontem sem dizer que e de ontem.
 */
export function syncIndex(db: HarnessDb, layout: Layout): IndexSync {
  const { slugs, skipped, examined } = listPageFiles(layout);
  const conhecidos = db.memoryHashes();
  const sync: IndexSync = {
    pages_examined: examined,
    indexed: 0,
    unchanged: 0,
    removed: 0,
    skipped,
    unreadable: [],
  };

  for (const slug of slugs) {
    let stored: StoredPage | null;
    try {
      stored = readPageIfPresent(layout, slug);
    } catch (cause) {
      // Pagina corrompida sai do indice em vez de responder com a versao velha.
      sync.unreadable.push({ slug, message: (cause as Error).message });
      if (conhecidos.has(slug)) {
        db.deleteMemoryPage(slug);
        sync.removed += 1;
      }
      continue;
    }
    if (stored === null) continue;
    if (conhecidos.get(slug) === stored.content_sha256) {
      sync.unchanged += 1;
      continue;
    }
    db.upsertMemoryPage(
      {
        slug: stored.page.slug,
        title: stored.page.title,
        kind: stored.page.kind,
        pinned: stored.page.pinned ? 1 : 0,
        phase: stored.page.phase,
        tags: JSON.stringify(stored.page.tags),
        source: stored.page.source,
        created_at: stored.page.created_at,
        updated_at: stored.page.updated_at,
        promoted_to: stored.page.promoted_to,
        content_sha256: stored.content_sha256,
        body: stored.page.body,
      },
      indexableText(stored.page),
    );
    sync.indexed += 1;
  }

  const noDisco = new Set(slugs);
  for (const slug of conhecidos.keys()) {
    if (!noDisco.has(slug)) {
      db.deleteMemoryPage(slug);
      sync.removed += 1;
    }
  }

  return sync;
}

/**
 * Consulta em linguagem de usuario, nunca em sintaxe de FTS5.
 *
 * Cada termo vira literal entre aspas com prefixo: `fronteira` casa
 * `fronteiras`, e um termo com `-`, `*` ou `"` nao derruba a consulta nem vira
 * operador por acidente. Quem digita `psh memory search "NOT ai-jail"` esta
 * procurando essas tres palavras, nao escrevendo uma expressao booleana.
 */
export function toMatchExpression(query: string): string | null {
  const termos = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .map((t) => `"${t.replaceAll('"', '""')}"*`);
  return termos.length === 0 ? null : termos.join(" ");
}

export function searchMemory(
  db: HarnessDb,
  layout: Layout,
  query: string,
  limit = 10,
): SearchResult {
  const sync = syncIndex(db, layout);
  const expressao = toMatchExpression(query);
  // O modo declarado e o do mecanismo, nao o do resultado: consulta sem termo
  // devolve zero por nao ter o que procurar, e dizer "scan" ali seria reportar
  // degradacao que nao houve.
  const mode: SearchMode = db.ftsAvailable ? "fts5" : "scan";

  const rows =
    expressao === null
      ? []
      : mode === "fts5"
        ? db.searchMemoryFts(expressao, limit)
        : db.searchMemoryScan(query, limit);

  return {
    query,
    mode,
    hits: rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      kind: row.kind,
      pinned: row.pinned === 1,
      phase: row.phase,
      tags: JSON.parse(row.tags) as string[],
      updated_at: row.updated_at,
      promoted_to: row.promoted_to,
      snippet: trecho(row.body, query),
    })),
    sync,
  };
}

/** Trecho ao redor da primeira ocorrencia, sem acentuar diferenca de caixa. */
export function trecho(body: string, query: string, janela = 160): string {
  const texto = body.replaceAll("\n", " ").trim();
  const primeiro = query.split(/\s+/).find((t) => t !== "") ?? "";
  const at = primeiro === "" ? -1 : texto.toLowerCase().indexOf(primeiro.toLowerCase());
  if (at < 0) return texto.slice(0, janela) + (texto.length > janela ? "..." : "");
  const inicio = Math.max(0, at - janela / 4);
  const fim = Math.min(texto.length, inicio + janela);
  return `${inicio > 0 ? "..." : ""}${texto.slice(inicio, fim)}${fim < texto.length ? "..." : ""}`;
}
