import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listTemplates,
  loadTemplate,
  parseTemplate,
  templatePath,
} from "../../src/domain/template-parser";
import type { AgCliError } from "../../src/types/protocol";
import { createSandbox, type Sandbox } from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("ag-cli-unit-template");
  active.push(created);
  return created;
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

describe("parseTemplate", () => {
  it("parses yaml frontmatter and the markdown preamble", () => {
    const parsed = parseTemplate(
      "---\nname: browser-verifier\ndescription: Run UI verification\nmodel: gemini-3.8-flash-medium\nprofile: verifier\ncwd: /Users/nocoo/workspace/personal/clip\nproject: proj-clip\n---\nYou are a dedicated browser QA verifier.\nDo not modify repository source code.",
    );
    expect(parsed).toEqual({
      name: "browser-verifier",
      description: "Run UI verification",
      model: "gemini-3.8-flash-medium",
      profile: "verifier",
      cwd: "/Users/nocoo/workspace/personal/clip",
      project: "proj-clip",
      preamble: "You are a dedicated browser QA verifier.\nDo not modify repository source code.",
    });
  });

  it("treats a bare document as preamble only", () => {
    const parsed = parseTemplate("Just a preamble.\nNo frontmatter here.");
    expect(parsed).toEqual({ preamble: "Just a preamble.\nNo frontmatter here." });
  });

  it("ignores unknown frontmatter keys", () => {
    const parsed = parseTemplate("---\nmodel: pro\nunknown-key: junk\n---\nBody.");
    expect(parsed).toEqual({ model: "pro", preamble: "Body." });
  });

  it("rejects malformed frontmatter lines", () => {
    expect(() => parseTemplate("---\nmodel: pro\nbroken-line\n---\nBody.")).toThrow();
  });

  it("rejects frontmatter keys with empty values", () => {
    expect(() => parseTemplate("---\nmodel:\n---\nBody.")).toThrow();
  });

  it("parses crlf frontmatter, quoted values, inline comments and block scalars", () => {
    const parsed = parseTemplate(
      [
        "---",
        'name: "browser-verifier"',
        "description: |",
        "  first line",
        "  second line",
        "model: pro # inline comment",
        "---",
        "Body.",
      ].join("\r\n"),
    );
    expect(parsed).toEqual({
      name: "browser-verifier",
      description: "first line\nsecond line",
      model: "pro",
      preamble: "Body.",
    });
  });

  it("parses single-quoted values with escaped apostrophes", () => {
    const parsed = parseTemplate(
      "---\nname: 'it''s a name'\ndescription: \"it's quoted\"\n---\nBody.",
    );
    expect(parsed).toEqual({ name: "it's a name", description: "it's quoted", preamble: "Body." });
  });

  it("skips comment and blank frontmatter lines and folded block scalars", () => {
    const parsed = parseTemplate(
      [
        "---",
        "# a comment",
        "",
        "description: >",
        "  folded one",
        "  folded two",
        "name: folded",
        "---",
        "Body.",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      description: "folded one folded two",
      name: "folded",
      preamble: "Body.",
    });
  });

  it("rejects a bare frontmatter marker", () => {
    expect(() => parseTemplate("---")).toThrow();
  });

  it("rejects non-string values for known fields", () => {
    expect(() => parseTemplate("---\nmodel: 42\n---\nBody.")).toThrow();
    expect(() => parseTemplate("---\nprofile: true\n---\nBody.")).toThrow();
  });

  it("rejects template names that could escape the templates dir", () => {
    const instance = sandbox();
    for (const bad of ["../../outside", "nested/name", "a\b"]) {
      expect(() => templatePath(instance.configDir, bad)).toThrow();
    }
  });
});

describe("real yaml frontmatter parsing (review F17)", () => {
  it("accepts quoted numeric strings as strings", () => {
    expect(parseTemplate('---\nprofile: "42"\n---\nBody.')).toEqual({
      profile: "42",
      preamble: "Body.",
    });
  });

  it("accepts strip block scalars", () => {
    expect(parseTemplate("---\ndescription: |-\n  first\n  second\n---\nBody.")).toEqual({
      description: "first\nsecond",
      preamble: "Body.",
    });
  });

  it("rejects unterminated quotes as invalid yaml", () => {
    expect(() => parseTemplate('---\ndescription: "unterminated\n---\nBody.')).toThrow();
  });

  it("rejects non-string scalars for string fields", () => {
    expect(() => parseTemplate("---\ncwd: [one, two]\n---\nBody.")).toThrow();
    expect(() => parseTemplate("---\nmodel: 42\n---\nBody.")).toThrow();
    expect(() => parseTemplate("---\nname: true\n---\nBody.")).toThrow();
    expect(() => parseTemplate("---\nproject: 123\n---\nBody.")).toThrow();
    expect(() => parseTemplate("---\nprofile: { a: b }\n---\nBody.")).toThrow();
  });

  it("accepts booleans for notify/raw and non-negative integers for timeout", () => {
    expect(parseTemplate("---\nnotify: true\nraw: false\ntimeout: 300\n---\nBody.")).toMatchObject({
      notify: true,
      raw: false,
      timeout: 300,
      preamble: "Body.",
    });
  });

  it("rejects invalid notify/raw/timeout values", () => {
    expect(() => parseTemplate('---\nnotify: "yes"\n---\nB.')).toThrow();
    expect(() => parseTemplate("---\nraw: 1\n---\nB.")).toThrow();
    expect(() => parseTemplate("---\ntimeout: -1\n---\nB.")).toThrow();
    expect(() => parseTemplate("---\ntimeout: 1.5\n---\nB.")).toThrow();
    expect(() => parseTemplate('---\ntimeout: "180"\n---\nB.')).toThrow();
  });
});

describe("loadTemplate", () => {
  it("reads a template from the config templates dir", () => {
    const instance = sandbox();
    mkdirSync(instance.configDir, { recursive: true });
    mkdirSync(join(instance.configDir, "templates"), { recursive: true });
    writeFileSync(
      join(instance.configDir, "templates", "researcher.md"),
      "---\nmodel: flash\ndescription: Research helper\n---\nResearch carefully.",
    );

    const loaded = loadTemplate(instance.configDir, "researcher");
    expect(loaded.template).toMatchObject({ model: "flash", preamble: "Research carefully." });
    expect(loaded.path).toBe(join(instance.configDir, "templates", "researcher.md"));
    expect(templatePath(instance.configDir, "researcher")).toBe(
      join(instance.configDir, "templates", "researcher.md"),
    );
  });

  it("returns an empty list when the templates directory does not exist", () => {
    const instance = sandbox();
    expect(listTemplates(join(instance.root, "missing-config"))).toEqual([]);
  });

  it("skips templates that escape the templates dir via symlink (review F9)", () => {
    const instance = sandbox();
    mkdirSync(join(instance.configDir, "templates"), { recursive: true });
    writeFileSync(
      join(instance.root, "outside.md"),
      "---\ndescription: SYNTHETIC-OUTSIDE\n---\nbody",
    );
    symlinkSync(
      join(instance.root, "outside.md"),
      join(instance.configDir, "templates", "escape.md"),
    );
    writeFileSync(
      join(instance.configDir, "templates", "safe.md"),
      "---\ndescription: safe\n---\nbody",
    );
    expect(listTemplates(instance.configDir).map((entry) => entry.file)).toEqual(["safe"]);
  });

  it("fails with not_found for unknown templates", () => {
    const instance = sandbox();
    try {
      loadTemplate(instance.configDir, "ghost");
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("not_found");
      expect((error as AgCliError).message).toContain("ghost");
    }
  });
});
