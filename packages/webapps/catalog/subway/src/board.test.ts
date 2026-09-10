import { describe, expect, test } from 'bun:test';
import { FOLLOWING_CAP, buildRows, minutesUntil, scrollDeltaForKey, type BoardRow } from './board.ts';
import { getStationById } from './static-data.ts';
import type { Arrival } from './feeds.ts';
import type { TransitAlert } from './alerts.ts';

const alert = (id: string, routeIds: string[], headerText = `${id} text`): TransitAlert => ({
  id,
  routeIds,
  stopIds: [],
  activePeriods: [],
  headerText,
  descriptionText: null,
});
const noAlerts = new Map<string, TransitAlert[]>();

const min = (offsetMinutes: number) => new Date(BASE + offsetMinutes * 60_000);
const BASE = Date.UTC(2026, 8, 9, 12, 0, 0);

function arrival(
  routeId: string,
  direction: 'N' | 'S',
  offsetMinutes: number,
  headsign = `${routeId} headsign`,
  stationId = '127',
): Arrival {
  return { routeId, headsign, direction, arrivalAt: min(offsetMinutes), tripId: `${routeId}-${offsetMinutes}`, stationId };
}

describe('scrollDeltaForKey', () => {
  test('ArrowDown steps down by about a viewport', () => {
    expect(scrollDeltaForKey('ArrowDown', 400)).toBe(320);
  });

  test('ArrowUp steps up by the same magnitude', () => {
    expect(scrollDeltaForKey('ArrowUp', 400)).toBe(-320);
  });

  test('small viewports still step', () => {
    expect(scrollDeltaForKey('ArrowDown', 10)).toBe(8);
  });

  test('non-wheel keys produce no delta', () => {
    expect(scrollDeltaForKey('Enter', 400)).toBeNull();
    expect(scrollDeltaForKey('PageDown', 400)).toBeNull();
    expect(scrollDeltaForKey('a', 400)).toBeNull();
  });
});

describe('minutesUntil', () => {
  test('rounds up to the next whole minute', () => {
    expect(minutesUntil(new Date(BASE + 90_000), BASE)).toBe(2);
    expect(minutesUntil(new Date(BASE + 61_000), BASE)).toBe(2);
  });

  test('an exact minute boundary stays exact', () => {
    expect(minutesUntil(new Date(BASE + 60_000), BASE)).toBe(1);
  });

  test('an arrival in the past clamps at zero', () => {
    expect(minutesUntil(new Date(BASE - 5_000), BASE)).toBe(0);
    expect(minutesUntil(new Date(BASE), BASE)).toBe(0);
  });
});

describe('buildRows', () => {
  test('one row per route: next train first, following trains after, both ascending', () => {
    const rows = buildRows(
      [
        arrival('6', 'N', 10),
        arrival('6', 'N', 3),
        arrival('6', 'N', 7),
        arrival('L', 'N', 5),
      ],
      'N',
    );
    expect(rows.map((r) => r.routeId)).toEqual(['6', 'L']);
    const six = rows[0] as BoardRow;
    expect(six.next.tripId).toBe('6-3');
    expect(six.following.map((a) => a.tripId)).toEqual(['6-7', '6-10']);
  });

  test('rows are sorted across routes by soonest arrival', () => {
    const rows = buildRows([arrival('6', 'N', 12), arrival('L', 'N', 4), arrival('A', 'N', 8)], 'N');
    expect(rows.map((r) => r.routeId)).toEqual(['L', 'A', '6']);
  });

  test('trains on the other direction are dropped', () => {
    const rows = buildRows([arrival('6', 'S', 3), arrival('6', 'N', 9), arrival('L', 'S', 1)], 'N');
    expect(rows.map((r) => r.routeId)).toEqual(['6']);
  });

  test('the station subtitle is the next arriving train\'s station', () => {
    // Van Cortlandt Park-242 St (127) is the bundled name for station 127;
    // a row whose next train leaves 635 shows that station instead
    const from127 = buildRows([arrival('1', 'N', 5)], 'N', noAlerts);
    expect(from127[0]!.stationName).toBe(getStationById('127')!.name);
    const from635 = buildRows([arrival('6', 'N', 5, undefined, '635')], 'N', noAlerts);
    expect(from635[0]!.stationName).toBe(getStationById('635')!.name);
  });

  test('an unknown station id renders a null subtitle', () => {
    const rows = buildRows([arrival('1', 'N', 5, undefined, 'nonexistent')], 'N', noAlerts);
    expect(rows[0]!.stationName).toBeNull();
  });

  test('routes with no upcoming trains in the shown direction are hidden', () => {
    const rows = buildRows([arrival('6', 'S', 3), arrival('L', 'S', 1)], 'N');
    expect(rows).toEqual([]);
  });

  test('following-train chips are capped', () => {
    const many = Array.from({ length: FOLLOWING_CAP + 5 }, (_, i) => arrival('6', 'N', i + 1));
    const rows = buildRows(many, 'N');
    expect(rows).toHaveLength(1);
    expect((rows[0] as BoardRow).following).toHaveLength(FOLLOWING_CAP);
  });

  test('rows carry the official route color from the static bundle', () => {
    const rows = buildRows([arrival('6', 'N', 3), arrival('L', 'N', 5)], 'N');
    const six = rows.find((r) => r.routeId === '6') as BoardRow;
    const el = rows.find((r) => r.routeId === 'L') as BoardRow;
    expect(six.color).toBe('009952'); // official MTA green for the 6, from the static bundle
    expect(el.color).toBe('7C858C'); // official MTA gray for the L, from the static bundle
    expect(six.textColor).toBe('FFFFFF');
  });

  test('an unknown route still renders with a null color rather than crashing', () => {
    const rows = buildRows([arrival('XX', 'N', 3)], 'N');
    expect(rows).toHaveLength(1);
    expect((rows[0] as BoardRow).color).toBeNull();
  });

  test('a row carries the active alerts for its line', () => {
    const alerts = new Map<string, TransitAlert[]>([
      ['6', [alert('a', ['6']), alert('b', ['6'])]],
      ['L', [alert('c', ['L', '1'])]],
    ]);
    const rows = buildRows([arrival('6', 'N', 3), arrival('L', 'N', 5)], 'N', alerts);
    expect(rows.map((r) => r.alerts.map((a) => a.id))).toEqual([['a', 'b'], ['c']]);
    expect((rows[0] as BoardRow).alerts[0]!.headerText).toBe('a text');
  });

  test('rows without alerts carry an empty list when no alerts are passed', () => {
    const rows = buildRows([arrival('6', 'N', 3)], 'N');
    expect((rows[0] as BoardRow).alerts).toEqual([]);
    const withNone = buildRows([arrival('6', 'N', 3)], 'N', noAlerts);
    expect((withNone[0] as BoardRow).alerts).toEqual([]);
  });

  test('the headsign comes from the next train', () => {
    const rows = buildRows(
      [arrival('6', 'N', 3, 'Pelham Bay Park'), arrival('6', 'N', 7, ' somewhere else ')],
      'N',
    );
    expect((rows[0] as BoardRow).headsign).toBe('Pelham Bay Park');
  });
});
