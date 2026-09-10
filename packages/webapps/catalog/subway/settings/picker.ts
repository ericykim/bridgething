/**
 * Search and selection logic for the companion settings station picker.
 *
 * The settings page is a self-contained preact bundle, but the logic here is
 * framework-free so it can be unit tested with bun test alongside the board.
 */

import { allStations, findStationsByName, type StaticStation } from '../src/static-data.ts';

const MAX_RESULTS = 20;

/**
 * Station search for the picker: exact and prefix id matches first, then the
 * shared name search, deduped and capped.
 */
export function searchStations(query: string): StaticStation[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results = new Map<string, StaticStation>();
  for (const station of allStations()) {
    const id = station.id.toLowerCase();
    if (id === q || (q.length >= 2 && id.startsWith(q))) results.set(station.id, station);
    if (results.size >= MAX_RESULTS) break;
  }
  for (const station of findStationsByName(query)) {
    if (results.size >= MAX_RESULTS) break;
    if (!results.has(station.id)) results.set(station.id, station);
  }
  return [...results.values()];
}

/**
 * Serialize a station selection to the `stations` config value: ordered,
 * deduped, comma-separated ids. Round-trips with `parseStationIds` in
 * src/config.ts.
 */
export function serializeStations(ids: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  for (const id of ids) {
    const trimmed = id?.trim();
    if (trimmed && !seen.has(trimmed)) seen.add(trimmed);
  }
  return [...seen].join(',');
}
