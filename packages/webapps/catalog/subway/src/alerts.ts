/**
 * MTA service alerts: fetch the camsys/subway-alerts GTFS-Realtime feed on a
 * slower cadence than trip updates (the alerts feed is a full-dataset snapshot,
 * ~435 KB), decode with the same compiled gtfs-realtime descriptor, and match
 * alerts onto configured lines. Standard GTFS-RT alert fields are enough for
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

/**
 * Match active alerts against the configured stations. Route selectors match
 * directly against the lines the stations serve. A stop/complex-only alert
 * (no route selectors) falls back to the routes serving the stop's station.
 * Alerts touching none of the configured stations have no row to sit on and
 * come back in `screenLevel` for the banner.
 */
export function matchAlerts(
  active: TransitAlert[],
  stationIds: string[],
): { byRoute: Map<string, TransitAlert[]>; screenLevel: TransitAlert[] } {
  const configuredRoutes = new Set<string>();
  const platformToStation = new Map<string, string>();
  for (const id of stationIds) {
    const station = getStationById(id);
    if (!station) continue;
    for (const routeId of station.routes) configuredRoutes.add(routeId);
    platformToStation.set(station.platforms.N, station.id);
    platformToStation.set(station.platforms.S, station.id);
  }

  const byRoute = new Map<string, TransitAlert[]>();
  const screenLevel: TransitAlert[] = [];
  for (const alert of active) {
    const touched = new Set<string>();
    for (const routeId of alert.routeIds) {
      if (configuredRoutes.has(routeId)) touched.add(routeId);
    }
    if (touched.size === 0) {
      // station-level fallback: a stop/complex-only alert attributes to the
      // routes serving that station (first matching platform wins)
      for (const stopId of alert.stopIds) {
        const stationId = platformToStation.get(stopId);
        if (!stationId) continue;
        for (const routeId of getStationById(stationId)?.routes ?? []) touched.add(routeId);
        break;
      }
    }
    if (touched.size === 0) {
      screenLevel.push(alert);
    } else {
      for (const routeId of touched) {
        let list = byRoute.get(routeId);
        if (!list) byRoute.set(routeId, (list = []));
        list.push(alert);
      }
    }
  }
  return { byRoute, screenLevel };
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
    private readonly apiKey: string,
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
      const bytes = await this.fetchFeed(ALERTS_FEED_URL, this.apiKey);
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
      // keep previous good alerts; retry on the next tick. A key rejected by
      // the alerts feed specifically is not surfaced (unlike FeedPoller's
      // ApiKeyError) — alerts are auxiliary and the arrivals feeds share the
      // key, so the board footer already points at the settings page.
      this.onChange?.(this.state);
    } finally {
      this.inFlight = false;
    }
  }
}
