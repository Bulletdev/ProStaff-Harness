import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { ContractError, PshError, EXIT } from "../util/errors.ts";
import { sha256 } from "../util/hash.ts";
import type { Layout } from "../util/paths.ts";
import { assertSafeSlug, parsePage, serializePage, slugify, type MemoryPage, type PageKind } from "./page.ts";

const EXT = ".md";

export interface StoredPage {
  page: MemoryPage;
  path: string;
  /** Hash do arquivo como esta no disco. E ele que decide frescor do indice. */
  content_sha256: string;
}

export function pagesDir(layout: Layout): string {
  return layout.memoryPagesDir;
}

export function pagePath(layout: Layout, slug: string): string {
  return join(pagesDir(layout), `${assertSafeSlug(slug)}${EXT}`);
}

/**
 * Enumeracao das paginas em disco.
 *
 * O disco e a versao canonica; o SQLite e so indice (mesma divisao da
 * evidencia). Arquivo com nome fora do alfabeto de slug e ignorado e contado,
 * nunca lido: o nome do arquivo e a chave, e chave que nao bate com o conteudo
 * so gera pagina fantasma no indice.
 */
export function listPageFiles(layout: Layout): { slugs: string[]; skipped: string[]; examined: number } {
  const dir = pagesDir(layout);
  if (!existsSync(dir)) return { slugs: [], skipped: [], examined: 0 };
  const slugs: string[] = [];
  const skipped: string[] = [];
  let examined = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    examined += 1;
    // Symlink nao e pagina: seguir um daqui leria arquivo de fora da faixa de
    // memoria e o conteudo entraria no bloco de handoff da sessao seguinte.
    // Ele e contado e nomeado, nunca invisivel (R2.13).
    if (!entry.isFile()) {
      skipped.push(entry.name);
      continue;
    }
    if (!entry.name.endsWith(EXT)) {
      skipped.push(entry.name);
      continue;
    }
    const slug = basename(entry.name, EXT);
    try {
      assertSafeSlug(slug);
    } catch {
      skipped.push(entry.name);
      continue;
    }
    slugs.push(slug);
  }
  return { slugs: slugs.sort(), skipped, examined };
}

export function readPage(layout: Layout, slug: string): StoredPage {
  const path = pagePath(layout, slug);
  if (!existsSync(path)) {
    throw new PshError(`pagina de memoria nao encontrada: ${slug}`, { exitCode: EXIT.FAILURE, detail: { slug } });
  }
  return readPageFile(path, slug);
}

export function readPageIfPresent(layout: Layout, slug: string): StoredPage | null {
  const path = pagePath(layout, slug);
  return existsSync(path) ? readPageFile(path, slug) : null;
}

function readPageFile(path: string, slug: string): StoredPage {
  // A enumeracao ja ignora o que nao e arquivo comum; `psh memory get` e a
  // outra porta para o mesmo caminho, e as duas precisam concordar.
  if (!lstatSync(path).isFile()) {
    throw new ContractError(`${path} nao e um arquivo comum: pagina de memoria nao segue symlink.`, { path });
  }
  const raw = readFileSync(path, "utf8");
  const page = parsePage(raw, path);
  if (page.slug !== slug) {
    throw new ContractError(
      `pagina ${path} declara slug ${JSON.stringify(page.slug)} mas o arquivo se chama ${JSON.stringify(slug)}.`,
      { path, declared: page.slug, file: slug },
    );
  }
  return { page, path, content_sha256: sha256(raw) };
}

/** R5.1 / R5.5: esta e a unica porta de escrita de pagina de memoria. */
export function writePage(layout: Layout, page: MemoryPage): StoredPage {
  const text = serializePage(page);
  const path = pagePath(layout, page.slug);
  mkdirSync(pagesDir(layout), { recursive: true });
  const tmp = join(pagesDir(layout), `.${page.slug}${EXT}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, path);
  } catch (cause) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp ja removido */
    }
    throw cause;
  }
  return { page, path, content_sha256: sha256(text) };
}

/**
 * Slug livre a partir do titulo. Colisao vira sufixo numerico em vez de
 * sobrescrever: duas anotacoes com o mesmo titulo sao duas anotacoes.
 */
export function freeSlug(layout: Layout, title: string, fallback = "nota"): string {
  const base = slugify(title) || fallback;
  if (!existsSync(pagePath(layout, base))) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidato = `${base}-${n}`;
    if (!existsSync(pagePath(layout, candidato))) return candidato;
  }
  throw new PshError(`nao foi possivel derivar slug livre a partir de ${JSON.stringify(title)}`, {
    exitCode: EXIT.FAILURE,
  });
}

export interface NewPageInput {
  title: string;
  body: string;
  kind: PageKind;
  pinned: boolean;
  source: string;
  phase?: string | null;
  tags?: string[];
  slug?: string;
  now?: Date;
}

export function buildPage(layout: Layout, input: NewPageInput): MemoryPage {
  const agora = (input.now ?? new Date()).toISOString();
  const titulo = input.title.trim();
  const slug = input.slug === undefined ? freeSlug(layout, titulo) : assertSafeSlug(input.slug);
  return {
    _type: "psh-memory-page",
    version: 1,
    slug,
    kind: input.kind,
    title: titulo,
    pinned: input.pinned,
    phase: input.phase ?? null,
    // A leitura devolve tag sem espaco na ponta; normalizar aqui e o que faz
    // escrever e ler de volta darem a mesma pagina.
    tags: (input.tags ?? []).map((t) => t.trim()).filter((t) => t !== ""),
    source: input.source.trim(),
    created_at: agora,
    updated_at: agora,
    promoted_to: null,
    body: input.body,
  };
}
