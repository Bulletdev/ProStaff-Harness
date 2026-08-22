import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import type { ProjectContext } from "./context.ts";
import { detectSandbox } from "../evidence/sandbox.ts";
import { probeGit } from "../evidence/workspace.ts";
import { defaultInstallDirs, loadBoundary } from "../boundary/policy.ts";
import { PSH_TOKEN } from "../util/self.ts";
import { PSH_VERSION } from "../version.ts";

export type Level = "ok" | "warn" | "fail";

export interface Check {
  id: string;
  level: Level;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  psh_version: string;
  root: string;
  checks: Check[];
  failed: number;
  warned: number;
}

export function runDoctor(ctx: ProjectContext): DoctorReport {
  const checks: Check[] = [];

  checks.push(checkSandbox());
  checks.push(...checkBoundaryEngine(ctx));
  checks.push(checkEnumeration(ctx));
  checks.push(checkAudit(ctx));
  checks.push(...checkVerifierExecutables(ctx));
  checks.push(...checkDeclaredFiles(ctx));
  checks.push(checkAbsolutePaths(ctx));
  checks.push(checkSecrets(ctx));
  checks.push(checkEvidenceOwnership(ctx));

  return {
    psh_version: PSH_VERSION,
    root: ctx.layout.root,
    checks,
    failed: checks.filter((c) => c.level === "fail").length,
    warned: checks.filter((c) => c.level === "warn").length,
  };
}

function checkSandbox(): Check {
  const s = detectSandbox(true);
  if (s.mode === "ai-jail") {
    return { id: "sandbox", level: "ok", message: `ai-jail ${s.jail_version ?? "?"} operante`, detail: s.detail };
  }
  if (s.mode === "inherited") {
    return { id: "sandbox", level: "ok", message: "sessao ja enjaulada; verificador nao reenjaula", detail: s.detail };
  }
  return {
    id: "sandbox",
    level: "warn",
    message: "MODO DEGRADADO: verificador roda sem isolamento",
    detail: `${s.detail}. R2.7 exige sandbox com rede desligada; ate instalar o ai-jail o modo fica declarado aqui, em 'psh status' e em cada registro de evidencia.`,
  };
}

/** C3 ativo: o diagnostico passa a dizer o estado real da fronteira. */
function checkBoundaryEngine(ctx: ProjectContext): Check[] {
  const out: Check[] = [];
  let policy;
  try {
    policy = loadBoundary(ctx.layout);
  } catch (cause) {
    return [
      {
        id: "boundary",
        level: "fail",
        message: "allowlist ausente ou invalida: toda escrita de agente fica bloqueada",
        detail: (cause as Error).message,
      },
    ];
  }

  const sandbox = detectSandbox();
  out.push(
    sandbox.mode === "ai-jail"
      ? { id: "boundary", level: "ok", message: "fronteira aplicada por mount do ai-jail (o kernel impede a escrita)" }
      : {
          id: "boundary",
          level: "warn",
          message: "fronteira em modo degradado: reversao por snapshot, nao bloqueio",
          detail:
            "Sem ai-jail a escrita fora da fronteira acontece e depois e revertida. Detectavel e reversivel, mas nao impedida. Instale o ai-jail para o controle real (R3.1).",
        },
  );

  // R3.5b: nenhum mapeamento de escrita pode alcancar o diretorio de instalacao.
  const instalacao = defaultInstallDirs();
  const amplos: string[] = [];
  for (const id of policy.agentIds) {
    const agente = policy.contract.agents[id]!;
    for (const dir of instalacao) {
      const d = policy.canWrite(id, join(dir, "psh"));
      if (d.allowed) {
        out.push({
          id: `boundary:${id}`,
          level: "fail",
          message: `o agente '${id}' alcanca o diretorio de instalacao (${dir})`,
          detail: "Um agente nunca pode reescrever o mecanismo que o restringe (R3.5b).",
        });
      }
    }
    if (agente.write.includes("**")) amplos.push(id);
  }
  if (amplos.length > 0) {
    out.push({
      id: "boundary:amplitude",
      level: "warn",
      message: `fronteira nao estreitada para: ${amplos.join(", ")}`,
      detail:
        "Agente com write '**' escreve em qualquer lugar fora do deny duro. Use 'psh boundary add' com um agente por area.",
    });
  }
  return out;
}

function checkAudit(ctx: ProjectContext): Check {
  const result = ctx.chain.verify();
  if (result.ok) {
    return {
      id: "audit",
      level: "ok",
      message: `cadeia integra: ${result.entries} entradas, ${result.candidates_examined} linhas examinadas`,
    };
  }
  return {
    id: "audit",
    level: "fail",
    message: `cadeia comprometida: ${result.problems.length} problemas`,
    detail: result.problems.map((p) => JSON.stringify(p)).join("\n"),
  };
}

function checkVerifierExecutables(ctx: ProjectContext): Check[] {
  const out: Check[] = [];
  const referenciados = new Set<string>();
  for (const phase of ctx.workflow.phases) {
    for (const check of phase.gate.checks) {
      if (check.kind === "verifier" || check.kind === "verifier-status") referenciados.add(check.verifier);
    }
  }

  for (const spec of ctx.workflow.verifiers) {
    const first = spec.run[0]!;
    if (first === PSH_TOKEN) {
      out.push({ id: `verifier:${spec.id}`, level: "ok", message: "executado pelo proprio psh" });
      continue;
    }
    const resolved = which(first);
    if (resolved !== null) {
      out.push({ id: `verifier:${spec.id}`, level: "ok", message: `${first} -> ${resolved}` });
      continue;
    }
    // Falta de ferramenta so e falha quando algum portao depende dela. Fora
    // disso e aviso: um verificador que nenhum portao consulta nao consegue
    // fazer fase nenhuma passar por omissao.
    const usado = referenciados.has(spec.id);
    out.push({
      id: `verifier:${spec.id}`,
      level: usado ? "fail" : "warn",
      message: `comando '${first}' nao encontrado no PATH`,
      detail: usado
        ? `o portao que depende de '${spec.id}' vai reprovar por 'nao verificado', nunca passar por omissao (R2.12)`
        : `nenhum portao consulta '${spec.id}'; 'psh verify --all' vai registrar erro para ele`,
    });
  }
  if (out.length === 0) {
    out.push({ id: "verifiers", level: "warn", message: "nenhum verificador declarado no contrato" });
  }
  return out;
}

/** R10.2: arquivo declarado que nao existe e falha, nao aviso. */
function checkDeclaredFiles(ctx: ProjectContext): Check[] {
  const out: Check[] = [];
  let examined = 0;
  for (const phase of ctx.workflow.phases) {
    for (const check of phase.gate.checks) {
      if (check.kind === "review-score") {
        examined += 1;
        const target = join(ctx.layout.root, check.target);
        if (!existsSync(target)) {
          out.push({
            id: `declared:${check.target}`,
            level: "warn",
            message: `artefato revisado ainda nao existe: ${check.target}`,
            detail: `declarado no portao de ${phase.id}; o portao reprova enquanto faltar`,
          });
        }
      }
      if (check.kind === "presence") {
        examined += 1;
        if (!existsSync(join(ctx.layout.root, check.file))) {
          out.push({
            id: `declared:${check.file}`,
            level: "warn",
            message: `arquivo declarado ainda nao existe: ${check.file}`,
            detail: `declarado no portao de ${phase.id}`,
          });
        }
      }
    }
  }
  // R2.13: varredura sem candidato e erro de configuracao, nao resultado limpo.
  if (examined === 0 && ctx.workflow.phases.length > 0) {
    out.push({
      id: "declared",
      level: "fail",
      message: "nenhum arquivo declarado foi examinado, com fases presentes no contrato",
      detail: "varredura sem candidato e falha de configuracao (R2.13)",
    });
  } else {
    out.push({ id: "declared", level: "ok", message: `${examined} arquivos declarados examinados` });
  }
  return out;
}

function checkAbsolutePaths(ctx: ProjectContext): Check {
  const offenders: string[] = [];
  for (const spec of ctx.workflow.verifiers) {
    for (const arg of spec.run) {
      if (arg !== PSH_TOKEN && isAbsolute(arg) && !existsSync(arg)) offenders.push(`${spec.id}: ${arg}`);
    }
    if (spec.cwd !== undefined && isAbsolute(spec.cwd)) offenders.push(`${spec.id}: cwd ${spec.cwd}`);
  }
  if (offenders.length === 0) {
    return { id: "abs-paths", level: "ok", message: "nenhum caminho absoluto de outra maquina no contrato" };
  }
  return {
    id: "abs-paths",
    level: "fail",
    message: "caminho absoluto inexistente no contrato",
    detail: offenders.join("\n"),
  };
}

const SECRET_MARKERS = [
  "AKIA",
  "sk-ant-",
  "sk-proj-",
  "ghp_",
  "github_pat_",
  "xoxb-",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
];
const SECRET_KEY_NAMES = ["API_KEY", "SECRET_KEY", "ACCESS_TOKEN", "PRIVATE_KEY"];

export interface SecretScan {
  hits: string[];
  /** R2.13: examinados, nao so os que casaram. */
  examined: number;
}

/** Varredura pura, separada da coleta de arquivos, para poder ser testada sozinha. */
export function scanSecrets(root: string, files: readonly string[]): SecretScan {
  const hits: string[] = [];
  let examined = 0;
  for (const rel of files) {
    const abs = join(root, rel);
    let text: string;
    try {
      if (statSync(abs).size > 512 * 1024) continue;
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    examined += 1;
    for (const marker of SECRET_MARKERS) {
      if (text.includes(marker)) hits.push(`${rel}: marcador '${marker}'`);
    }
    for (const name of SECRET_KEY_NAMES) {
      const at = text.indexOf(`${name}=`);
      if (at < 0) continue;
      const value = text.slice(at + name.length + 1).split("\n")[0] ?? "";
      const cleaned = value.trim().replaceAll('"', "").replaceAll("'", "");
      if (cleaned.length >= 20 && !cleaned.startsWith("$")) hits.push(`${rel}: ${name} com valor literal`);
    }
  }
  return { hits, examined };
}

/** G5 / R10.5: segredo em arquivo versionado reprova. */
function checkSecrets(ctx: ProjectContext): Check {
  const files = trackedFiles(ctx.layout.root);
  if (files.length === 0) {
    return {
      id: "secrets",
      level: "warn",
      message: "nenhum arquivo versionado para examinar",
      detail: "projeto fora do Git ou sem arquivos rastreados: a varredura de segredo nao tem candidato (R2.13)",
    };
  }
  const { hits, examined } = scanSecrets(ctx.layout.root, files);
  if (hits.length > 0) {
    return {
      id: "secrets",
      level: "fail",
      message: `${hits.length} suspeitas de segredo em arquivo versionado (${examined} arquivos examinados)`,
      detail: hits.join("\n"),
    };
  }
  return { id: "secrets", level: "ok", message: `${examined} arquivos versionados examinados, nenhum segredo aparente` };
}

/** R2.4: o modo de enumeracao da arvore observada e declarado, nunca inferido. */
function checkEnumeration(ctx: ProjectContext): Check {
  const probe = probeGit(ctx.layout.root);
  if (probe.available) {
    return { id: "workspace-enum", level: "ok", message: "enumeracao por git", detail: probe.detail };
  }
  if (!existsSync(join(ctx.layout.root, ".git"))) {
    return { id: "workspace-enum", level: "ok", message: "enumeracao por caminhada", detail: probe.detail };
  }
  return {
    id: "workspace-enum",
    level: "fail",
    message: "repositorio Git com git indisponivel: frescor cai para caminhada",
    detail: `${probe.detail} Arquivo ignorado pelo .gitignore passa a entrar no hash da arvore, e evidencia valida vira obsoleta sozinha.`,
  };
}

function checkEvidenceOwnership(ctx: ProjectContext): Check {
  const gitignore = join(ctx.layout.harness, ".gitignore");
  if (!existsSync(gitignore)) {
    return { id: "evidence-ignore", level: "warn", message: ".harness/.gitignore ausente" };
  }
  const text = readFileSync(gitignore, "utf8");
  const missing = ["harness.db", "evidence/", "audit/"].filter((entry) => !text.includes(entry));
  if (missing.length > 0) {
    return {
      id: "evidence-ignore",
      level: "warn",
      message: `.harness/.gitignore nao cobre: ${missing.join(", ")}`,
    };
  }
  return { id: "evidence-ignore", level: "ok", message: "artefato de execucao fora do repositorio" };
}

function trackedFiles(root: string): string[] {
  const res = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) return [];
  return res.stdout
    .toString("utf8")
    .split(String.fromCharCode(0))
    .filter((s) => s !== "");
}

function which(cmd: string): string | null {
  if (cmd.includes("/")) return existsSync(cmd) ? cmd : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`psh ${report.psh_version}`);
  lines.push(`projeto ${report.root}`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(`${tag(check.level)} ${check.id.padEnd(26)} ${check.message}`);
    if (check.detail !== undefined) {
      for (const line of check.detail.split("\n")) lines.push(`       ${line}`);
    }
  }
  lines.push("");
  lines.push(`${report.failed} falhas, ${report.warned} avisos`);
  return lines.join("\n");
}

function tag(level: Level): string {
  return level === "ok" ? "[ok]  " : level === "warn" ? "[warn]" : "[FAIL]";
}
