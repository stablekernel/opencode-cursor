/**
 * Types for `sync-model-limits.mjs`. The script is plain ESM JavaScript (it
 * runs via `node` with no build step), but `tsconfig.json` includes `test`, so
 * `test/sync-model-limits.test.ts` needs a declaration to import it.
 *
 * This mirror is hand-maintained. `allowJs: true` would remove the need for it,
 * but it does not work in this repo: it pulls `src/sidecar/agent-host.mjs` into
 * the program, and that file assigns to `console.log`, which strips `log`,
 * `debug`, `info`, `warn`, and `error` off the global `Console` type and breaks
 * 30 checks in existing `.ts` files. Measured, not assumed — see
 * `.superpowers/sdd/task-6-report.md`. Two things keep this file honest in the
 * meantime: `test/sync-model-limits.test.ts` asserts the module's runtime
 * export names match the list declared here, and the tests call every declared
 * signature, so a parameter that is declared but missing (or vice versa) fails
 * `npm run typecheck`.
 */

export type DocsRow = Record<string, string>;

export type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type MatchResult =
  | { row: DocsRow; ambiguous?: never }
  | { row?: never; ambiguous: string[] };

export declare const SOURCES: { context: string; pricing: string };
export declare const MODEL_IDS: string[];
export declare const OVERRIDES: Record<
  string,
  { context?: number; cost?: ModelCost; why: string }
>;

export declare function parseDocsTable(md: string, columnNames: string[]): DocsRow[];
export declare function parseTokens(text: string): number | undefined;
export declare function parsePrice(text: string): number;
export declare function matchModelId(id: string, docRows: DocsRow[]): MatchResult | undefined;
export declare function normalizeForComparison(text: string): string;
export declare function generate(input: {
  contextMd: string;
  pricingMd: string;
  modelIds?: readonly string[];
  overrides?: Record<string, { context?: number; cost?: ModelCost; why?: string }>;
  date?: string;
}): {
  text: string;
  stats: {
    context: { matched: number; overridden: number };
    cost: { matched: number; overridden: number };
  };
};
export declare function main(argv: string[]): Promise<number>;
