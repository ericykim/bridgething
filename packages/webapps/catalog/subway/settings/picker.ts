/**
 * Search and selection logic for the companion settings station picker.
 *
 * The settings page is a self-contained preact bundle, but the logic here is
 * framework-free so it can be unit tested with bun test alongside the board.
 */

import {
  allStations,
  findStationsByName,
  normalizeStationName,
  unionRoutes,
  type StaticStation,
} from '../src/static-data.ts';

const MAX_RESULTS = 20;

/**
 * One autocomplete option: every station sharing a display name, merged.
 * The MTA data splits complex stations (e.g. Borough Hall's 4/5 and 2/3
 * platforms) into separate ids, but users think of them as one station.
 */
export interface StationGroup {
  /** Shared display name of the group. */
  name: string;
  /** All station ids in the group, selecting it selects all of them. */
  ids: string[];
  /** Union of the group's routes, in the MTA's official route sort order. */
  routes: string[];
}

/** Merge stations that share a normalized name into one option each. */
export function groupStations(stations: StaticStation[]): StationGroup[] {
  const byName = new Map<string, StaticStation[]>();
  for (const station of stations) {
    const key = normalizeStationName(station.name);
    const group = byName.get(key);
    if (group) group.push(station);
    else byName.set(key, [station]);
  }
  return [...byName.values()].map(group => ({
    name: group[0].name,
    ids: group.map(s => s.id),
    routes: unionRoutes(group),
  }));
}

/**
 * Station search for the picker: exact and prefix id matches first, then the
 * shared name search, deduped, merged into one option per station name, and
 * capped.
 */
export function searchStations(query: string): StationGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results = new Map<string, StaticStation>();
  for (const station of allStations()) {
    const id = station.id.toLowerCase();
    if (id === q || (q.length >= 2 && id.startsWith(q))) results.set(station.id, station);
  }
  for (const station of findStationsByName(query)) {
    if (!results.has(station.id)) results.set(station.id, station);
  }
  return groupStations([...results.values()]).slice(0, MAX_RESULTS);
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
