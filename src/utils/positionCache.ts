import { readTextFile, writeTextFile, rename, remove, exists } from "@tauri-apps/plugin-fs";
import type { PositionStats } from "./repertoire";

const SCHEMA_VERSION = 1;

export type FenCacheEntry = {
    moves: PositionStats[];
    total: number;
};

type CacheFile = {
    schemaVersion: number;
    dbPath: string;
    dbLastModified: number;
    pgnLastModified: number; 
    data: Record<string, FenCacheEntry>;
};

export type DbCache = Map<string, FenCacheEntry>;

export function getCachePath(pgnPath: string): string {
    return pgnPath.replace(/\.pgn$/, ".movecache.json");
}

export async function loadCache(
    pgnPath: string,
    dbPath: string,
): Promise<{ map: DbCache; dbLastModified: number; pgnLastModified: number } | null> {
    const cachePath = getCachePath(pgnPath);
    if (!(await exists(cachePath))) return null;

    try {
        const raw = await readTextFile(cachePath);
        const cache: CacheFile = JSON.parse(raw);

        if (
            cache.schemaVersion !== SCHEMA_VERSION ||
            cache.dbPath !== dbPath
        ) {
            return null;
        }

        const map = new Map<string, FenCacheEntry>(Object.entries(cache.data));
    return { map, dbLastModified: cache.dbLastModified, pgnLastModified: cache.pgnLastModified };
    } catch (err) {
        return null;
    }
}

// Simple in-flight guard so overlapping saveCache calls (progress callback +
// interval + final save) can't race each other's tmp file.
let savingInFlight: Promise<void> = Promise.resolve();

export async function saveCache(
    pgnPath: string,
    dbPath: string,
    dbLastModified: number,
    pgnLastModified: number,  
      dataMap: Map<string, FenCacheEntry>,
): Promise<void> {
    // Chain onto any in-progress save so writes are serialized, not concurrent.
    const run = savingInFlight.then(() => doSaveCache(pgnPath, dbPath, dbLastModified, pgnLastModified, dataMap));
    savingInFlight = run.catch(() => {
        // swallow here so the chain never breaks; the error is already logged below
    });
    return run;
}

async function doSaveCache(
    pgnPath: string,
    dbPath: string,
    dbLastModified: number,
     pgnLastModified: number,  
      dataMap: Map<string, FenCacheEntry>,
): Promise<void> {
    const cachePath = getCachePath(pgnPath);
    const tmpPath = `${cachePath}.tmp`;

    let json: string;
    try {
        const data: Record<string, FenCacheEntry> = {};
        for (const [fen, entry] of dataMap) {
            data[fen] = entry;
        }

        const cache: CacheFile = {
            schemaVersion: SCHEMA_VERSION,
            dbPath,
            dbLastModified,
            pgnLastModified,
            data,
        };

        json = JSON.stringify(cache, null, 2);
    } catch (err) {
        throw err;
    }

    const byteSize = new TextEncoder().encode(json).length;

    try {
        const t0 = performance.now();
        await writeTextFile(tmpPath, json);
    } catch (err) {
        throw err;
    }

    try {
        const t1 = performance.now();
        await rename(tmpPath, cachePath);
    } catch (err) {
        // Best-effort cleanup so a failed rename doesn't leave the tmp file
        // behind forever and doesn't block the next save attempt.
        try {
            await remove(tmpPath);
        } catch {
            // ignore
        }
        throw err;
    }
}
