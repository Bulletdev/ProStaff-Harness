import Ajv from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import workflowSchema from "../../schemas/workflow.schema.json" with { type: "json" };
import stateSchema from "../../schemas/state.schema.json" with { type: "json" };
import evidenceSchema from "../../schemas/evidence.schema.json" with { type: "json" };
import reviewSchema from "../../schemas/review.schema.json" with { type: "json" };
import { ContractError } from "../util/errors.ts";
import { readJsonFile } from "../util/json.ts";
import { compileGlobs } from "../util/globs.ts";
import { Workflow, type WorkflowContract } from "./types.ts";

const ajv = new Ajv({ allErrors: true, strict: false });

export const validateWorkflowSchema = ajv.compile(workflowSchema) as ValidateFunction;
export const validateStateSchema = ajv.compile(stateSchema) as ValidateFunction;
export const validateEvidenceSchema = ajv.compile(evidenceSchema) as ValidateFunction;
export const validateReviewSchema = ajv.compile(reviewSchema) as ValidateFunction;

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalido"}`);
}

/**
 * R1.1: contrato invalido e falha fatal.
 * R1.5b: alem do schema, integridade referencial - todo `next` resolve, todo
 * verificador referenciado existe, fase terminal e declarada.
 */
export function parseWorkflow(raw: unknown, source: string): Workflow {
  if (!validateWorkflowSchema(raw)) {
    throw new ContractError(`workflow.json invalido (${source}):\n  - ${formatAjvErrors(validateWorkflowSchema.errors).join("\n  - ")}`, {
      source,
      errors: formatAjvErrors(validateWorkflowSchema.errors),
    });
  }
  const contract = raw as WorkflowContract;
  const problems = checkReferentialIntegrity(contract);
  if (problems.length > 0) {
    throw new ContractError(`workflow.json inconsistente (${source}):\n  - ${problems.join("\n  - ")}`, {
      source,
      problems,
    });
  }
  return new Workflow(contract);
}

export function loadWorkflow(path: string): Workflow {
  return parseWorkflow(readJsonFile(path), path);
}

export function checkReferentialIntegrity(contract: WorkflowContract): string[] {
  const problems: string[] = [];

  const phaseIds = new Set<string>();
  for (const phase of contract.phases) {
    if (phaseIds.has(phase.id)) problems.push(`fase duplicada: ${phase.id}`);
    phaseIds.add(phase.id);
  }

  const verifierIds = new Set<string>();
  for (const verifier of contract.verifiers ?? []) {
    if (verifierIds.has(verifier.id)) problems.push(`verificador duplicado: ${verifier.id}`);
    verifierIds.add(verifier.id);

    try {
      compileGlobs(verifier.watch);
    } catch (cause) {
      problems.push(`verificador ${verifier.id}: ${(cause as Error).message}`);
    }
    if (verifier.watch_exclude && verifier.watch_exclude.length > 0) {
      try {
        compileGlobs(verifier.watch_exclude);
      } catch (cause) {
        problems.push(`verificador ${verifier.id} (watch_exclude): ${(cause as Error).message}`);
      }
    }
    // O schema nao consegue exigir `file` so quando `from` e `file`, entao a
    // condicao mora aqui. Sem isto, o contrato carrega e o erro so aparece na
    // hora de extrair - ou seja, depois do verificador ja ter rodado.
    if (
      verifier.extract.kind === "json" &&
      (verifier.extract.from ?? "file") === "file" &&
      verifier.extract.file === undefined
    ) {
      problems.push(
        `verificador ${verifier.id}: extract json com from='file' precisa declarar 'file' (use from='stdout' para ler a saida do comando)`,
      );
    }
    if (verifier.extract.kind === "json" && verifier.extract.from === "stdout" && verifier.extract.file !== undefined) {
      problems.push(
        `verificador ${verifier.id}: extract json com from='stdout' nao pode declarar 'file'; o mesmo dado em dois lugares e ambiguidade, nao redundancia`,
      );
    }
  }

  if (contract.entry !== undefined && !phaseIds.has(contract.entry)) {
    problems.push(`entry aponta para fase inexistente: ${contract.entry}`);
  }

  if (contract.profile === "gate-only" && contract.phases.length > 0) {
    problems.push("perfil gate-only nao pode declarar fases");
  }
  if (contract.profile !== "gate-only" && contract.phases.length === 0) {
    problems.push(`perfil ${contract.profile} precisa declarar ao menos uma fase`);
  }

  for (const phase of contract.phases) {
    for (const target of phase.next) {
      if (!phaseIds.has(target)) {
        problems.push(`fase ${phase.id}: next aponta para fase inexistente '${target}'`);
      }
    }
    if (phase.terminal && phase.next.length > 0) {
      problems.push(`fase ${phase.id}: declarada terminal mas tem next`);
    }
    if (!phase.terminal && phase.next.length === 0) {
      problems.push(
        `fase ${phase.id}: sem next e sem terminal:true. Fase terminal e declarada, nunca inferida (R1.5b)`,
      );
    }

    const loopback = phase.gate.on_fail.loopback_to;
    if (loopback !== undefined && !phaseIds.has(loopback)) {
      problems.push(`fase ${phase.id}: gate.on_fail.loopback_to aponta para '${loopback}', que nao existe`);
    }
    if (phase.gate.on_fail.action === "rework" && loopback === undefined) {
      problems.push(`fase ${phase.id}: acao 'rework' exige loopback_to`);
    }
    const failureLoopback = phase.on_failure.loopback_to;
    if (failureLoopback !== undefined && !phaseIds.has(failureLoopback)) {
      problems.push(
        `fase ${phase.id}: on_failure.loopback_to aponta para '${failureLoopback}', que nao existe`,
      );
    }

    if (phase.gate.type !== "none" && phase.gate.checks.length === 0) {
      problems.push(`fase ${phase.id}: gate '${phase.gate.type}' sem nenhum check`);
    }
    if (phase.gate.type === "none" && phase.gate.checks.length > 0) {
      problems.push(`fase ${phase.id}: gate 'none' nao pode declarar checks`);
    }

    for (const [i, check] of phase.gate.checks.entries()) {
      const where = `fase ${phase.id}, check #${i + 1}`;
      if (check.kind === "verifier" || check.kind === "verifier-status") {
        if (!verifierIds.has(check.verifier)) {
          problems.push(`${where}: verificador '${check.verifier}' nao esta declarado`);
        }
      }
      if (check.kind === "verifier") {
        if (check.min === undefined && check.max === undefined) {
          problems.push(`${where}: check de verificador precisa de min ou max`);
        }
        if (check.min !== undefined && check.max !== undefined && check.min > check.max) {
          problems.push(`${where}: min (${check.min}) maior que max (${check.max})`);
        }
        const spec = (contract.verifiers ?? []).find((v) => v.id === check.verifier);
        if (spec && spec.extract.kind === "exit-code") {
          problems.push(
            `${where}: verificador '${check.verifier}' extrai apenas exit-code e nao produz valor; use kind 'verifier-status'`,
          );
        }
      }
    }
  }

  if (contract.profile !== "gate-only") {
    const terminals = contract.phases.filter((p) => p.terminal);
    if (terminals.length === 0) problems.push("nenhuma fase terminal declarada");
  }

  return problems;
}

export { Workflow };
