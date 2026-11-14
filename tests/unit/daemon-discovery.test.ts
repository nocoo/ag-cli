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
import { NullgError } from "../../src/types/protocol";
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
  it("returns true when /healthz responds 200 over node:http", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    await expect(httpHealthzProbe(port)).resolves.toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns false on non-200 responses", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503);
      res.end("nope");
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    await expect(httpHealthzProbe(port)).resolves.toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns false against a closed local port", async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(httpHealthzProbe(port)).resolves.toBe(false);
  });

  it("returns false when the server accepts the socket then destroys it without a response", async () => {
    const server = createServer((_req, res) => {
      res.socket?.destroy();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    await expect(httpHealthzProbe(port)).resolves.toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns false when the body is aborted mid-stream (review R3 #11)", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("partial");
      setTimeout(() => res.destroy(), 20);
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const started = Date.now();
    await expect(httpHealthzProbe(port, 500)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns false when the server hangs and the hard deadline fires (review P3-32)", async () => {
    const server = createServer(() => {});
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const started = Date.now();
    await expect(httpHealthzProbe(port, 300)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 10_000);

  it("returns false for out-of-range and malformed ports without throwing (review R3 #11)", async () => {
    for (const bad of [65536, 65537, -1, 1.5]) {
      await expect(httpHealthzProbe(bad as number, 100)).resolves.toBe(false);
    }
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

  it("marks out-of-range hub ports as parse errors so healthy daemons still win (review R3 #11)", async () => {
    const instance = sandbox();
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: 65536,
      httpsPort: 0,
      lsVersion: "bad",
      csrfToken: "token-bad",
    });
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: 8125,
      httpsPort: 0,
      lsVersion: "good",
      csrfToken: "token-good",
    });
    const { probe } = alwaysHealthy();

    const candidates = await inspectDaemons(instance.antigravityDir, { probe });
    const broken = candidates.find((candidate) => candidate.hubFile.includes("65536"));
    const healthy = candidates.find((candidate) => candidate.lsVersion === "good");
    expect(broken?.parseError).toBeDefined();
    expect(broken?.pidAlive).toBe(false);
    expect(healthy?.parseError).toBeUndefined();
    await expect(discoverDaemon(instance.antigravityDir, { probe })).resolves.toMatchObject({
      lsVersion: "good",
    });
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
    await expect(discoverDaemon(instance.antigravityDir)).rejects.toBeInstanceOf(NullgError);
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
