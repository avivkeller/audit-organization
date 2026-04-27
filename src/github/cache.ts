import * as cache from '@actions/cache';
import * as core from '@actions/core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Schema bumps invalidate prior caches. Bump when the persisted shape changes
// in a way older runs cannot read (or current runs cannot trust).
const CACHE_VERSION = 1;
const CACHE_DIR = '.organization-auditor-cache';
const CACHE_FILE = 'activity-cache.json';

// Per-login most-recent activity timestamps, scoped so org-wide and per-team
// signals stay independent (a user's team-repo activity is a strict subset of
// their org-wide activity, but not vice versa).
export interface ActivityCache {
	org: Record<string, string>;
	teams: Record<string, Record<string, string>>;
}

interface PersistedCache {
	version: number;
	scope: string;
	data: ActivityCache;
}

export function emptyCache(): ActivityCache {
	return { org: {}, teams: {} };
}

function cacheDir(): string {
	return join(process.cwd(), CACHE_DIR);
}

function cacheFilePath(): string {
	return join(cacheDir(), CACHE_FILE);
}

function buildCacheKeys(
	org: string,
	runMarker: string,
): { primaryKey: string; restoreKeys: string[] } {
	const prefix = `org-auditor-v${CACHE_VERSION}-${org}-`;
	return {
		primaryKey: `${prefix}${runMarker}`,
		restoreKeys: [prefix],
	};
}

// `cfg.now` is an ISO timestamp; the Actions cache key allows a limited
// charset, so we strip the punctuation rather than risk a 400 from the cache
// service.
export function runMarkerFromIso(now: string): string {
	return now.replace(/[^A-Za-z0-9-]/g, '-');
}

// Returns the parsed cache, or an empty cache on miss / parse failure / version
// or scope mismatch. Never throws - caching is a best-effort speed-up, never a
// hard requirement for the audit.
export async function restoreActivityCache(org: string, runMarker: string): Promise<ActivityCache> {
	if (!cache.isFeatureAvailable?.()) {
		core.info('cache: Actions cache service unavailable; starting with an empty cache');
		return emptyCache();
	}

	const { primaryKey, restoreKeys } = buildCacheKeys(org, runMarker);
	let hit: string | undefined;
	try {
		hit = await cache.restoreCache([cacheDir()], primaryKey, restoreKeys);
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		core.warning(`cache: restore failed (${cause}); starting with an empty cache`);
		return emptyCache();
	}
	if (!hit) {
		core.info('cache: miss; starting with an empty cache');
		return emptyCache();
	}
	core.info(`cache: restored from "${hit}"`);

	let parsed: PersistedCache;
	try {
		const raw = await readFile(cacheFilePath(), 'utf8');
		parsed = JSON.parse(raw) as PersistedCache;
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		core.warning(`cache: read failed (${cause}); starting with an empty cache`);
		return emptyCache();
	}

	if (parsed.version !== CACHE_VERSION) {
		core.info(`cache: version ${parsed.version} != expected ${CACHE_VERSION}; discarding`);
		return emptyCache();
	}
	if (parsed.scope !== org) {
		core.info(`cache: scope "${parsed.scope}" != expected "${org}"; discarding`);
		return emptyCache();
	}
	return {
		org: parsed.data.org ?? {},
		teams: parsed.data.teams ?? {},
	};
}

export async function saveActivityCache(
	org: string,
	runMarker: string,
	data: ActivityCache,
): Promise<void> {
	if (!cache.isFeatureAvailable?.()) return;

	try {
		await mkdir(dirname(cacheFilePath()), { recursive: true });
		const persisted: PersistedCache = { version: CACHE_VERSION, scope: org, data };
		await writeFile(cacheFilePath(), JSON.stringify(persisted));
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		core.warning(`cache: write failed (${cause})`);
		return;
	}

	const { primaryKey } = buildCacheKeys(org, runMarker);
	try {
		await cache.saveCache([cacheDir()], primaryKey);
		core.info(`cache: saved to "${primaryKey}"`);
	} catch (err) {
		// `ReserveCacheError` is benign - another concurrent run already saved
		// under the same key. Anything else is also non-fatal but worth a warning.
		const cause = err instanceof Error ? err.message : String(err);
		core.warning(`cache: save failed (${cause})`);
	}
}

// `null`-tolerant max for ISO timestamps. Lexicographic compare works for ISO
// 8601 strings as long as both are absolute (UTC); the rest of the codebase
// emits ISO-Z timestamps, so this is safe.
export function maxIso(a: string | null | undefined, b: string | null | undefined): string | null {
	if (!a) return b ?? null;
	if (!b) return a;
	return a >= b ? a : b;
}

export function isWithinWindow(lastSeen: string | null | undefined, since: string): boolean {
	return !!lastSeen && lastSeen >= since;
}
