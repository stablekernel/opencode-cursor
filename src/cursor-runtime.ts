/**
 * Lazy loader for the official Cursor SDK (`@cursor/sdk`).
 *
 * The SDK is heavy and only needed once a Cursor model is actually used or
 * models are discovered, so it is imported on demand. A failed import (e.g. the
 * dependency is missing) degrades gracefully into a clear error instead of
 * crashing opencode at startup.
 */
export type CursorSdkModule = typeof import("@cursor/sdk");

let cached: Promise<CursorSdkModule> | undefined;

export async function loadCursorSdk(): Promise<CursorSdkModule> {
  if (!cached) {
    cached = import("@cursor/sdk").catch((err: unknown) => {
      // Allow a later retry if the failure was transient.
      cached = undefined;
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[opencode-cursor] Failed to load "@cursor/sdk". Make sure it is installed ` +
          `(\`npm install @cursor/sdk\`). Original error: ${detail}`,
      );
    });
  }
  return cached;
}
