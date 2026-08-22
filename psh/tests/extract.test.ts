import { describe, expect, test } from "bun:test";
import { extractCobertura, extractGoCover, extractLcov, extractSimplecov } from "../src/evidence/extract/index.ts";

describe("extratores de metrica (R2.5, R2.11, R2.13)", () => {
  test("lcov soma os registros e calcula a porcentagem de linha", () => {
    const text = [
      "SF:src/a.ts",
      "LF:100",
      "LH:80",
      "FNF:10",
      "FNH:5",
      "end_of_record",
      "SF:src/b.ts",
      "LF:100",
      "LH:90",
      "FNF:10",
      "FNH:10",
      "end_of_record",
    ].join("\n");

    expect(extractLcov(text, "lines.pct").value).toBeCloseTo(85, 5);
    expect(extractLcov(text, "functions.pct").value).toBeCloseTo(75, 5);
    expect(extractLcov(text, "lines.pct").candidates_examined).toBe(2);
  });

  test("lcov sem nenhum registro SF e falta de candidato, nao cobertura zero", () => {
    const outcome = extractLcov("TN:\n", "lines.pct");
    expect(outcome.value).toBeNull();
    expect(outcome.failure).toBe("no-candidates");
  });

  test("lcov com denominador zero nao vira 0% nem NaN", () => {
    const outcome = extractLcov("SF:src/a.ts\nLF:0\nLH:0\nend_of_record\n", "lines.pct");
    expect(outcome.value).toBeNull();
    expect(outcome.failure).toBe("extractor-no-match");
  });

  test("lcov sem dados de branch reprova quando a metrica pedida e branch", () => {
    const outcome = extractLcov("SF:a\nLF:10\nLH:10\nend_of_record\n", "branches.pct");
    expect(outcome.value).toBeNull();
    expect(outcome.failure).toBe("extractor-no-match");
  });

  test("cobertura le line-rate do elemento raiz e conta as classes", () => {
    const xml = `<?xml version="1.0"?>
<coverage line-rate="0.873" branch-rate="0.5" version="1">
  <packages><package><classes>
    <class name="a" filename="a.py"/>
    <class name="b" filename="b.py"/>
  </classes></package></packages>
</coverage>`;
    const outcome = extractCobertura(xml, "lines.pct");
    expect(outcome.value).toBeCloseTo(87.3, 5);
    expect(outcome.candidates_examined).toBe(2);
    expect(extractCobertura(xml, "branches.pct").value).toBeCloseTo(50, 5);
  });

  test("cobertura sem nenhuma classe e falta de candidato", () => {
    const outcome = extractCobertura('<coverage line-rate="0.9"></coverage>', "lines.pct");
    expect(outcome.value).toBeNull();
    expect(outcome.failure).toBe("no-candidates");
  });

  test("simplecov le result.line e tambem o formato antigo covered_percent", () => {
    expect(extractSimplecov('{"result":{"line":91.2}}', "lines.pct").value).toBeCloseTo(91.2, 5);
    expect(extractSimplecov('{"result":{"covered_percent":88.5}}', "lines.pct").value).toBeCloseTo(88.5, 5);
  });

  test("simplecov com JSON quebrado e parse-failed, nao zero", () => {
    const outcome = extractSimplecov("{nao e json", "lines.pct");
    expect(outcome.value).toBeNull();
    expect(outcome.failure).toBe("parse-failed");
  });

  test("simplecov sem o campo esperado e extractor-no-match", () => {
    const outcome = extractSimplecov('{"result":{}}', "lines.pct");
    expect(outcome.value).toBeNull();
    expect(outcome.failure).toBe("extractor-no-match");
  });

  test("go cover soma statements cobertos, nao blocos", () => {
    const profile = [
      "mode: set",
      "pkg/a.go:1.2,3.4 10 1",
      "pkg/a.go:5.2,7.4 10 0",
      "pkg/b.go:1.2,2.4 80 1",
      "",
    ].join("\n");
    const outcome = extractGoCover(profile, "lines.pct");
    expect(outcome.value).toBeCloseTo(90, 5);
    expect(outcome.candidates_examined).toBe(3);
  });

  test("go cover so com o cabecalho e falta de candidato", () => {
    const outcome = extractGoCover("mode: set\n", "lines.pct");
    expect(outcome.value).toBeNull();
    expect(outcome.failure).toBe("no-candidates");
  });
});
