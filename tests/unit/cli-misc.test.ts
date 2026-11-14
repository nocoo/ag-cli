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
  const created = createSandbox("ag-cli-unit-misc");
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
    expect(inbound).toContain('<ag-cli cwd="/tmp/verify">');
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
    const schema = stdoutJson<{
      $schema: string;
      title: string;
      properties: {
        exitCodes: { properties: Record<string, { const: number }> };
        reasons: { items: { enum: string[] } };
        types: { properties: Record<string, { required?: string[] }> };
        commands: {
          properties: Record<
            string,
            {
              properties: {
                options: { properties: Record<string, unknown> };
                output: { $ref: string };
              };
              required: string[];
            }
          >;
        };
      };
    }>(ctx);
    expect(schema.title).toBe("ag-cli");
    expect(schema.$schema).toContain("json-schema");
    expect(schema.properties.exitCodes.properties.timeout?.const).toBe(124);
    expect(schema.properties.reasons.items.enum).toEqual([
      "done",
      "blocked",
      "error",
      "message",
      "timeout",
    ]);
    const commands = schema.properties.commands.properties;
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
      "schema",
    ]) {
      expect(commands[expected]).toBeDefined();
    }
    expect(Object.keys(commands.run?.properties.options.properties ?? {})).toContain("--bg");
    for (const name of Object.keys(commands)) {
      const ref = (commands[name]?.properties.output.$ref ?? "").replace("#/types/", "");
      expect(schema.properties.types.properties[ref]).toBeDefined();
    }
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
      expect(text).toContain("# ag-cli manual");
      expect(text).toContain("ag-cli wait");
      expect(text).toContain("ag-cli read");
    }
  });
});
