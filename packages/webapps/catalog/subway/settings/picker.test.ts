import { describe, expect, test } from 'bun:test';
import { parseStationIds } from '../src/config.ts';
import { searchStations, serializeStations } from './picker.ts';

describe('searchStations', () => {
  test('finds stations by exact id first', () => {
    const results = searchStations('127');
    expect(results[0]?.id).toBe('127');
    expect(results[0]?.name).toBe('Times Sq-42 St');
  });

  test('finds stations by id prefix', () => {
    const results = searchStations('90');
    expect(results.map(s => s.id)).toContain('901');
    expect(results.map(s => s.id)).toContain('902');
  });

  test('finds stations by name and ranks them like the shared search', () => {
    const results = searchStations('union sq');
    expect(results.map(s => s.id)).toContain('635');
  });

  test('name and id matches are deduped', () => {
    const results = searchStations('127');
    const ids = results.map(s => s.id);
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
