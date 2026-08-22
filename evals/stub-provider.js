// Provider de mentira, para exercitar o harness sem gastar chamada de API.
//
// Prova, sem nenhuma credencial: que o prompt renderiza com as vars, que os
// asserts de formato e de nota pegam resposta errada, e que a conta de custo
// usa o inputCost/outputCost declarado no YAML.
//
// O que ele NAO prova: como um modelo de verdade se comporta. Isso so sai
// rodando com chave. Por isso ele vive num config separado (smoke) em vez de
// virar mais uma coluna da comparacao.

class StubProvider {
  constructor(options = {}) {
    this.providerId = options.id || 'stub';
    this.config = options.config || {};
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt) {
    const modo = this.config.modo || 'bom';

    // Latencia simulada, para o assert de latencia ter o que medir
    await new Promise(r => setTimeout(r, this.config.latenciaMs ?? 20));

    const output = JSON.stringify(this.responder(prompt, modo));

    return {
      output,
      tokenUsage: {
        prompt: this.config.promptTokens ?? 200,
        completion: this.config.completionTokens ?? 40,
        total: (this.config.promptTokens ?? 200) + (this.config.completionTokens ?? 40),
      },
    };
  }

  responder(prompt, modo) {
    if (modo === 'formato-quebrado') return 'isto nao e o schema';
    if (modo === 'nota-errada') return { mark: 1, mistakes: [] };

    // Modo "bom": le a resposta do aluno do proprio prompt e devolve algo
    // coerente, para os asserts de nota passarem.
    const m = prompt.match(/Answer:\s*\n?"([^"]*)"/);
    const resposta = m ? m[1] : '';

    const temErro = /La gato|Der Katze|She go/.test(resposta);
    return temErro
      ? { mark: 4, mistakes: ['concordancia'] }
      : { mark: 10, mistakes: [] };
  }
}

module.exports = StubProvider;
