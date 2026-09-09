import { describe, expect, test } from 'bun:test';
import {
  allStations,
  findStationsByName,
  getRoute,
  getStationById,
  headsignForTrip,
  platformForDirection,
  routesForStation,
  staticDataSource,
} from './static-data.ts';

describe('getStationById', () => {
  test('finds a station and its routes and platforms', () => {
    const station = getStationById('127');
    expect(station).toBeDefined();
    expect(station!.name).toBe('Times Sq-42 St');
    expect(station!.routes).toEqual(['1', '2', '3']);
    expect(station!.platforms).toEqual({ N: '127N', S: '127S' });
  });

  test('returns undefined for an unknown id', () => {
    expect(getStationById('ZZZ')).toBeUndefined();
  });

  test('station ids are unique', () => {
    const ids = allStations().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('findStationsByName', () => {
  test('exact name match ranks first regardless of case or separator width', () => {
    const results = findStationsByName('  times sq-42 st ');
    expect(results[0]?.id).toBe('127');
  });

  test('whole-word prefix matches rank above substring-only matches', () => {
    const results = findStationsByName('mar');
    // word-prefix hits ("St Mary's St", "Marble Hill", "Marcy Av") rank above
    // the substring-only "mar" inside "Astoria-Ditmars Blvd"
    const ids = results.map((s) => s.id);
    expect(ids).toContain('M16');
    expect(ids).toContain('R01');
    expect(ids.indexOf('M16')).toBeLessThan(ids.indexOf('R01'));
  });

  test('substring match finds stations where the query is not a word prefix', () => {
    const results = findStationsByName('union');
    expect(results.map((s) => s.id)).toContain('635');
  });

  test('an empty or blank query matches nothing', () => {
    expect(findStationsByName('')).toEqual([]);
    expect(findStationsByName('   ')).toEqual([]);
  });

  test('garbage matches nothing', () => {
    expect(findStationsByName('zzzz qqqq')).toEqual([]);
  });
});

describe('platformForDirection', () => {
  test('maps directions onto the N/S platform id suffixes', () => {
    const station = getStationById('635')!;
    expect(platformForDirection(station, 'N')).toBe('635N');
    expect(platformForDirection(station, 'S')).toBe('635S');
  });

  test('every station has exactly one N and one S platform with matching suffixes', () => {
    for (const station of allStations()) {
      expect(platformForDirection(station, 'N')).toMatch(/N$/);
      expect(platformForDirection(station, 'S')).toMatch(/S$/);
    }
  });
});

describe('headsignForTrip', () => {
  test('resolves a realtime-style trip id (suffix after the last underscore)', () => {
    expect(headsignForTrip('061600_1..N03R')).toBe('Van Cortlandt Park-242 St');
    expect(headsignForTrip('1..N03R')).toBe('Van Cortlandt Park-242 St');
  });

  test('route+direction fallback covers a trip id missing from the bundle', () => {
    expect(headsignForTrip('999999_9..N99Z', { routeId: '1', direction: 'N' })).toBe(
      'Van Cortlandt Park-242 St',
    );
    expect(headsignForTrip('999999_9..S99Z', { routeId: '1', direction: 'S' })).toBe('South Ferry');
  });

  test('route-only fallback works when the direction is unknown', () => {
    expect(headsignForTrip('999999_9..X99Z', { routeId: '1' })).toBeDefined();
  });

  test('returns undefined for an unknown trip with no usable fallback', () => {
    expect(headsignForTrip('999999_9..X99Z')).toBeUndefined();
    expect(headsignForTrip('999999_9..X99Z', { routeId: 'NOTAROUTE' })).toBeUndefined();
  });
});

describe('routesForStation', () => {
  test('returns colored route info for a station', () => {
    const routes = routesForStation('127');
    expect(routes.map((r) => r.name)).toEqual(['Broadway - 7 Avenue Local', '7 Avenue Express', '7 Avenue Express']);
    expect(routes[0]!.color).toMatch(/^[0-9A-F]{6}$/);
  });

  test('unknown station serves no routes', () => {
    expect(routesForStation('ZZZ')).toEqual([]);
  });

  test('every route referenced by any station exists in the route table', () => {
    for (const station of allStations()) {
      for (const routeId of station.routes) {
        expect(getRoute(routeId), `station ${station.id} references route ${routeId}`).toBeDefined();
      }
    }
  });

  test('bundle documents its source', () => {
    expect(staticDataSource).toBe('https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip');
  });
});
