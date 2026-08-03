/**
 * Types for `sync-model-limits.mjs`. The script is plain ESM JavaScript (it
 * runs via `node` with no build step), but `tsconfig.json` includes `test`, so
 * `test/sync-model-limits.test.ts` needs a declaration to import it.
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
export declare function generate(input: { contextMd: string; pricingMd: string; date?: string }): {
  text: string;
  stats: {
    context: { matched: number; overridden: number };
    cost: { matched: number; overridden: number };
  };
};
