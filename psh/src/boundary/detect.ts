/**
 * Deteccao de comando destrutivo (R3.3).
 *
 * Isto **nao e protecao** e nao bloqueia nada. Quem impede escrita e o mount do
 * ai-jail, e na falta dele a reversao do modo degradado. O papel deste modulo e
 * dar nome ao que passou, para aparecer na trilha e no relatorio.
 *
 * A razao de nao bloquear: casamento por texto de comando erra nos dois
 * sentidos. `rm -rf "$DIR"` nao casa quando a variavel esconde o alvo, e
 * `echo "rm -rf /"` casa sem apagar nada. Tratar isso como controle cria
 * confianca que o mecanismo nao sustenta, que e exatamente o problema que este
 * harness existe para resolver.
 *
 * As expressoes abaixo casam **texto de comando**, nunca caminho de arquivo, e
 * por isso nao violam o R2.14.
 */

export type AlertSeverity = "alta" | "media";

export interface CommandAlert {
  id: string;
  severity: AlertSeverity;
  summary: string;
  /** Trecho do comando que disparou o alerta, para a trilha. */
  match: string;
}

interface Padrao {
  id: string;
  severity: AlertSeverity;
  summary: string;
  regex: RegExp;
}

const PADROES: Padrao[] = [
  {
    id: "rm-recursivo-forcado",
    severity: "alta",
    summary: "remocao recursiva e forcada",
    regex: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*[rR]/,
  },
  {
    id: "git-reset-hard",
    severity: "alta",
    summary: "git reset --hard descarta trabalho nao commitado",
    regex: /\bgit\s+reset\s+--hard\b/,
  },
  {
    id: "git-clean-forcado",
    severity: "alta",
    summary: "git clean remove arquivo nao rastreado",
    regex: /\bgit\s+clean\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[dfx]/,
  },
  {
    id: "git-checkout-descarta",
    severity: "media",
    summary: "git checkout sobre caminho descarta modificacao local",
    regex: /\bgit\s+(checkout|restore)\s+(--\s+|\.|[^\s-])/,
  },
  {
    id: "git-push-forcado",
    severity: "alta",
    summary: "push forcado reescreve historico remoto",
    regex: /\bgit\s+push\s+.*(--force\b|(?<!-)-f\b)/,
  },
  {
    id: "curl-para-shell",
    severity: "alta",
    summary: "download executado direto no shell",
    regex: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|)sh\b/,
  },
  {
    id: "sobrescrita-de-dispositivo",
    severity: "alta",
    summary: "escrita direta em dispositivo de bloco",
    regex: /\b(dd|tee)\b[^\n]*\bof?=?\s*\/dev\/(sd|nvme|hd)/,
  },
  {
    id: "permissao-total",
    severity: "media",
    summary: "permissao 777 concedida",
    regex: /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/,
  },
  {
    id: "escalonamento",
    severity: "media",
    summary: "elevacao de privilegio",
    regex: /(^|[\s;&|(])(sudo|doas)\s/,
  },
  {
    id: "truncamento-de-historico",
    severity: "media",
    summary: "reescrita de historico do Git",
    regex: /\bgit\s+(filter-branch|filter-repo)\b|\bgit\s+rebase\s+.*(-i|--interactive)\b/,
  },
];

/**
 * Varre o comando e devolve os alertas encontrados.
 *
 * R2.13: `examined` diz quantos padroes foram avaliados. Zero alertas com zero
 * padroes avaliados seria erro de configuracao, nao comando limpo.
 */
export function detectDestructive(argv: readonly string[]): {
  alerts: CommandAlert[];
  patterns_examined: number;
} {
  const texto = argv.join(" ");
  const alerts: CommandAlert[] = [];
  for (const padrao of PADROES) {
    const m = padrao.regex.exec(texto);
    if (m === null) continue;
    alerts.push({
      id: padrao.id,
      severity: padrao.severity,
      summary: padrao.summary,
      match: m[0].trim(),
    });
  }
  return { alerts, patterns_examined: PADROES.length };
}

export function renderAlerts(alerts: readonly CommandAlert[]): string {
  if (alerts.length === 0) return "";
  const linhas = alerts.map((a) => `  [${a.severity}] ${a.id}: ${a.summary} (${a.match})`);
  return [
    `deteccao de comando destrutivo: ${alerts.length} alerta(s).`,
    "Isto e alerta, nao bloqueio. O controle de escrita e a fronteira.",
    ...linhas,
  ].join("\n");
}
