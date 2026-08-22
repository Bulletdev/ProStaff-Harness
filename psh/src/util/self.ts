/**
 * Como reinvocar o proprio psh a partir de um contrato.
 *
 * O contrato escreve o token `${PSH}`; quem resolve e o nucleo. No binario
 * compilado isso e um argv de um elemento; rodando pelo fonte sao dois
 * (`bun src/index.ts`). Deixar o contrato escrever `psh` e contar com o PATH
 * seria adivinhar qual instalacao responde.
 */
export const PSH_TOKEN = "${PSH}";

export function selfArgv(): string[] {
  const main = Bun.main;
  if (main.endsWith(".ts") || main.endsWith(".tsx") || main.endsWith(".js")) {
    return [process.execPath, main];
  }
  return [process.execPath];
}
