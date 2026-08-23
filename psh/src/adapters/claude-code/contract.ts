import { existsSync, openSync, readSync, closeSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import contratoJson from "./contract.json" with { type: "json" };

export interface EventoDoContrato {
  usa: string;
  payload: string[];
  output: string[];
}

export interface ContratoDoAdapter {
  _type: "psh-adapter-contract";
  version: 1;
  runtime: string;
  description: string;
  verified_against: { version: string; artifact: string; method: string; verified_at: string };
  events: Record<string, EventoDoContrato>;
  permission_decisions: string[];
  settings: {
    arquivo: string;
    chaves: string[];
    forma: string;
    entrada_de_hook: string[];
    tipo_de_hook: string;
    forma_exec: string;
  };
  simbolos_conferidos: string[];
}

export const CONTRATO = contratoJson as unknown as ContratoDoAdapter;

export interface RuntimeInstalado {
  encontrado: boolean;
  bin: string | null;
  /** Artefato real, com symlink resolvido: e nele que a varredura roda. */
  artefato: string | null;
  versao: string | null;
  detalhe: string;
}

/**
 * Onde o runtime instalado esta.
 *
 * `PSH_CLAUDE_BIN` existe para o teste e para instalacao fora do PATH. Sem ela,
 * a busca e por PATH, e o symlink e resolvido: o artefato que interessa e o
 * arquivo de verdade, nao o atalho.
 */
export function acharRuntime(): RuntimeInstalado {
  const declarado = process.env.PSH_CLAUDE_BIN;
  const candidato =
    declarado !== undefined && declarado !== "" ? declarado : procurarNoPath("claude") ?? localDeInstalacao();

  if (candidato === null || !existsSync(candidato)) {
    return {
      encontrado: false,
      bin: candidato,
      artefato: null,
      versao: null,
      detalhe:
        candidato === null
          ? "nenhum 'claude' no PATH; declare PSH_CLAUDE_BIN se ele estiver instalado fora dele"
          : `${candidato} nao existe`,
    };
  }

  const artefato = realpathSync(candidato);
  const versao = spawnSync(candidato, ["--version"], { encoding: "utf8" });
  const linha = (versao.stdout ?? "").trim().split("\n")[0] ?? "";
  return {
    encontrado: true,
    bin: candidato,
    artefato,
    versao: linha === "" ? null : linha,
    detalhe: `${candidato} -> ${artefato}`,
  };
}

/**
 * Local de instalacao conhecido, quando o PATH nao ajuda.
 *
 * Um `bun` confinado por snap recebe PATH higienizado e nao enxerga
 * `~/.local/bin`, onde o instalador nativo do Claude Code poe o atalho. Sem
 * este segundo olhar, o diagnostico diria "runtime ausente" numa maquina que
 * tem o runtime instalado, e diagnostico que mente e pior do que diagnostico
 * que falta.
 */
function localDeInstalacao(): string | null {
  const home = process.env.HOME;
  if (home === undefined || home === "") return null;
  const alvo = join(home, ".local", "bin", "claude");
  return existsSync(alvo) ? alvo : null;
}

function procurarNoPath(nome: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const alvo = isAbsolute(dir) ? join(dir, nome) : null;
    if (alvo !== null && existsSync(alvo)) return alvo;
  }
  return null;
}

export interface ResultadoDaVarredura {
  encontrados: string[];
  ausentes: string[];
  /** R2.13: bytes lidos do artefato, para varredura vazia nao virar sucesso. */
  bytes_examinados: number;
}

/**
 * Procura cada simbolo dentro do artefato instalado.
 *
 * A leitura e por bloco com sobreposicao: um simbolo pode cair exatamente na
 * emenda de dois blocos, e sem a sobreposicao ele sumiria - varredura que perde
 * o que existe reprova adapter que esta certo, e ensina a ignorar o resultado.
 *
 * A comparacao e por `Buffer.indexOf`, nunca por expressao regular montada com
 * o simbolo: e a mesma regra do R2.14, um simbolo com `+` ou `[` viraria
 * quantificador.
 *
 * Limite declarado: a busca e por bytes, entao um simbolo que e prefixo de
 * outro (`permissionDecision` dentro de `permissionDecisionReason`) e dado como
 * presente quando so o mais longo existe. O que esta validacao pega e ponto de
 * extensao que sumiu ou campo que mudou de nome, que sao os dois modos de falha
 * que a secao 3.2 do PRD descreve; renomeacao parcial de campo irmao passa.
 */
export function varrerSimbolos(
  artefato: string,
  simbolos: readonly string[],
  opts: { blocoBytes?: number } = {},
): ResultadoDaVarredura {
  const bloco = opts.blocoBytes ?? 8 * 1024 * 1024;
  const faltando = new Set(simbolos);
  const encontrados: string[] = [];
  const maiorSimbolo = simbolos.reduce((max, s) => Math.max(max, Buffer.byteLength(s)), 0);
  const sobreposicao = Math.max(0, maiorSimbolo - 1);

  const tamanho = statSync(artefato).size;
  const fd = openSync(artefato, "r");
  let lidos = 0;
  try {
    const buffer = Buffer.allocUnsafe(bloco + sobreposicao);
    let posicao = 0;
    while (posicao < tamanho && faltando.size > 0) {
      const cauda = posicao === 0 ? 0 : Math.min(sobreposicao, posicao);
      const inicio = posicao - cauda;
      const n = readSync(fd, buffer, 0, bloco + cauda, inicio);
      if (n <= 0) break;
      lidos += n - cauda;
      const janela = buffer.subarray(0, n);
      for (const simbolo of [...faltando]) {
        if (janela.indexOf(simbolo, 0, "utf8") >= 0) {
          faltando.delete(simbolo);
          encontrados.push(simbolo);
        }
      }
      posicao = inicio + n;
    }
  } finally {
    closeSync(fd);
  }

  return { encontrados: encontrados.sort(), ausentes: [...faltando].sort(), bytes_examinados: lidos };
}

export interface RelatorioDoContrato {
  runtime: RuntimeInstalado;
  contrato_versao_conferida: string;
  simbolos_declarados: number;
  encontrados: string[];
  ausentes: string[];
  bytes_examinados: number;
  ok: boolean;
  motivo: string;
}

/**
 * R8.6b: valida o contrato contra o runtime **instalado**, nao contra a
 * documentacao.
 *
 * Este e o modo de falha mais provavel e o mais silencioso do projeto, e ja
 * aconteceu duas vezes na casa: 881 linhas de plugin morto no harness de
 * referencia, e os tres mecanismos do `prostaff-hooks` que nunca responderam
 * porque o campo se chamava `prompt` e o codigo dizia `message`.
 */
export function conferirContrato(): RelatorioDoContrato {
  const runtime = acharRuntime();
  const base = {
    runtime,
    contrato_versao_conferida: CONTRATO.verified_against.version,
    simbolos_declarados: CONTRATO.simbolos_conferidos.length,
  };

  if (!runtime.encontrado || runtime.artefato === null) {
    return {
      ...base,
      encontrados: [],
      ausentes: [...CONTRATO.simbolos_conferidos],
      bytes_examinados: 0,
      ok: false,
      motivo: `runtime nao encontrado: ${runtime.detalhe}`,
    };
  }

  const varredura = varrerSimbolos(runtime.artefato, CONTRATO.simbolos_conferidos);

  // Varredura que nao leu nada nao e varredura limpa (R2.13).
  if (varredura.bytes_examinados === 0) {
    return {
      ...base,
      ...varredura,
      ok: false,
      motivo: `nenhum byte lido de ${runtime.artefato}: varredura sem candidato e falha de configuracao, nao resultado limpo`,
    };
  }

  const ok = varredura.ausentes.length === 0;
  return {
    ...base,
    ...varredura,
    ok,
    motivo: ok
      ? `${varredura.encontrados.length} simbolo(s) conferido(s) em ${runtime.versao ?? "versao desconhecida"}`
      : `${varredura.ausentes.length} simbolo(s) que o adapter usa nao existem em ${runtime.versao ?? "?"}: ${varredura.ausentes.join(", ")}`,
  };
}

export function renderContrato(r: RelatorioDoContrato): string {
  const linhas = [
    `runtime        ${r.runtime.versao ?? "(ausente)"}`,
    `artefato       ${r.runtime.artefato ?? "-"}`,
    `contrato       conferido contra ${r.contrato_versao_conferida}`,
    `simbolos       ${r.encontrados.length}/${r.simbolos_declarados} encontrados, ${Math.round(r.bytes_examinados / 1024 / 1024)} MiB examinados`,
    `resultado      ${r.ok ? "OK" : "REPROVADO"}`,
    `               ${r.motivo}`,
  ];
  if (r.ausentes.length > 0 && r.runtime.encontrado) {
    linhas.push("", "ausentes:");
    for (const s of r.ausentes) linhas.push(`  - ${s}`);
  }
  return linhas.join("\n");
}
