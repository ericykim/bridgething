import { describe, expect, test } from 'bun:test';
import { FOLLOWING_CAP, buildRows, minutesUntil, type BoardRow } from './board.ts';
import type { Arrival } from './feeds.ts';

const min = (offsetMinutes: number) => new Date(BASE + offsetMinutes * 60_000);
const BASE = Date.UTC(2026, 8, 9, 12, 0, 0);

function arrival(
  routeId: string,
  direction: 'N' | 'S',
  offsetMinutes: number,
  headsign = `${routeId} headsign`,
): Arrival {
  return { routeId, headsign, direction, arrivalAt: min(offsetMinutes), tripId: `${routeId}-${offsetMinutes}` };
}

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

  test('the headsign comes from the next train', () => {
    const rows = buildRows(
      [arrival('6', 'N', 3, 'Pelham Bay Park'), arrival('6', 'N', 7, ' somewhere else ')],
      'N',
    );
    expect((rows[0] as BoardRow).headsign).toBe('Pelham Bay Park');
  });
});
