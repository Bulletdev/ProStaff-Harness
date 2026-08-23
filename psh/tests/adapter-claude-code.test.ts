import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/index.ts";
import { captureIo } from "../src/cli/io.ts";
import { EXIT } from "../src/util/errors.ts";
import { AuditChain } from "../src/audit/chain.ts";
import { openProject } from "../src/cli/context.ts";
import { handleHook } from "../src/adapters/claude-code/hook.ts";
import {
  CONTRATO,
  acharRuntime,
  conferirContrato,
  renderContrato,
  varrerSimbolos,
} from "../src/adapters/claude-code/contract.ts";
import {
  desinstalar,
  ehNosso,
  instalar,
  podar,
  settingsPath,
  statusDoAdapter,
  type SettingsDoClaude,
} from "../src/adapters/claude-code/install.ts";
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

const CONTRATO_VAZIO: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
  profile: "gate-only",
  verifiers: [],
  phases: [],
};

/** Projeto com fronteira estreita: backend so escreve em src/api. */
function projeto(): Layout {
  const layout = tempProject({ git: false });
  writeFile(layout, "src/api/users.ts", "api\n");
  writeFile(layout, "src/web/app.tsx", "web\n");
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
  harnessWith(layout, CONTRATO_VAZIO).close();
  return layout;
}

function hook(layout: Layout | null, payload: Record<string, unknown>) {
  const ctx = layout === null ? null : openProject(layout.root);
  try {
    return handleHook(payload, ctx === null ? {} : { abrirProjeto: () => ctx });
  } finally {
    ctx?.close();
  }
}

function trilha(layout: Layout) {
  return new AuditChain(layout.chainPath).read();
}

describe("contrato do runtime (R8.6b, R8.6g)", () => {
  test("todo campo que o adapter usa esta declarado no fixture", () => {
    // O adapter le `tool_input.file_path`; se o nome nao estivesse na lista
    // conferida, a validacao contra o binario nao pegaria a troca de nome.
    for (const simbolo of ["hook_event_name", "tool_name", "tool_input", "prompt", "permissionDecision"]) {
      expect(CONTRATO.simbolos_conferidos).toContain(simbolo);
    }
    for (const evento of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"]) {
      expect(Object.keys(CONTRATO.events)).toContain(evento);
      expect(CONTRATO.simbolos_conferidos).toContain(evento);
    }
  });

  test("a varredura acha simbolo colado na emenda de dois blocos", () => {
    // Sem sobreposicao entre blocos, um simbolo partido ao meio sumiria e a
    // validacao reprovaria adapter que esta certo.
    const layout = tempProject({ git: false });
    const alvo = join(layout.root, "artefato.bin");
    const recheio = "x".repeat(1000);
    writeFileSync(alvo, `${recheio}PreToolUse${recheio}`);

    const r = varrerSimbolos(alvo, ["PreToolUse"], { blocoBytes: 1005 });
    expect(r.encontrados).toEqual(["PreToolUse"]);
    expect(r.ausentes).toEqual([]);
    expect(r.bytes_examinados).toBeGreaterThan(0);
  });

  test("simbolo ausente e reprovado, nao ignorado", () => {
    const layout = tempProject({ git: false });
    const alvo = join(layout.root, "artefato.bin");
    writeFileSync(alvo, "runtime que nao fala nossa lingua");
    const r = varrerSimbolos(alvo, ["PreToolUse", "hookSpecificOutput"]);
    expect(r.ausentes.sort()).toEqual(["PreToolUse", "hookSpecificOutput"]);
  });
});

describe("contrato conferido contra um artefato controlado", () => {
  /**
   * Runtime de mentira: um script que responde `--version` e carrega os
   * simbolos no proprio corpo. Ele existe para que o caminho de validacao seja
   * exercitado em qualquer maquina, inclusive onde o Claude Code nao esta
   * instalado - o teste contra o binario de verdade continua logo abaixo.
   */
  function runtimeFalso(layout: Layout, simbolos: readonly string[]): string {
    const alvo = join(layout.root, "claude-de-mentira");
    writeFileSync(alvo, `#!/bin/sh\necho "9.9.9 (Claude Code)"\n# ${simbolos.join(" ")}\n`, { mode: 0o755 });
    return alvo;
  }

  function comRuntime<T>(bin: string, fn: () => T): T {
    const antes = process.env.PSH_CLAUDE_BIN;
    process.env.PSH_CLAUDE_BIN = bin;
    try {
      return fn();
    } finally {
      if (antes === undefined) delete process.env.PSH_CLAUDE_BIN;
      else process.env.PSH_CLAUDE_BIN = antes;
    }
  }

  test("artefato com todos os simbolos passa, e a versao vem do proprio binario", () => {
    const layout = tempProject({ git: false });
    const bin = runtimeFalso(layout, CONTRATO.simbolos_conferidos);
    const r = comRuntime(bin, () => conferirContrato());

    expect(r.ok).toBe(true);
    expect(r.ausentes).toEqual([]);
    expect(r.runtime.versao).toBe("9.9.9 (Claude Code)");
    expect(r.bytes_examinados).toBeGreaterThan(0);
    expect(renderContrato(r)).toContain("OK");
  });

  test("artefato sem um simbolo reprova nomeando o que falta", async () => {
    const layout = tempProject({ git: false });
    const bin = runtimeFalso(
      layout,
      CONTRATO.simbolos_conferidos.filter((x) => x !== "notebook_path"),
    );
    const r = comRuntime(bin, () => conferirContrato());

    expect(r.ok).toBe(false);
    expect(r.ausentes).toEqual(["notebook_path"]);
    expect(renderContrato(r)).toContain("notebook_path");

    const saida = await comRuntime(bin, () => cli(["adapter", "claude-code", "contract"]));
    expect(saida.code).toBe(EXIT.CONTRACT_INVALID);
  });

  test("simbolo que e prefixo de outro nao e conferido sozinho, e isso e declarado", () => {
    const layout = tempProject({ git: false });
    // A varredura procura os bytes do simbolo. `permissionDecision` aparece
    // dentro de `permissionDecisionReason`, entao a presenca do segundo
    // satisfaz o primeiro. O limite e este, e esta escrito: a validacao pega
    // ponto de extensao que sumiu, nao renomeacao parcial de campo irmao.
    const bin = runtimeFalso(layout, ["permissionDecisionReason"]);
    const r = varrerSimbolos(bin, ["permissionDecision", "permissionDecisionReason"]);
    expect(r.ausentes).toEqual([]);
  });

  test("runtime ausente e reprovacao declarada, nao passe livre", () => {
    const r = comRuntime("/caminho/que/nao/existe/claude", () => conferirContrato());
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain("runtime nao encontrado");
    expect(r.bytes_examinados).toBe(0);
  });
});

const RUNTIME = acharRuntime();

describe.skipIf(!RUNTIME.encontrado)("contrato conferido contra o runtime instalado", () => {
  test("todo simbolo declarado existe no artefato instalado", async () => {
    const r = await cli(["adapter", "claude-code", "contract", "--json"]);
    const relatorio = JSON.parse(r.out) as {
      ok: boolean;
      ausentes: string[];
      bytes_examinados: number;
      runtime: { versao: string };
    };
    expect(relatorio.ausentes).toEqual([]);
    expect(relatorio.ok).toBe(true);
    // R2.13: varredura que nao leu nada nao e varredura limpa.
    expect(relatorio.bytes_examinados).toBeGreaterThan(0);
    expect(r.code).toBe(EXIT.OK);
  });
});

describe("hook: fronteira antes da escrita (R8.1, R8.2b)", () => {
  test("escrita fora da allowlist e negada, com o motivo e o caminho de liberacao", () => {
    const layout = projeto();
    const r = hook(layout, {
      hook_event_name: "PreToolUse",
      cwd: layout.root,
      tool_name: "Write",
      tool_input: { file_path: "src/web/app.tsx", content: "x" },
      tool_use_id: "t1",
    });

    expect(r.output?.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(r.output?.hookSpecificOutput?.permissionDecisionReason).toContain("psh boundary add");
    // R8.6e: o efeito e conferido no disco, nao na resposta.
    const entrada = trilha(layout).at(-1)!;
    expect(entrada.type).toBe("boundary.decision");
    expect(entrada.payload.path).toBe("src/web/app.tsx");
  });

  test("escrita dentro da allowlist passa sem ruido", () => {
    const layout = projeto();
    const antes = trilha(layout).length;
    const r = hook(layout, {
      hook_event_name: "PreToolUse",
      cwd: layout.root,
      tool_name: "Write",
      tool_input: { file_path: "src/api/users.ts" },
    });
    expect(r.output).toBeNull();
    expect(trilha(layout)).toHaveLength(antes);
  });

  test("o deny duro tambem vale pela tool", () => {
    const layout = projeto();
    const r = hook(layout, {
      hook_event_name: "PreToolUse",
      cwd: layout.root,
      tool_name: "Edit",
      tool_input: { file_path: ".harness/evidence/coverage.json" },
    });
    expect(r.output?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("notebook usa notebook_path, e nao file_path", () => {
    const layout = projeto();
    const r = hook(layout, {
      hook_event_name: "PreToolUse",
      cwd: layout.root,
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "src/web/analise.ipynb" },
    });
    expect(r.output?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("comando destrutivo e alerta, nunca bloqueio (R3.3)", () => {
    const layout = projeto();
    const r = hook(layout, {
      hook_event_name: "PreToolUse",
      cwd: layout.root,
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
    });
    expect(r.output?.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(r.output?.hookSpecificOutput?.permissionDecisionReason).toContain("alerta");
  });

  test("tool que nao escreve arquivo nao interessa ao adapter", () => {
    const layout = projeto();
    expect(hook(layout, { hook_event_name: "PreToolUse", cwd: layout.root, tool_name: "Read", tool_input: { file_path: "x" } }).output).toBeNull();
  });

  test("falha do harness vira 'ask', nunca liberacao calada nem sessao travada", () => {
    const layout = projeto();
    writeFileSync(layout.boundaryPath, "{ isto nao e json");
    const r = hook(layout, {
      hook_event_name: "PreToolUse",
      cwd: layout.root,
      tool_name: "Write",
      tool_input: { file_path: "src/web/app.tsx" },
    });
    expect(r.output?.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(r.exitCode).toBe(EXIT.OK);
  });
});

describe("hook: inicio e fim de sessao (R5.4, R5.2)", () => {
  test("SessionStart injeta as regras do harness e o bloco de retomada", () => {
    const layout = projeto();
    const r = hook(layout, { hook_event_name: "SessionStart", cwd: layout.root, session_id: "s1", source: "startup" });

    const contexto = r.output?.hookSpecificOutput?.additionalContext ?? "";
    expect(r.output?.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(contexto).toContain("Harness psh");
    expect(contexto).toContain("Retomada de sessao");

    const entrada = trilha(layout).at(-1)!;
    expect(entrada.type).toBe("adapter.event");
    expect(entrada.payload.event).toBe("SessionStart");
    expect(entrada.payload.injected_chars).toBe(contexto.length);
  });

  test("a memoria fixada chega ao bloco injetado", async () => {
    const layout = projeto();
    await cli(["remember", "nao mexer no gerador de migration", "--root", layout.root]);
    const r = hook(layout, { hook_event_name: "SessionStart", cwd: layout.root });
    expect(r.output?.hookSpecificOutput?.additionalContext).toContain("nao mexer no gerador de migration");
  });

  test("SessionEnd consolida a sessao em pagina", () => {
    const layout = projeto();
    hook(layout, { hook_event_name: "SessionStart", cwd: layout.root });
    const r = hook(layout, { hook_event_name: "SessionEnd", cwd: layout.root, reason: "clear" });

    expect(r.nota).toContain("consolidada");
    const paginas = readFileSync(layout.chainPath, "utf8");
    expect(paginas).toContain("core:consolidate");
  });

  test("trilha adulterada para o hook na porta, sem travar a sessao", () => {
    const layout = projeto();
    hook(layout, { hook_event_name: "SessionStart", cwd: layout.root });
    const linhas = readFileSync(layout.chainPath, "utf8").split("\n").filter((l) => l !== "");
    writeFileSync(layout.chainPath, `${linhas.slice(0, -1).join("\n")}\n`);

    const r = hook(layout, { hook_event_name: "SessionEnd", cwd: layout.root, reason: "other" });
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.nota).toContain("ancora");
    expect(r.output).toBeNull();
  });

  test("falha na consolidacao nao derruba o fim da sessao de quem trabalha", () => {
    const layout = projeto();
    hook(layout, { hook_event_name: "SessionStart", cwd: layout.root });
    mkdirSync(layout.memoryDir, { recursive: true });
    writeFileSync(join(layout.memoryDir, "consolidation.json"), '{"_type":"outra-coisa"}');

    const r = hook(layout, { hook_event_name: "SessionEnd", cwd: layout.root, reason: "other" });
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.nota).toContain("consolidacao falhou");
  });
});

describe("hook: captura de prompt (R5.1)", () => {
  test("o prompt entra na trilha, que e de onde a consolidacao le", () => {
    const layout = projeto();
    hook(layout, { hook_event_name: "UserPromptSubmit", cwd: layout.root, prompt: "arruma o endpoint de login" });

    const entrada = trilha(layout).at(-1)!;
    expect(entrada.type).toBe("prompt.submit");
    expect(entrada.payload.text).toBe("arruma o endpoint de login");
    expect(entrada.payload.redacted).toBe(false);
  });

  test("prompt com marcador de segredo nao vira texto na trilha (R4.4)", () => {
    const layout = projeto();
    hook(layout, {
      hook_event_name: "UserPromptSubmit",
      cwd: layout.root,
      prompt: "usa a chave sk-ant-api03-EXEMPLO para o deploy",
    });

    const entrada = trilha(layout).at(-1)!;
    // A trilha e append-only e encadeada: segredo que entra nao sai mais.
    expect(entrada.payload.text).toBeNull();
    expect(entrada.payload.redacted).toBe(true);
    expect(entrada.payload.redacted_marker).toBe("sk-ant-");
    expect(entrada.payload.chars).toBeGreaterThan(0);
  });

  test("prompt longo entra cortado, e o corte fica declarado", () => {
    const layout = projeto();
    hook(layout, { hook_event_name: "UserPromptSubmit", cwd: layout.root, prompt: "a".repeat(5000) });
    const entrada = trilha(layout).at(-1)!;
    expect(entrada.payload.truncated).toBe(true);
    expect(String(entrada.payload.text)).toHaveLength(2000);
    expect(entrada.payload.chars).toBe(5000);
  });
});

describe("hook: frescor depois da escrita (R2.4)", () => {
  test("escrever em arvore observada avisa que a evidencia caiu", () => {
    const layout = tempProject({ git: false });
    writeFile(layout, "src/a.ts", "x\n");
    harnessWith(layout, {
      profile: "gate-only",
      phases: [],
      verifiers: [
        {
          id: "coverage",
          run: ["sh", "-c", "exit 0"],
          extract: { kind: "lcov", file: "coverage/lcov.info", metric: "lines.pct" },
          watch: ["src/**"],
          timeout_s: 30,
        },
      ],
    } as unknown as Partial<WorkflowContract> & { phases: WorkflowContract["phases"] }).close();

    const r = hook(layout, {
      hook_event_name: "PostToolUse",
      cwd: layout.root,
      tool_name: "Write",
      tool_input: { file_path: "src/a.ts" },
      tool_response: { success: true },
    });
    expect(r.output?.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(r.output?.hookSpecificOutput?.additionalContext).toContain("coverage");
  });

  test("escrita fora da arvore observada nao vira ruido", () => {
    const layout = tempProject({ git: false });
    harnessWith(layout, {
      profile: "gate-only",
      phases: [],
      verifiers: [
        {
          id: "coverage",
          run: ["sh", "-c", "exit 0"],
          extract: { kind: "lcov", file: "coverage/lcov.info", metric: "lines.pct" },
          watch: ["src/**"],
          timeout_s: 30,
        },
      ],
    } as unknown as Partial<WorkflowContract> & { phases: WorkflowContract["phases"] }).close();

    const r = hook(layout, {
      hook_event_name: "PostToolUse",
      cwd: layout.root,
      tool_name: "Write",
      tool_input: { file_path: "README.md" },
    });
    expect(r.output).toBeNull();
  });
});

describe("hook: fora de projeto com harness", () => {
  test("sessao em diretorio qualquer nao vira erro nem saida", () => {
    const r = handleHook({ hook_event_name: "SessionStart", cwd: "/tmp" });
    expect(r.output).toBeNull();
    expect(r.exitCode).toBe(EXIT.OK);
  });

  test("payload sem evento nao faz nada", () => {
    expect(handleHook({}).output).toBeNull();
    expect(handleHook(null).output).toBeNull();
    expect(handleHook("texto").exitCode).toBe(EXIT.OK);
  });

  test("evento que o adapter nao trata sai calado", () => {
    const r = handleHook({ hook_event_name: "PreCompact", cwd: "/tmp" });
    expect(r.output).toBeNull();
  });
});

describe("instalacao dos hooks (R8.6f)", () => {
  const ARGV = ["/usr/bin/bun", "/opt/psh/src/index.ts"];

  test("registra os cinco eventos em forma exec, sem shell no meio", () => {
    const layout = projeto();
    const r = instalar(layout, { selfArgv: ARGV });
    expect(r.eventos).toHaveLength(5);

    const settings = JSON.parse(readFileSync(settingsPath(layout), "utf8")) as SettingsDoClaude;
    const entrada = settings.hooks!.PreToolUse![0]!.hooks![0]!;
    expect(entrada.type).toBe("command");
    expect(entrada.command).toBe("/usr/bin/bun");
    // Caminho com aspas ou cifrao nunca chega a um parser de shell.
    expect(entrada.args).toEqual(["/opt/psh/src/index.ts", "adapter", "claude-code", "hook"]);
  });

  test("instalar duas vezes nao duplica registro", () => {
    const layout = projeto();
    instalar(layout, { selfArgv: ARGV });
    const segunda = instalar(layout, { selfArgv: ARGV });

    expect(segunda.removidos).toBe(5);
    const settings = JSON.parse(readFileSync(settingsPath(layout), "utf8")) as SettingsDoClaude;
    expect(settings.hooks!.PreToolUse).toHaveLength(1);
  });

  test("hook de terceiro no mesmo evento sobrevive", () => {
    const layout = projeto();
    writeFile(
      layout,
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "/opt/outra-ferramenta" }] }],
        },
        permissions: { allow: ["Bash(git *)"] },
      }),
    );

    const r = instalar(layout, { selfArgv: ARGV });
    expect(r.preservados).toBe(1);

    const settings = JSON.parse(readFileSync(settingsPath(layout), "utf8")) as SettingsDoClaude;
    const comandos = settings.hooks!.PreToolUse!.flatMap((g) => g.hooks!.map((h) => h.command));
    expect(comandos).toContain("/opt/outra-ferramenta");
    expect(comandos).toContain("/usr/bin/bun");
    // Chave que nao e nossa continua no arquivo.
    expect(settings.permissions).toEqual({ allow: ["Bash(git *)"] });
  });

  test("registro nosso apontando para artefato ausente e podado e contado", () => {
    const layout = projeto();
    writeFile(
      layout,
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: "/opt/psh-que-foi-desinstalado/psh", args: ["adapter", "claude-code", "hook"] },
              ],
            },
          ],
        },
      }),
    );

    const r = instalar(layout, { selfArgv: ARGV });
    expect(r.orfaos).toBe(1);
    expect(r.removidos).toBe(1);
    const settings = JSON.parse(readFileSync(settingsPath(layout), "utf8")) as SettingsDoClaude;
    const comandos = settings.hooks!.SessionStart!.flatMap((g) => g.hooks!.map((h) => h.command));
    expect(comandos).not.toContain("/opt/psh-que-foi-desinstalado/psh");
  });

  test("grupo que fica sem hook nenhum sai do arquivo", () => {
    const { settings } = podar({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "/x", args: ["adapter", "claude-code", "hook"] }] }] },
    });
    expect(settings.hooks).toBeUndefined();
  });

  test("instalacao antiga em forma de shell tambem e reconhecida", () => {
    expect(ehNosso({ type: "command", command: "psh adapter claude-code hook" })).toBe(true);
    expect(ehNosso({ type: "command", command: "/opt/outra" })).toBe(false);
    expect(ehNosso({ type: "command", command: "x", args: ["adapter", "claude-code", "hook"] })).toBe(true);
  });

  test("desinstalar tira o nosso e devolve a conta", () => {
    const layout = projeto();
    instalar(layout, { selfArgv: ARGV });
    const r = desinstalar(layout);
    expect(r.removidos).toBe(5);
    expect(statusDoAdapter(layout).registrados).toBe(0);
  });

  test("--dry-run nao escreve", () => {
    const layout = projeto();
    const r = instalar(layout, { selfArgv: ARGV, dryRun: true });
    expect(r.aplicado).toBe(false);
    expect(existsSync(settingsPath(layout))).toBe(false);
  });
});

describe("status do adapter (R8.6c)", () => {
  test("adapter carregado pela metade e falha visivel", async () => {
    const layout = projeto();
    instalar(layout, { selfArgv: [process.execPath, "/opt/psh/src/index.ts"] });

    // Alguem tirou um evento a mao: quatro de cinco significa uma
    // responsabilidade do R8.1 que simplesmente nao acontece.
    const settings = JSON.parse(readFileSync(settingsPath(layout), "utf8")) as SettingsDoClaude;
    delete settings.hooks!.PostToolUse;
    writeFileSync(settingsPath(layout), JSON.stringify(settings));

    const s = statusDoAdapter(layout);
    expect(s.registrados).toBe(4);
    expect(s.completo).toBe(false);
    expect(s.pontos.find((p) => p.evento === "PostToolUse")!.registrado).toBe(false);

    const r = await cli(["adapter", "claude-code", "status", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.out).toContain("parcialmente carregado");
  });

  test("registro apontando para artefato ausente aparece como orfao", () => {
    const layout = projeto();
    instalar(layout, { selfArgv: ["/opt/psh-que-sumiu/psh"] });
    const s = statusDoAdapter(layout);
    expect(s.orfaos).toBe(5);
    expect(s.completo).toBe(false);
  });

  test("sem settings, o status diz que nao ha ponto ativo", () => {
    const layout = projeto();
    const s = statusDoAdapter(layout);
    expect(s.existe).toBe(false);
    expect(s.registrados).toBe(0);
  });
});

describe("CLI do adapter", () => {
  test("acao desconhecida nao vira status em silencio", async () => {
    const layout = projeto();
    const r = await cli(["adapter", "claude-code", "ativar", "--root", layout.root]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("acao desconhecida");
  });

  test("adapter desconhecido lista os que existem", async () => {
    const r = await cli(["adapter", "opencode"]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("ci, claude-code");
  });

  test("install e status conversam pelo disco", async () => {
    const layout = projeto();
    const i = await cli(["adapter", "claude-code", "install", "--json", "--root", layout.root]);
    expect(i.code).toBe(EXIT.OK);
    const s = await cli(["adapter", "claude-code", "status", "--json", "--root", layout.root]);
    const status = JSON.parse(s.out) as { registrados: number; completo: boolean };
    expect(status.registrados).toBe(5);
    expect(status.completo).toBe(true);
  });
});
