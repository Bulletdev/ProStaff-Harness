/**
 * Saida da CLI atras de um ponto unico.
 *
 * Sem isto a unica forma de exercitar os comandos e por subprocesso, e teste
 * por subprocesso nao entra no relatorio de cobertura: o codigo pareceria
 * testado no CI e nao apareceria em lugar nenhum na medicao. Trocar o destino
 * da escrita e o que permite medir de verdade.
 */
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const REAL: Io = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

let current: Io = REAL;

export function io(): Io {
  return current;
}

/** Devolve a funcao que restaura o destino anterior. */
export function setIo(next: Io): () => void {
  const previous = current;
  current = next;
  return () => {
    current = previous;
  };
}

/** Coletor pronto para teste. */
export function captureIo(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const restore = setIo({ out: (t) => out.push(t), err: (t) => err.push(t) });
  return { out, err, restore };
}
