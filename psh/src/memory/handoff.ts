import type { ProjectContext } from "../cli/context.ts";
import { buildStatus, type StatusReport } from "../cli/status.ts";
import { PSH_VERSION } from "../version.ts";
import { syncIndex, type IndexSync } from "./search.ts";

/**
 * Teto do bloco de retomada.
 *
 * O bloco vai para o inicio da sessao seguinte, e a janela util e recurso
 * medido (R7.2). Memoria fixada que cresce sem limite viraria prefixo fixo que
 * ninguem contou. O corte e **declarado**, item por item e no total, e o texto
 * inteiro continua a um `psh memory get` de distancia.
 */
export const MAX_PINNED_NO_BLOCO = 12;
export const MAX_CORPO_POR_ITEM = 400;

export interface HandoffItem {
  slug: string;
  title: string;
  kind: string;
  updated_at: string;
  body: string;
  /** Verdadeiro quando o corpo foi cortado para caber no bloco. */
  body_truncated: boolean;
}

export interface HandoffPending {
  label: string;
  observed: string;
  expected: string;
  reason: string | null;
}

export interface Handoff {
  _type: "psh-handoff";
  version: 1;
  psh_version: string;
  generated_at: string;
  root: string;
  profile: string;
  phase: string | null;
  phase_name: string | null;
  attempt: number;
  retries_used: number;
  status: string;
  /** Ultima transicao registrada: de onde a sessao anterior parou. */
  last_decision: { phase: string; attempt: number; verdict: string; at: string } | null;
  /** O que reprova o portao agora. E isto que a proxima sessao precisa fechar. */
  pending: HandoffPending[];
  sandbox_mode: string;
  boundary_mode: string;
  audit_ok: boolean;
  pinned: HandoffItem[];
  /** Fixadas que existem mas nao couberam no bloco. Nunca corte silencioso. */
  pinned_omitted: number;
  recent: HandoffItem[];
  memory_index: IndexSync;
  next_commands: string[];
}

/**
 * R5.4: contexto de retomada.
 *
 * Tudo aqui e lido do estado e da evidencia em disco, nunca de resumo de
 * modelo. O bloco existe porque a sessao seguinte pode abrir em outro runtime,
 * outro dia, ou depois de o processo morrer no meio de uma fase (UC3): o que
 * ele afirma precisa ser verificavel pelos mesmos comandos que ele sugere.
 */
export function buildHandoff(ctx: ProjectContext, opts: { limit?: number; now?: Date } = {}): Handoff {
  const limite = opts.limit ?? 5;
  const status = buildStatus(ctx);
  const memoryIndex = syncIndex(ctx.db, ctx.layout);

  const todasFixadas = ctx.db.listMemoryPages({ pinnedOnly: true, limit: MAX_PINNED_NO_BLOCO + 1 });
  const pinned = todasFixadas.slice(0, MAX_PINNED_NO_BLOCO).map(toItem);
  const totalFixadas = ctx.db.countMemoryPages({ pinnedOnly: true });
  const fixadas = new Set(pinned.map((p) => p.slug));
  const recent = ctx.db
    .listMemoryPages({ limit: limite + pinned.length })
    .filter((row) => !fixadas.has(row.slug) && row.pinned !== 1)
    .slice(0, limite)
    .map(toItem);

  const ultima = ctx.state.history.at(-1) ?? null;

  return {
    _type: "psh-handoff",
    version: 1,
    psh_version: PSH_VERSION,
    generated_at: (opts.now ?? new Date()).toISOString(),
    root: ctx.layout.root,
    profile: status.profile,
    phase: status.phase,
    phase_name: status.phase_name,
    attempt: status.attempt,
    retries_used: status.retries_used,
    status: status.status,
    last_decision:
      ultima === null
        ? null
        : { phase: ultima.phase, attempt: ultima.attempt, verdict: ultima.verdict, at: ultima.at },
    pending: pendencias(status),
    sandbox_mode: status.sandbox.mode,
    boundary_mode: status.boundary.mode,
    audit_ok: status.audit.ok,
    pinned,
    pinned_omitted: Math.max(0, totalFixadas - pinned.length),
    recent,
    memory_index: memoryIndex,
    next_commands: proximosComandos(status),
  };
}

function toItem(row: { slug: string; title: string; kind: string; updated_at: string; body: string }): HandoffItem {
  const corpo = row.body.trim();
  const cortado = corpo.length > MAX_CORPO_POR_ITEM;
  return {
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    updated_at: row.updated_at,
    body: cortado ? `${corpo.slice(0, MAX_CORPO_POR_ITEM).trimEnd()}...` : corpo,
    body_truncated: cortado,
  };
}

function pendencias(status: StatusReport): HandoffPending[] {
  if (status.gate === null) return [];
  return status.gate.checks
    .filter((c) => !c.passed)
    .map((c) => ({
      label: c.label,
      observed: c.observed === null ? "sem evidencia" : String(c.observed),
      expected: c.expected === null || c.expected === undefined ? "-" : String(c.expected),
      reason: c.reason ?? null,
    }));
}

function proximosComandos(status: StatusReport): string[] {
  if (!status.audit.ok) return ["psh audit verify"];
  if (status.phase === null) return ["psh status"];
  if (status.gate === null || status.gate.passed) return ["psh advance"];
  const semEvidencia = status.gate.checks.some((c) => !c.passed && c.observed === null);
  return semEvidencia ? ["psh verify --all", "psh status"] : ["psh status", "psh verify --all"];
}

/**
 * Bloco pronto para prepend. Markdown, porque e o formato que todo runtime
 * aceita como texto de sistema sem tratamento especial.
 */
export function renderHandoff(h: Handoff): string {
  const linhas: string[] = [];
  linhas.push("# Retomada de sessao (psh handoff)");
  linhas.push("");
  linhas.push(
    `Projeto \`${h.root}\`, perfil ${h.profile}, gerado em ${h.generated_at} pelo psh ${h.psh_version}.`,
  );
  linhas.push("");
  linhas.push("## Onde a sessao anterior parou");
  linhas.push("");
  linhas.push(
    `- Fase **${h.phase ?? "(nenhuma)"}**${h.phase_name === null ? "" : ` - ${h.phase_name}`}, tentativa ${h.attempt}, status ${h.status}.`,
  );
  linhas.push(
    h.last_decision === null
      ? "- Nenhuma transicao registrada ainda."
      : `- Ultima decisao: ${h.last_decision.phase} #${h.last_decision.attempt} ${h.last_decision.verdict} em ${h.last_decision.at}.`,
  );
  linhas.push(`- Sandbox ${h.sandbox_mode}, fronteira ${h.boundary_mode}, trilha ${h.audit_ok ? "integra" : "COMPROMETIDA"}.`);
  linhas.push("");

  linhas.push("## Pendencias abertas");
  linhas.push("");
  if (h.pending.length === 0) {
    linhas.push("Nenhum check do portao esta reprovado agora.");
  } else {
    for (const p of h.pending) {
      linhas.push(`- **${p.label}**: observado ${p.observed}, esperado ${p.expected}.${p.reason === null ? "" : ` ${p.reason}`}`);
    }
  }
  linhas.push("");

  if (h.pinned.length > 0) {
    linhas.push("## Memoria fixada");
    linhas.push("");
    for (const item of h.pinned) {
      linhas.push(`- **${item.title}** (\`${item.slug}\`)`);
      if (item.body !== "") linhas.push(`  ${item.body.replaceAll("\n", "\n  ")}`);
      if (item.body_truncated) linhas.push(`  (cortado no bloco; \`psh memory get ${item.slug}\` traz o texto inteiro)`);
    }
    if (h.pinned_omitted > 0) {
      linhas.push(
        `- mais ${h.pinned_omitted} pagina(s) fixada(s) fora do bloco, por teto de tamanho: \`psh memory list --pinned\``,
      );
    }
    linhas.push("");
  }

  if (h.recent.length > 0) {
    linhas.push("## Memoria recente");
    linhas.push("");
    for (const item of h.recent) {
      linhas.push(`- ${item.title} (\`${item.slug}\`, ${item.kind}, ${item.updated_at})`);
    }
    linhas.push("");
  }

  linhas.push("## Como continuar");
  linhas.push("");
  for (const cmd of h.next_commands) linhas.push(`- \`${cmd}\``);
  linhas.push("");
  linhas.push(
    "> R5.7: memoria e faixa transitoria, nao e fonte canonica. O que precisa " +
      "sobreviver com garantia vira arquivo no repositorio por `psh memory promote`.",
  );
  return linhas.join("\n");
}
