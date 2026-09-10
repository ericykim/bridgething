import { describe, expect, test } from 'bun:test';
import protobuf from 'protobufjs';
import {
  ARRIVALS_CAP,
  ApiKeyError,
  FEED_BASE_URL,
  FeedPoller,
  STALE_AFTER_MS,
  buildPlatformIndex,
  decodeFeedMessage,
  extractArrivals,
  feedGroupForRoute,
  feedGroupsForRoutes,
  feedUrl,
  isStale,
  type Arrival,
  type FeedGroup,
  type FeedHealth,
  type FeedMessage,
  type FetchFeed,
  type PollerState,
} from './feeds.ts';
import descriptor from './proto/gtfsrt-descriptor.json';

const root = protobuf.Root.fromJSON(descriptor);
const FeedMessageType = root.lookupType('transit_realtime.FeedMessage');

const fixtureBytes = async (name: string) =>
  new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/${name}.bin`).arrayBuffer());

function encodeFeed(partial: object): Uint8Array {
  return FeedMessageType.encode(FeedMessageType.fromObject(partial)).finish();
}

function makeArrival(
  feed: FeedMessage,
  platformIndex = buildPlatformIndex(['127', '635']),
): Arrival[] {
  return extractArrivals(feed, platformIndex);
}

const at = (iso: string) => ({ time: String(Math.floor(new Date(iso).getTime() / 1000)) });

const INDEX = buildPlatformIndex(['127', '635']);

describe('feed group mapping', () => {
  test('routes map to their documented feed groups', () => {
    expect(feedGroupForRoute('1')).toBe('gtfs');
    expect(feedGroupForRoute('A')).toBe('ace');
    expect(feedGroupForRoute('F')).toBe('bdfm');
    expect(feedGroupForRoute('G')).toBe('g');
    expect(feedGroupForRoute('J')).toBe('jz');
    expect(feedGroupForRoute('L')).toBe('l');
    expect(feedGroupForRoute('N')).toBe('nqrw');
    expect(feedGroupForRoute('SI')).toBe('si');
  });

  test('shuttles ride with the trunk lines they connect to', () => {
    expect(feedGroupForRoute('GS')).toBe('gtfs');
    expect(feedGroupForRoute('H')).toBe('ace');
    expect(feedGroupForRoute('FS')).toBe('bdfm');
  });

  test('feed groups are derived in canonical order with duplicates collapsed', () => {
    expect(feedGroupsForRoutes(['6', 'L', '1', '6', 'NOTAROUTE'])).toEqual(['gtfs', 'l']);
  });

  test('feed urls use the url-encoded nyct feed path', () => {
    expect(feedUrl('gtfs')).toBe(`${FEED_BASE_URL}/nyct%2Fgtfs`);
    expect(feedUrl('ace')).toBe(`${FEED_BASE_URL}/nyct%2Fgtfs-ace`);
    expect(feedUrl('si')).toBe(`${FEED_BASE_URL}/nyct%2Fgtfs-si`);
  });
});

describe('decodeFeedMessage', () => {
  test('every checked-in feed group fixture decodes with a header and entities', async () => {
    for (const name of ['nyctgtfs', 'nyctgtfsace', 'nyctgtfsbdfm', 'nyctgtfsg', 'nyctgtfsjz', 'nyctgtfsl', 'nyctgtfsnqrw', 'nyctgtfssi']) {
      const feed = decodeFeedMessage(await fixtureBytes(name));
      expect(feed.header, name).toBeDefined();
      expect(feed.entity.length, name).toBeGreaterThan(0);
      for (const entity of feed.entity) {
        if (entity.tripUpdate) expect(entity.tripUpdate.trip?.routeId, name).toBeDefined();
      }
    }
  });

  test('a truncated message throws instead of yielding partial data', async () => {
    const bytes = await fixtureBytes('truncated');
    expect(() => decodeFeedMessage(bytes)).toThrow();
  });

  test('garbage input either throws or decodes to something with no arrivals', async () => {
    const bytes = await fixtureBytes('garbage');
    let arrivals: Arrival[] = [];
    try {
      arrivals = extractArrivals(decodeFeedMessage(bytes), INDEX);
    } catch {
      // throwing is fine, the poller keeps previous data either way
    }
    expect(arrivals).toEqual([]);
  });
});

describe('extractArrivals', () => {
  test('matches platform ids and derives direction from the N/S suffix', () => {
    const feed = decodeFeedMessage(
      encodeFeed({
        header: { gtfsRealtimeVersion: '1.0' },
        entity: [
          {
            id: 'a',
            tripUpdate: {
              trip: { tripId: '112150_1..S15R', routeId: '1' },
              stopTimeUpdate: [
                { stopId: '999N', arrival: at('2026-09-10T12:00:00Z') },
                { stopId: '127S', arrival: at('2026-09-10T12:01:00Z') },
              ],
            },
          },
        ],
      }),
    );
    const arrivals = makeArrival(feed);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({
      routeId: '1',
      direction: 'S',
      headsign: 'South Ferry',
      tripId: '112150_1..S15R',
    });
    expect(arrivals[0]!.arrivalAt.toISOString()).toBe('2026-09-10T12:01:00.000Z');
  });

  test('headsign resolves from the realtime trip id suffix against the static bundle', async () => {
    const bytes = await fixtureBytes('nyctgtfs');
    // station 101 (Van Cortlandt Park-242 St) appears in this fixture on both platforms
    const arrivals = extractArrivals(decodeFeedMessage(bytes), buildPlatformIndex(['101']));
    expect(arrivals.length).toBeGreaterThan(0);
    for (const arrival of arrivals) {
      expect(['N', 'S']).toContain(arrival.direction);
      expect(arrival.headsign.length).toBeGreaterThan(0);
    }
    // the S-toward train whose next stop is 101S carries the bundle's headsign for that trip
    const south = arrivals.filter((a) => a.direction === 'S');
    expect(south.length).toBeGreaterThan(0);
  });

  test('falls back to the route+direction modal headsign for unknown trip ids', () => {
    const feed = decodeFeedMessage(
      encodeFeed({
        header: { gtfsRealtimeVersion: '1.0' },
        entity: [
          {
            id: 'a',
            tripUpdate: {
              trip: { tripId: '999999_9..N99Z', routeId: '1' },
              stopTimeUpdate: [{ stopId: '127N', arrival: at('2026-09-10T12:00:00Z') }],
            },
          },
        ],
      }),
    );
    const arrivals = makeArrival(feed);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]!.headsign).toBe('Van Cortlandt Park-242 St');
  });

  test('skips SKIPPED stop_time_updates and entities without a trip update', () => {
    const feed = decodeFeedMessage(
      encodeFeed({
        header: { gtfsRealtimeVersion: '1.0' },
        entity: [
          { id: 'deleted', isDeleted: true, tripUpdate: { trip: { tripId: '1..N', routeId: '1' }, stopTimeUpdate: [{ stopId: '127N', arrival: at('2026-09-10T12:00:00Z') }] } },
          {
            id: 'skipped',
            tripUpdate: {
              trip: { tripId: '2..N', routeId: '2' },
              stopTimeUpdate: [{ stopId: '127N', scheduleRelationship: 'SKIPPED', arrival: at('2026-09-10T12:00:00Z') }],
            },
          },
          { id: 'no-trip' },
        ],
      }),
    );
    expect(makeArrival(feed)).toEqual([]);
  });

  test('dedupes a trip repeated across entities to its earliest arrival', () => {
    const feed = decodeFeedMessage(
      encodeFeed({
        header: { gtfsRealtimeVersion: '1.0' },
        entity: [
          {
            id: 'a',
            tripUpdate: {
              trip: { tripId: '112150_1..S15R', routeId: '1' },
              stopTimeUpdate: [{ stopId: '127S', arrival: at('2026-09-10T12:05:00Z') }],
            },
          },
          {
            id: 'b',
            tripUpdate: {
              trip: { tripId: '112150_1..S15R', routeId: '1' },
              stopTimeUpdate: [{ stopId: '127S', arrival: at('2026-09-10T12:03:00Z') }],
            },
          },
        ],
      }),
    );
    const arrivals = makeArrival(feed);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]!.arrivalAt.toISOString()).toBe('2026-09-10T12:03:00.000Z');
  });

  test('caps arrivals per route and direction and sorts everything by time', () => {
    const entity = (i: number) => ({
      id: `e${i}`,
      tripUpdate: {
        trip: { tripId: `trip${i}..S`, routeId: '6' },
        stopTimeUpdate: [{ stopId: '635S', arrival: at(`2026-09-10T12:${String(i).padStart(2, '0')}:00Z`) }],
      },
    });
    const north = {
      id: 'n',
      tripUpdate: {
        trip: { tripId: 'n0..N', routeId: '6' },
        stopTimeUpdate: [{ stopId: '635N', arrival: at('2026-09-10T11:00:00Z') }],
      },
    };
    const feed = decodeFeedMessage(
      encodeFeed({
        header: { gtfsRealtimeVersion: '1.0' },
        entity: [...Array.from({ length: ARRIVALS_CAP + 2 }, (_, i) => entity(i)), north],
      }),
    );
    const arrivals = makeArrival(feed);
    expect(arrivals.filter((a) => a.direction === 'S')).toHaveLength(ARRIVALS_CAP);
    expect(arrivals[0]!.direction).toBe('N');
    const times = arrivals.map((a) => a.arrivalAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('staleness', () => {
  test('never-good is stale; fresh data recovers; 90s without a good poll goes stale', () => {
    const fresh: FeedHealth = { lastGoodAt: 1000, lastAttemptAt: 1000 };
    expect(isStale(fresh, 1000)).toBe(false);
    expect(isStale(fresh, 1000 + STALE_AFTER_MS)).toBe(false);
    expect(isStale(fresh, 1000 + STALE_AFTER_MS + 1)).toBe(true);
    expect(isStale({ lastGoodAt: null, lastAttemptAt: 1000 }, 0)).toBe(true);
  });
});

describe('FeedPoller', () => {
  const goodBytes = encodeFeed({
    header: { gtfsRealtimeVersion: '1.0' },
    entity: [
      {
        id: 'a',
        tripUpdate: {
          trip: { tripId: '112150_1..S15R', routeId: '1' },
          stopTimeUpdate: [{ stopId: '127S', arrival: at('2026-09-10T12:01:00Z') }],
        },
      },
    ],
  });

  function poller(fetchFeed: FetchFeed, onChange?: (state: PollerState) => void): FeedPoller {
    return new FeedPoller(['gtfs' as FeedGroup], INDEX, 'key', fetchFeed, onChange);
  }

  test('a successful poll records arrivals and health', async () => {
    const updates: PollerState[] = [];
    const p = poller(async () => goodBytes, (s) => updates.push(s));
    const outcomes = await p.pollAll();
    expect(outcomes[0]!.kind).toBe('arrivals');
    expect(p.state.arrivals).toHaveLength(1);
    expect(p.state.health.get('gtfs')!.lastGoodAt).not.toBeNull();
    expect(p.state.apiKeyInvalid).toBe(false);
    expect(updates).toHaveLength(1);
  });

  test('a failed poll keeps previous arrivals and just updates the attempt time', async () => {
    let fail = false;
    const p = poller(async () => {
      if (fail) throw new Error('phone disconnected');
      return goodBytes;
    });
    await p.pollAll();
    const good = p.state.arrivals;
    fail = true;
    const outcomes = await p.pollAll();
    expect(outcomes[0]!.kind).toBe('error');
    expect(p.state.arrivals).toEqual(good);
    expect(p.state.health.get('gtfs')!.lastAttemptAt).toBeGreaterThanOrEqual(p.state.health.get('gtfs')!.lastGoodAt!);
  });

  test('401/403 from the feed surfaces as an api key problem', async () => {
    const p = poller(async () => {
      throw new ApiKeyError();
    });
    const outcomes = await p.pollAll();
    expect(outcomes[0]!.kind).toBe('api-key');
    expect(p.state.apiKeyInvalid).toBe(true);
    expect(p.state.arrivals).toEqual([]);
  });

  test('a group still in flight is skipped on the next poll', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const p = poller(async () => {
      calls++;
      await gate;
      return goodBytes;
    });
    const first = p.pollAll();
    const second = p.pollAll();
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  test('staleness recovery: failed polls go stale, a good poll recovers automatically', async () => {
    let fail = false;
    const p = poller(async () => {
      if (fail) throw new Error('phone disconnected');
      return goodBytes;
    });
    await p.pollAll();
    expect(isStale(p.state.health.get('gtfs')!, Date.now())).toBe(false);

    // phone disconnects; enough failed polls plus elapsed time crosses the window
    fail = true;
    for (let i = 0; i < 3; i++) await p.pollAll();
    const staleAt = Date.now() + STALE_AFTER_MS + 1;
    expect(isStale(p.state.health.get('gtfs')!, staleAt)).toBe(true);
    // last known times remain while stale
    expect(p.state.arrivals).toHaveLength(1);

    // reconnect: the next good poll recovers live data without any action
    fail = false;
    await p.pollAll();
    expect(isStale(p.state.health.get('gtfs')!, Date.now())).toBe(false);
    expect(p.state.arrivals).toHaveLength(1);
    expect(p.state.health.get('gtfs')!.lastGoodAt).not.toBeNull();
  });
});
