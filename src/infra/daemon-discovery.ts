import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { AgCliError } from "../types/protocol";

export interface DaemonCandidate {
  hubFile: string;
  modifiedAtMs: number;
  pid: number;
  httpPort: number;
  httpsPort: number;
  lsVersion: string;
  csrfToken: string;
  pidAlive: boolean;
  healthz: boolean;
  parseError?: string;
}

export type HealthProbe = (port: number) => Promise<boolean>;

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function httpHealthzProbe(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolveOnce) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      resolveOnce(value);
    };
    try {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/healthz",
          method: "GET",
          headers: { accept: "application/json" },
        },
        (response) => {
          let ended = false;
          response.on("data", () => {});
          response.on("end", () => {
            ended = true;
            settle(response.statusCode === 200);
          });
          response.on("aborted", () => settle(false));
          response.on("error", () => settle(false));
          response.on("close", () => {
            if (!ended) {
              settle(false);
            }
          });
        },
      );
      deadlineTimer = setTimeout(() => {
        req.destroy();
        settle(false);
      }, timeoutMs);
      req.on("error", () => settle(false));
      req.end();
    } catch {
      settle(false);
    }
  });
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asPort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : undefined;
}

type ParsedHub = { ok: true; candidate: DaemonCandidate } | { ok: false; error: string };

function parseHubFile(hubFile: string): ParsedHub {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(hubFile, "utf8"));
  } catch {
    return { ok: false, error: "invalid json" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "hub payload is not an object" };
  }
  const hub = raw as Record<string, unknown>;
  const pid = asPositiveInt(hub.pid);
  const httpPort = asPort(hub.httpPort);
  const lsVersion = typeof hub.lsVersion === "string" ? hub.lsVersion : undefined;
  const csrfToken = typeof hub.csrfToken === "string" ? hub.csrfToken : undefined;
  if (
    pid === undefined ||
    httpPort === undefined ||
    lsVersion === undefined ||
    csrfToken === undefined
  ) {
    return { ok: false, error: "hub payload is missing required fields" };
  }
  const httpsPort = asPort(hub.httpsPort) ?? 0;
  return {
    ok: true,
    candidate: {
      hubFile,
      modifiedAtMs: statSync(hubFile).mtimeMs,
      pid,
      httpPort,
      httpsPort,
      lsVersion,
      csrfToken,
      pidAlive: false,
      healthz: false,
    },
  };
}

export async function inspectDaemons(
  antigravityDir: string,
  options: { probe?: HealthProbe } = {},
): Promise<DaemonCandidate[]> {
  const probe = options.probe ?? ((port: number) => httpHealthzProbe(port));
  const daemonDir = join(antigravityDir, "daemon");
  if (!existsSync(daemonDir)) {
    return [];
  }

  const candidates: DaemonCandidate[] = [];
  for (const entry of readdirSync(daemonDir)) {
    if (!/^hub_.+\.json$/.test(entry)) {
      continue;
    }
    const hubFile = join(daemonDir, entry);
    const parsed = parseHubFile(hubFile);
    if (!parsed.ok) {
      candidates.push({
        hubFile,
        modifiedAtMs: statSync(hubFile).mtimeMs,
        pid: 0,
        httpPort: 0,
        httpsPort: 0,
        lsVersion: "",
        csrfToken: "",
        pidAlive: false,
        healthz: false,
        parseError: parsed.error,
      });
      continue;
    }
    candidates.push(parsed.candidate);
  }

  for (const candidate of candidates) {
    if (candidate.parseError !== undefined) {
      continue;
    }
    candidate.pidAlive = isPidAlive(candidate.pid);
    candidate.healthz = candidate.pidAlive ? await probe(candidate.httpPort) : false;
  }

  candidates.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs || b.httpPort - a.httpPort);
  return candidates;
}

export async function discoverDaemon(
  antigravityDir: string,
  options: { probe?: HealthProbe } = {},
): Promise<DaemonCandidate> {
  const candidates = await inspectDaemons(antigravityDir, options);
  const healthy = candidates.filter(
    (candidate) => candidate.parseError === undefined && candidate.pidAlive && candidate.healthz,
  );
  if (healthy.length === 0) {
    const reasons = candidates.map(
      (candidate) =>
        `${candidate.hubFile}: ${candidate.parseError ?? (candidate.pidAlive ? "unreachable /healthz" : "dead pid")}`,
    );
    const detail = reasons.length > 0 ? ` Checked: ${reasons.join("; ")}.` : "";
    throw new AgCliError(
      "daemon_unavailable",
      `no healthy Antigravity language_server daemon found.${detail}`,
      {
        hint: "Start the Antigravity IDE or language_server, then retry.",
      },
    );
  }
  return healthy[0] as DaemonCandidate;
}
