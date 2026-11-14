import { utimesSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverDaemon,
  httpHealthzProbe,
  inspectDaemons,
  isPidAlive,
} from "../../src/infra/daemon-discovery";
import { AgCliError } from "../../src/types/protocol";
import { createSandbox, type Sandbox, writeHubFile } from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox();
  active.push(created);
  return created;
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

function alwaysHealthy(): { probe: (port: number) => Promise<boolean>; calls: number[] } {
  const calls: number[] = [];
  return {
    probe: async (port: number) => {
      calls.push(port);
      return true;
    },
    calls,
  };
}

function neverHealthy(): { probe: (port: number) => Promise<boolean>; calls: number[] } {
  const calls: number[] = [];
  return {
    probe: async (port: number) => {
      calls.push(port);
      return false;
    },
    calls,
  };
}

function withModifiedTime(path: string, modifiedAtMs: number): void {
  const when = new Date(modifiedAtMs);
  utimesSync(path, when, when);
}

describe("isPidAlive", () => {
  it("reports the current process as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("reports clearly invalid pids as dead", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it("reports an unused pid as dead", () => {
    expect(isPidAlive(999_999_999)).toBe(false);
  });
});

describe("httpHealthzProbe", () => {
  it("returns true when /healthz responds 200", async () => {
    const probe = async () => new Response('{"status":"ok"}', { status: 200 });
    await expect(httpHealthzProbe(1234, probe as unknown as typeof fetch)).resolves.toBe(true);
  });

  it("returns false on non-200 responses", async () => {
    const probe = async () => new Response("nope", { status: 503 });
    await expect(httpHealthzProbe(1234, probe as unknown as typeof fetch)).resolves.toBe(false);
  });

  it("returns false when the request fails", async () => {
    const probe = async () => {
      throw new Error("connection refused");
    };
    await expect(httpHealthzProbe(1234, probe as unknown as typeof fetch)).resolves.toBe(false);
  });

  it("returns false against a closed local port with the default fetch", async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(httpHealthzProbe(port)).resolves.toBe(false);
  });
});

describe("inspectDaemons", () => {
  it("returns empty when the daemon directory does not exist", async () => {
    const instance = sandbox();
    const emptyRoot = join(instance.root, "missing-antigravity");
    await expect(inspectDaemons(emptyRoot)).resolves.toEqual([]);
  });

  it("parses hub files and checks pid liveness and health", async () => {
    const instance = sandbox();
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: 8123,
      httpsPort: 8124,
      lsVersion: "1.2.3",
      csrfToken: "token-abc",
    });
    const { probe, calls } = alwaysHealthy();

    const candidates = await inspectDaemons(instance.antigravityDir, { probe });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      httpPort: 8123,
      httpsPort: 8124,
      lsVersion: "1.2.3",
      csrfToken: "token-abc",
      pidAlive: true,
      healthz: true,
    });
    expect(candidates[0]?.parseError).toBeUndefined();
    expect(calls).toEqual([8123]);
  });

  it("marks hub files with broken payloads as parse errors", async () => {
    const instance = sandbox();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(instance.daemonDir, "hub_1.json"), "{ not json");
    writeFileSync(
      join(instance.daemonDir, "hub_2.json"),
      JSON.stringify({ pid: 1, httpPort: 2, lsVersion: 5, csrfToken: "t" }),
    );
    writeFileSync(
      join(instance.daemonDir, "hub_4.json"),
      JSON.stringify({ pid: 1, httpPort: 2, lsVersion: "1", csrfToken: 7 }),
    );
    writeFileSync(join(instance.daemonDir, "hub_3.json"), "123");
    writeFileSync(join(instance.daemonDir, "not-a-hub.txt"), "ignore me");

    const { probe, calls } = alwaysHealthy();
    const candidates = await inspectDaemons(instance.antigravityDir, { probe });
    expect(candidates).toHaveLength(4);
    for (const candidate of candidates) {
      expect(candidate.parseError).toBeTruthy();
      expect(candidate.pidAlive).toBe(false);
      expect(candidate.healthz).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("skips the health probe when the pid is dead", async () => {
    const instance = sandbox();
    writeHubFile(instance, {
      pid: 999_999_999,
      httpPort: 8123,
      httpsPort: 8124,
      lsVersion: "1.2.3",
      csrfToken: "token-abc",
    });
    const { probe, calls } = alwaysHealthy();

    const candidates = await inspectDaemons(instance.antigravityDir, { probe });
    expect(candidates[0]?.pidAlive).toBe(false);
    expect(candidates[0]?.healthz).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("defaults httpsPort to 0 and probes /healthz with the default probe when omitted", async () => {
    const instance = sandbox();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(instance.daemonDir, "hub_5300.json"),
      JSON.stringify({
        pid: process.pid,
        httpPort: 1,
        lsVersion: "1.2.3",
        csrfToken: "no-https-port",
      }),
    );

    const candidates = await inspectDaemons(instance.antigravityDir);
    expect(candidates[0]).toMatchObject({
      httpPort: 1,
      httpsPort: 0,
      pidAlive: true,
      healthz: false,
    });
  });
});

describe("discoverDaemon", () => {
  it("selects the newest healthy daemon", async () => {
    const instance = sandbox();
    const oldFile = writeHubFile(instance, {
      pid: process.pid,
      httpPort: 4100,
      httpsPort: 4101,
      lsVersion: "1.0.0",
      csrfToken: "old",
    });
    const newFile = writeHubFile(instance, {
      pid: process.pid,
      httpPort: 4200,
      httpsPort: 4201,
      lsVersion: "1.2.0",
      csrfToken: "new",
    });
    withModifiedTime(oldFile, 1_000_000_000_000);
    withModifiedTime(newFile, 2_000_000_000_000);
    const { probe } = alwaysHealthy();

    const daemon = await discoverDaemon(instance.antigravityDir, { probe });
    expect(daemon.csrfToken).toBe("new");
    expect(daemon.httpPort).toBe(4200);
  });

  it("fails with daemon_unavailable when nothing is healthy", async () => {
    const instance = sandbox();
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: 4100,
      httpsPort: 4101,
      lsVersion: "1.0.0",
      csrfToken: "old",
    });
    const { probe } = neverHealthy();

    await expect(discoverDaemon(instance.antigravityDir, { probe })).rejects.toMatchObject({
      kind: "daemon_unavailable",
      exitCode: 4,
    });
  });

  it("reports dead pids in the daemon_unavailable detail", async () => {
    const instance = sandbox();
    writeHubFile(instance, {
      pid: 999_999_999,
      httpPort: 4100,
      httpsPort: 4101,
      lsVersion: "1.0.0",
      csrfToken: "dead",
    });

    await expect(discoverDaemon(instance.antigravityDir)).rejects.toMatchObject({
      kind: "daemon_unavailable",
      message: expect.stringContaining("dead pid"),
    });
  });

  it("fails with daemon_unavailable when the daemon directory is missing", async () => {
    const instance = sandbox();
    await expect(discoverDaemon(instance.antigravityDir)).rejects.toBeInstanceOf(AgCliError);
  });

  it("breaks ties between equally healthy daemons by port", async () => {
    const instance = sandbox();
    const a = writeHubFile(instance, {
      pid: process.pid,
      httpPort: 4100,
      httpsPort: 4101,
      lsVersion: "1.0.0",
      csrfToken: "a",
    });
    const b = writeHubFile(instance, {
      pid: process.pid,
      httpPort: 4200,
      httpsPort: 4201,
      lsVersion: "1.0.0",
      csrfToken: "b",
    });
    const when = new Date(1_500_000_000_000);
    utimesSync(a, when, when);
    utimesSync(b, when, when);
    const { probe } = alwaysHealthy();

    const daemon = await discoverDaemon(instance.antigravityDir, { probe });
    expect(daemon.httpPort).toBe(4200);
  });
});
