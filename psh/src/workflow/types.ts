import type { FailureClass } from "../util/errors.ts";

export type ProfileName = "strict" | "lean" | "gate-only";

export type ExtractSpec =
  | { kind: "exit-code" }
  | {
      kind: "lcov" | "cobertura" | "simplecov" | "go-cover";
      file: string;
      metric: "lines.pct" | "functions.pct" | "branches.pct" | "statements.pct";
    }
  | { kind: "json"; from?: "file" | "stdout"; file?: string; pointer: string };

export interface VerifierSpec {
  id: string;
  description?: string;
  run: string[];
  cwd?: string;
  env?: Record<string, string>;
  extract: ExtractSpec;
  watch: string[];
  watch_exclude?: string[];
  timeout_s: number;
  success_exit_codes?: number[];
  network?: boolean;
  stacks?: string[];
  applies_when_exists?: string[];
}

export type GateCheck =
  | { kind: "verifier"; verifier: string; min?: number; max?: number }
  | { kind: "verifier-status"; verifier: string }
  | { kind: "review-score"; file: string; target: string; min: number }
  | { kind: "presence"; file: string; min_lines?: number; min_bytes?: number }
  | { kind: "user-approval"; subject: string; message?: string };

export interface GateSpec {
  type: "all-of" | "any-of" | "none";
  checks: GateCheck[];
  on_fail: {
    action: "block" | "rework" | "restart";
    loopback_to?: string;
    message: string;
  };
}

export interface OnFailureSpec {
  class: FailureClass;
  max_auto_retries: number;
  backoff?: "exponential" | "none";
  delays_ms?: number[];
  loopback_to?: string;
}

export interface PhaseSpec {
  id: string;
  name: string;
  owner?: string;
  description?: string;
  terminal: boolean;
  next: string[];
  gate: GateSpec;
  on_failure: OnFailureSpec;
}

export interface FailureClassSpec {
  description?: string;
  max_auto_retries: number;
  backoff: "exponential" | "none";
  delays_ms: number[];
  on_exhaustion: "escalate" | "block" | "halt";
}

export interface WorkflowContract {
  _type: "psh-workflow";
  version: 1;
  profile: ProfileName;
  description?: string;
  entry?: string;
  verifiers?: VerifierSpec[];
  phases: PhaseSpec[];
  failure_protocol: {
    description?: string;
    classes: Record<FailureClass, FailureClassSpec>;
  };
}

/** Contrato ja validado, com indices prontos. */
export class Workflow {
  readonly contract: WorkflowContract;
  readonly #phases: Map<string, PhaseSpec>;
  readonly #verifiers: Map<string, VerifierSpec>;

  constructor(contract: WorkflowContract) {
    this.contract = contract;
    this.#phases = new Map(contract.phases.map((p) => [p.id, p]));
    this.#verifiers = new Map((contract.verifiers ?? []).map((v) => [v.id, v]));
  }

  get profile(): ProfileName {
    return this.contract.profile;
  }

  get phases(): PhaseSpec[] {
    return this.contract.phases;
  }

  get verifiers(): VerifierSpec[] {
    return this.contract.verifiers ?? [];
  }

  get entryPhase(): string | null {
    if (this.contract.phases.length === 0) return null;
    return this.contract.entry ?? this.contract.phases[0]!.id;
  }

  phase(id: string): PhaseSpec | undefined {
    return this.#phases.get(id);
  }

  verifier(id: string): VerifierSpec | undefined {
    return this.#verifiers.get(id);
  }

  failureClass(name: FailureClass): FailureClassSpec {
    return this.contract.failure_protocol.classes[name];
  }
}
