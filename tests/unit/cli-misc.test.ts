import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliContext, runCli } from "../../src/cli/index";
import {
  createSandbox,
  initSummariesDb,
  type MockLanguageServer,
  readTranscript,
  type Sandbox,
  startMockLanguageServer,
  writeHubFile,
  writeMockAgentapi,
} from "../helpers/sandbox";

const active: Sandbox[] = [];
const servers: MockLanguageServer[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("nullg-unit-misc");
  active.push(created);
  return created;
}

function context(tty: boolean, env: Record<string, string> = {}): CliContext {
  const make = () => {
    const stream = {
      isTTY: tty,
      write(chunk: string) {
        stream.chunks.push(chunk);
        return true;
      },
      chunks: [] as string[],
    };
    return stream;
  };
  return { stdout: make(), stderr: make(), env: { ...env } };
}

function stdoutText(ctx: CliContext): string {
  return (ctx.stdout as unknown as { chunks: string[] }).chunks.join("");
}

function stderrText(ctx: CliContext): string {
  return (ctx.stderr as unknown as { chunks: string[] }).chunks.join("");
}

function stdoutJson<T>(ctx: CliContext): T {
  return JSON.parse(stdoutText(ctx)) as T;
}

async function prepared(): Promise<Sandbox> {
  const instance = sandbox();
  initSummariesDb(instance);
  writeMockAgentapi(instance);
  const server = await startMockLanguageServer();
  servers.push(server);
  writeHubFile(instance, {
    pid: process.pid,
    httpPort: server.port,
    httpsPort: server.port,
    lsVersion: "1.0.0",
    csrfToken: server.csrfToken,
  });
  return instance;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

function writeTemplate(instance: Sandbox): void {
  mkdirSync(join(instance.configDir, "templates"), { recursive: true });
  writeFileSync(
    join(instance.configDir, "templates", "browser-verifier.md"),
    "---\nname: browser-verifier\ndescription: Run UI verification\nmodel: gemini-3.8-flash-medium\nprofile: verifier\ncwd: /tmp/verify\n---\nYou are a dedicated browser QA verifier.\nDo not modify repository source code.",
  );
}

describe("templates command", () => {
  it("lists configured templates in json", async () => {
    const instance = await prepared();
    writeTemplate(instance);

    const ctx = context(false, instance.env);
    const code = await runCli(["templates", "--json"], ctx);
    expect(code).toBe(0);
    expect(
      stdoutJson<
        Array<{ name: string; description: string; model: string; profile: string; cwd: string }>
      >(ctx),
    ).toEqual([
      {
        name: "browser-verifier",
        description: "Run UI verification",
        model: "gemini-3.8-flash-medium",
        profile: "verifier",
        cwd: "/tmp/verify",
      },
    ]);
  });

  it("returns an empty list when the templates dir is missing", async () => {
    const instance = await prepared();
    const ctx = context(false, instance.env);
    expect(await runCli(["templates", "--json"], ctx)).toBe(0);
    expect(stdoutJson<Array<unknown>>(ctx)).toEqual([]);
  });

  it("fills defaults for sparse templates and ignores non-markdown files", async () => {
    const instance = await prepared();
    const { mkdirSync: mkdir, writeFileSync: write } = await import("node:fs");
    mkdir(join(instance.configDir, "templates"), { recursive: true });
    write(
      join(instance.configDir, "templates", "bare.md"),
      "---\ndescription: Tiny helper\n---\nBare body.",
    );
    write(join(instance.configDir, "templates", "readme.txt"), "ignore me");

    const ctx = context(false, instance.env);
    const code = await runCli(["templates", "--json"], ctx);
    expect(code).toBe(0);
    expect(
      stdoutJson<
        Array<{ name: string; description: string; model: string; profile: string; cwd: string }>
      >(ctx),
    ).toEqual([{ name: "bare", description: "Tiny helper", model: "", profile: "", cwd: "" }]);

    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "bare", "task"], runCtx);
    expect(stdoutJson<{ model: string; cwd: string }>(runCtx)).toMatchObject({
      model: "flash",
      cwd: process.cwd(),
    });
  });

  it("fills empty descriptions and names from the file stem", async () => {
    const instance = await prepared();
    const { mkdirSync: mkdir, writeFileSync: write } = await import("node:fs");
    mkdir(join(instance.configDir, "templates"), { recursive: true });
    write(join(instance.configDir, "templates", "minimal.md"), "---\nmodel: pro\n---\nBody.");

    const ctx = context(false, instance.env);
    await runCli(["templates", "--json"], ctx);
    expect(stdoutJson<Array<{ name: string; description: string; model: string }>>(ctx)).toEqual([
      { name: "minimal", description: "", model: "pro", profile: "", cwd: "" },
    ]);
  });

  it("renders a tty table and tolerates an empty templates dir", async () => {
    const instance = await prepared();
    const empty = context(true, instance.env);
    expect(await runCli(["templates"], empty)).toBe(0);
    expect(stdoutText(empty)).toContain("NAME");

    writeTemplate(instance);
    const tty = context(true, instance.env);
    expect(await runCli(["templates"], tty)).toBe(0);
    expect(stdoutText(tty)).toContain("browser-verifier");
    expect(stdoutText(tty)).toContain("gemini-3.8-flash-medium");
  });
});

describe("run with templates", () => {
  it("combines the template preamble with the prompt and honors template defaults", async () => {
    const instance = await prepared();
    writeTemplate(instance);

    const ctx = context(false, instance.env);
    const code = await runCli(
      ["run", "--bg", "--json", "browser-verifier", "Verify login flow on http://localhost:3000"],
      ctx,
    );
    expect(code).toBe(0);
    const payload = stdoutJson<{ model: string; cwd: string; projectId: string | null }>(ctx);
    expect(payload).toMatchObject({ model: "gemini-3.8-flash-medium", cwd: "/tmp/verify" });

    const conversationId = stdoutJson<{ conversationId: string }>(ctx).conversationId;
    const inbound = String(readTranscript(instance, conversationId)[0]?.content);
    expect(inbound).toContain('<nullg cwd="/tmp/verify">');
    expect(inbound).toContain("You are a dedicated browser QA verifier.");
    expect(inbound).toContain("Verify login flow on http://localhost:3000");
  });

  it("lets cli flags override template defaults", async () => {
    const instance = await prepared();
    writeTemplate(instance);

    const ctx = context(false, instance.env);
    await runCli(
      [
        "run",
        "--bg",
        "--json",
        "--model",
        "pro",
        "--cwd",
        "/tmp/other",
        "browser-verifier",
        "task",
      ],
      ctx,
    );
    expect(stdoutJson<{ model: string; cwd: string }>(ctx)).toMatchObject({
      model: "pro",
      cwd: "/tmp/other",
    });
  });

  it("fails with not_found for unknown templates", async () => {
    const instance = await prepared();
    const ctx = context(false, instance.env);
    const code = await runCli(["run", "--bg", "--json", "ghost-template", "task"], ctx);
    expect(code).toBe(1);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({
      error: { kind: "not_found", message: expect.stringContaining("ghost-template") },
    });
  });
});

describe("schema command", () => {
  it("prints machine-readable json schema definitions", async () => {
    const instance = await prepared();
    const ctx = context(true, instance.env);
    const code = await runCli(["schema"], ctx);
    expect(code).toBe(0);
    const schema = stdoutJson<Record<string, unknown>>(ctx);
    expect(schema.$schema).toContain("json-schema");
    const defs = (schema as { $defs: Record<string, unknown> }).$defs;
    expect(defs).toBeDefined();
    const commands = (
      schema as { properties: { commands: { properties: Record<string, unknown> } } }
    ).properties.commands.properties;
    for (const expected of [
      "run",
      "send",
      "wait",
      "read",
      "ls",
      "get",
      "label",
      "kill",
      "rm",
      "interrupt",
      "templates",
      "events",
      "status",
    ]) {
      expect(commands[expected]).toBeDefined();
    }
    for (const name of Object.keys(commands)) {
      const ref = (commands[name] as { properties: { output: { $ref: string } } }).properties.output
        .$ref;
      expect(ref.startsWith("#/$defs/")).toBe(true);
      expect(defs[ref.slice("#/$defs/".length)]).toBeDefined();
    }
    const runOptions = (
      commands.run as {
        properties: { options: { properties: Record<string, Record<string, unknown>> } };
      }
    ).properties.options.properties;
    expect(runOptions["--timeout"]).toMatchObject({ type: "integer", default: 180 });
    expect(runOptions["--timeout"]?.const).toBeUndefined();
    const runSummary = defs.runSummary as unknown as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(runSummary.properties.reason).toMatchObject({
      enum: ["done", "blocked", "error", "message", "timeout"],
    });
    expect(runSummary.properties.timedOut).toMatchObject({ type: "boolean" });
    expect(runSummary.properties.durationMs).toMatchObject({ type: "integer", minimum: 0 });
  });

  it("validates real command outputs against the schema (review F18)", async () => {
    const instance = await prepared();
    const schemaCtx = context(true, instance.env);
    await runCli(["schema"], schemaCtx);
    const schema = stdoutJson<Record<string, unknown>>(schemaCtx);

    const errors: string[] = [];
    const resolveRef = (ref: string): Record<string, unknown> => {
      if (!ref.startsWith("#/")) {
        throw new Error(`external ref ${ref}`);
      }
      let node: unknown = schema;
      for (const part of ref.slice(2).split("/")) {
        node = (node as Record<string, unknown>)?.[part];
      }
      if (node === undefined) {
        throw new Error(`unresolvable ref ${ref}`);
      }
      return node as Record<string, unknown>;
    };
    const typeOf = (value: unknown): string => {
      if (value === null) return "null";
      if (Array.isArray(value)) return "array";
      if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
      return typeof value;
    };
    const validate = (node: unknown, value: unknown, path: string): void => {
      if (node === undefined || node === null) return;
      const spec = node as Record<string, unknown>;
      if (typeof spec.$ref === "string") {
        validate(resolveRef(spec.$ref), value, path);
        return;
      }
      if (spec.type !== undefined) {
        const allowed = Array.isArray(spec.type) ? spec.type : [spec.type];
        const actual = typeOf(value);
        if (!allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) {
          errors.push(`${path}: expected type ${allowed.join("|")}, got ${actual}`);
          return;
        }
      }
      if (spec.enum !== undefined && !(spec.enum as unknown[]).includes(value)) {
        errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
      }
      if (spec.const !== undefined && spec.const !== value) {
        errors.push(`${path}: expected const ${JSON.stringify(spec.const)}`);
      }
      if (
        spec.minimum !== undefined &&
        typeof value === "number" &&
        value < (spec.minimum as number)
      ) {
        errors.push(`${path}: ${value} is below minimum ${String(spec.minimum)}`);
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const properties = (spec.properties ?? {}) as Record<string, unknown>;
        for (const key of (spec.required as string[] | undefined) ?? []) {
          if (!(key in value)) {
            errors.push(`${path}: missing required property ${key}`);
          }
        }
        if (spec.additionalProperties === false) {
          for (const key of Object.keys(value)) {
            if (!(key in properties)) {
              errors.push(`${path}: unexpected property ${key}`);
            }
          }
        }
        for (const [key, child] of Object.entries(properties)) {
          if (key in value) {
            validate(child, (value as Record<string, unknown>)[key], `${path}.${key}`);
          }
        }
      }
      if (Array.isArray(value) && spec.items !== undefined) {
        for (const [index, entry] of value.entries()) {
          validate(spec.items, entry, `${path}[${index}]`);
        }
      }
    };

    const outputRef = async (command: string[], def: string, expectedCode = 0): Promise<void> => {
      const ctx = context(false, instance.env);
      const code = await runCli(command, ctx);
      expect(code, `command ${command.join(" ")} failed: ${stderrText(ctx)}`).toBe(expectedCode);
      if (code !== 0 && expectedCode === 0) return;
      validate({ $ref: `#/$defs/${def}` }, stdoutJson(ctx), def);
    };

    const timeoutCtx = context(false, { ...instance.env, AG_MOCK_AGENTAPI_MODE: "stuck" });
    const timeoutCode = await runCli(
      ["run", "--json", "--timeout", "1", "--name", "schema-timeout", "task"],
      timeoutCtx,
    );
    expect(timeoutCode).toBe(124);
    validate(
      { $ref: "#/$defs/runSummary" },
      stdoutJson<{ reason: string; timedOut: boolean; durationMs: number }>(timeoutCtx),
      "runSummary",
    );

    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "schema-run", "task"], runCtx);
    validate({ $ref: "#/$defs/runSummary" }, stdoutJson(runCtx), "runSummary");
    const summary = stdoutJson<{ conversationId: string; shortId: string }>(runCtx);
    const conversationId = summary.conversationId;
    const shortId = summary.shortId;

    await outputRef(["send", "--json", "schema-run", "second"], "receipt");
    await outputRef(["wait", "--json", "schema-run"], "waitResult");
    await outputRef(["read", "--json", "--steps", "schema-run"], "readResult");
    await outputRef(["get", "--json", "schema-run"], "getSnapshot");
    await outputRef(["ls", "--json"], "lsOutput");
    await outputRef(["label", "--json", "schema-run", "k=v"], "labelResult");
    await outputRef(["templates", "--json"], "templatesOutput");
    await outputRef(["status", "--json"], "statusReport");
    await outputRef(["kill", "--json", "schema-run"], "controlResult");
    await outputRef(["interrupt", "--json", conversationId], "controlResult");
    await outputRef(["rm", "--json", shortId], "controlResult");

    expect(errors).toEqual([]);
  });
});

describe("--skill", () => {
  it("keeps the embedded manual in sync with src/cli/skill.md", async () => {
    const { readFileSync } = await import("node:fs");
    const { SKILL_MANUAL } = await import("../../src/cli/skill");
    const source = readFileSync(join(process.cwd(), "src", "cli", "skill.md"), "utf8").trimEnd();
    expect(SKILL_MANUAL.trimEnd()).toBe(source);
  });

  it("prints the embedded agent manual", async () => {
    const instance = await prepared();
    for (const args of [["--skill"], ["skill"]]) {
      const ctx = context(true, instance.env);
      const code = await runCli(args, ctx);
      expect(code).toBe(0);
      const text = stdoutText(ctx);
      expect(text).toContain("# nullg manual");
      expect(text).toContain("nullg wait");
      expect(text).toContain("nullg read");
    }
  });
});
