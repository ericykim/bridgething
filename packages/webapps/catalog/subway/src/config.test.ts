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
  test('unconfigured when both keys are missing', () => {
    expect(configState({ stations: null, mta_api_key: null })).toBe('unconfigured');
  });

  test('unconfigured when stations is blank', () => {
    expect(configState({ stations: '  ', mta_api_key: 'k' })).toBe('unconfigured');
  });

  test('unconfigured when mta_api_key is missing even with stations', () => {
    expect(configState({ stations: '635', mta_api_key: null })).toBe('unconfigured');
    expect(configState({ stations: '635', mta_api_key: '' })).toBe('unconfigured');
  });

  test('ready when both keys are present', () => {
    expect(configState({ stations: '635,127', mta_api_key: 'k' })).toBe('ready');
  });
});
