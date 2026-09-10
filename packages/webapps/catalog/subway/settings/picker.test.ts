import { describe, expect, test } from 'bun:test';
import { parseStationIds } from '../src/config.ts';
import { getStationById, unionRoutes, type StaticStation } from '../src/static-data.ts';
import { groupStations, searchStations, serializeStations } from './picker.ts';

function station(id: string, name: string, routes: string[]): StaticStation {
  return { id, name, routes, platforms: { N: '', S: '' } };
}

describe('searchStations', () => {
  test('finds stations by exact id first', () => {
    const results = searchStations('127');
    expect(results[0]?.ids).toContain('127');
    expect(results[0]?.name).toBe('Times Sq-42 St');
  });

  test('finds stations by id prefix', () => {
    const results = searchStations('90');
    const ids = results.flatMap(s => s.ids);
    expect(ids).toContain('901');
    expect(ids).toContain('902');
  });

  test('finds stations by name and ranks them like the shared search', () => {
    const results = searchStations('union sq');
    expect(results.flatMap(s => s.ids)).toContain('635');
  });

  test('merges same-name stations into one option with all of their trains', () => {
    const results = searchStations('borough hall');
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe('Borough Hall');
    expect(results[0]?.ids).toEqual(['232', '423']);
    expect(results[0]?.routes).toEqual(['2', '3', '4', '5']);
  });

  test('ids are unique across the result groups', () => {
    const results = searchStations('127');
    const ids = results.flatMap(s => s.ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('an empty or blank query matches nothing', () => {
    expect(searchStations('')).toEqual([]);
    expect(searchStations('   ')).toEqual([]);
  });

  test('garbage matches nothing', () => {
    expect(searchStations('zzzz qqqq')).toEqual([]);
  });

  test('results are capped', () => {
    expect(searchStations('s').length).toBeLessThanOrEqual(20);
  });
});

describe('groupStations', () => {
  test('merges stations sharing a name into one group', () => {
    const groups = groupStations([
      station('423', 'Borough Hall', ['4', '5']),
      station('232', 'Borough Hall', ['2', '3']),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0]?.name).toBe('Borough Hall');
    expect(groups[0]?.ids).toEqual(['423', '232']);
    expect(groups[0]?.routes).toEqual(['2', '3', '4', '5']);
  });

  test('keeps distinct names separate', () => {
    const groups = groupStations([station('a1', 'Foo St', ['1']), station('b2', 'Foo St Annex', ['2'])]);
    expect(groups.length).toBe(2);
  });
});

describe('unionRoutes', () => {
  test('unions a real name group in official MTA route order', () => {
    const stations = ['232', '423'].map(id => getStationById(id)).filter(s => s !== undefined);
    expect(unionRoutes(stations)).toEqual(['2', '3', '4', '5']);
  });

  test('orders complex multi-line groups by route sort order, not station order', () => {
    const stations = [station('x1', 'Test Plaza', ['6', '4', '5']), station('x2', 'Test Plaza', ['N', 'A', 'C'])];
    expect(unionRoutes(stations)).toEqual(['4', '5', '6', 'A', 'C', 'N']);
  });
});

describe('serializeStations', () => {
  test('joins ids with commas in order', () => {
    expect(serializeStations(['127', '635'])).toBe('127,635');
  });

  test('dedupes while keeping first-seen order', () => {
    expect(serializeStations(['635', '127', '635'])).toBe('635,127');
  });

  test('trims surrounding whitespace and drops empties', () => {
    expect(serializeStations([' 127 ', '', '635'])).toBe('127,635');
  });

  test('serializes to an empty string when nothing is selected', () => {
    expect(serializeStations([])).toBe('');
  });

  test('round-trips with the board config parser', () => {
    const ids = ['127', '635', '902'];
    expect(parseStationIds(serializeStations(ids))).toEqual(ids);
  });
});
