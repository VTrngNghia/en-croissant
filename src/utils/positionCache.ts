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
    data: Record<string, FenCacheEntry>;
};

export type DbCache = Map<string, FenCacheEntry>;

export function getCachePath(pgnPath: string): string {
    return pgnPath.replace(/\.pgn$/, ".movecache.json");
}

export async function loadCache(
    pgnPath: string,
    dbPath: string,
): Promise<{ map: DbCache; dbLastModified: number } | null> {
    const cachePath = getCachePath(pgnPath);
    if (!(await exists(cachePath))) return null;

    try {
        const raw = await readTextFile(cachePath);
        const cache: CacheFile = JSON.parse(raw);
        if (cache.schemaVersion !== SCHEMA_VERSION || cache.dbPath !== dbPath) return null;
        const map = new Map<string, FenCacheEntry>(Object.entries(cache.data));
        console.log(`leuleu loadCache: hydrated ${map.size} entries from ${cachePath}`);
        return { map, dbLastModified: cache.dbLastModified };
    } catch (err) {
        console.error(`leuleu loadCache: failed ${cachePath}`, err);
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
    dataMap: Map<string, FenCacheEntry>,
    validFens?: Set<string>,
): Promise<void> {
    const run = savingInFlight.then(() =>
        doSaveCache(pgnPath, dbPath, dbLastModified, dataMap, validFens),
    );
    savingInFlight = run.catch(() => {});
    return run;
}

async function doSaveCache(
    pgnPath: string,
    dbPath: string,
    dbLastModified: number,
    dataMap: Map<string, FenCacheEntry>,
    validFens?: Set<string>,
): Promise<void> {
    console.log(`leuleu doSaveCache: saving ${dataMap.size} entries to ${getCachePath(pgnPath)}`);
    const cachePath = getCachePath(pgnPath);
    const tmpPath = `${cachePath}.tmp`;

    let filteredData = dataMap;
    if (validFens) {
        const before = dataMap.size;
        filteredData = new Map();
        for (const [fen, entry] of dataMap) {
            if (validFens.has(fen)) filteredData.set(fen, entry);
        }
        console.log(`leuleu saveCache: filtered from ${before} to ${filteredData.size} entries`);
    }

    const data: Record<string, FenCacheEntry> = {};
    for (const [fen, entry] of filteredData) data[fen] = entry;

    const cache: CacheFile = {
        schemaVersion: SCHEMA_VERSION,
        dbPath,
        dbLastModified,
        data,
    };

    const json = JSON.stringify(cache, null, 2);
    const byteSize = new TextEncoder().encode(json).length;

    try {
        await writeTextFile(tmpPath, json);
    } catch (err) {
        console.error(`leuleu saveCache: writeTextFile failed ${tmpPath}`, err);
        throw err;
    }

    try {
        await rename(tmpPath, cachePath);
    } catch (err) {
        try {
            await remove(tmpPath);
        } catch {}
        throw err;
    }

    console.log(
        `leuleu saveCache: done ${cachePath}, ${filteredData.size} entries, ${byteSize} bytes`,
    );
}
