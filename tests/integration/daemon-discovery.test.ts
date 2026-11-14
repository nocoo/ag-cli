import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverDaemon, inspectDaemons } from "../../src/infra/daemon-discovery";
import {
  createSandbox,
  type Sandbox,
  startMockLanguageServer,
  writeHubFile,
} from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("ag-cli-int-daemon");
  active.push(created);
  return created;
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

describe("discoverDaemon against a real node:http mock language_server", () => {
  it("discovers a live daemon through a real /healthz probe", async () => {
    const instance = sandbox();
    const mock = await startMockLanguageServer();
    try {
      writeHubFile(instance, {
        pid: process.pid,
        httpPort: mock.port,
        httpsPort: mock.port + 1,
        lsVersion: "9.9.9",
        csrfToken: mock.csrfToken,
      });

      const daemon = await discoverDaemon(instance.antigravityDir);
      expect(daemon).toMatchObject({
        pid: process.pid,
        httpPort: mock.port,
        lsVersion: "9.9.9",
        csrfToken: mock.csrfToken,
        pidAlive: true,
        healthz: true,
      });
      expect(mock.requests.map((entry) => entry.url)).toContain("/healthz");
    } finally {
      await mock.close();
    }
  });

  it("rejects a hub file whose port has nothing listening", async () => {
    const instance = sandbox();
    const mock = await startMockLanguageServer();
    try {
      const stalePort = mock.port;
      await mock.close();
      writeHubFile(instance, {
        pid: process.pid,
        httpPort: stalePort,
        httpsPort: stalePort + 1,
        lsVersion: "9.9.9",
        csrfToken: mock.csrfToken,
      });

      await expect(discoverDaemon(instance.antigravityDir)).rejects.toMatchObject({
        kind: "daemon_unavailable",
      });
    } finally {
      await mock.close();
    }
  });

  it("reports each hub file reason when nothing is healthy", async () => {
    const instance = sandbox();
    writeHubFile(instance, {
      pid: 999_999_999,
      httpPort: 4100,
      httpsPort: 4101,
      lsVersion: "1.0.0",
      csrfToken: "dead-pid",
    });
    writeFileSync(join(instance.daemonDir, "hub_broken.json"), "{ nope");

    const candidates = (await inspectDaemons(instance.antigravityDir)) as Array<{
      pidAlive: boolean;
      healthz: boolean;
      parseError?: string;
    }>;
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => !candidate.pidAlive && !candidate.healthz)).toBe(true);
    expect(candidates.some((candidate) => candidate.parseError !== undefined)).toBe(true);

    await expect(discoverDaemon(instance.antigravityDir)).rejects.toMatchObject({
      kind: "daemon_unavailable",
    });
  });
});
