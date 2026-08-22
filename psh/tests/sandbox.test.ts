import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildArgv,
  detectSandbox,
  resetSandboxCache,
  runSandboxed,
  type SandboxStatus,
} from "../src/evidence/sandbox.ts";
import { cleanupTempProjects, tempProject } from "./helpers.ts";

afterAll(cleanupTempProjects);

const originais = {
  PSH_SANDBOX: process.env.PSH_SANDBOX,
  PSH_IN_SANDBOX: process.env.PSH_IN_SANDBOX,
  PSH_AI_JAIL_BIN: process.env.PSH_AI_JAIL_BIN,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originais)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSandboxCache();
});

function fakeJailBin(body: string): string {
  const layout = tempProject({ git: false });
  const path = join(layout.root, "ai-jail");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

describe("deteccao de sandbox e declarada, nunca adivinhada (R2.7, R3.2)", () => {
  test("PSH_SANDBOX=off declara modo degradado", () => {
    process.env.PSH_SANDBOX = "off";
    resetSandboxCache();
    const status = detectSandbox(true);
    expect(status.mode).toBe("degraded");
    expect(status.detail).toContain("explicitamente");
  });

  test("PSH_IN_SANDBOX=1 declara sessao ja enjaulada", () => {
    delete process.env.PSH_SANDBOX;
    process.env.PSH_IN_SANDBOX = "1";
    resetSandboxCache();
    expect(detectSandbox(true).mode).toBe("inherited");
  });

  test("ai-jail que responde ao probe habilita o modo ai-jail com versao", () => {
    delete process.env.PSH_SANDBOX;
    delete process.env.PSH_IN_SANDBOX;
    process.env.PSH_AI_JAIL_BIN = fakeJailBin('if [ "$1" = "--version" ]; then echo "ai-jail 9.9.9"; exit 0; fi');
    resetSandboxCache();
    const status = detectSandbox(true);
    expect(status.mode).toBe("ai-jail");
    expect(status.jail_version).toBe("ai-jail 9.9.9");
  });

  test("ai-jail que falha no probe cai para degradado, e diz por que", () => {
    delete process.env.PSH_SANDBOX;
    delete process.env.PSH_IN_SANDBOX;
    process.env.PSH_AI_JAIL_BIN = fakeJailBin("exit 3");
    resetSandboxCache();
    const status = detectSandbox(true);
    expect(status.mode).toBe("degraded");
    expect(status.detail).toContain("probe");
  });

  test("caminho de ai-jail inexistente cai para degradado", () => {
    delete process.env.PSH_SANDBOX;
    delete process.env.PSH_IN_SANDBOX;
    process.env.PSH_AI_JAIL_BIN = "/nao/existe/ai-jail";
    resetSandboxCache();
    expect(detectSandbox(true).mode).toBe("degraded");
  });

  test("o resultado e cacheado ate alguem pedir nova deteccao", () => {
    process.env.PSH_SANDBOX = "off";
    resetSandboxCache();
    const primeiro = detectSandbox();
    expect(detectSandbox()).toBe(primeiro);
    expect(detectSandbox(true)).not.toBe(primeiro);
  });
});

describe("montagem do comando (R3.4: defaults seguros preservados)", () => {
  const req = { argv: ["sh", "-c", "true"], cwd: "/tmp", env: {}, timeout_s: 5, network: false };

  test("degradado e herdado nao envolvem o comando", () => {
    for (const mode of ["degraded", "inherited"] as const) {
      const status: SandboxStatus = { mode, detail: "t", jail_bin: null, jail_version: null };
      const { argv, wrapped } = buildArgv(req, status);
      expect(wrapped).toBe(false);
      expect(argv).toEqual(req.argv);
    }
  });

  test("ai-jail entra sem credencial de agente, sem docker, sem ssh e sem rede", () => {
    const status: SandboxStatus = { mode: "ai-jail", detail: "t", jail_bin: "/bin/ai-jail", jail_version: "1" };
    const { argv, wrapped } = buildArgv(req, status);
    expect(wrapped).toBe(true);
    expect(argv.slice(0, 5)).toEqual(["/bin/ai-jail", "--no-agent-state", "--no-docker", "--no-ssh", "--no-network"]);
    expect(argv).toContain("--");
    expect(argv.slice(-3)).toEqual(["sh", "-c", "true"]);
  });

  test("rede so aparece quando o verificador declara que precisa (R2.7)", () => {
    const status: SandboxStatus = { mode: "ai-jail", detail: "t", jail_bin: "/bin/ai-jail", jail_version: "1" };
    const { argv } = buildArgv({ ...req, network: true }, status);
    expect(argv).toContain("--network");
    expect(argv).not.toContain("--no-network");
  });
});

describe("propagacao de codigo de saida atravessando o wrapper (R2.10)", () => {
  test("o wrapper nao engole o codigo do comando", () => {
    const bin = fakeJailBin('while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"');
    const status: SandboxStatus = { mode: "ai-jail", detail: "t", jail_bin: bin, jail_version: "1" };
    const result = runSandboxed(
      { argv: ["sh", "-c", "exit 42"], cwd: "/tmp", env: { PATH: process.env.PATH ?? "" }, timeout_s: 10, network: false },
      status,
    );
    expect(result.exit_code).toBe(42);
    expect(result.signal).toBeNull();
    expect(result.mode).toBe("ai-jail");
  });

  test("comando inexistente devolve erro de spawn e exit_code nulo, nunca zero", () => {
    const status: SandboxStatus = { mode: "degraded", detail: "t", jail_bin: null, jail_version: null };
    const result = runSandboxed(
      { argv: ["binario-inexistente-psh-teste"], cwd: "/tmp", env: {}, timeout_s: 5, network: false },
      status,
    );
    expect(result.spawn_error).not.toBeNull();
    expect(result.exit_code).toBeNull();
  });
});
