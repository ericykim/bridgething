/**
 * MTA service alerts: fetch the camsys/subway-alerts GTFS-Realtime feed on a
 * slower cadence than trip updates (the alerts feed is a full-dataset snapshot,
 * ~435 KB), decode with the same compiled gtfs-realtime descriptor, and match
 * alerts onto the configured stations (station-level) and their lines (row-level). Standard GTFS-RT alert fields are enough for
 * the indicator + text; Mercury's rich-text extensions are ignored.
 */

import {
  FEED_BASE_URL,
  type FetchFeed,
  type FeedMessage,
  decodeFeedMessage,
} from './feeds.ts';
import { getStationById } from './static-data';

export type { FetchFeed };

/** The single MTA subway service-alerts feed (all lines, one snapshot). */
export const ALERTS_FEED_URL = `${FEED_BASE_URL}/camsys%2Fsubway-alerts`;

/** Alerts refresh every 3 minutes — inside the planned 2-5 min window, well above the 30 s arrivals cadence. */
export const ALERT_POLL_INTERVAL_MS = 3 * 60_000;

export interface TransitAlert {
  id: string;
  /** route ids from informed_entity selectors (possibly none for stop-only alerts) */
  routeIds: string[];
  /** stop ids from informed_entity selectors; feeds the station-level fallback match */
  stopIds: string[];
  /** half-open [start, end) windows in epoch ms; null side means open-ended */
  activePeriods: Array<{ start: number | null; end: number | null }>;
  headerText: string | null;
  descriptionText: string | null;
}

type Translation = { text?: string | null } | null | undefined;
type RawAlert = {
  informedEntity?: Array<{ routeId?: string | null; stopId?: string | null }> | null;
  activePeriod?: Array<{ start?: string | number | null; end?: string | number | null }> | null;
  headerText?: { translation?: Translation[] | null } | null;
  descriptionText?: { translation?: Translation[] | null } | null;
} | null;

function firstTranslation(text: { translation?: Translation[] | null } | null | undefined): string | null {
  for (const t of text?.translation ?? []) {
    if (t?.text) return t.text;
  }
  return null;
}

function toEpochMsOrNull(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const ms = Number(value) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

/** Reduce a decoded FeedMessage to our lightweight alert shape, skipping deleted/empty entities. */
export function extractAlerts(feed: FeedMessage): TransitAlert[] {
  const alerts: TransitAlert[] = [];
  for (const entity of feed.entity) {
    if (entity.isDeleted) continue;
    const raw = (entity as { alert?: RawAlert }).alert;
    if (!raw) continue;
    const routeIds: string[] = [];
    const stopIds: string[] = [];
    for (const sel of raw.informedEntity ?? []) {
      if (sel?.routeId) routeIds.push(sel.routeId);
      if (sel?.stopId) stopIds.push(sel.stopId);
    }
    alerts.push({
      id: entity.id ?? '',
      routeIds,
      stopIds,
      activePeriods: (raw.activePeriod ?? []).map((p) => ({
        start: toEpochMsOrNull(p.start),
        end: toEpochMsOrNull(p.end),
      })),
      headerText: firstTranslation(raw.headerText),
      descriptionText: firstTranslation(raw.descriptionText),
    });
  }
  return alerts;
}

/** Alerts in effect at `now`: no active_period means always active; a window is half-open [start, end). */
export function activeAlerts(alerts: TransitAlert[], now: number): TransitAlert[] {
  return alerts.filter((a) =>
    a.activePeriods.length === 0 ||
    a.activePeriods.some((p) => (p.start == null || p.start <= now) && (p.end == null || now < p.end)),
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Compact local timestamp, e.g. "Fri Sep 25 9:45 PM". Local device time: the
 * windows are enforcement windows (roughly 10:45 PM to 5 AM) and riders think
 * in local time. */
function formatMoment(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${h}:${min} ${ampm}`;
}

/**
 * Every active window as compact local timestamps, e.g.
 * "Fri Sep 25 10:45 PM - Mon Sep 28 5:00 AM" (joined by ", " when the alert
 * has several). Open-ended sides render as "from X" / "until Y"; an alert
 * with no windows (always active) returns null.
 */
export function formatActivePeriods(alert: TransitAlert): string | null {
  const parts: string[] = [];
  for (const p of alert.activePeriods) {
    const start = p.start == null ? null : formatMoment(p.start);
    const end = p.end == null ? null : formatMoment(p.end);
    if (start && end) parts.push(`${start} - ${end}`);
    else if (start) parts.push(`from ${start}`);
    else if (end) parts.push(`until ${end}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Match active alerts against the configured stations. A stop selector naming
 * one of the configured stations makes the alert station-level — it is about
 * that station and surfaces above all rows. Otherwise route selectors match
 * against the lines the stations serve and the alert rides the matching rows.
 * Alerts touching none of the configured stations (or their lines) are
 * unrelated and simply not returned.
 */
export interface MatchedAlerts {
  /** line-level alerts keyed by route id; rendered on that route's row */
  byRoute: Map<string, TransitAlert[]>;
  /** station-level alerts; rendered above all rows */
  stationLevel: TransitAlert[];
}

export function matchAlerts(
  active: TransitAlert[],
  stationIds: string[],
): MatchedAlerts {
  const configuredRoutes = new Set<string>();
  // station ids and platform stop ids both count: feeds tag elevator-style
  // notices with the complex id but trip-level selectors with platform ids
  const configuredStops = new Set<string>();
  for (const id of stationIds) {
    const station = getStationById(id);
    if (!station) continue;
    for (const routeId of station.routes) configuredRoutes.add(routeId);
    configuredStops.add(station.id);
    configuredStops.add(station.platforms.N);
    configuredStops.add(station.platforms.S);
  }

  const byRoute = new Map<string, TransitAlert[]>();
  const stationLevel: TransitAlert[] = [];
  for (const alert of active) {
    if (alert.stopIds.some((stopId) => configuredStops.has(stopId))) {
      stationLevel.push(alert);
      continue;
    }
    for (const routeId of new Set(alert.routeIds)) {
      if (!configuredRoutes.has(routeId)) continue;
      let list = byRoute.get(routeId);
      if (!list) byRoute.set(routeId, (list = []));
      list.push(alert);
    }
  }
  return { byRoute, stationLevel };
}

export interface AlertState {
  alerts: TransitAlert[];
  /** When the last successful decode finished, or null before the first success. */
  lastGoodAt: number | null;
}

/**
 * Polls the alerts feed on the slow cadence. Failures and malformed data keep
 * the previous good alerts and retry silently on the next tick; a poll whose
 * previous fetch is still in flight is skipped.
 */
export class AlertPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private alerts: TransitAlert[] = [];
  private lastGoodAt: number | null = null;

  constructor(
    private readonly fetchFeed: FetchFeed,
    private readonly onChange?: (state: AlertState) => void,
  ) {}

  get state(): AlertState {
    return { alerts: [...this.alerts], lastGoodAt: this.lastGoodAt };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollAll(), ALERT_POLL_INTERVAL_MS);
    void this.pollAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollAll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const bytes = await this.fetchFeed(ALERTS_FEED_URL);
      const feed = decodeFeedMessage(bytes);
      const extracted = extractAlerts(feed);
      // dedupe repeated entities by alert id, first wins; entities without an
      // id (never seen on real MTA data) are all kept rather than collapsed
      const byId = new Map<string, TransitAlert>();
      for (const a of extracted) {
        if (!a.id || !byId.has(a.id)) byId.set(a.id, a);
      }
      this.alerts = [...byId.values()];
      this.lastGoodAt = Date.now();
      this.onChange?.(this.state);
    } catch {
      // keep previous good alerts; retry on the next tick.
      this.onChange?.(this.state);
    } finally {
      this.inFlight = false;
    }
  }
}
