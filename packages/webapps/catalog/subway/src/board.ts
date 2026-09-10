/**
 * Board logic: pure derivation of the on-device arrivals board from the feed
 * pipeline's Arrival list. Rendering order, direction filtering, minute
 * countdowns, and the following-train chips all live here so they can be
 * unit-tested without React or the daemon.
 */

import { getRoute, type Direction } from './static-data';
import type { Arrival } from './feeds';
import type { TransitAlert } from './alerts.ts';

/** Max following-train chips rendered on a row (~4-5 fit the row height). */
export const FOLLOWING_CAP = 5;

export type BoardRow = {
  routeId: string;
  /** Official MTA line color without '#', or null when the route is not in the static bundle. */
  color: string | null;
  /** Static-bundle text color paired with `color`, or null. */
  textColor: string | null;
  /** Destination headsign of the next arriving train. */
  headsign: string;
  /** The train the row is counting down to. */
  next: Arrival;
  /** Following trains on this line for the shown direction, soonest first, capped at FOLLOWING_CAP. */
  following: Arrival[];
  /** Active service alerts for this line (indicator + text on the row), empty when none. */
  alerts: TransitAlert[];
};

/** Whole minutes until the train arrives, rounded up, clamped at zero. */
export function minutesUntil(arrivalAt: Date, now: number | Date): number {
  const diff = arrivalAt.getTime() - (now instanceof Date ? now.getTime() : now);
  return Math.max(0, Math.ceil(diff / 60_000));
}

/**
 * Rows for the board, one per line, in the shown direction: next train +
 * capped following trains per route, rows sorted by soonest arrival across
 * all lines. Lines with no upcoming trains in the shown direction are
 * dropped (including lines with no service today).
 */
export function buildRows(
  arrivals: Arrival[],
  direction: Direction,
  alertsByRoute: ReadonlyMap<string, TransitAlert[]> = new Map(),
): BoardRow[] {
  const byRoute = new Map<string, Arrival[]>();
  for (const a of arrivals) {
    if (a.direction !== direction) continue;
    let list = byRoute.get(a.routeId);
    if (!list) byRoute.set(a.routeId, (list = []));
    list.push(a);
  }

  const rows: BoardRow[] = [];
  for (const [routeId, trains] of byRoute) {
    trains.sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime());
    const [next, ...rest] = trains;
    if (!next) continue;
    const route = getRoute(routeId);
    rows.push({
      routeId,
      color: route?.color ?? null,
      textColor: route?.textColor ?? null,
      headsign: next.headsign,
      next,
      following: rest.slice(0, FOLLOWING_CAP),
      alerts: alertsByRoute.get(routeId) ?? [],
    });
  }
  return rows.sort((a, b) => a.next.arrivalAt.getTime() - b.next.arrivalAt.getTime());
}
