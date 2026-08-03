#!/usr/bin/env node
/**
 * CLI entry point for `scripts/sync-model-limits.mjs`.
 *
 * This file exists so the generator module stays import-pure (the tests import
 * it) without needing an "am I the entry point?" guard inside it. Such a guard
 * — comparing `process.argv[1]` against `import.meta.url` — is fail-open: on
 * any invocation where the two differ (a symlinked path, a wrapper, an exec
 * shim) `main()` never runs and the process exits 0 having done nothing, which
 * makes the scheduled drift check permanently green and permanently useless.
 * That already happened once, via a symlinked `/tmp` path on macOS.
 *
 * There is no guard here. Running this file always runs `main()`.
 */
import { main } from "./sync-model-limits.mjs";

process.exitCode = await main(process.argv.slice(2));
