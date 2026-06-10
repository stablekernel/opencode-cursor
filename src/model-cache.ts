import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelListItem } from "@cursor/sdk";

/** Default cache lifetime: 24 hours, overridable via env. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function ttlMs(): number {
  const raw = process.env.OPENCODE_CURSOR_MODEL_CACHE_TTL_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

function cacheDir(): string {
  const base =
    process.env.XDG_CACHE_HOME?.trim() ||
    (homedir() ? join(homedir(), ".cache") : tmpdir());
  return join(base, "opencode-cursor");
}

function cacheFile(fingerprint: string): string {
  return join(cacheDir(), `models-${fingerprint}.json`);
}

/**
 * Key-independent "latest known catalog" file. The `config` plugin hook runs
 * without access to the stored API key, so it can't read the per-key cache.
 * This file lets a keyless caller (the config hook) seed opencode's model
 * picker with the real catalog that a previous *authed* load discovered.
 */
function latestCacheFile(): string {
  return join(cacheDir(), "models-latest.json");
}

/** The latest-catalog seed is kept longer than the per-key cache: the catalog
 * is stable and this only feeds pre-auth UI seeding. */
const LATEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CacheEnvelope {
  savedAt: number;
  models: ModelListItem[];
}

function readCacheFile(file: string, maxAgeMs: number): ModelListItem[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CacheEnvelope;
    if (!parsed?.savedAt || !Array.isArray(parsed.models)) return undefined;
    if (Date.now() - parsed.savedAt > maxAgeMs) return undefined;
    return parsed.models;
  } catch {
    return undefined;
  }
}

function writeCacheFile(file: string, models: ModelListItem[]): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    const envelope: CacheEnvelope = { savedAt: Date.now(), models };
    writeFileSync(file, JSON.stringify(envelope), "utf8");
  } catch {
    // Caching is an optimization; ignore write failures.
  }
}

/**
 * Return cached models for the given API-key fingerprint when present and still
 * fresh, otherwise `undefined`. Never throws on a missing/corrupt cache.
 */
export function readModelCache(fingerprint: string): ModelListItem[] | undefined {
  return readCacheFile(cacheFile(fingerprint), ttlMs());
}

/** Persist the discovered model list (per-key cache + key-independent latest
 * catalog). Best-effort; never throws. */
export function writeModelCache(fingerprint: string, models: ModelListItem[]): void {
  writeCacheFile(cacheFile(fingerprint), models);
  writeCacheFile(latestCacheFile(), models);
}

/**
 * Return the most recently discovered catalog regardless of API key, when
 * present and within {@link LATEST_TTL_MS}. Used by the keyless `config` hook to
 * seed the picker with the real catalog after a prior authed load.
 */
export function readLatestModelCache(): ModelListItem[] | undefined {
  return readCacheFile(latestCacheFile(), LATEST_TTL_MS);
}
