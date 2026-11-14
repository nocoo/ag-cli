import { AgCliError } from "../types/protocol";

export interface StreamLike {
  write(chunk: string): boolean;
  isTTY?: boolean;
}

export type OutputMode = "text" | "json";

export function resolveMode(options: {
  json: boolean;
  tty: boolean;
  pipedIsJson: boolean;
}): OutputMode {
  if (options.json) {
    return "json";
  }
  return options.tty || !options.pipedIsJson ? "text" : "json";
}

export function emitJson(stream: StreamLike, payload: unknown): void {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function emitText(stream: StreamLike, text: string): void {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function errorPayload(error: unknown): {
  error: { kind: string; message: string; hint?: string };
} {
  if (error instanceof AgCliError) {
    return {
      error: {
        kind: error.kind,
        message: error.message,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { error: { kind: "runtime_error", message } };
}

export function emitError(stream: StreamLike, error: unknown, mode: OutputMode): void {
  if (mode === "json") {
    emitJson(stream, errorPayload(error));
    return;
  }
  const payload = errorPayload(error).error;
  emitText(stream, `ag-cli: ${payload.message}`);
  if (payload.hint !== undefined) {
    emitText(stream, `hint: ${payload.hint}`);
  }
}

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [render(headers), ...rows.map(render)].join("\n");
}
