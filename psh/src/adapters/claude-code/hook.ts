import { isAbsolute, resolve } from "node:path";
import { openProject, type ProjectContext } from "../../cli/context.ts";
import { boundaryOf } from "../../cli/boundary.ts";
import { consolidate } from "../../cli/memory.ts";
import { buildHandoff, renderHandoff } from "../../memory/handoff.ts";
import { detectDestructive } from "../../boundary/detect.ts";
import { compileGlobs } from "../../util/globs.ts";
import { toRel } from "../../util/paths.ts";
import { EXIT, PshError } from "../../util/errors.ts";
import { PSH_VERSION } from "../../version.ts";

/**
 * Entrada de hook, com os nomes que o runtime instalado usa de verdade.
 *
 * Nenhum destes nomes foi escrito de memoria: todos saem do `contract.json`,
 * que e conferido contra o artefato instalado (R8.2b, R8.6b, R8.6g). A
 * diferenca entre `prompt` e `message` foi o que desligou o `prostaff-hooks`
 * inteiro sem emitir um erro sequer.
 */
export interface HookInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  source?: unknown;
  reason?: unknown;
  prompt?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: unknown;
}

export type PermissionDecision = "allow" | "deny" | "ask";

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: PermissionDecision;
    permissionDecisionReason?: string;
  };
  systemMessage?: string;
}

export interface HookResult {
  output: HookOutput | null;
  exitCode: number;
  /** Por que o hook fez o que fez. Vai para stderr, para diagnostico. */
  nota: string;
}

const SILENCIO: HookResult = { output: null, exitCode: EXIT.OK, nota: "" };

/** Tools que escrevem arquivo, com o campo onde o caminho vem em cada uma. */
const CAMPO_DE_CAMINHO: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export interface HookDeps {
  /** Injetavel para o teste nao depender do diretorio de trabalho do processo. */
  abrirProjeto?: (cwd: string) => ProjectContext;
  now?: Date;
}

/**
 * R8.1: o adapter so traduz evento para chamada do nucleo.
 *
 * Nenhuma regra de negocio mora aqui. Fronteira e do C3, memoria e do C5,
 * frescor e do C2: o hook decide de quem e o assunto e devolve o formato que o
 * runtime entende.
 */
export function handleHook(bruto: unknown, deps: HookDeps = {}): HookResult {
  if (bruto === null || typeof bruto !== "object") {
    return { output: null, exitCode: EXIT.OK, nota: "payload de hook nao e objeto; nada a fazer" };
  }
  const input = bruto as HookInput;
  const evento = texto(input.hook_event_name);
  if (evento === null) {
    return { output: null, exitCode: EXIT.OK, nota: "payload sem hook_event_name; nada a fazer" };
  }

  const cwd = texto(input.cwd) ?? process.cwd();
  const abrir = deps.abrirProjeto ?? ((dir: string) => openProject(dir));

  let ctx: ProjectContext;
  try {
    ctx = abrir(cwd);
  } catch (cause) {
    // Sessao fora de projeto com harness e o caso comum, nao erro: o hook fica
    // calado. Travar toda sessao do usuario por causa disso seria pior do que
    // nao existir.
    const erro = cause as PshError;
    if (erro.exitCode === EXIT.NOT_INITIALIZED) return SILENCIO;
    return degradar(evento, `nao foi possivel abrir o projeto em ${cwd}: ${erro.message}`);
  }

  try {
    switch (evento) {
      case "SessionStart":
        return aoAbrirSessao(ctx, input, deps);
      case "UserPromptSubmit":
        return aoReceberPrompt(ctx, input);
      case "PreToolUse":
        return antesDaTool(ctx, input);
      case "PostToolUse":
        return depoisDaTool(ctx, input);
      case "SessionEnd":
        return aoFecharSessao(ctx, input, deps);
      default:
        return { output: null, exitCode: EXIT.OK, nota: `evento ${evento} nao e tratado por este adapter` };
    }
  } catch (cause) {
    return degradar(evento, (cause as Error).message);
  } finally {
    ctx.close();
  }
}

/**
 * Falha do adapter nunca vira sessao travada nem escrita liberada em silencio.
 *
 * Em `PreToolUse` a decisao degradada e `ask`: quem decide passa a ser o
 * humano, com o motivo na tela. Liberar caladamente esconderia o furo, e negar
 * tudo transformaria qualquer erro do harness em sessao inutilizavel.
 */
function degradar(evento: string, motivo: string): HookResult {
  if (evento === "PreToolUse") {
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `psh ${PSH_VERSION} nao conseguiu decidir: ${motivo}`,
        },
      },
      exitCode: EXIT.OK,
      nota: motivo,
    };
  }
  return { output: null, exitCode: EXIT.OK, nota: motivo };
}

// --- SessionStart ---------------------------------------------------------

function aoAbrirSessao(ctx: ProjectContext, input: HookInput, deps: HookDeps): HookResult {
  const handoff = buildHandoff(ctx, { now: deps.now });
  const bloco = [regrasDoHarness(ctx), "", renderHandoff(handoff)].join("\n");

  ctx.chain.append("adapter.event", "adapter:claude-code", {
    event: "SessionStart",
    session_id: texto(input.session_id),
    source: texto(input.source),
    phase: handoff.phase,
    pending: handoff.pending.length,
    injected_chars: bloco.length,
  });

  return {
    output: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: bloco } },
    exitCode: EXIT.OK,
    nota: `bloco de retomada injetado (${bloco.length} caracteres)`,
  };
}

/**
 * R8.1, primeira responsabilidade: o prompt do harness.
 *
 * Curto de proposito. Ele ocupa janela em toda sessao (R7.2), e regra que o
 * nucleo aplica sozinho nao precisa ser pedida ao modelo: a fronteira barra a
 * escrita, o portao recusa metrica por argumento. O que esta aqui e o que o
 * modelo precisa saber para nao perder tempo tentando.
 */
function regrasDoHarness(ctx: ProjectContext): string {
  return [
    `# Harness psh ${PSH_VERSION}`,
    "",
    `Este projeto roda sob o ProStaff Harness, perfil ${ctx.state.profile}.`,
    "",
    "- Portao consome evidencia produzida por `psh verify`. Numero dito por voce",
    "  nao entra: nenhum comando aceita metrica por argumento.",
    "- Escrita fora da allowlist do agente e barrada pela fronteira, nao por",
    "  convencao. `psh boundary check <caminho>` diz o veredito antes da tentativa.",
    "- Fato que precisa sobreviver a esta sessao vira `psh remember \"<fato>\"`.",
    "  O resto e resumido sozinho no fim da sessao.",
  ].join("\n");
}

// --- UserPromptSubmit -----------------------------------------------------

const MARCADORES_DE_SEGREDO = [
  "AKIA",
  "sk-ant-",
  "sk-proj-",
  "ghp_",
  "github_pat_",
  "xoxb-",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
];

export const LIMITE_DO_PROMPT = 2000;

/**
 * R5.1: a peca da captura que a trilha nao ve sozinha.
 *
 * O prompt vai para a trilha, nao para uma pagina por prompt: a consolidacao ja
 * le a trilha, entao ele aparece na pagina da sessao junto do resto.
 *
 * R4.4, versao curta: prompt com marcador de segredo nao entra em texto. A
 * trilha e append-only e encadeada por hash, entao segredo que entra nao sai
 * mais - o registro guarda que houve prompt, e o tamanho dele.
 */
function aoReceberPrompt(ctx: ProjectContext, input: HookInput): HookResult {
  const prompt = texto(input.prompt);
  if (prompt === null) {
    return { output: null, exitCode: EXIT.OK, nota: "prompt vazio" };
  }

  const marcador = MARCADORES_DE_SEGREDO.find((m) => prompt.includes(m)) ?? null;
  const cortado = prompt.length > LIMITE_DO_PROMPT;

  ctx.chain.append("prompt.submit", "human:sessao", {
    session_id: texto(input.session_id),
    phase: ctx.state.phase,
    chars: prompt.length,
    truncated: cortado,
    redacted: marcador !== null,
    redacted_marker: marcador,
    text: marcador === null ? prompt.slice(0, LIMITE_DO_PROMPT) : null,
  });

  return {
    output: null,
    exitCode: EXIT.OK,
    nota: marcador === null ? `prompt registrado (${prompt.length} caracteres)` : `prompt redigido: marcador ${marcador}`,
  };
}

// --- PreToolUse -----------------------------------------------------------

function antesDaTool(ctx: ProjectContext, input: HookInput): HookResult {
  const tool = texto(input.tool_name);
  if (tool === null) return SILENCIO;
  const entrada = (input.tool_input ?? {}) as Record<string, unknown>;

  if (tool === "Bash") {
    // R3.3: deteccao de comando destrutivo e alerta, nunca bloqueio. Quem
    // decide escrita e a fronteira, e ela nao le expressao regular.
    const argv = [texto(entrada.command) ?? ""];
    const alertas = detectDestructive(argv);
    if (alertas.alerts.length === 0) return SILENCIO;
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `psh: alerta de comando destrutivo (${alertas.alerts.map((a) => a.id).join(", ")}). O comando roda; a fronteira decide o que ele consegue escrever.`,
        },
      },
      exitCode: EXIT.OK,
      nota: `alerta destrutivo: ${alertas.alerts.map((a) => a.id).join(", ")}`,
    };
  }

  const campo = CAMPO_DE_CAMINHO[tool];
  if (campo === undefined) return SILENCIO;
  const alvo = texto(entrada[campo]);
  if (alvo === null) return SILENCIO;

  const agente = agenteDaSessao(ctx);
  const decisao = boundaryOf(ctx).canWrite(agente, alvo);
  if (decisao.allowed) {
    return { output: null, exitCode: EXIT.OK, nota: `${alvo} dentro da fronteira de ${agente}` };
  }

  ctx.chain.append("boundary.decision", `agent:${agente}`, {
    action: "negado-antes-da-escrita",
    tool,
    path: decisao.rel ?? alvo,
    rule: decisao.rule.kind,
    reason: decisao.reason,
    tool_use_id: texto(input.tool_use_id),
  });

  return {
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `psh: ${decisao.reason}. Para liberar, o humano roda 'psh boundary add ${agente} <glob>'.`,
      },
    },
    exitCode: EXIT.OK,
    nota: `negado: ${alvo}`,
  };
}

/**
 * Qual agente a sessao esta usando.
 *
 * `PSH_AGENT` quando a sessao roda sob `psh exec`; senao o `default_agent` do
 * contrato. Sem nenhum dos dois nao ha o que decidir, e a fronteira ja recusa
 * agente desconhecido.
 */
function agenteDaSessao(ctx: ProjectContext): string {
  const marcado = process.env.PSH_AGENT?.trim();
  if (marcado !== undefined && marcado !== "") return marcado;
  return boundaryOf(ctx).defaultAgent ?? "default";
}

// --- PostToolUse ----------------------------------------------------------

/**
 * R2.4 pelo lado do agente: a escrita acabou de derrubar evidencia.
 *
 * O portao ja recusaria na hora de avancar, mas o agente descobriria isso
 * minutos depois. Dizer na hora custa uma linha e evita uma fase inteira
 * apoiada em numero velho.
 */
function depoisDaTool(ctx: ProjectContext, input: HookInput): HookResult {
  const tool = texto(input.tool_name);
  if (tool === null) return SILENCIO;
  const campo = CAMPO_DE_CAMINHO[tool];
  if (campo === undefined) return SILENCIO;
  const entrada = (input.tool_input ?? {}) as Record<string, unknown>;
  const alvo = texto(entrada[campo]);
  if (alvo === null) return SILENCIO;

  const abs = isAbsolute(alvo) ? alvo : resolve(ctx.layout.root, alvo);
  const rel = toRel(ctx.layout.root, abs);
  const atingidos: string[] = [];

  for (const verificador of ctx.workflow.verifiers) {
    const globs = verificador.watch ?? [];
    if (globs.length === 0) continue;
    if (compileGlobs(globs).matchedBy(rel) !== null) atingidos.push(verificador.id);
  }
  if (atingidos.length === 0) return SILENCIO;

  return {
    output: {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `psh: ${rel} esta na arvore observada por ${atingidos.join(", ")}. ` +
          `A evidencia desses verificadores ficou obsoleta e o portao vai recusar ate 'psh verify' rodar de novo.`,
      },
    },
    exitCode: EXIT.OK,
    nota: `frescor derrubado: ${atingidos.join(", ")}`,
  };
}

// --- SessionEnd -----------------------------------------------------------

function aoFecharSessao(ctx: ProjectContext, input: HookInput, deps: HookDeps): HookResult {
  ctx.chain.append("adapter.event", "adapter:claude-code", {
    event: "SessionEnd",
    session_id: texto(input.session_id),
    reason: texto(input.reason),
  });

  // R5.2: a sessao vira pagina. Falha aqui nao pode derrubar o encerramento da
  // sessao do usuario, entao o motivo vai para o diagnostico e o hook sai limpo.
  try {
    const r = consolidate(ctx, { now: deps.now });
    return {
      output: null,
      exitCode: EXIT.OK,
      nota: r.slug === null ? "nada a consolidar" : `sessao consolidada em ${r.slug}`,
    };
  } catch (cause) {
    return { output: null, exitCode: EXIT.OK, nota: `consolidacao falhou: ${(cause as Error).message}` };
  }
}
