import { describe, expect, test } from 'bun:test';
import { configState, parseStationIds } from './config.ts';

describe('parseStationIds', () => {
  test('splits a comma-separated list and trims whitespace', () => {
    expect(parseStationIds(' 635 , 127 , A14 ')).toEqual(['635', '127', 'A14']);
  });

  test('drops empty entries from stray separators', () => {
    expect(parseStationIds('635,,127,')).toEqual(['635', '127']);
  });

  test('dedupes while preserving first-occurrence order', () => {
    expect(parseStationIds('127,635,127')).toEqual(['127', '635']);
  });

  test('returns empty for null, undefined, and blank input', () => {
    expect(parseStationIds(null)).toEqual([]);
    expect(parseStationIds(undefined)).toEqual([]);
    expect(parseStationIds('   ')).toEqual([]);
  });
});

describe('configState', () => {
  test('unconfigured when stations are missing', () => {
    expect(configState(null)).toBe('unconfigured');
    expect(configState(undefined)).toBe('unconfigured');
  });

  test('unconfigured when stations is blank', () => {
    expect(configState('  ')).toBe('unconfigured');
  });

  test('ready when stations is non-empty', () => {
    expect(configState('635,127')).toBe('ready');
  });
});
