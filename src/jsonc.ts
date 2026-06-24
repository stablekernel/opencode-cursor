/**
 * JSONC (JSON with Comments) helpers.
 *
 * These functions are also inlined verbatim (as plain JS) into install.sh so
 * that the installer remains a self-contained bash script with no runtime
 * dependencies beyond Node. Keep the two copies in sync when changing this
 * file.
 *
 * Tests live in test/jsonc.test.ts.
 */

/** Result of scanning a JSONC string: comment-stripped text plus index map. */
export interface ScanResult {
  /** Comment-stripped output (string literals preserved, comments removed). */
  out: string;
  /** map[i] is the index in the original raw string that produced out[i]. */
  map: number[];
}

/**
 * Strip line comments and block comments from a JSONC string while preserving
 * string literals verbatim. Returns the stripped text and a map from
 * stripped-index back to raw-index so callers can locate and edit the original
 * text in place.
 */
export function scan(s: string): ScanResult {
  let out = "",
    map: number[] = [],
    inStr = false,
    i = 0;
  while (i < s.length) {
    const ch = s[i],
      nx = s[i + 1];
    if (inStr) {
      out += ch;
      map.push(i);
      if (ch === "\\") {
        out += s[i + 1] || "";
        map.push(i + 1);
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      map.push(i);
      i++;
      continue;
    }
    if (ch === "/" && nx === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && nx === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    map.push(i);
    i++;
  }
  return { out, map };
}

/**
 * Remove trailing commas from a comment-stripped JSONC string so that
 * `JSON.parse` accepts it. Tracks string context to avoid removing commas
 * that are part of a string value.
 *
 * A trailing comma is a `,` whose next non-whitespace character is `}` or `]`.
 */
export function removeTrailingCommas(s: string): string {
  let result = "",
    inStr = false,
    i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inStr) {
      result += ch;
      if (ch === "\\") {
        result += s[i + 1] || "";
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      result += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (
        j < s.length &&
        (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")
      )
        j++;
      if (j < s.length && (s[j] === "}" || s[j] === "]")) {
        i++;
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}
