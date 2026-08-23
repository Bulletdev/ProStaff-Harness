import Ajv from "ajv";
import type { ValidateFunction } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Validador compilado na primeira vez que e usado, nunca no import.
 *
 * Compilar JSON Schema e geracao de codigo, e o ajv fazia isso no escopo de
 * modulo: `psh --version` pagava a compilacao dos sete schemas do projeto sem
 * validar nada. Medido no binario compilado, eram 185 ms de partida contra 2 ms
 * do `bun` cru, e 181 desses 185 iam embora antes de a primeira linha de logica
 * rodar.
 *
 * Isso importa porque o hook do adapter roda **uma vez por chamada de tool**: a
 * mesma partida entrava no caminho critico de cada escrita da sessao.
 *
 * A funcao devolvida mantem a interface do ajv, incluindo `.errors` depois da
 * chamada, entao nenhum ponto de uso muda.
 */
export function lazyValidator(schema: object): ValidateFunction {
  let compilado: ValidateFunction | null = null;
  const validar = ((dados: unknown): boolean => {
    compilado ??= ajv.compile(schema);
    const ok = compilado(dados);
    validar.errors = compilado.errors;
    return ok;
  }) as ValidateFunction;
  return validar;
}
