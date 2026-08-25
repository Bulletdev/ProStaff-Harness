import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../../util/json.ts";
import type { Layout } from "../../util/paths.ts";
import { CONTRATO } from "./contract.ts";

/** Argumentos que marcam um hook como nosso. Ver `ehNosso`. */
export const ARGV_DO_HOOK = ["adapter", "claude-code", "hook"] as const;

export interface EntradaDeHook {
  type?: string;
  command?: string;
  args?: string[];
  timeout?: number;
  [k: string]: unknown;
}

export interface GrupoDeHook {
  matcher?: string;
  hooks?: EntradaDeHook[];
  [k: string]: unknown;
}

export interface SettingsDoClaude {
  hooks?: Record<string, GrupoDeHook[]>;
  [k: string]: unknown;
}

export function settingsPath(layout: Layout): string {
  return join(layout.root, ".claude", "settings.json");
}

/**
 * Um hook e nosso quando o argv dele e o do adapter.
 *
 * A marca e o proprio argv, e nao um campo inventado: quem executa o hook e o
 * runtime, e o que ele executa e exatamente isto. Marca em campo extra some
 * quando alguem edita o arquivo a mao; o argv nao, porque sem ele o hook deixa
 * de funcionar.
 */
export function ehNosso(entrada: EntradaDeHook): boolean {
  const args = entrada.args;
  if (Array.isArray(args)) {
    for (let i = 0; i + ARGV_DO_HOOK.length <= args.length; i += 1) {
      if (ARGV_DO_HOOK.every((parte, j) => args[i + j] === parte)) return true;
    }
  }
  // Instalacao antiga, em forma de shell.
  return typeof entrada.command === "string" && entrada.command.includes(ARGV_DO_HOOK.join(" "));
}

export interface PlanoDeInstalacao {
  settings: string;
  existia: boolean;
  eventos: string[];
  /** R8.6f: registros nossos removidos antes de reescrever, contados. */
  removidos: number;
  /** Registros nossos que apontavam para artefato ausente. */
  orfaos: number;
  /** Hooks de terceiros preservados, contados: instalar nao pisa em vizinho. */
  preservados: number;
  timeout_s: number;
}

export interface ResultadoDaInstalacao extends PlanoDeInstalacao {
  aplicado: boolean;
}

function lerSettings(path: string): SettingsDoClaude {
  if (!existsSync(path)) return {};
  return readJsonFile<SettingsDoClaude>(path);
}

/**
 * R8.6f: remover ponto de extensao e operacao de duas pontas.
 *
 * A poda opera por handler, nunca por bloco: um grupo que tem o nosso hook e o
 * de outra ferramenta perde so o nosso. Ela tambem so toca o que e nosso, e
 * reporta quantos removeu - apagar o produtor sem limpar o consumidor deixa o
 * erro na maquina de quem instalou.
 */
export function podar(
  settings: SettingsDoClaude,
  opts: { somenteOrfaos?: boolean } = {},
): { settings: SettingsDoClaude; removidos: number; orfaos: number; preservados: number } {
  const hooks = settings.hooks ?? {};
  const novo: Record<string, GrupoDeHook[]> = {};
  let removidos = 0;
  let orfaos = 0;
  let preservados = 0;

  for (const [evento, grupos] of Object.entries(hooks)) {
    const gruposNovos: GrupoDeHook[] = [];
    for (const grupo of Array.isArray(grupos) ? grupos : []) {
      const entradas = Array.isArray(grupo.hooks) ? grupo.hooks : [];
      const mantidas: EntradaDeHook[] = [];
      for (const entrada of entradas) {
        if (!ehNosso(entrada)) {
          preservados += 1;
          mantidas.push(entrada);
          continue;
        }
        const orfao = typeof entrada.command === "string" && !existsSync(entrada.command);
        if (orfao) orfaos += 1;
        if (opts.somenteOrfaos === true && !orfao) {
          mantidas.push(entrada);
          continue;
        }
        removidos += 1;
      }
      // Grupo que ficou sem hook nenhum nao fica no arquivo: registro vazio
      // apontando para lugar nenhum e exatamente o que a poda existe para tirar.
      if (mantidas.length > 0) gruposNovos.push({ ...grupo, hooks: mantidas });
    }
    if (gruposNovos.length > 0) novo[evento] = gruposNovos;
  }

  const resultado: SettingsDoClaude = { ...settings };
  if (Object.keys(novo).length > 0) resultado.hooks = novo;
  else delete resultado.hooks;
  return { settings: resultado, removidos, orfaos, preservados };
}

export interface InstallOptions {
  /** argv do proprio psh, como o runtime vai executar. */
  selfArgv: string[];
  timeout_s?: number;
  dryRun?: boolean;
}

/**
 * Registra os hooks do adapter em `.claude/settings.json`.
 *
 * A forma e a **exec**: `command` e o executavel e `args` sao os argumentos,
 * sem shell no meio. Caminho de instalacao com espaco, aspas ou cifrao nunca
 * chega a um parser de shell - mesma postura do R2.14 para expressao regular.
 */
export function instalar(layout: Layout, opts: InstallOptions): ResultadoDaInstalacao {
  const path = settingsPath(layout);
  const existia = existsSync(path);
  const timeout = opts.timeout_s ?? 30;

  const podado = podar(lerSettings(path));
  const hooks: Record<string, GrupoDeHook[]> = { ...(podado.settings.hooks ?? {}) };

  const [executavel, ...prefixo] = opts.selfArgv;
  if (executavel === undefined) {
    throw new Error("selfArgv vazio: sem executavel nao ha o que registrar");
  }

  const eventos = Object.keys(CONTRATO.events);
  for (const evento of eventos) {
    const entrada: EntradaDeHook = {
      type: CONTRATO.settings.tipo_de_hook,
      command: executavel,
      args: [...prefixo, ...ARGV_DO_HOOK],
      timeout,
    };
    const grupos = hooks[evento] ?? [];
    hooks[evento] = [...grupos, { matcher: "", hooks: [entrada] }];
  }

  const resultado: ResultadoDaInstalacao = {
    settings: path,
    existia,
    eventos,
    removidos: podado.removidos,
    orfaos: podado.orfaos,
    preservados: podado.preservados,
    timeout_s: timeout,
    aplicado: opts.dryRun !== true,
  };

  if (opts.dryRun === true) return resultado;

  mkdirSync(join(layout.root, ".claude"), { recursive: true });
  writeJsonAtomic(path, { ...podado.settings, hooks });
  return resultado;
}

export interface ResultadoDaRemocao {
  settings: string;
  removidos: number;
  orfaos: number;
  preservados: number;
  existia: boolean;
}

export function desinstalar(layout: Layout): ResultadoDaRemocao {
  const path = settingsPath(layout);
  if (!existsSync(path)) {
    return { settings: path, removidos: 0, orfaos: 0, preservados: 0, existia: false };
  }
  const podado = podar(lerSettings(path));
  writeJsonAtomic(path, podado.settings);
  return {
    settings: path,
    removidos: podado.removidos,
    orfaos: podado.orfaos,
    preservados: podado.preservados,
    existia: true,
  };
}

export interface PontoAtivo {
  evento: string;
  registrado: boolean;
  orfao: boolean;
  comando: string | null;
}

export interface StatusDoAdapter {
  settings: string;
  existe: boolean;
  pontos: PontoAtivo[];
  registrados: number;
  esperados: number;
  orfaos: number;
  completo: boolean;
}

/**
 * R8.6c: quais pontos de extensao estao efetivamente registrados.
 *
 * Adapter carregado pela metade e falha visivel, nunca degradacao silenciosa:
 * quatro de cinco eventos registrados significa uma responsabilidade do R8.1
 * que simplesmente nao acontece, e ninguem descobriria sozinho.
 */
export function statusDoAdapter(layout: Layout): StatusDoAdapter {
  const path = settingsPath(layout);
  const existe = existsSync(path);
  const settings = existe ? lerSettings(path) : {};
  const hooks = settings.hooks ?? {};
  const pontos: PontoAtivo[] = [];

  for (const evento of Object.keys(CONTRATO.events)) {
    let registrado = false;
    let orfao = false;
    let comando: string | null = null;
    for (const grupo of hooks[evento] ?? []) {
      for (const entrada of grupo.hooks ?? []) {
        if (!ehNosso(entrada)) continue;
        registrado = true;
        comando = typeof entrada.command === "string" ? entrada.command : null;
        if (comando !== null && !existsSync(comando)) orfao = true;
      }
    }
    pontos.push({ evento, registrado, orfao, comando });
  }

  const registrados = pontos.filter((p) => p.registrado).length;
  const orfaos = pontos.filter((p) => p.orfao).length;
  return {
    settings: path,
    existe,
    pontos,
    registrados,
    esperados: pontos.length,
    orfaos,
    completo: registrados === pontos.length && orfaos === 0,
  };
}

export function renderStatusDoAdapter(s: StatusDoAdapter): string {
  const linhas = [
    `settings       ${s.settings}${s.existe ? "" : " (ausente)"}`,
    `pontos ativos  ${s.registrados}/${s.esperados}${s.orfaos > 0 ? `, ${s.orfaos} apontando para artefato ausente` : ""}`,
    "",
  ];
  for (const p of s.pontos) {
    const marca = p.orfao ? "ORFAO" : p.registrado ? "ok   " : "NAO  ";
    linhas.push(`  ${marca} ${p.evento.padEnd(18)} ${CONTRATO.events[p.evento]?.usa ?? ""}`);
  }
  if (!s.completo) {
    linhas.push("", "Adapter parcialmente carregado. Rode 'psh adapter claude-code install'.");
  }
  return linhas.join("\n");
}

export function renderInstalacao(r: ResultadoDaInstalacao): string {
  return [
    `${r.aplicado ? "registrado" : "registraria"} em ${r.settings}${r.existia ? "" : " (arquivo novo)"}`,
    `  eventos: ${r.eventos.join(", ")}`,
    `  hooks nossos substituidos: ${r.removidos} (${r.orfaos} apontavam para artefato ausente)`,
    `  hooks de terceiros preservados: ${r.preservados}`,
    `  forma exec: o runtime executa o binario direto, sem shell no meio`,
  ].join("\n");
}
