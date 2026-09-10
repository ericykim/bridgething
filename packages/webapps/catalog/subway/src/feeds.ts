/**
 * MTA GTFS-Realtime feed pipeline: fetch the trip-updates feeds that cover the
 * configured lines, decode the protobuf, and reduce to a lightweight Arrival
 * list. Protobuf decoding uses the descriptor generated from the standard
 * gtfs-realtime.proto plus MTA's NYCT extensions (see scripts/generate-fixtures.ts
 * for regeneration and src/fixtures/ for checked-in wire fixtures).
 */

import protobuf from 'protobufjs';
import descriptor from './proto/gtfsrt-descriptor.json';
import { getStationById, headsignForTrip, type Direction } from './static-data';

export const FEED_BASE_URL = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds';

/** MTA's eight subway trip-updates feed groups. */
export type FeedGroup = 'gtfs' | 'ace' | 'bdfm' | 'g' | 'jz' | 'l' | 'nqrw' | 'si';

export const FEED_GROUPS: FeedGroup[] = ['gtfs', 'ace', 'bdfm', 'g', 'jz', 'l', 'nqrw', 'si'];

/** GTFS-RT ScheduleRelationship enum: SKIPPED; protobufjs decodes enums as numbers. */
const SCHEDULE_RELATIONSHIP_SKIPPED = 1;

/**
 * Route id -> feed group, per MTA's documented grouping. The shuttles ride
 * with the trunk lines they connect to: GS with the numbered routes, H with
 * the ACE line, FS with the BDFM line.
 */
const ROUTE_FEED_GROUP: Record<string, FeedGroup> = {
  '1': 'gtfs', '2': 'gtfs', '3': 'gtfs', '4': 'gtfs', '5': 'gtfs', '6': 'gtfs', '7': 'gtfs', GS: 'gtfs',
  A: 'ace', C: 'ace', E: 'ace', H: 'ace',
  B: 'bdfm', D: 'bdfm', F: 'bdfm', M: 'bdfm', FS: 'bdfm',
  G: 'g',
  J: 'jz', Z: 'jz',
  L: 'l',
  N: 'nqrw', Q: 'nqrw', R: 'nqrw', W: 'nqrw',
  SI: 'si',
};

export function feedGroupForRoute(routeId: string): FeedGroup | undefined {
  return ROUTE_FEED_GROUP[routeId];
}

/** The feed groups needed to cover the given route ids. */
export function feedGroupsForRoutes(routeIds: string[]): FeedGroup[] {
  const groups = new Set<FeedGroup>();
  for (const routeId of routeIds) {
    const group = ROUTE_FEED_GROUP[routeId];
    if (group) groups.add(group);
  }
  return FEED_GROUPS.filter((g) => groups.has(g));
}

export function feedUrl(group: FeedGroup): string {
  const feed = group === 'gtfs' ? 'nyct%2Fgtfs' : `nyct%2Fgtfs-${group}`;
  return `${FEED_BASE_URL}/${feed}`;
}

export interface Arrival {
  routeId: string;
  headsign: string;
  direction: Direction;
  arrivalAt: Date;
  tripId: string;
}

export const POLL_INTERVAL_MS = 30_000;
/** Three missed polls without a good one renders the board stale; derives from
 * the cadence so a cadence flip (e.g. 30 s to 60 s for BT contention) drags the
 * staleness window along instead of pinning the board as permanently old. */
export const STALE_AFTER_MS = 3 * POLL_INTERVAL_MS;
/** Max arrivals kept per route and direction (chips row plus buffer). */
export const ARRIVALS_CAP = 8;

const root = protobuf.Root.fromJSON(descriptor);
const FeedMessageType = root.lookupType('transit_realtime.FeedMessage');

/** Decoded shape we rely on; protobufjs may hand back 64-bit ints as Long instances. */
export type FeedMessage = {
  header: { timestamp?: LongLike | number | string | null };
  entity: Array<{
    id?: string | null;
    isDeleted?: boolean | null;
    tripUpdate?: {
      trip?: { tripId?: string | null; routeId?: string | null; directionId?: number | null } | null;
      stopTimeUpdate?: Array<{
        stopId?: string | null;
        arrival?: { time?: LongLike | number | string | null } | null;
        departure?: { time?: LongLike | number | string | null } | null;
        scheduleRelationship?: ('SCHEDULED' | 'SKIPPED' | 'NO_DATA' | number) | null;
      }> | null;
    } | null;
  }>;
};

interface LongLike {
  toNumber?: () => number;
}

/** protobufjs decodes 64-bit ints as Long objects when long.js is present, numbers otherwise. */
function toEpochMs(value: LongLike | number | string | null | undefined): number | null {
  if (value == null) return null;
  const seconds = typeof value === 'object' && value.toNumber ? value.toNumber() : Number(value);
  if (!Number.isFinite(seconds)) return null;
  const ms = seconds * 1000;
  return Number.isFinite(ms) ? ms : null;
}

export function decodeFeedMessage(bytes: Uint8Array): FeedMessage {
  return FeedMessageType.decode(bytes) as unknown as FeedMessage;
}

export type PlatformLookup = Map<string, { stationId: string; direction: Direction }>;

/** Platform index over the bundled stations: platform stop id -> station + direction. */
export function buildPlatformIndex(stationIds: string[]): PlatformLookup {
  const index: PlatformLookup = new Map();
  for (const id of stationIds) {
    const station = getStationById(id);
    if (!station) continue;
    for (const dir of ['N', 'S'] as const) {
      index.set(station.platforms[dir], { stationId: id, direction: dir });
    }
  }
  return index;
}

/**
 * Extract arrivals from a decoded trip-updates feed. Only stop_time_updates
 * matching one of the indexed platform ids produce arrivals, and only the
 * first matching stop per trip (that is the stop the train reaches next, and
 * it fixes the trip's direction).
 */
export function extractArrivals(
  feed: FeedMessage,
  platformIndex: PlatformLookup,
): Arrival[] {
  const byRouteDirection = new Map<string, Arrival[]>();
  for (const entity of feed.entity) {
    const tripUpdate = entity.tripUpdate;
    if (!tripUpdate || entity.isDeleted) continue;
    const tripId = tripUpdate.trip?.tripId;
    const routeId = tripUpdate.trip?.routeId;
    if (!tripId || !routeId) continue;

    for (const stopTime of tripUpdate.stopTimeUpdate ?? []) {
      if (typeof stopTime.scheduleRelationship === 'string'
        ? stopTime.scheduleRelationship === 'SKIPPED'
        : stopTime.scheduleRelationship === SCHEDULE_RELATIONSHIP_SKIPPED) continue;
      const platform = stopTime.stopId ? platformIndex.get(stopTime.stopId) : undefined;
      if (!platform) continue;
      const ms = toEpochMs(stopTime.arrival?.time ?? stopTime.departure?.time);
      if (ms === null) continue;

      const key = `${routeId}:${platform.direction}`;
      let list = byRouteDirection.get(key);
      if (!list) byRouteDirection.set(key, (list = []));
      list.push({
        routeId,
        headsign: headsignForTrip(tripId, { routeId, direction: platform.direction }) ?? routeId,
        direction: platform.direction,
        arrivalAt: new Date(ms),
        tripId,
      });
      break;
    }
  }

  // dedupe per trip (a trip can appear twice via multiple entities), keep the
  // earliest arrival, cap each route+direction, then order everything by time
  const arrivals: Arrival[] = [];
  for (const list of byRouteDirection.values()) {
    const earliestByTrip = new Map<string, Arrival>();
    for (const arrival of list) {
      const known = earliestByTrip.get(arrival.tripId);
      if (!known || arrival.arrivalAt < known.arrivalAt) earliestByTrip.set(arrival.tripId, arrival);
    }
    arrivals.push(
      ...[...earliestByTrip.values()]
        .sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime())
        .slice(0, ARRIVALS_CAP),
    );
  }
  return arrivals.sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime());
}

export class ApiKeyError extends Error {
  constructor() {
    super('mta rejected the api key - check your api key in the companion settings');
    this.name = 'ApiKeyError';
  }
}

export type FeedHealth = {
  /** When the last successful decode finished, or null before the first success. */
  lastGoodAt: number | null;
  /** When the last poll attempt finished, whatever the outcome. */
  lastAttemptAt: number | null;
};

export function isStale(health: FeedHealth, now: number): boolean {
  return health.lastGoodAt === null || now - health.lastGoodAt > STALE_AFTER_MS;
}

export type PollOutcome =
  | { kind: 'arrivals'; group: FeedGroup; arrivals: Arrival[] }
  | { kind: 'api-key'; group: FeedGroup }
  | { kind: 'error'; group: FeedGroup };

/** Transport for one feed fetch: returns the raw protobuf body or throws. */
export type FetchFeed = (url: string, apiKey: string) => Promise<Uint8Array>;

export interface PollerState {
  arrivals: Arrival[];
  health: Map<FeedGroup, FeedHealth>;
  /** True once any feed answered 401/403; the UI points at the settings page. */
  apiKeyInvalid: boolean;
}

/**
 * Polls the configured feed groups on a fixed cadence. A group whose previous
 * fetch is still in flight is skipped. Fetch/decode failures keep the previous
 * arrivals and retry on the next tick; a 401/403 surfaces as apiKeyInvalid.
 */
export class FeedPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<FeedGroup>();
  private arrivals: Arrival[] = [];
  private healthByGroup = new Map<FeedGroup, FeedHealth>();
  private apiKeyInvalid = false;

  constructor(
    private readonly groups: FeedGroup[],
    private readonly platformIndex: PlatformLookup,
    private readonly apiKey: string,
    private readonly fetchFeed: FetchFeed,
    private readonly onChange?: (state: PollerState) => void,
  ) {
    for (const group of groups) {
      this.healthByGroup.set(group, { lastGoodAt: null, lastAttemptAt: null });
    }
  }

  get state(): PollerState {
    const health = new Map<FeedGroup, FeedHealth>();
    for (const [group, h] of this.healthByGroup) health.set(group, { ...h });
    return { arrivals: [...this.arrivals], health, apiKeyInvalid: this.apiKeyInvalid };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollAll(), POLL_INTERVAL_MS);
    void this.pollAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollAll(): Promise<PollOutcome[]> {
    const outcomes = await Promise.all(this.groups.map((group) => this.pollOne(group)));
    return outcomes;
  }

  private async pollOne(group: FeedGroup): Promise<PollOutcome> {
    if (this.inFlight.has(group)) return { kind: 'error', group };
    this.inFlight.add(group);
    const health = this.healthByGroup.get(group)!;
    try {
      const bytes = await this.fetchFeed(feedUrl(group), this.apiKey);
      const feed = decodeFeedMessage(bytes);
      const groupArrivals = extractArrivals(feed, this.platformIndex);
      health.lastGoodAt = Date.now();
      health.lastAttemptAt = health.lastGoodAt;
      this.arrivals = this.mergedArrivals(group, groupArrivals);
      this.onChange?.(this.state);
      return { kind: 'arrivals', group, arrivals: groupArrivals };
    } catch (err) {
      health.lastAttemptAt = Date.now();
      if (err instanceof ApiKeyError) this.apiKeyInvalid = true;
      this.onChange?.(this.state);
      return err instanceof ApiKeyError ? { kind: 'api-key', group } : { kind: 'error', group };
    } finally {
      this.inFlight.delete(group);
    }
  }

  /** Replaces one group's slice of the arrival list, keeping the list sorted by time. */
  private mergedArrivals(group: FeedGroup, groupArrivals: Arrival[]): Arrival[] {
    const kept = this.arrivals.filter((a) => feedGroupForRoute(a.routeId) !== group);
    return [...kept, ...groupArrivals].sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime());
  }
}
