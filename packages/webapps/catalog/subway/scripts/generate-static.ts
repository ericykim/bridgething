/**
 * Regenerates src/data/static-data.json from the MTA GTFS static archive.
 *
 * Source: https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip (official MTA
 * GTFS static feed for the subway, see https://data.mta.info).
 *
 * Usage: bun scripts/generate-static.ts [--refresh]
 *   --refresh  re-download the archive even if a cached copy exists
 *
 * Output is trimmed to station + platform rows, route colors, and a compact
 * trip headsign lookup (realtime trip ids are the static trip id after the
 * last underscore, so the map is keyed by that suffix).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GTFS_URL = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(scriptDir, '..');
const cacheDir = join(scriptDir, '.cache');
const zipPath = join(cacheDir, 'gtfs_subway.zip');
const outPath = join(pkgDir, 'src', 'data', 'static-data.json');

interface OutRoute {
  name: string;
  shortName: string;
  color: string;
  textColor: string;
}

interface OutStation {
  id: string;
  name: string;
  routes: string[];
  platforms: { N: string; S: string };
}

interface OutData {
  sourceUrl: string;
  generatedAt: string;
  routes: Record<string, OutRoute>;
  stations: OutStation[];
  headsigns: {
    /** realtime trip id (the static trip id after the last underscore) -> headsign */
    trips: Record<string, string>;
    /** modal headsign per route and travel direction, used when a trip id is unknown */
    byRoute: Record<string, { N: string; S: string }>;
  };
}

const refresh = process.argv.includes('--refresh');

function downloadAndExtract(): string {
  mkdirSync(cacheDir, { recursive: true });
  if (refresh || !existsSync(zipPath)) {
    console.log(`downloading ${GTFS_URL}`);
    // curl keeps this dependency-free; bun has no zip reader
    const code = Bun.spawnSync(['curl', '-sfL', '--max-time', '300', '-o', zipPath, GTFS_URL], {
      stdout: 'inherit',
    });
    if (!code.success || !existsSync(zipPath)) {
      throw new Error(`download failed: ${GTFS_URL}`);
    }
  } else {
    console.log('using cached gtfs archive (pass --refresh to re-download)');
  }
  const extractDir = join(cacheDir, 'extracted');
  rmSync(extractDir, { recursive: true, force: true });
  const code = Bun.spawnSync(['unzip', '-q', '-o', zipPath, '-d', extractDir], { stdout: 'inherit' });
  if (!code.success) throw new Error(`unzip failed for ${zipPath}`);
  return extractDir;
}

/** Minimal RFC 4180 csv parser: handles quoted fields with embedded commas and escaped quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

function readCsvRecords(dir: string, name: string): Record<string, string>[] {
  const rows = parseCsv(readFileSync(join(dir, name), 'utf8'));
  const header = rows[0] ?? [];
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = r[i] ?? ''));
    return rec;
  });
}

function main() {
  const extractDir = downloadAndExtract();

  // routes: id -> name/color, keep the official sort order for station route lists
  const routeOrder = new Map<string, number>();
  const routes: Record<string, OutRoute> = {};
  for (const r of readCsvRecords(extractDir, 'routes.txt')) {
    routeOrder.set(r.route_id, Number(r.route_sort_order) || 0);
    routes[r.route_id] = {
      name: r.route_long_name,
      shortName: r.route_short_name,
      color: r.route_color,
      textColor: r.route_text_color,
    };
  }

  // stops: location_type 1 rows are stations, the rest are platforms parented to them
  const stationById = new Map<string, OutStation>();
  const platformsByStation = new Map<string, string[]>();
  for (const s of readCsvRecords(extractDir, 'stops.txt')) {
    if (s.location_type === '1') {
      stationById.set(s.stop_id, { id: s.stop_id, name: s.stop_name, routes: [], platforms: { N: '', S: '' } });
    } else if (s.parent_station) {
      const ids = platformsByStation.get(s.parent_station) ?? [];
      ids.push(s.stop_id);
      platformsByStation.set(s.parent_station, ids);
    }
  }

  // platform stop ids must split cleanly into N/S pairs; the direction logic downstream depends on it
  for (const [stationId, platformIds] of platformsByStation) {
    const station = stationById.get(stationId);
    if (!station) throw new Error(`platform ${platformIds.join(',')} parented to unknown station ${stationId}`);
    for (const pid of platformIds) {
      const dir = pid[pid.length - 1];
      if (dir !== 'N' && dir !== 'S') throw new Error(`platform ${pid} does not end in N or S`);
      if (station.platforms[dir]) throw new Error(`station ${stationId} has two ${dir} platforms`);
      station.platforms[dir] = pid;
    }
  }

  // trips: static trip ids carry a feed-specific prefix; realtime feeds use the
  // part after the last underscore, so key the headsign lookup by that suffix
  const routeOfTrip = new Map<string, string>();
  const suffixHeadsign = new Map<string, string>();
  for (const t of readCsvRecords(extractDir, 'trips.txt')) {
    const suffix = t.trip_id.split('_').pop() ?? t.trip_id;
    const known = suffixHeadsign.get(suffix);
    if (known !== undefined && known !== t.trip_headsign) {
      throw new Error(`trip suffix ${suffix} maps to two headsigns`);
    }
    suffixHeadsign.set(suffix, t.trip_headsign);
    routeOfTrip.set(t.trip_id, t.route_id);
  }

  // stop_times: routes per platform, plus each trip's travel direction from the
  // N/S suffix of the stop with the lowest stop_sequence
  const platformRoutes = new Map<string, Set<string>>();
  const tripFirstStop = new Map<string, { seq: number; dir: 'N' | 'S' }>();
  for (const row of readCsvRecords(extractDir, 'stop_times.txt')) {
    const routeId = routeOfTrip.get(row.trip_id);
    if (routeId !== undefined) {
      let set = platformRoutes.get(row.stop_id);
      if (!set) platformRoutes.set(row.stop_id, (set = new Set()));
      set.add(routeId);
    }
    const dir = row.stop_id[row.stop_id.length - 1];
    if (dir === 'N' || dir === 'S') {
      const seq = Number(row.stop_sequence) || 0;
      const first = tripFirstStop.get(row.trip_id);
      if (!first || seq < first.seq) tripFirstStop.set(row.trip_id, { seq, dir });
    }
  }

  for (const station of stationById.values()) {
    const ids = new Set<string>();
    for (const pid of Object.values(station.platforms)) {
      for (const r of platformRoutes.get(pid) ?? []) ids.add(r);
    }
    if (ids.size === 0) throw new Error(`station ${station.id} serves no routes`);
    station.routes = [...ids].sort((a, b) => (routeOrder.get(a) ?? 0) - (routeOrder.get(b) ?? 0));
  }

  // modal headsign per (route, N/S) as the fallback for trip ids missing from the lookup
  const votes = new Map<string, Record<'N' | 'S', Map<string, number>>>();
  for (const [tripId, routeId] of routeOfTrip) {
    const first = tripFirstStop.get(tripId);
    if (!first) continue;
    let byRoute = votes.get(routeId);
    if (!byRoute) votes.set(routeId, (byRoute = { N: new Map(), S: new Map() }));
    const ballot = byRoute[first.dir];
    const headsign = suffixHeadsign.get(tripId.split('_').pop() ?? tripId);
    if (headsign) ballot.set(headsign, (ballot.get(headsign) ?? 0) + 1);
  }
  const byRoute: Record<string, { N: string; S: string }> = {};
  for (const [routeId, byDir] of votes) {
    const pick = (dir: 'N' | 'S') => [...byDir[dir].entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    byRoute[routeId] = { N: pick('N'), S: pick('S') };
  }

  const out: OutData = {
    sourceUrl: GTFS_URL,
    generatedAt: new Date().toISOString(),
    routes,
    stations: [...stationById.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    headsigns: {
      trips: Object.fromEntries([...suffixHeadsign.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      byRoute,
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out));
  const bytes = statSync(outPath).size;
  console.log(
    `wrote ${basename(outPath)}: ${(bytes / 1024).toFixed(1)} KB, ` +
      `${out.stations.length} stations, ${Object.keys(routes).length} routes, ` +
      `${Object.keys(out.headsigns.trips).length} trip headsigns`,
  );
  if (bytes > 1024 * 1024) {
    throw new Error(`bundle is ${(bytes / 1024 / 1024).toFixed(2)} MB, over the 1 MB settings-bridge cap`);
  }
}

main();
