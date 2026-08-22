#!/usr/bin/env node
// Calcula custo por tarefa APROVADA a partir do results.json do promptfoo.
//
// Uso:
//   npx promptfoo eval -c promptfooconfig.cost-comparison.yaml --repeat 3 -o results.json
//   node analyze-cost-comparison.js results.json
//
// Por que isto existe: o assert `cost` do promptfoo e um portao (passa ou nao
// passa do threshold), nao uma metrica comparavel. Custo bruto tambem nao
// decide nada: um modelo barato que erra metade das vezes custa duas chamadas
// por resposta util, e ai nao e mais barato. O numero que decide e
//
//     custo total / respostas que passaram
//
// Se um provider reprova em tudo, o custo por aprovacao e infinito, e e assim
// que ele aparece aqui: nunca como zero, nunca omitido da tabela.

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || 'results.json';

// Tabela de precos nossa, em US$ por 1M de tokens. Nao usamos a do promptfoo:
// a versao mais recente publicada nao conhece nenhum modelo de geracao atual,
// e o assert `cost` aborta o teste inteiro quando o modelo nao esta la.
const PRICES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'prices.json'), 'utf8')
);

let raw;
try {
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  fail(`nao consegui ler ${file}: ${err.message}`);
}

const rows = extractRows(raw);

// Zero linhas nunca vira tabela vazia com cara de sucesso: ou o arquivo mudou
// de formato, ou a rodada nao aconteceu. Os dois sao erro, nao "sem achados".
if (rows.length === 0) {
  fail(
    `nenhum resultado encontrado em ${file}.\n` +
    `O formato do promptfoo mudou entre versoes; confira a estrutura do arquivo ` +
    `antes de confiar em qualquer numero.`
  );
}

const porProvider = new Map();

for (const row of rows) {
  const nome = row.provider;
  const acc = porProvider.get(nome) || {
    chamadas: 0, aprovadas: 0, custo: 0, latencias: [], semCusto: 0,
  };

  acc.chamadas++;
  if (row.success) acc.aprovadas++;

  // Custo ausente e ausencia, nao zero: um provider sem tabela de preco
  // conhecida apareceria como "de graca" e ganharia a comparacao.
  if (typeof row.cost === 'number') acc.custo += row.cost;
  else acc.semCusto++;

  if (typeof row.latencyMs === 'number') acc.latencias.push(row.latencyMs);

  porProvider.set(nome, acc);
}

const tabela = [...porProvider.entries()].map(([provider, a]) => {
  const taxa = a.aprovadas / a.chamadas;

  // Provider com chamada sem preco nao entra no ranking. Somar so o que tem
  // preco e apresentar o total como se fosse completo colocaria ele no topo
  // por ser barato, quando na verdade e desconhecido. Aqui `null` significa
  // "nao da para comparar", e nunca vira zero.
  const incompleto = a.semCusto > 0;
  const porAprovada = incompleto
    ? null
    : (a.aprovadas > 0 ? a.custo / a.aprovadas : Infinity);

  return {
    provider,
    chamadas: a.chamadas,
    aprovacao: `${(taxa * 100).toFixed(0)}%`,
    custoTotal: a.custo,
    custoPorChamada: incompleto ? null : a.custo / a.chamadas,
    custoPorAprovada: porAprovada,
    p50: percentil(a.latencias, 0.5),
    p95: percentil(a.latencias, 0.95),
    semCusto: a.semCusto,
  };
});

// Quem nao da para comparar vai para o fim, nunca para o topo.
tabela.sort((x, y) => ordem(x.custoPorAprovada) - ordem(y.custoPorAprovada));

console.log(`\nRodada: ${rows.length} chamadas, ${porProvider.size} providers`);
console.log(`Precos: prices.json, conferidos em ${PRICES.verifiedOn}\n`);
console.log(
  pad('PROVIDER', 24) + pad('APROV', 7) + pad('US$/CHAMADA', 13) +
  pad('US$/APROVADA', 14) + pad('P50 ms', 9) + 'P95 ms'
);
console.log('-'.repeat(74));

for (const r of tabela) {
  console.log(
    pad(r.provider, 24) +
    pad(r.aprovacao, 7) +
    pad(money(r.custoPorChamada), 13) +
    pad(money(r.custoPorAprovada), 14) +
    pad(r.p50 === null ? 'n/d' : String(Math.round(r.p50)), 9) +
    (r.p95 === null ? 'n/d' : String(Math.round(r.p95)))
  );
}

const semPreco = tabela.filter(r => r.semCusto > 0);
if (semPreco.length > 0) {
  console.log('\nAVISO: chamadas sem custo calculavel. Ou o id do provider nao esta');
  console.log('em prices.json, ou o promptfoo nao reportou contagem de tokens:');
  for (const r of semPreco) {
    console.log(`  ${r.provider}: ${r.semCusto}/${r.chamadas} chamadas`);
  }
  console.log('Estes ficam fora do ranking ate o preco ser declarado.');
}

coerencia(rows);

const reprovouTudo = tabela.filter(r => r.custoPorAprovada === Infinity);
if (reprovouTudo.length > 0) {
  console.log('\nProviders que nao passaram em nenhuma chamada (custo por aprovacao');
  console.log('infinito, nao zero): ' + reprovouTudo.map(r => r.provider).join(', '));
}

console.log('');

// ---------------------------------------------------------------------------

// Nota absoluta nao compara entre modelos: um modelo generoso e um severo dao
// numeros diferentes para a mesma frase sem que nenhum esteja errado. O que da
// para cobrar de todos e coerencia interna: dentro do mesmo modelo e do mesmo
// idioma, a frase com erro tem que tirar nota MENOR que a frase correta.
function coerencia(rows) {
  const porProvider = new Map();

  for (const r of rows) {
    if (!r.idioma || !r.esperado || r.nota === null) continue;
    const m = porProvider.get(r.provider) || new Map();
    const par = m.get(r.idioma) || {};
    par[r.esperado] = r.nota;
    m.set(r.idioma, par);
    porProvider.set(r.provider, m);
  }

  if (porProvider.size === 0) return;

  console.log('\nCOERENCIA: a frase com erro tira nota menor que a correta?');
  console.log('(comparacao dentro do mesmo modelo, sem threshold absoluto)\n');

  for (const [provider, idiomas] of porProvider) {
    const partes = [];
    let ok = 0, total = 0;

    for (const [idioma, par] of idiomas) {
      if (typeof par.correta !== 'number' || typeof par.incorreta !== 'number') continue;
      total++;
      const passou = par.incorreta < par.correta;
      if (passou) ok++;
      partes.push(`${idioma.slice(0, 2)}:${par.correta}>${par.incorreta}${passou ? '' : ' X'}`);
    }

    // Nenhum par comparavel nao vira "100%": vira aviso de que nao deu para medir
    const veredito = total === 0 ? 'sem par comparavel' : `${ok}/${total}`;
    console.log(`  ${provider.padEnd(22)}${String(veredito).padEnd(20)}${partes.join('  ')}`);
  }
}

function extractRows(data) {
  // O formato mudou entre versoes do promptfoo; tenta os conhecidos e para no
  // primeiro que der lista, em vez de assumir um so e devolver vazio.
  const candidatos = [data?.results?.results, data?.results, data?.evalRecord?.results];

  for (const c of candidatos) {
    if (!Array.isArray(c) || c.length === 0) continue;

    return c.map(r => {
      const id = r.provider?.id || r.provider || '';
      const uso = r.response?.tokenUsage || r.tokenUsage || {};

      let saida = r.response?.output;
      if (typeof saida === 'string') { try { saida = JSON.parse(saida); } catch { saida = null; } }

      return {
        provider: r.provider?.label || id || '(desconhecido)',
        providerId: id,
        success: Boolean(r.success ?? r.pass),
        cost: custoDeTokens(id, uso),
        latencyMs: r.latencyMs ?? r.response?.latencyMs,
        idioma: r.metadata?.language ?? r.testCase?.metadata?.language,
        esperado: r.metadata?.esperado ?? r.testCase?.metadata?.esperado,
        nota: saida && typeof saida.mark === 'number' ? saida.mark : null,
      };
    });
  }

  return [];
}

// Custo a partir dos tokens reportados e da nossa tabela. Devolve undefined
// quando falta preco ou falta contagem de token: undefined vira "SEM PRECO" na
// tabela final e sai do ranking, em vez de virar zero e ganhar a comparacao.
function custoDeTokens(providerId, uso) {
  const preco = PRICES.models[providerId];
  if (!preco) return undefined;

  const entrada = uso.prompt;
  const saida = uso.completion;
  if (typeof entrada !== 'number' || typeof saida !== 'number') return undefined;

  return (entrada * preco.input + saida * preco.output) / 1e6;
}

function percentil(valores, p) {
  if (valores.length === 0) return null;
  const ord = [...valores].sort((a, b) => a - b);
  return ord[Math.min(ord.length - 1, Math.floor(ord.length * p))];
}

function money(v) {
  if (v === null) return 'SEM PRECO';
  if (v === Infinity) return 'INFINITO';
  return `$${v.toFixed(5)}`;
}

// null (preco desconhecido) e Infinity (nunca aprovou) vao para o fim da
// ordenacao, cada um pelo seu motivo.
function ordem(v) {
  if (v === null) return Number.MAX_VALUE;
  return v;
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function fail(msg) {
  process.stderr.write(`erro: ${msg}\n`);
  process.exit(1);
}
