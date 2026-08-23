import { existsSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import consolidationSchema from "../../schemas/memory-consolidation.schema.json" with { type: "json" };
import type { AuditChain, AuditEntry } from "../audit/chain.ts";
import { AuditError, ContractError } from "../util/errors.ts";
import { readJsonFile, writeJsonAtomic } from "../util/json.ts";
import type { Layout } from "../util/paths.ts";
import { formatAjvErrors } from "../workflow/load.ts";

const ajv = new Ajv({ allErrors: true, strict: false });
export const validateConsolidationSchema = ajv.compile(consolidationSchema);

export interface ConsolidationState {
  _type: "psh-memory-consolidation";
  version: 1;
  last_seq: number;
  last_slug: string | null;
  updated_at: string;
}

export function consolidationStatePath(layout: Layout): string {
  return join(layout.memoryDir, "consolidation.json");
}

/**
 * A marca d'agua mora em disco, nao no SQLite.
 *
 * O indice e descartavel por construcao; se a marca morasse nele, apagar o
 * indice faria a proxima consolidacao varrer a trilha inteira de novo e
 * despejar meses de historico numa pagina so.
 */
export function readConsolidationState(layout: Layout): ConsolidationState {
  const path = consolidationStatePath(layout);
  if (!existsSync(path)) {
    return {
      _type: "psh-memory-consolidation",
      version: 1,
      last_seq: 0,
      last_slug: null,
      updated_at: new Date(0).toISOString(),
    };
  }
  const raw = readJsonFile(path);
  if (!validateConsolidationSchema(raw)) {
    throw new ContractError(
      `${path} invalido:\n  - ${formatAjvErrors(validateConsolidationSchema.errors).join("\n  - ")}`,
      { path },
    );
  }
  return raw as unknown as ConsolidationState;
}

export function writeConsolidationState(layout: Layout, state: ConsolidationState): void {
  writeJsonAtomic(consolidationStatePath(layout), state);
}

// --- digest ---------------------------------------------------------------

export interface FaseNoDigest {
  from: string | null;
  to: string | null;
  attempt: number;
  verdict: string;
  passed: boolean;
  override: boolean;
  reason: string | null;
  seq: number;
}

export interface VerificadorNoDigest {
  verifier: string;
  phase: string | null;
  status: string;
  value: number | null;
  exit_code: number | null;
  error: string | null;
  seq: number;
}

export interface AnotacaoNoDigest {
  slug: string;
  kind: string;
  pinned: boolean;
  promoted_to: string | null;
  seq: number;
}

export interface ViolacaoNoDigest {
  path: string;
  action: string;
  agent: string;
  seq: number;
}

export interface DecisaoHumanaNoDigest {
  tipo: "aprovacao" | "override" | "allowlist";
  quem: string;
  assunto: string;
  motivo: string | null;
  seq: number;
}

export interface MarcoNoDigest {
  descricao: string;
  seq: number;
}

export interface SessionDigest {
  /** Faixa de entradas da trilha que virou esta pagina. */
  from_seq: number;
  to_seq: number;
  started_at: string;
  finished_at: string;
  /** R2.13: quantas entradas foram examinadas, nao so as que viraram linha. */
  entries_examined: number;
  marcos: MarcoNoDigest[];
  fases: FaseNoDigest[];
  verificadores: VerificadorNoDigest[];
  anotacoes: AnotacaoNoDigest[];
  violacoes: ViolacaoNoDigest[];
  decisoes: DecisaoHumanaNoDigest[];
  comandos: { total: number; falharam: number; alertas: string[] };
  /** Tipos de entrada que nenhuma seção soube ler, contados por tipo. */
  nao_classificadas: Record<string, number>;
}

const texto = (valor: unknown): string | null => (typeof valor === "string" ? valor : null);
const numero = (valor: unknown): number | null => (typeof valor === "number" ? valor : null);

/**
 * R5.2, lado da captura: a trilha **e** a captura.
 *
 * Decisao de fase, resultado de verificador e anotacao ja entram nela por
 * R4.3, encadeados por hash e conferiveis por `psh audit verify`. Guardar uma
 * segunda copia dos mesmos fatos num buffer paralelo criaria duas versoes da
 * mesma sessao, e a segunda nao teria como provar que e verdadeira.
 *
 * O que falta e prompt do usuario, que so o adapter enxerga (R5.1, R8.2).
 */
export function buildDigest(entries: readonly AuditEntry[]): SessionDigest {
  const digest: SessionDigest = {
    from_seq: entries[0]?.seq ?? 0,
    to_seq: entries.at(-1)?.seq ?? 0,
    started_at: entries[0]?.ts ?? "",
    finished_at: entries.at(-1)?.ts ?? "",
    entries_examined: entries.length,
    marcos: [],
    fases: [],
    verificadores: [],
    anotacoes: [],
    violacoes: [],
    decisoes: [],
    comandos: { total: 0, falharam: 0, alertas: [] },
    nao_classificadas: {},
  };

  for (const entry of entries) {
    const p = entry.payload;
    switch (entry.type) {
      case "phase.transition":
      case "human.override": {
        const gate = p.gate as { passed?: boolean } | undefined;
        digest.fases.push({
          from: texto(p.from_phase),
          to: texto(p.to_phase),
          attempt: numero(p.attempt) ?? 1,
          verdict: texto(p.verdict) ?? "?",
          passed: gate?.passed === true,
          override: entry.type === "human.override",
          reason: texto(p.reason),
          seq: entry.seq,
        });
        break;
      }
      case "verifier.run": {
        const erro = p.error as { message?: string } | null | undefined;
        digest.verificadores.push({
          verifier: texto(p.verifier) ?? "?",
          phase: texto(p.phase),
          status: texto(p.status) ?? "?",
          value: numero(p.value),
          exit_code: numero(p.exit_code),
          error: erro?.message ?? null,
          seq: entry.seq,
        });
        break;
      }
      case "memory.write": {
        digest.anotacoes.push({
          slug: texto(p.slug) ?? "?",
          kind: texto(p.kind) ?? "?",
          pinned: p.pinned === true,
          promoted_to: null,
          seq: entry.seq,
        });
        break;
      }
      case "memory.promote": {
        const slug = texto(p.slug) ?? "?";
        const anterior = digest.anotacoes.find((a) => a.slug === slug);
        if (anterior !== undefined) anterior.promoted_to = texto(p.to);
        else
          digest.anotacoes.push({
            slug,
            kind: "promovida",
            pinned: false,
            promoted_to: texto(p.to),
            seq: entry.seq,
          });
        break;
      }
      case "boundary.decision": {
        if (texto(p.action) === "violacao") {
          digest.violacoes.push({
            path: texto(p.path) ?? "?",
            action: texto(p.result) ?? texto(p.boundary_action) ?? "registrada",
            agent: entry.actor,
            seq: entry.seq,
          });
        } else {
          digest.decisoes.push({
            tipo: "allowlist",
            quem: entry.actor,
            assunto: texto(p.glob) ?? texto(p.path) ?? "allowlist",
            motivo: texto(p.action),
            seq: entry.seq,
          });
        }
        break;
      }
      case "command.exec": {
        digest.comandos.total += 1;
        if (numero(p.exit_code) !== 0) digest.comandos.falharam += 1;
        for (const alerta of Array.isArray(p.destructive_alerts) ? p.destructive_alerts : []) {
          const id = texto(alerta);
          if (id !== null && !digest.comandos.alertas.includes(id)) digest.comandos.alertas.push(id);
        }
        break;
      }
      case "harness.init": {
        const perfil = texto(p.profile) ?? "?";
        const stack = texto(p.stack) ?? "?";
        digest.marcos.push({ descricao: `harness inicializado: perfil ${perfil}, stack ${stack}`, seq: entry.seq });
        break;
      }
      case "human.approval": {
        digest.decisoes.push({
          tipo: "aprovacao",
          quem: entry.actor,
          assunto: texto(p.subject) ?? "?",
          motivo: null,
          seq: entry.seq,
        });
        break;
      }
      default: {
        const tipo = entry.type;
        digest.nao_classificadas[tipo] = (digest.nao_classificadas[tipo] ?? 0) + 1;
      }
    }
  }

  // Override entra duas vezes na trilha quando tambem transiciona; a lista de
  // decisoes recebe a versao humana para que o registro nao dependa de quem le
  // a secao de fases.
  for (const fase of digest.fases) {
    if (!fase.override) continue;
    digest.decisoes.push({
      tipo: "override",
      quem: "humano",
      assunto: `${fase.from ?? "?"} #${fase.attempt}`,
      motivo: fase.reason,
      seq: fase.seq,
    });
  }
  digest.decisoes.sort((a, b) => a.seq - b.seq);

  return digest;
}

// --- narracao -------------------------------------------------------------

export const NARRADOR = "trilha";

/**
 * R5.2 pede a pagina "reescrita como narrativa", e isso e uma chamada de LLM
 * que passa pelo Maestro (C6). O Maestro nao existe nesta versao.
 *
 * Em vez de chamar modelo por fora do roteador, a consolidacao monta a pagina a
 * partir da trilha: cada linha tem o numero da entrada que a originou, e nada
 * aqui depende de um modelo lembrar direito. Quando o C6 entrar, a narrativa
 * vira uma reescrita **por cima** deste texto, com o original preservado.
 */
export function narrarDaTrilha(digest: SessionDigest): string {
  const l: string[] = [];

  l.push(
    `Sessao de ${digest.started_at} a ${digest.finished_at}, entradas ${digest.from_seq} a ${digest.to_seq} da trilha.`,
  );
  l.push("");

  if (digest.marcos.length > 0) {
    l.push("## Marcos");
    l.push("");
    for (const m of digest.marcos) l.push(`- \`#${m.seq}\` ${m.descricao}`);
    l.push("");
  }

  if (digest.fases.length > 0) {
    l.push("## Fases");
    l.push("");
    for (const f of digest.fases) {
      const alvo = f.to === null ? "(fim)" : f.to;
      const marca = f.override ? " **override humano**" : "";
      l.push(`- \`#${f.seq}\` ${f.from ?? "(nenhuma)"} -> ${alvo}, tentativa ${f.attempt}: ${f.verdict}${marca}`);
      if (f.reason !== null) l.push(`  motivo declarado: ${f.reason}`);
    }
    l.push("");
  }

  if (digest.verificadores.length > 0) {
    l.push("## Verificadores");
    l.push("");
    for (const v of digest.verificadores) {
      const valor = v.value === null ? "sem valor" : String(v.value);
      l.push(`- \`#${v.seq}\` ${v.verifier}: ${v.status}, ${valor}, exit ${v.exit_code ?? "-"}`);
      if (v.error !== null) l.push(`  erro: ${v.error}`);
    }
    l.push("");
  }

  if (digest.violacoes.length > 0) {
    l.push("## Fronteira");
    l.push("");
    for (const v of digest.violacoes) {
      l.push(`- \`#${v.seq}\` ${v.agent} tentou escrever em ${v.path} (${v.action})`);
    }
    l.push("");
  }

  if (digest.decisoes.length > 0) {
    l.push("## Decisoes humanas");
    l.push("");
    for (const d of digest.decisoes) {
      l.push(`- \`#${d.seq}\` ${d.tipo}: ${d.assunto}, por ${d.quem}`);
      if (d.motivo !== null) l.push(`  ${d.motivo}`);
    }
    l.push("");
  }

  if (digest.anotacoes.length > 0) {
    l.push("## Anotacoes da sessao");
    l.push("");
    for (const a of digest.anotacoes) {
      const destino = a.promoted_to === null ? "" : `, promovida para ${a.promoted_to}`;
      l.push(`- \`#${a.seq}\` \`${a.slug}\`${a.pinned ? " (fixada)" : ""}${destino}`);
    }
    l.push("");
  }

  if (digest.comandos.total > 0) {
    l.push("## Comandos sob fronteira");
    l.push("");
    l.push(`- ${digest.comandos.total} execucao(oes), ${digest.comandos.falharam} com codigo de saida diferente de zero.`);
    if (digest.comandos.alertas.length > 0) {
      l.push(`- Alertas de comando destrutivo: ${digest.comandos.alertas.join(", ")}.`);
    }
    l.push("");
  }

  const naoLidas = Object.entries(digest.nao_classificadas);
  if (naoLidas.length > 0) {
    l.push("## Entradas que esta versao nao resume");
    l.push("");
    // R2.13: o que a consolidacao nao soube ler sai contado por tipo. Entrada
    // que some sem numero vira sessao que parece menor do que foi.
    for (const [tipo, n] of naoLidas.sort()) l.push(`- ${tipo}: ${n}`);
    l.push("");
  }

  l.push("---");
  l.push("");
  l.push(
    `Pagina montada a partir da trilha por \`psh memory consolidate\`, sem chamada de modelo. ` +
      `${digest.entries_examined} entrada(s) examinada(s). ` +
      `A reescrita como narrativa (R5.2) depende do Maestro e ainda nao existe.`,
  );

  return l.join("\n");
}

export function tituloDoDigest(digest: SessionDigest): string {
  const dia = digest.started_at.slice(0, 10);
  const fase = digest.fases.at(-1);
  if (fase !== undefined) {
    return `Sessao de ${dia}: ${fase.from ?? "inicio"} para ${fase.to ?? "fim"}`;
  }
  if (digest.verificadores.length > 0) {
    return `Sessao de ${dia}: ${digest.verificadores.length} verificacao(oes)`;
  }
  return `Sessao de ${dia}: ${digest.entries_examined} entrada(s) na trilha`;
}

export function slugDoDigest(digest: SessionDigest): string {
  const dia = digest.started_at.slice(0, 10);
  return `sessao-${dia}-${String(digest.from_seq).padStart(4, "0")}-${String(digest.to_seq).padStart(4, "0")}`;
}

export function tagsDoDigest(digest: SessionDigest): string[] {
  const tags = new Set<string>(["sessao"]);
  for (const f of digest.fases) {
    if (f.to !== null) tags.add(f.to);
    if (f.from !== null) tags.add(f.from);
  }
  for (const v of digest.verificadores) tags.add(v.verifier);
  return [...tags].slice(0, 12);
}

/** Ator com que a propria consolidacao assina o que grava na trilha. */
export const ATOR_DA_CONSOLIDACAO = "core:consolidate";

/**
 * A consolidacao nao resume a si mesma.
 *
 * Ela grava uma entrada `memory.write` na trilha ao terminar. Sem este filtro
 * essa entrada vira material da corrida seguinte, que gera outra pagina, que
 * grava outra entrada: `psh memory consolidate` rodado tres vezes seguidas
 * produzia tres paginas, e as duas ultimas so falavam da anterior.
 */
export function ehEntradaDaConsolidacao(entry: AuditEntry): boolean {
  return entry.type === "memory.write" && entry.actor === ATOR_DA_CONSOLIDACAO;
}

export interface Pendentes {
  entradas: AuditEntry[];
  /** Topo da trilha, para a marca d'agua avancar mesmo sem pagina nova. */
  head_seq: number;
  /** Quantas entradas de bookkeeping da propria consolidacao foram puladas. */
  ignoradas: number;
}

/**
 * Entradas ainda nao consolidadas.
 *
 * Consolidar em cima de trilha comprometida seria assinar como memoria um
 * relato que a propria cadeia nao sustenta, entao a verificacao vem antes.
 */
export function entradasPendentes(chain: AuditChain, state: ConsolidationState): Pendentes {
  const verificacao = chain.verify();
  if (!verificacao.ok) {
    throw new AuditError(
      `trilha comprometida (${verificacao.problems.length} problema(s)): a consolidacao nao resume o que a cadeia nao sustenta. Rode 'psh audit verify'.`,
      { problems: verificacao.problems.length },
    );
  }
  const todas = chain.read();
  const topo = todas.at(-1)?.seq ?? 0;
  if (state.last_seq > topo) {
    throw new ContractError(
      `a marca d'agua da consolidacao aponta para a entrada ${state.last_seq}, mas a trilha termina em ${topo}. ` +
        "A trilha encolheu depois da ultima consolidacao, e isso e problema de auditoria, nao de memoria.",
      { last_seq: state.last_seq, head_seq: topo },
    );
  }
  const novas = todas.filter((e) => e.seq > state.last_seq);
  const entradas = novas.filter((e) => !ehEntradaDaConsolidacao(e));
  return { entradas, head_seq: topo, ignoradas: novas.length - entradas.length };
}
