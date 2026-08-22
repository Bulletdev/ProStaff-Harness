export type FailureClass = "transient" | "quality" | "user-action" | "fatal";

/** Codigos de saida estaveis: o adapter `ci` e os hooks dependem deles. */
export const EXIT = {
  OK: 0,
  FAILURE: 1,
  GATE_FAILED: 2,
  CONTRACT_INVALID: 3,
  AUDIT_BROKEN: 4,
  FORGED_INPUT: 5,
  NOT_INITIALIZED: 6,
  /** Fronteira violada. Ganha do codigo do comando: a corrida esta contaminada. */
  BOUNDARY_VIOLATION: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class PshError extends Error {
  readonly failureClass: FailureClass;
  readonly exitCode: ExitCode;
  readonly detail: Record<string, unknown>;

  constructor(
    message: string,
    opts: {
      failureClass?: FailureClass;
      exitCode?: ExitCode;
      detail?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "PshError";
    this.failureClass = opts.failureClass ?? "fatal";
    this.exitCode = opts.exitCode ?? EXIT.FAILURE;
    this.detail = opts.detail ?? {};
  }
}

/** R1.1 / R1.5b: contrato invalido e falha fatal, nunca aviso. */
export class ContractError extends PshError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, { failureClass: "fatal", exitCode: EXIT.CONTRACT_INVALID, detail });
    this.name = "ContractError";
  }
}

/** R2.1: valor de metrica vindo do chamador nao e aceito por nenhum portao. */
export class ForgedInputError extends PshError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, { failureClass: "fatal", exitCode: EXIT.FORGED_INPUT, detail });
    this.name = "ForgedInputError";
  }
}

/** R4.2: falha de escrita na trilha interrompe a execucao. */
export class AuditError extends PshError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, { failureClass: "fatal", exitCode: EXIT.AUDIT_BROKEN, detail });
    this.name = "AuditError";
  }
}
