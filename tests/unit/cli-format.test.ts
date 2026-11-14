import { describe, expect, it } from "vitest";
import {
  emitError,
  emitJson,
  emitText,
  errorPayload,
  renderTable,
  resolveMode,
} from "../../src/cli/format";
import { AgCliError } from "../../src/types/protocol";

function fakeStream(tty: boolean): {
  chunks: string[];
  isTTY: boolean;
  write(chunk: string): boolean;
} {
  return {
    chunks: [],
    isTTY: tty,
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
  };
}

describe("resolveMode (docs/02 §1.1)", () => {
  it("keeps text on a tty without --json", () => {
    expect(resolveMode({ json: false, tty: true, pipedIsJson: true })).toBe("text");
  });

  it("switches to json when piped for auto-json commands", () => {
    expect(resolveMode({ json: false, tty: false, pipedIsJson: true })).toBe("json");
  });

  it("stays text when piped for run/read style commands", () => {
    expect(resolveMode({ json: false, tty: false, pipedIsJson: false })).toBe("text");
  });

  it("forces json with --json regardless of tty", () => {
    expect(resolveMode({ json: true, tty: true, pipedIsJson: false })).toBe("json");
    expect(resolveMode({ json: true, tty: true, pipedIsJson: true })).toBe("json");
  });
});

describe("emit helpers", () => {
  it("emitJson writes pretty json with a trailing newline", () => {
    const stream = fakeStream(false);
    emitJson(stream, { ok: true });
    expect(stream.chunks).toEqual([`${JSON.stringify({ ok: true }, null, 2)}\n`]);
  });

  it("emitText appends a newline when missing", () => {
    const stream = fakeStream(true);
    emitText(stream, "hello");
    emitText(stream, "already\n");
    expect(stream.chunks).toEqual(["hello\n", "already\n"]);
  });
});

describe("errorPayload", () => {
  it("serializes AgCliError with kind, message and hint", () => {
    const error = new AgCliError("not_found", "conversation c99 not found", {
      hint: "Run ag-cli ls.",
    });
    expect(errorPayload(error)).toEqual({
      error: {
        kind: "not_found",
        message: "conversation c99 not found",
        hint: "Run ag-cli ls.",
      },
    });
  });

  it("wraps unknown errors as runtime_error", () => {
    expect(errorPayload(new Error("boom"))).toEqual({
      error: { kind: "runtime_error", message: "boom" },
    });
    expect(errorPayload("not even an error")).toEqual({
      error: { kind: "runtime_error", message: "not even an error" },
    });
  });
});

describe("emitError", () => {
  it("writes json to the stream in json mode", () => {
    const stream = fakeStream(false);
    emitError(stream, new AgCliError("invalid_usage", "bad flag"), "json");
    expect(stream.chunks).toHaveLength(1);
    expect(JSON.parse(stream.chunks[0] ?? "")).toEqual({
      error: { kind: "invalid_usage", message: "bad flag" },
    });
  });

  it("writes plain text in text mode with hint", () => {
    const stream = fakeStream(true);
    emitError(stream, new AgCliError("not_found", "missing", { hint: "try ls" }), "text");
    expect(stream.chunks.join("")).toContain("missing");
    expect(stream.chunks.join("")).toContain("try ls");
  });

  it("writes plain text without a hint line when the hint is absent", () => {
    const stream = fakeStream(true);
    emitError(stream, new AgCliError("invalid_usage", "bad flag"), "text");
    const text = stream.chunks.join("");
    expect(text).toContain("bad flag");
    expect(text).not.toContain("hint:");
  });
});

describe("renderTable", () => {
  it("renders padded columns separated by two spaces", () => {
    const table = renderTable(
      ["SHORT", "STATUS"],
      [
        ["c1", "done"],
        ["c22", "working"],
      ],
    );
    expect(table).toBe(["SHORT  STATUS", "c1     done", "c22    working"].join("\n"));
  });

  it("handles empty rows", () => {
    expect(renderTable(["A"], [])).toBe("A");
  });

  it("tolerates ragged rows", () => {
    expect(renderTable(["A", "B"], [["x"]])).toBe("A  B\nx");
    expect(renderTable(["A"], [["x", "yy"]])).toBe("A\nx  yy");
  });
});
