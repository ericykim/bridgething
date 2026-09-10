import { describe, expect, test } from 'bun:test';
import protobuf from 'protobufjs';
import {
  ALERTS_FEED_URL,
  ALERT_POLL_INTERVAL_MS,
  AlertPoller,
  activeAlerts,
  extractAlerts,
  matchAlerts,
  type AlertState,
  type FetchFeed,
  type TransitAlert,
} from './alerts.ts';
import { FEED_BASE_URL, POLL_INTERVAL_MS } from './feeds.ts';
import descriptor from './proto/gtfsrt-descriptor.json';

const root = protobuf.Root.fromJSON(descriptor);
const FeedMessageType = root.lookupType('transit_realtime.FeedMessage');

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const sec = (iso: string) => String(Math.floor(new Date(iso).getTime() / 1000));

function encodeAlerts(entities: object[]): Uint8Array {
  return FeedMessageType.encode(
    FeedMessageType.fromObject({ header: { gtfsRealtimeVersion: '1.0' }, entity: entities }),
  ).finish();
}

/** A minimal alert entity; informedEntity entries become route or stop selectors. */
function alertEntity(
  id: string,
  opts: {
    routeIds?: string[];
    stopIds?: string[];
    header?: string;
    description?: string;
    start?: string;
    end?: string;
  } = {},
) {
  return {
    id,
    alert: {
      informedEntity: [
        ...(opts.routeIds ?? []).map((routeId) => ({ routeId })),
        ...(opts.stopIds ?? []).map((stopId) => ({ stopId })),
      ],
      activePeriod: opts.start || opts.end
        ? [{ start: opts.start ? sec(opts.start) : null, end: opts.end ? sec(opts.end) : null }]
        : undefined,
      headerText: opts.header ? { translation: [{ text: opts.header, language: 'en' }] } : undefined,
      descriptionText: opts.description
        ? { translation: [{ text: opts.description, language: 'en' }] }
        : undefined,
    },
  };
}

const decode = (bytes: Uint8Array) => FeedMessageType.decode(bytes) as unknown as Parameters<typeof extractAlerts>[0];

describe('alerts feed', () => {
  test('the alerts feed url is the camsys subway-alerts feed', () => {
    expect(ALERTS_FEED_URL).toBe(`${FEED_BASE_URL}/camsys%2Fsubway-alerts`);
  });

  test('alerts poll on a slower 2-5 minute cadence than arrivals', () => {
    expect(ALERT_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(2 * 60_000);
    expect(ALERT_POLL_INTERVAL_MS).toBeLessThanOrEqual(5 * 60_000);
    expect(ALERT_POLL_INTERVAL_MS).toBeGreaterThan(POLL_INTERVAL_MS);
  });
});

describe('extractAlerts', () => {
  test('extracts id, route ids, and header/description text', () => {
    const feed = decode(
      encodeAlerts([
        alertEntity('alert-1', {
          routeIds: ['1', '2'],
          header: 'Delays',
          description: 'Trains are running with delays.',
        }),
      ]),
    );
    const alerts = extractAlerts(feed);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: 'alert-1',
      routeIds: ['1', '2'],
      stopIds: [],
      headerText: 'Delays',
      descriptionText: 'Trains are running with delays.',
    });
  });

  test('collects stop ids from informed entities for the station-level fallback', () => {
    const feed = decode(encodeAlerts([alertEntity('alert-1', { stopIds: ['127S', '635N'] })]));
    const alerts = extractAlerts(feed);
    expect(alerts[0]!.stopIds).toEqual(['127S', '635N']);
    expect(alerts[0]!.routeIds).toEqual([]);
  });

  test('skips deleted entities and entities without an alert', () => {
    const feed = decode(
      encodeAlerts([
        { id: 'deleted', isDeleted: true, alert: { informedEntity: [{ routeId: '1' }] } },
        { id: 'empty' },
        alertEntity('kept', { routeIds: ['6'] }),
      ]),
    );
    const alerts = extractAlerts(feed);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.id).toBe('kept');
  });

  test('an alert with no informed entities is kept (surface at screen level)', () => {
    const feed = decode(encodeAlerts([{ id: 'blanket', alert: { headerText: { translation: [{ text: 'System wide' }] } } }]));
    expect(extractAlerts(feed)).toHaveLength(1);
  });

  test('active_period int64 timestamps survive the wire decode as epoch ms', () => {
    // protobufjs returns 64-bit fields as Long instances; this exercises the
    // real decode -> epoch-ms conversion end to end, not hand-built values
    const feed = decode(
      encodeAlerts([
        alertEntity('windowed', { routeIds: ['1'], start: '2026-09-09T10:00:00Z', end: '2026-09-09T13:00:00Z' }),
      ]),
    );
    const alerts = extractAlerts(feed);
    expect(alerts[0]!.activePeriods).toEqual([
      { start: Date.parse('2026-09-09T10:00:00Z'), end: Date.parse('2026-09-09T13:00:00Z') },
    ]);
  });
});

describe('activeAlerts', () => {
  const alert = (id: string, start?: string, end?: string): TransitAlert => ({
    id,
    routeIds: ['1'],
    stopIds: [],
    activePeriods: start || end ? [{ start: start ? new Date(start).getTime() : null, end: end ? new Date(end).getTime() : null }] : [],
    headerText: id,
    descriptionText: null,
  });

  test('an alert with no active period is always active', () => {
    expect(activeAlerts([alert('a')], NOW)).toHaveLength(1);
  });

  test('an alert inside its active period is active at both edges', () => {
    const a = alert('a', '2026-09-09T11:00:00Z', '2026-09-09T13:00:00Z');
    expect(activeAlerts([a], Date.parse('2026-09-09T11:00:00Z'))).toHaveLength(1);
    expect(activeAlerts([a], NOW)).toHaveLength(1);
  });

  test('an expired or not-yet-started alert is inactive', () => {
    const ended = alert('ended', '2026-09-09T10:00:00Z', '2026-09-09T11:00:00Z');
    const future = alert('future', '2026-09-09T14:00:00Z', '2026-09-09T16:00:00Z');
    expect(activeAlerts([ended, future], NOW)).toEqual([]);
  });

  test('an open-ended or open-started period stays active on the missing side', () => {
    expect(activeAlerts([alert('open-end', '2026-09-09T10:00:00Z')], NOW)).toHaveLength(1);
    expect(activeAlerts([alert('open-start', undefined, '2026-09-09T14:00:00Z')], NOW)).toHaveLength(1);
    expect(activeAlerts([alert('closed-start', undefined, '2026-09-09T11:00:00Z')], NOW)).toEqual([]);
  });
});

describe('matchAlerts', () => {
  // Stations 127 (Van Cortlandt Park-242 St, route 1) and 635 (route 6).
  const STATIONS = ['127', '635'];

  test('a route alert on a configured line lands on that line only', () => {
    const alerts = extractAlerts(decode(encodeAlerts([alertEntity('a', { routeIds: ['1'], header: 'Delays' })])));
    const { byRoute, screenLevel } = matchAlerts(activeAlerts(alerts, NOW), STATIONS);
    expect([...byRoute.keys()]).toEqual(['1']);
    expect(byRoute.get('1')![0]!.headerText).toBe('Delays');
    expect(screenLevel).toEqual([]);
  });

  test('a route alert on an unconfigured line has no row to sit on and surfaces at screen level', () => {
    const alerts = extractAlerts(decode(encodeAlerts([alertEntity('a', { routeIds: ['G'], header: 'G detour' })])));
    const { byRoute, screenLevel } = matchAlerts(activeAlerts(alerts, NOW), STATIONS);
    expect(byRoute.size).toBe(0);
    expect(screenLevel.map((a) => a.id)).toEqual(['a']);
  });

  test('a stop-only alert falls back to the routes serving that station', () => {
    const alerts = extractAlerts(decode(encodeAlerts([alertEntity('a', { stopIds: ['635N'], header: 'Station change' })])));
    const { byRoute, screenLevel } = matchAlerts(activeAlerts(alerts, NOW), STATIONS);
    // 635N is a 14 St-Union Sq platform, so every route serving that station is implicated
    expect(byRoute.get('6')?.map((a) => a.id)).toEqual(['a']);
    expect(byRoute.get('4')?.map((a) => a.id)).toEqual(['a']);
    expect(screenLevel).toEqual([]);
  });

  test('an alert naming several routes is attributed to each matching row', () => {
    const alerts = extractAlerts(decode(encodeAlerts([alertEntity('a', { routeIds: ['1', '6'] })])));
    const { byRoute, screenLevel } = matchAlerts(activeAlerts(alerts, NOW), STATIONS);
    expect([...byRoute.keys()].sort()).toEqual(['1', '6']);
    expect(screenLevel).toEqual([]);
  });

  test('an inactive alert is not matched at all', () => {
    const alerts = extractAlerts(
      decode(encodeAlerts([alertEntity('a', { routeIds: ['1'], end: '2026-09-09T10:00:00Z' })])),
    );
    const { byRoute, screenLevel } = matchAlerts(activeAlerts(alerts, NOW), STATIONS);
    expect(byRoute.size).toBe(0);
    expect(screenLevel).toEqual([]);
  });
});

describe('AlertPoller', () => {
  const goodBytes = encodeAlerts([alertEntity('a', { routeIds: ['1'], header: 'Delays' })]);

  function poller(fetchFeed: FetchFeed, onChange?: (state: AlertState) => void): AlertPoller {
    return new AlertPoller('key', fetchFeed, onChange);
  }

  test('a successful poll records alerts', async () => {
    const updates: AlertState[] = [];
    const p = poller(async () => goodBytes, (s) => updates.push(s));
    await p.pollAll();
    expect(p.state.alerts.map((a) => a.id)).toEqual(['a']);
    expect(p.state.lastGoodAt).not.toBeNull();
    expect(updates).toHaveLength(1);
  });

  test('a failed poll keeps the previous good alerts and retries silently', async () => {
    let fail = false;
    const p = poller(async () => {
      if (fail) throw new Error('phone disconnected');
      return goodBytes;
    });
    await p.pollAll();
    const good = p.state.alerts;
    fail = true;
    await p.pollAll();
    expect(p.state.alerts).toEqual(good);
  });

  test('malformed alert data keeps previous good alerts', async () => {
    let malformed = false;
    const p = poller(async () => {
      if (malformed) return new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      return goodBytes;
    });
    await p.pollAll();
    const good = p.state.alerts;
    malformed = true;
    await p.pollAll();
    expect(p.state.alerts).toEqual(good);
    // and recovery on the next good poll
    malformed = false;
    await p.pollAll();
    expect(p.state.alerts.map((a) => a.id)).toEqual(['a']);
  });

  test('repeated entities for the same alert id are deduped', async () => {
    const bytes = encodeAlerts([
      alertEntity('a', { routeIds: ['1'], header: 'first' }),
      alertEntity('a', { routeIds: ['1'], header: 'second' }),
      alertEntity('b', { routeIds: ['6'] }),
    ]);
    const p = poller(async () => bytes);
    await p.pollAll();
    expect(p.state.alerts.map((a) => a.id)).toEqual(['a', 'b']);
  });
});
