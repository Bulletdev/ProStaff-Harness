import memoryPageSchema from "../../schemas/memory-page.schema.json" with { type: "json" };
import { ContractError } from "../util/errors.ts";
import { lazyValidator } from "../util/schema.ts";
import { formatAjvErrors } from "../workflow/load.ts";

export const validateMemoryPageSchema = lazyValidator(memoryPageSchema);

export type PageKind = "fact" | "decision" | "verifier" | "session" | "prompt" | "note";

/** Cabecalho da pagina. O corpo fica fora daqui porque nao entra no schema. */
export interface PageHeader {
  _type: "psh-memory-page";
  version: 1;
  slug: string;
  kind: PageKind;
  title: string;
  pinned: boolean;
  phase: string | null;
  tags: string[];
  source: string;
  created_at: string;
  updated_at: string;
  promoted_to: string | null;
}

export interface MemoryPage extends PageHeader {
  body: string;
}

const FENCE = "---";

/**
 * Ordem fixa de campo no cabecalho.
 *
 * Nao e estetica: a pagina em disco e a versao canonica e o indice guarda o
 * hash do arquivo. Se a ordem variasse entre duas escritas do mesmo conteudo, o
 * hash mudaria sozinho e toda pagina pareceria desatualizada a cada leitura.
 */
const FIELD_ORDER: readonly (keyof PageHeader)[] = [
  "_type",
  "version",
  "slug",
  "kind",
  "title",
  "pinned",
  "phase",
  "tags",
  "source",
  "created_at",
  "updated_at",
  "promoted_to",
];

const KNOWN_FIELDS = new Set<string>(FIELD_ORDER as readonly string[]);

/**
 * R5.7 / R3.6: o slug vira nome de arquivo dentro de `.harness/memory/pages/`.
 *
 * Um slug com `/`, `..` ou nome vazio escreveria fora do diretorio de memoria,
 * e a memoria e injetada no contexto da sessao seguinte pelo handoff (R5.4). O
 * alfabeto e conferido aqui, antes de qualquer `join`, e nao por regex sobre o
 * caminho ja montado (R2.14).
 */
export function assertSafeSlug(slug: string): string {
  const ok = slug.length > 0 && slug.length <= 96 && !slug.startsWith("-") && !slug.endsWith("-");
  const alfabetoOk = [...slug].every((ch) => (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-");
  if (!ok || !alfabetoOk) {
    throw new ContractError(
      `slug de memoria invalido: ${JSON.stringify(slug)}. Use minuscula, digito e hifen, sem separador de caminho.`,
      { slug },
    );
  }
  return slug;
}

const ACENTOS: Record<string, string> = {
  á: "a", à: "a", ã: "a", â: "a", ä: "a",
  é: "e", ê: "e", è: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i",
  ó: "o", õ: "o", ô: "o", ò: "o", ö: "o",
  ú: "u", ù: "u", û: "u", ü: "u",
  ç: "c", ñ: "n",
};

/**
 * Titulo vira slug: sem acento, sem maiuscula, separador unico.
 *
 * O corte respeita palavra inteira. Um slug cortado no meio da palavra vira
 * nome de arquivo que ninguem reconhece na listagem, e o slug e a chave que o
 * humano digita em `psh memory get`.
 */
export function slugify(title: string, limit = 48): string {
  const palavras: string[] = [];
  let atual: string[] = [];
  for (const ch of title.toLowerCase()) {
    const base = ACENTOS[ch] ?? ch;
    if ((base >= "a" && base <= "z") || (base >= "0" && base <= "9")) {
      atual.push(base);
    } else if (atual.length > 0) {
      palavras.push(atual.join(""));
      atual = [];
    }
  }
  if (atual.length > 0) palavras.push(atual.join(""));
  if (palavras.length === 0) return "";

  const escolhidas: string[] = [];
  let tamanho = 0;
  for (const palavra of palavras) {
    const custo = palavra.length + (escolhidas.length > 0 ? 1 : 0);
    if (escolhidas.length > 0 && tamanho + custo > limit) break;
    escolhidas.push(palavra);
    tamanho += custo;
  }
  return escolhidas.join("-").slice(0, limit);
}

export function serializePage(page: MemoryPage): string {
  const header = headerOf(page);
  assertValidHeader(header);
  const linhas = [FENCE];
  for (const field of FIELD_ORDER) {
    linhas.push(`${field}: ${formatValue(header[field])}`);
  }
  linhas.push(FENCE, "");
  const corpo = page.body.trim();
  return `${linhas.join("\n")}\n${corpo}\n`;
}

function formatValue(value: unknown): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Leitura estrita: campo desconhecido, cabecalho ausente ou linha sem `:`
 * derrubam a leitura. Pagina meio lida vira contexto errado na sessao seguinte,
 * e contexto errado nao avisa que esta errado.
 */
export function parsePage(text: string, origem: string): MemoryPage {
  const linhas = text.split("\n");
  if (linhas[0]?.trim() !== FENCE) {
    throw new ContractError(`pagina de memoria sem cabecalho em ${origem}: a primeira linha precisa ser '---'.`, {
      path: origem,
    });
  }
  const bruto: Record<string, string> = {};
  let i = 1;
  for (; i < linhas.length; i += 1) {
    const linha = linhas[i]!;
    if (linha.trim() === FENCE) break;
    // Linha em branco dentro do cabecalho e cabecalho que acabou sem fechar. O
    // arquivo termina com quebra de linha, entao este e o caso comum de
    // truncamento, e ele merece a mensagem certa em vez de "esperado campo:".
    if (linha.trim() === "") {
      throw new ContractError(`cabecalho nao fechado em ${origem}: falta o '---' de fechamento.`, {
        path: origem,
        line: i + 1,
      });
    }
    const sep = linha.indexOf(":");
    if (sep < 0) {
      throw new ContractError(`cabecalho invalido em ${origem}, linha ${i + 1}: esperado 'campo: valor'.`, {
        path: origem,
        line: i + 1,
      });
    }
    const campo = linha.slice(0, sep).trim();
    if (!KNOWN_FIELDS.has(campo)) {
      throw new ContractError(
        `campo desconhecido no cabecalho de ${origem}: ${JSON.stringify(campo)}. Conhecidos: ${FIELD_ORDER.join(", ")}.`,
        { path: origem, field: campo },
      );
    }
    if (Object.hasOwn(bruto, campo)) {
      throw new ContractError(`campo repetido no cabecalho de ${origem}: ${campo}.`, { path: origem, field: campo });
    }
    bruto[campo] = linha.slice(sep + 1).trim();
  }
  if (i >= linhas.length) {
    throw new ContractError(`cabecalho nao fechado em ${origem}: falta o '---' de fechamento.`, { path: origem });
  }

  const header = {
    _type: bruto._type ?? "",
    version: bruto.version === undefined ? undefined : Number(bruto.version),
    slug: bruto.slug ?? "",
    kind: bruto.kind ?? "",
    title: bruto.title ?? "",
    pinned: parseBool(bruto.pinned, origem),
    phase: emptyToNull(bruto.phase),
    tags: parseTags(bruto.tags),
    source: bruto.source ?? "",
    created_at: bruto.created_at ?? "",
    updated_at: bruto.updated_at ?? "",
    promoted_to: emptyToNull(bruto.promoted_to),
  } as unknown as PageHeader;

  assertValidHeader(header, origem);
  assertSafeSlug(header.slug);
  return { ...header, body: linhas.slice(i + 1).join("\n").trim() };
}

function assertValidHeader(header: PageHeader, origem = "<memoria>"): void {
  if (!validateMemoryPageSchema(header as unknown)) {
    throw new ContractError(
      `pagina de memoria invalida (${origem}):\n  - ${formatAjvErrors(validateMemoryPageSchema.errors).join("\n  - ")}`,
      { path: origem },
    );
  }
  assertCabecalhoRepresentavel(header, origem);
}

/**
 * O cabecalho e uma linha por campo, e a lista de tags e separada por virgula.
 *
 * Um titulo com quebra de linha escreveria campo novo no meio do cabecalho, e o
 * arquivo nao voltaria a ser lido: `psh remember --title $'x\npinned: false'`
 * reportava sucesso e deixava a anotacao ilegivel para sempre. Uma tag com
 * virgula voltava partida em duas.
 *
 * A recusa e na porta de escrita, com o campo nomeado. Perder a anotacao que o
 * comando existe para guardar e pior do que recusar o titulo.
 */
function assertCabecalhoRepresentavel(header: PageHeader, origem: string): void {
  for (const campo of ["slug", "title", "source", "phase", "created_at", "updated_at", "promoted_to"] as const) {
    const valor = header[campo];
    if (typeof valor === "string" && temQuebraDeLinha(valor)) {
      throw new ContractError(
        `campo '${campo}' da pagina de memoria nao pode ter quebra de linha (${origem}): ${JSON.stringify(valor)}`,
        { path: origem, field: campo },
      );
    }
  }
  for (const tag of header.tags) {
    if (temQuebraDeLinha(tag) || tag.includes(",")) {
      throw new ContractError(
        `tag invalida (${origem}): ${JSON.stringify(tag)}. A lista e separada por virgula, entao a tag nao pode ter virgula nem quebra de linha.`,
        { path: origem, tag },
      );
    }
    if (tag.trim() !== tag) {
      throw new ContractError(`tag com espaco na ponta (${origem}): ${JSON.stringify(tag)}`, { path: origem, tag });
    }
  }
}

function temQuebraDeLinha(valor: string): boolean {
  return valor.includes("\n") || valor.includes("\r");
}

function parseBool(value: string | undefined, origem: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ContractError(
    `campo 'pinned' invalido em ${origem}: ${JSON.stringify(value ?? "")}. Use true ou false.`,
    { path: origem },
  );
}

function parseTags(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

function headerOf(page: MemoryPage): PageHeader {
  const { body, ...header } = page;
  void body;
  return header;
}

/** Texto que entra no indice de busca: titulo, tags e corpo. */
export function indexableText(page: MemoryPage): string {
  return [page.title, page.tags.join(" "), page.body].filter((p) => p !== "").join("\n");
}
