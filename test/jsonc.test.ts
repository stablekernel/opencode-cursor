import { describe, expect, it } from "vitest";
import { removeTrailingCommas, scan } from "../src/jsonc.js";

// ---------------------------------------------------------------------------
// removeTrailingCommas
// ---------------------------------------------------------------------------

describe("removeTrailingCommas", () => {
  // --- basic cases -----------------------------------------------------------

  it("removes a trailing comma from a flat array", () => {
    const result = removeTrailingCommas('["a", "b", "c",]');
    expect(JSON.parse(result)).toEqual(["a", "b", "c"]);
  });

  it("removes a trailing comma from a flat object", () => {
    const result = removeTrailingCommas('{"x": 1, "y": 2,}');
    expect(JSON.parse(result)).toEqual({ x: 1, y: 2 });
  });

  it("removes trailing commas from both arrays and objects in one pass", () => {
    const input = '{"arr": [1, 2, 3,], "obj": {"a": true,},}';
    const result = removeTrailingCommas(input);
    expect(JSON.parse(result)).toEqual({ arr: [1, 2, 3], obj: { a: true } });
  });

  it("handles trailing comma with spaces before the closing bracket", () => {
    expect(JSON.parse(removeTrailingCommas('["a", "b",  ]'))).toEqual([
      "a",
      "b",
    ]);
  });

  it("handles trailing comma with a newline before the closing bracket", () => {
    const input = `{
  "key": "value",
}`;
    expect(JSON.parse(removeTrailingCommas(input))).toEqual({ key: "value" });
  });

  it("handles trailing comma with mixed whitespace before the closing bracket", () => {
    const input = '["x",\t\n  ]';
    expect(JSON.parse(removeTrailingCommas(input))).toEqual(["x"]);
  });

  // --- already-valid JSON must pass through unchanged -----------------------

  it("leaves already-valid JSON untouched", () => {
    const valid = '{"plugin": ["@stablekernel/opencode-cursor@latest"]}';
    expect(removeTrailingCommas(valid)).toBe(valid);
  });

  it("leaves an empty array untouched", () => {
    expect(removeTrailingCommas("[]")).toBe("[]");
  });

  it("leaves an empty object untouched", () => {
    expect(removeTrailingCommas("{}")).toBe("{}");
  });

  it("leaves a nested structure with no trailing commas untouched", () => {
    const valid = '{"a": [1, 2], "b": {"c": null}}';
    expect(removeTrailingCommas(valid)).toBe(valid);
  });

  // --- string values that contain comma + bracket must NOT be changed -------

  it("does not remove a comma that is inside a string value", () => {
    // The comma here is part of the string literal, not a trailing comma.
    const input = '{"key": "trailing,"}';
    expect(JSON.parse(removeTrailingCommas(input))).toEqual({
      key: "trailing,",
    });
    // The raw text must be identical — nothing was removed.
    expect(removeTrailingCommas(input)).toBe(input);
  });

  it("does not remove a comma followed by ] that is inside a string", () => {
    // ",]" appears inside the string — must be preserved.
    const input = '{"key": ",]"}';
    expect(JSON.parse(removeTrailingCommas(input))).toEqual({ key: ",]" });
    expect(removeTrailingCommas(input)).toBe(input);
  });

  it("does not remove a comma followed by } that is inside a string", () => {
    const input = '{"key": ",}"}';
    expect(JSON.parse(removeTrailingCommas(input))).toEqual({ key: ",}" });
    expect(removeTrailingCommas(input)).toBe(input);
  });

  it("handles an escaped quote inside a string without confusing string-context tracking", () => {
    // The \" inside the string must not end string context prematurely.
    const input = '{"msg": "say \\"hi,\\"",}';
    const result = removeTrailingCommas(input);
    expect(JSON.parse(result)).toEqual({ msg: 'say "hi,"' });
  });

  // --- deeply nested --------------------------------------------------------

  it("removes trailing commas at every nesting level", () => {
    const input = `{
  "models": [
    "cursor/gpt-4o",
    "cursor/claude-3-5-sonnet",
  ],
  "settings": {
    "theme": "dark",
    "fontSize": 14,
  },
}`;
    const parsed = JSON.parse(removeTrailingCommas(input));
    expect(parsed).toEqual({
      models: ["cursor/gpt-4o", "cursor/claude-3-5-sonnet"],
      settings: { theme: "dark", fontSize: 14 },
    });
  });
});

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

describe("scan", () => {
  it("passes plain JSON through unchanged", () => {
    const s = '{"a": 1}';
    expect(scan(s).out).toBe(s);
  });

  it("removes a single-line comment", () => {
    const s = '{"a": 1} // comment';
    expect(scan(s).out).toBe('{"a": 1} ');
  });

  it("removes a single-line comment on its own line", () => {
    const s = '// top-level comment\n{"a": 1}';
    expect(scan(s).out).toBe('\n{"a": 1}');
  });

  it("removes a block comment", () => {
    const s = '{"a": /* inline */ 1}';
    expect(scan(s).out).toBe('{"a":  1}');
  });

  it("preserves // inside a string literal", () => {
    const s = '{"url": "https://example.com"}';
    expect(scan(s).out).toBe(s);
  });

  it("preserves /* */ inside a string literal", () => {
    const s = '{"k": "/* not a comment */"}';
    expect(scan(s).out).toBe(s);
  });

  it("strips a multi-line block comment spanning multiple lines", () => {
    const s = `{
  /* this is a
     block comment */
  "a": 1
}`;
    const stripped = scan(s).out;
    expect(JSON.parse(stripped)).toEqual({ a: 1 });
  });

  it("produces a map with the same length as the output", () => {
    const s = '{"a": 1} // tail';
    const { out, map } = scan(s);
    expect(map).toHaveLength(out.length);
  });

  it("map entries point to the correct raw indices", () => {
    // After stripping "// tail", the last non-whitespace output char is '}'.
    // In the raw string that's index 7.
    const s = '{"a": 1} // tail';
    const { out, map } = scan(s);
    const closingBrace = out.indexOf("}");
    expect(s[map[closingBrace]]).toBe("}");
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: scan → removeTrailingCommas → JSON.parse
// This mirrors what install.sh does when processing a real opencode.jsonc.
// ---------------------------------------------------------------------------

describe("scan + removeTrailingCommas pipeline", () => {
  it("parses a realistic opencode.jsonc with comments and trailing commas", () => {
    const jsonc = `{
  // opencode configuration
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    // cursor provider plugin
    "@stablekernel/opencode-cursor@latest",
  ],
  "model": "cursor/claude-3-5-sonnet", /* default model */
}`;
    const { out } = scan(jsonc);
    const parsed = JSON.parse(removeTrailingCommas(out));
    expect(parsed).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugin: ["@stablekernel/opencode-cursor@latest"],
      model: "cursor/claude-3-5-sonnet",
    });
  });

  it("parses JSONC where a string value contains comment-like text", () => {
    const jsonc = `{
  "note": "see https://example.com/docs /* not a comment */",
  "value": 42, // trailing comma here
}`;
    const { out } = scan(jsonc);
    const parsed = JSON.parse(removeTrailingCommas(out));
    expect(parsed).toEqual({
      note: "see https://example.com/docs /* not a comment */",
      value: 42,
    });
  });

  it("reproduces the exact error case from the bug report: trailing comma after last array element", () => {
    // Simulates the auto-generated opencode.jsonc that caused the install failure.
    const jsonc = `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "atest",
  ],
  "agen": {}
}`;
    const { out } = scan(jsonc);
    const parsed = JSON.parse(removeTrailingCommas(out));
    expect(parsed.plugin).toEqual(["atest"]);
  });
});
