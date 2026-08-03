/**
 * Generate `src/model-limits.ts` from Cursor's published docs.
 *
 * opencode computes cost as `tokens x model.cost`, so a static rate card is
 * structurally required — no provider channel can inject a dollar amount. This
 * script keeps that rate card from being hand-written: it reads Cursor's own
 * markdown docs, matches their display names against our supported model ids,
 * and emits the two generated maps.
 *
 * This module is import-pure: it never runs `main()` as a side effect. The CLI
 * lives in `scripts/sync-model-limits-cli.mjs`, which calls `main()`
 * unconditionally. That split is deliberate — a "am I the entry point?" guard
 * comparing `process.argv[1]` against `import.meta.url` is fail-open: any
 * invocation where the two differ makes `main()` never run and the process exit
 * 0 having done nothing, which is a permanently green, permanently useless
 * drift job. That already happened once (a symlinked path).
 *
 * Modes:
 *   (default)  fetch docs, write `src/model-limits.ts`
 *   --check    fetch docs, regenerate in memory, compare against the committed
 *              file without writing
 *
 * Exit codes (CI depends on these):
 *   0  no drift
 *   1  drift detected (committed file differs from generated)
 *   2  network, parse, or write failure — docs unreachable, table/columns
 *      missing, a row missing a requested column, an unparseable cell, a
 *      MODEL_IDS entry unmatched with no override, an ambiguous match, or the
 *      output file could not be written
 *
 * Node 22 built-ins only. No dependencies.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(HERE, "..", "src", "model-limits.ts");

/**
 * The two docs pages, both in their `.md` form.
 *
 * Cursor's docs site content-negotiates. Measured against both URL shapes:
 * with the markdown-preferring Accept header `fetchDoc` sends, the `.md` and
 * extensionless forms both return the same markdown. With a default wildcard
 * Accept header, only the `.md` form does — the extensionless form returns the
 * ~110KB HTML page instead, which carries no pipe table.
 *
 * The `.md` form is therefore the more robust choice: it does not depend on the
 * Accept header staying markdown-preferring. Keep both URLs on `.md`.
 *
 * A non-2xx response, or a page that stops carrying the expected columns,
 * exits 2 — so if Cursor moves either page it surfaces rather than going quiet.
 */
export const SOURCES = {
  context: "https://cursor.com/docs/account/pricing/request-based-legacy.md",
  pricing: "https://cursor.com/docs/models-and-pricing.md",
};

/**
 * The Cursor model ids we support — the single source of truth for coverage.
 * Taken from Cursor's live model catalog. An id here that the docs do not list
 * must have an OVERRIDES entry; otherwise this script exits 2 rather than
 * emitting a silent default.
 */
export const MODEL_IDS = [
  "auto-smart",
  "claude-fable-5",
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "composer-2",
  "composer-2.5",
  "default",
  "gemini-2.5-flash",
  "gemini-3-flash",
  "gemini-3.1-pro",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "glm-5.2",
  "gpt-5-mini",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "grok-4.5",
];

const POOL_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Ids the docs cannot supply, with the reason. `context` and `cost` are
 * independent: a model can appear in the context table but not the pricing
 * one, because the pricing doc is the "Other Models" table and Cursor Models
 * pool models are priced by pool rather than per token.
 */
export const OVERRIDES = {
  "auto-smart": {
    context: 200_000,
    cost: POOL_COST,
    why: 'docs row is "Auto Cost", which lists "-" for context; Cursor Models pool, so no per-token charge',
  },
  default: {
    context: 200_000,
    cost: POOL_COST,
    why: 'the "Auto" catalog id; same docs row as auto-smart, same pool pricing',
  },
  "composer-2": {
    context: 200_000,
    cost: POOL_COST,
    why: 'docs list "Composer 1" and "Composer 2.5", never "Composer 2"; Cursor Models pool',
  },
  "gpt-5.1": {
    context: 272_000,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    why: "docs list only GPT-5.1 Codex / Codex Max / Codex Mini, never bare 5.1; values follow GPT-5.1 Codex",
  },
  "grok-4.5": {
    cost: POOL_COST,
    why: 'absent from models-and-pricing.md ("Other Models" table); Cursor Models pool, so no per-token charge',
  },
  "composer-2.5": {
    cost: POOL_COST,
    why: 'absent from models-and-pricing.md ("Other Models" table); Cursor Models pool, so no per-token charge',
  },
};

/** Column that holds the model display name in both docs tables. */
const NAME_COLUMN = "Model";

/** Column that holds the vendor in both docs tables. */
const PROVIDER_COLUMN = "Provider";

/** Vendor/pricing words that appear on one side of a match but not the other. */
const NOISE_TOKENS = new Set(["claude", "gpt", "cursor", "cost"]);

/**
 * Vendor identity for the vendor words {@link NOISE_TOKENS} drops, mapped to
 * the `Provider` cell that must accompany them.
 *
 * Dropping `claude`/`gpt` is what lets `claude-sonnet-4-6` match "Claude 4.6
 * Sonnet", but it also discards vendor identity: a surviving row from a
 * different vendor whose remaining tokens coincide would be a wrong-but-
 * confident match (e.g. the id `gpt-5.5` against a hypothetical Anthropic row
 * "Claude 5.5", both reducing to `{5.5}`). Re-checking the `Provider` column
 * puts the discarded identity back.
 *
 * Only the dropped words need an entry. `gemini`, `grok`, `glm`, `composer`,
 * and `kimi` are not noise tokens, so their vendor identity already survives
 * inside the compared token set.
 */
const PROVIDER_BY_VENDOR_TOKEN = new Map([
  ["claude", "anthropic"],
  ["gpt", "openai"],
]);

/** A cell that is nothing but a markdown link, e.g. `[Claude Opus 4.8](url)`. */
const WHOLE_CELL_LINK = /^\[([^\]]+)\]\([^)]*\)$/;

function splitRow(line) {
  const trimmed = line.trim();
  return trimmed
    .slice(1, trimmed.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => {
      const value = cell.trim();
      // Unwrap link cells (the Model column is usually a link) but leave cells
      // that merely contain a link — notably Notes — untouched.
      const link = WHOLE_CELL_LINK.exec(value);
      return link ? link[1].trim() : value;
    });
}

const SEPARATOR_ROW = /^\|[\s:|-]+\|$/;

/**
 * Parse the first GFM table in `md` that carries every column in
 * `columnNames`. Selecting by column rather than by position matters: the
 * pricing doc ships an unrelated Plan/Price table alongside the model table.
 *
 * @param {string} md
 * @param {string[]} columnNames
 * @returns {Array<Record<string, string>>}
 */
export function parseDocsTable(md, columnNames) {
  const lines = md.split("\n");
  const seenHeaders = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!SEPARATOR_ROW.test(line)) continue;
    const previous = lines[i - 1].trim();
    if (!previous.startsWith("|")) continue;
    const header = splitRow(previous);
    seenHeaders.push(header.join(" | "));
    if (!columnNames.every((name) => header.includes(name))) continue;

    const rows = [];
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j].trim();
      if (!raw.startsWith("|")) break;
      const cells = splitRow(raw);
      const row = {};
      // An absent cell (row shorter than the header) is left unset rather than
      // defaulted to "". Conflating the two is how a missing price column
      // becomes a silent $0: `parsePrice("")` used to answer 0.
      for (const [index, name] of header.entries()) {
        if (index < cells.length) row[name] = cells[index];
      }
      for (const name of columnNames) {
        if (row[name] === undefined) {
          throw new Error(
            `row ${JSON.stringify(row[NAME_COLUMN] ?? raw.slice(0, 60))} is missing the requested ` +
              `column "${name}" (${cells.length} cells for ${header.length} headers)`,
          );
        }
      }
      rows.push(row);
    }
    if (rows.length === 0) {
      throw new Error(`table with columns [${columnNames.join(", ")}] has no data rows`);
    }
    return rows;
  }
  throw new Error(
    `no table carries every column [${columnNames.join(", ")}]. Tables found: ${
      seenHeaders.length ? seenHeaders.map((h) => `<${h}>`).join("; ") : "none"
    }`,
  );
}

/**
 * `"200k"` -> `200000`, `"1M"` -> `1000000`, `"-"` -> `undefined`.
 * Throws on anything else so an unexpected docs format exits 2.
 *
 * @param {string} text
 * @returns {number | undefined}
 */
export function parseTokens(text) {
  const value = String(text ?? "").trim();
  if (value === "" || value === "-") return undefined;
  const match = /^([\d,]+(?:\.\d+)?)\s*([kKmM])?$/.exec(value);
  if (!match) throw new Error(`cannot parse a token count from ${JSON.stringify(text)}`);
  const amount = Number(match[1].replace(/,/g, ""));
  const scale = match[2]?.toLowerCase() === "k" ? 1_000 : match[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
  return amount * scale;
}

/**
 * `"$3"` -> `3`, `"$0.30"` -> `0.3`, `"-"` -> `0`.
 * Throws on anything else so an unexpected docs format exits 2.
 *
 * `"-"` is Cursor's documented "not applicable" and is a real $0. An empty cell
 * is not: it carries no statement about price, and answering 0 for it would
 * emit a silently wrong rate card entry for a model that matched. So it throws.
 *
 * @param {string} text
 * @returns {number}
 */
export function parsePrice(text) {
  const value = String(text ?? "").trim();
  if (value === "-") return 0;
  if (value === "") {
    throw new Error(`empty price cell: expected a dollar amount, or "-" for not applicable`);
  }
  const match = /^\$?([\d,]+(?:\.\d+)?)$/.exec(value);
  if (!match) throw new Error(`cannot parse a price from ${JSON.stringify(text)}`);
  return Number(match[1].replace(/,/g, ""));
}

/**
 * Reduce a model id or a docs display name to a comparable token set.
 * Cursor's ids and its docs names disagree on word order and on vendor
 * prefixes (`claude-sonnet-4-6` vs "Claude 4.6 Sonnet"; "Claude Opus 4.8"
 * flips it back), so compare as sets. Adjacent bare numbers are joined so the
 * id's `4-6` lines up with the docs' `4.6`.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenSet(text) {
  const parts = String(text).toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  const merged = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    if (/^\d+$/.test(part) && previous !== undefined && /^[\d.]+$/.test(previous)) {
      merged[merged.length - 1] = `${previous}.${part}`;
    } else {
      merged.push(part);
    }
  }
  return new Set(merged.filter((token) => !NOISE_TOKENS.has(token)));
}

function sameTokens(a, b) {
  if (a.size !== b.size) return false;
  for (const token of a) if (!b.has(token)) return false;
  return true;
}

/**
 * The `Provider` cell a row must carry for `id`, or `undefined` when `id`
 * names no vendor whose identity {@link tokenSet} discards.
 *
 * @param {string} id
 * @returns {string | undefined}
 */
function requiredProvider(id) {
  for (const part of String(id).toLowerCase().split(/[^a-z0-9.]+/)) {
    const provider = PROVIDER_BY_VENDOR_TOKEN.get(part);
    if (provider !== undefined) return provider;
  }
  return undefined;
}

/**
 * Find the single docs row whose display name describes `id`. Exact set
 * equality only — a near miss like "Composer 2.5" must not satisfy
 * "composer-2" — plus a `Provider` check for vendors the token set drops.
 *
 * The provider check is strict, not best-effort: an id naming a dropped vendor
 * matches only a row whose `Provider` cell says so. A row with a blank or
 * absent `Provider` therefore does not match such an id, which is the honest
 * outcome — the alternative is matching on the same evidence that was just
 * found insufficient.
 *
 * @param {string} id
 * @param {Array<Record<string, string>>} docRows
 * @returns {{ row: Record<string, string>, ambiguous?: never } | { row?: never, ambiguous: string[] } | undefined}
 */
export function matchModelId(id, docRows) {
  const wanted = tokenSet(id);
  const provider = requiredProvider(id);
  const hits = docRows.filter((row) => {
    if (!sameTokens(wanted, tokenSet(row[NAME_COLUMN] ?? ""))) return false;
    if (provider === undefined) return true;
    return (row[PROVIDER_COLUMN] ?? "").trim().toLowerCase() === provider;
  });
  if (hits.length === 1) return { row: hits[0] };
  if (hits.length > 1) return { ambiguous: hits.map((row) => row[NAME_COLUMN] ?? "") };
  return undefined;
}

function formatTokens(value) {
  return value.toLocaleString("en-US").replace(/,/g, "_");
}

function formatCost(cost) {
  return `{ input: ${cost.input}, output: ${cost.output}, cacheRead: ${cost.cacheRead}, cacheWrite: ${cost.cacheWrite} }`;
}

/** Placeholder the generated date line is normalized to before any comparison. */
const SYNC_DATE_LINE = /^ \* Data last changed: .*$/m;
const SYNC_DATE_PLACEHOLDER = " * Data last changed: <ignored for comparison>";

/**
 * Strip the date line so `--check` reports data drift, not the passage of
 * time. Write mode uses the same normalization to leave the committed date
 * alone when nothing else moved.
 *
 * @param {string} text
 */
export function normalizeForComparison(text) {
  return text.replace(SYNC_DATE_LINE, SYNC_DATE_PLACEHOLDER);
}

/**
 * Resolve every id in `modelIds` against the two docs tables and emit the full
 * text of `src/model-limits.ts`.
 *
 * `modelIds` and `overrides` are injectable so the contracts this function
 * holds — strict overrides, ambiguity, docs-over-override precedence, sorted
 * output — can be exercised against small fixtures instead of only against the
 * live 33-id catalog.
 *
 * @param {{
 *   contextMd: string,
 *   pricingMd: string,
 *   modelIds?: readonly string[],
 *   overrides?: Record<string, { context?: number, cost?: { input: number, output: number, cacheRead: number, cacheWrite: number }, why?: string }>,
 *   date?: string,
 * }} input
 * @returns {{ text: string, stats: { context: { matched: number, overridden: number }, cost: { matched: number, overridden: number } } }}
 */
export function generate({
  contextMd,
  pricingMd,
  modelIds = MODEL_IDS,
  overrides = OVERRIDES,
  date = new Date().toISOString().slice(0, 10),
}) {
  const contextRows = parseDocsTable(contextMd, [NAME_COLUMN, "Default context"]);
  const priceRows = parseDocsTable(pricingMd, [NAME_COLUMN, "Input", "Cache write", "Cache read", "Output"]);

  const stats = {
    context: { matched: 0, overridden: 0 },
    cost: { matched: 0, overridden: 0 },
  };
  const contextLimits = [];
  const costs = [];

  for (const id of [...modelIds].sort()) {
    const override = overrides[id];

    const contextHit = matchModelId(id, contextRows);
    if (contextHit && "ambiguous" in contextHit) {
      throw new Error(`${id}: ambiguous context match against [${contextHit.ambiguous.join(", ")}]`);
    }
    // "Default context", never "Max context": Max context requires Max Mode,
    // which the plugin cannot detect.
    const docContext = contextHit?.row ? parseTokens(contextHit.row["Default context"]) : undefined;
    let context;
    if (docContext !== undefined) {
      context = docContext;
      stats.context.matched += 1;
    } else if (override?.context !== undefined) {
      context = override.context;
      stats.context.overridden += 1;
    } else {
      throw new Error(
        `${id}: no "Default context" in ${SOURCES.context} and no OVERRIDES entry. ` +
          `Add an override with a reason, or drop the id from MODEL_IDS.`,
      );
    }
    contextLimits.push(`  ${JSON.stringify(id)}: ${formatTokens(context)},`);

    const priceHit = matchModelId(id, priceRows);
    if (priceHit && "ambiguous" in priceHit) {
      throw new Error(`${id}: ambiguous pricing match against [${priceHit.ambiguous.join(", ")}]`);
    }
    let cost;
    if (priceHit?.row) {
      // Structured columns only. The Notes cell is never parsed — see the
      // generated file's header for why.
      cost = {
        input: parsePrice(priceHit.row["Input"]),
        output: parsePrice(priceHit.row["Output"]),
        cacheRead: parsePrice(priceHit.row["Cache read"]),
        cacheWrite: parsePrice(priceHit.row["Cache write"]),
      };
      stats.cost.matched += 1;
    } else if (override?.cost !== undefined) {
      cost = override.cost;
      stats.cost.overridden += 1;
    } else {
      throw new Error(
        `${id}: no pricing row in ${SOURCES.pricing} and no OVERRIDES entry. ` +
          `Add an override with a reason, or drop the id from MODEL_IDS.`,
      );
    }
    costs.push(`  ${JSON.stringify(id)}: ${formatCost(cost)},`);
  }

  const text = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Generated by \`scripts/sync-model-limits.mjs\` from Cursor's published docs:
 *   context windows  ${SOURCES.context}
 *   pricing          ${SOURCES.pricing}
 *
 * Data last changed: ${date}
 * (a sync that finds no data change leaves this date alone, so it dates the
 *  last change to the generated maps — NOT the last time they were verified.
 *  Verification runs on a schedule in CI; see the model-data-drift job.)
 * Regenerate: \`npm run sync:model-limits\`
 *
 * Only MODEL_CONTEXT_LIMITS and MODEL_COST are derived from the docs.
 * MODEL_OUTPUT_LIMITS further down is hand-maintained, because Cursor's docs
 * publish no output-token column — but it is still emitted from this file's
 * template, so edit it in \`scripts/sync-model-limits.mjs\`, not here. An edit
 * made here is reverted by the next sync.
 *
 * Pricing is read from the structured Input / Cache write / Cache read /
 * Output columns only. The \`Notes\` cell is deliberately NOT parsed, even
 * though promotions are announced there in prose (Claude Sonnet 5's row
 * advertises "$2/M input and $10/M output through August 31, 2026" while its
 * price columns still read $3 / $15). Extracting money from free text is
 * confidently wrong by construction, promo windows expire, and Cursor's own
 * \`agent.getUsage()\` -> \`chargedCents\` is the authoritative source for
 * promotions, discounts, the Cursor Token Fee, and Max Mode multipliers. This
 * map is only the rate card opencode multiplies token counts by.
 */

/**
 * Per-model default context window limits (tokens), keyed by model id prefix.
 * The "Max context" column (1M for frontier models) requires Max Mode and is
 * NOT used here — the plugin can't detect Max Mode, so the default window is
 * the honest limit to display.
 *
 * Longest prefix wins: \`claude-opus-4-8\` (300K) beats \`claude-opus-4\` (200K).
 */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
${contextLimits.join("\n")}
};

const DEFAULT_CONTEXT_LIMIT = 200_000;

/**
 * Resolve a model's context window by longest-prefix match against
 * {@link MODEL_CONTEXT_LIMITS}. Falls back to 200K for unknown models.
 */
export function resolveContextLimit(modelId: string): number {
  let best: number | undefined;
  let bestLen = 0;
  for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelId.startsWith(prefix) && prefix.length > bestLen) {
      best = limit;
      bestLen = prefix.length;
    }
  }
  return best ?? DEFAULT_CONTEXT_LIMIT;
}

/**
 * Per-model API pricing (USD per million tokens), keyed by model id prefix.
 * Cursor Models pool models (Grok 4.5, Composer, Auto) have $0 — they draw
 * from the Cursor Models pool, not the Other Models pool, so there is no
 * per-token API charge and they are absent from the pricing docs entirely.
 *
 * Longest prefix wins: \`gpt-5.4-mini\` (0.75) beats \`gpt-5.4\` (2.50).
 */
const MODEL_COST: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
${costs.join("\n")}
};

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Resolve a model's per-token cost by longest-prefix match against
 * {@link MODEL_COST}. Falls back to $0 for unknown models (treated as
 * subscription/Cursor Models pool).
 */
export function resolveCost(modelId: string): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  let best: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
  let bestLen = 0;
  for (const [prefix, cost] of Object.entries(MODEL_COST)) {
    if (modelId.startsWith(prefix) && prefix.length > bestLen) {
      best = cost;
      bestLen = prefix.length;
    }
  }
  return best ?? DEFAULT_COST;
}

/**
 * NOT DERIVED FROM THE DOCS — hand-maintained in the template inside
 * \`scripts/sync-model-limits.mjs\`. Cursor's docs publish no output-token
 * column, so there is nothing to generate these from. Editing this map here
 * has no lasting effect; the next sync reverts it.
 *
 * Per-model output token limits, keyed by model id prefix. The Cursor SDK
 * doesn't expose output limits, so these are best-known values. 32K default
 * (the previous hardcoded value); 64K for frontier models known to support
 * higher output. Low priority — the TUI doesn't display output limit.
 */
const MODEL_OUTPUT_LIMITS: Record<string, number> = {
  "claude-opus-4-7": 64_000,
  "claude-opus-4-8": 64_000,
  "claude-opus-5": 64_000,
  "claude-fable-5": 64_000,
  "gpt-5.5": 64_000,
  "gpt-5.6-sol": 64_000,
};

const DEFAULT_OUTPUT_LIMIT = 32_000;

/**
 * Resolve a model's output limit by longest-prefix match. Falls back to 32K.
 */
export function resolveOutputLimit(modelId: string): number {
  let best: number | undefined;
  let bestLen = 0;
  for (const [prefix, limit] of Object.entries(MODEL_OUTPUT_LIMITS)) {
    if (modelId.startsWith(prefix) && prefix.length > bestLen) {
      best = limit;
      bestLen = prefix.length;
    }
  }
  return best ?? DEFAULT_OUTPUT_LIMIT;
}
`;

  return { text, stats };
}

async function fetchDoc(url) {
  const response = await fetch(url, { headers: { accept: "text/plain,text/markdown,*/*" } });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return await response.text();
}

/**
 * Run the CLI. Returns the process exit code rather than calling
 * `process.exit`, so the caller owns the exit. Invoked unconditionally by
 * `scripts/sync-model-limits-cli.mjs`.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const check = argv.includes("--check");

  let generated;
  try {
    const [contextMd, pricingMd] = await Promise.all([fetchDoc(SOURCES.context), fetchDoc(SOURCES.pricing)]);
    generated = generate({ contextMd, pricingMd });
  } catch (error) {
    process.stderr.write(`sync-model-limits: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const { text, stats } = generated;
  let committed;
  try {
    committed = readFileSync(OUTPUT_PATH, "utf8");
  } catch {
    committed = undefined;
  }
  const unchanged = committed !== undefined && normalizeForComparison(committed) === normalizeForComparison(text);

  const summary =
    `context: ${stats.context.matched} from docs, ${stats.context.overridden} overridden | ` +
    `cost: ${stats.cost.matched} from docs, ${stats.cost.overridden} overridden | ` +
    `${MODEL_IDS.length} model ids`;

  if (check) {
    if (committed === undefined) {
      process.stderr.write(`sync-model-limits: ${OUTPUT_PATH} does not exist\n`);
      return 1;
    }
    if (unchanged) {
      process.stdout.write(`sync-model-limits: src/model-limits.ts is up to date (${summary})\n`);
      return 0;
    }
    process.stderr.write(
      `sync-model-limits: src/model-limits.ts differs from Cursor's docs. ` +
        `Run \`npm run sync:model-limits\` and commit the result. (${summary})\n`,
    );
    return 1;
  }

  if (unchanged) {
    // Only the sync date would move; leave the file alone so a no-op sync does
    // not produce a diff.
    process.stdout.write(`sync-model-limits: src/model-limits.ts already up to date (${summary})\n`);
    return 0;
  }

  try {
    writeFileSync(OUTPUT_PATH, text);
  } catch (error) {
    // Exit 2, not 1: an I/O failure is an environment problem, and 1 means
    // "the committed file is stale", which this does not establish.
    process.stderr.write(
      `sync-model-limits: cannot write ${OUTPUT_PATH}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  process.stdout.write(`sync-model-limits: wrote src/model-limits.ts (${summary})\n`);
  return 0;
}
