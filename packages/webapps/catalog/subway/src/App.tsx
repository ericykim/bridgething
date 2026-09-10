import { BridgethingClient } from '@bridgething/client';
import { daemonUrl } from '@bridgething/webapp-shared/daemon';
import { useEffect, useMemo, useState } from 'react';
import { buildRows, minutesUntil } from './board';
import { configState, parseStationIds } from './config';
import {
  ApiKeyError,
  FeedPoller,
  buildPlatformIndex,
  feedGroupsForRoutes,
  isStale,
  type FetchFeed,
  type PollerState,
} from './feeds';
import { getStationById, type Direction } from './static-data';

type Phase =
  | { kind: 'loading' }
  | { kind: 'unconfigured' }
  | { kind: 'ready'; stationIds: string[]; apiKey: string | null }
  | { kind: 'error'; message: string };

export default function App() {
  const client = useMemo(() => new BridgethingClient({ url: daemonUrl() }), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (cancelled) return;
      try {
        const [stationsCfg, keyCfg] = await Promise.all([
          client.config.get({ key: 'stations' }),
          client.config.get({ key: 'mta_api_key' }),
        ]);
        if (cancelled) return;

        const stations = stationsCfg.ok ? stationsCfg.response.value : null;
        const apiKey = keyCfg.ok && keyCfg.response.value?.trim() ? keyCfg.response.value.trim() : null;
        const state = configState({ stations, mta_api_key: apiKey });
        if (state === 'unconfigured') {
          setPhase({ kind: 'unconfigured' });
          return;
        }
        setPhase({ kind: 'ready', stationIds: parseStationIds(stations), apiKey });
      } catch (err) {
        if (!cancelled) setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    };

    load();
    const offChanged = client.config.onChanged(() => load());
    return () => {
      cancelled = true;
      offChanged();
    };
  }, [client]);

  return (
    <div className="flex h-full w-full flex-col bg-bg text-off-white">
      {phase.kind === 'loading' && <Centered>loading subway...</Centered>}
      {phase.kind === 'unconfigured' && (
        <Centered>
          no stations yet - set stations in the companion app settings (an mta api key is optional).
        </Centered>
      )}
      {phase.kind === 'error' && <Centered tone="muted">{phase.message}</Centered>}
      {phase.kind === 'ready' && (
        <Board client={client} stationIds={phase.stationIds} apiKey={phase.apiKey} />
      )}
    </div>
  );
}

/** Re-renders on a fixed tick so countdowns advance between feed polls. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The arrivals board: one row per line for the shown direction, ordered by
 * soonest arrival. Wheel rotation scrolls natively (overflow-y, clamps at the
 * ends); wheel press arrives as an Enter keydown and flips the direction for
 * every row. Countdowns tick every second; data refreshes on the poller's
 * 30 s cadence. Stale feeds keep the last known times, dimmed with an "old"
 * marker (visuals finalized in phase 5).
 */
function Board({
  client,
  stationIds,
  apiKey,
}: {
  client: BridgethingClient;
  stationIds: string[];
  apiKey: string | null;
}) {
  const [direction, setDirection] = useState<Direction>('N');
  const [pollerState, setPollerState] = useState<PollerState>({
    arrivals: [],
    health: new Map(),
    apiKeyInvalid: false,
  });
  const now = useNow(1_000);

  const platformIndex = useMemo(() => buildPlatformIndex(stationIds), [stationIds]);
  const groups = useMemo(
    () => feedGroupsForRoutes(stationIds.flatMap((id) => getStationById(id)?.routes ?? [])),
    [stationIds],
  );

  useEffect(() => {
    // The poller keeps fetching until stopped; if this effect re-runs (station
    // set or key changed) an in-flight poll from the previous instance could
    // still resolve and clobber the new poller's fresh state. Gate onChange on
    // cancellation so stale-line-set data never reaches React.
    let cancelled = false;
    const onChange = (state: PollerState) => {
      if (!cancelled) setPollerState(state);
    };

    const fetchFeed: FetchFeed = async (url, key) => {
      // The MTA realtime feeds no longer require a key; one is only sent when
      // the user has set one (header name must be lowercase per MTA docs).
      const headers = key ? [{ name: 'x-api-key', value: key }] : [];
      const res = await client.net.fetch({
        request: {
          url,
          method: 'GET',
          headers,
          body: null,
          timeoutMs: 12_000,
          redirect: 'follow',
        },
      });
      if (!res.ok) throw new Error('network request failed - is the phone connected?');
      if (res.response.response.status === 401 || res.response.response.status === 403) {
        throw new ApiKeyError();
      }
      if (res.response.response.status >= 400) {
        throw new Error(`mta feed returned ${res.response.response.status}`);
      }
      return new Uint8Array(res.response.response.body);
    };

    const poller = new FeedPoller(groups, platformIndex, apiKey ?? '', fetchFeed, onChange);
    setPollerState(poller.state); // drop arrivals from a previous line set
    poller.start();
    return () => {
      cancelled = true;
      poller.stop();
    };
  }, [client, groups, platformIndex, apiKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.key !== 'Enter') return;
      setDirection((d) => (d === 'N' ? 'S' : 'N'));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const rows = useMemo(
    () => buildRows(pollerState.arrivals, direction),
    [pollerState.arrivals, direction],
  );

  // Stale hook for phase 5: every feed group past the staleness window dims the
  // board. Rows only exist once data has arrived, so first-load never shows it.
  const stale =
    groups.length > 0 &&
    rows.length > 0 &&
    [...pollerState.health.values()].every((h) => isStale(h, now));

  const hadData = pollerState.arrivals.length > 0;

  return (
    <>
      <header className="mb-3 flex items-baseline justify-between border-b border-rule px-8 pt-6 pb-3">
        <div className="font-display text-hero font-medium tracking-display">subway</div>
        <div className="font-mono text-eyebrow tracking-[0.25em] text-dim uppercase">
          {stale && <span className="mr-3 text-warn">old</span>}
          {direction === 'N' ? 'inbound' : 'outbound'}
        </div>
      </header>
      <main className="flex-1 overflow-y-auto px-8 pb-6">
        {rows.length === 0 ? (
          <Centered tone="muted">
            {hadData
              ? 'no trains in this direction right now - press the wheel to flip.'
              : 'waiting for trains...'}
          </Centered>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <BoardRowView key={row.routeId} row={row} now={now} stale={stale} />
            ))}
          </div>
        )}
      </main>
      <footer className="border-t border-rule px-8 py-2 font-mono text-hint tracking-[0.08em] text-dim uppercase">
        {pollerState.apiKeyInvalid
          ? 'mta rejected the api key - check it in the companion settings'
          : 'wheel rotates to scroll - press flips inbound / outbound'}
      </footer>
    </>
  );
}

function BoardRowView({
  row,
  now,
  stale,
}: {
  row: ReturnType<typeof buildRows>[number];
  now: number;
  stale: boolean;
}) {
  const minutes = minutesUntil(row.next.arrivalAt, now);
  const bulletStyle = row.color ? { backgroundColor: `#${row.color}` } : undefined;
  const bulletText =
    row.textColor != null ? { color: `#${row.textColor}` } : undefined;

  return (
    <div
      className={`flex items-center gap-3 border border-rule bg-screen px-4 py-3 transition-opacity ${
        stale ? 'opacity-50' : ''
      }`}
    >
      <span
        className="flex h-8 w-10 shrink-0 items-center justify-center rounded-full font-mono text-sm font-bold text-white"
        style={bulletStyle}
      >
        <span style={bulletText}>{row.routeId}</span>
      </span>
      <div className="min-w-0 flex-1 truncate font-mono text-row text-near">{row.headsign}</div>
      <div className="flex shrink-0 items-center gap-1">
        {row.following.map((a) => {
          const m = minutesUntil(a.arrivalAt, now);
          return (
            <span
              key={a.tripId}
              className="rounded-full border border-rule px-2 py-0.5 font-mono text-hint text-dim"
            >
              {m === 0 ? 'now' : m}
            </span>
          );
        })}
      </div>
      <div className="w-16 shrink-0 text-right font-display text-title">
        {minutes === 0 ? 'now' : <>{minutes}<span className="ml-1 font-mono text-hint text-dim">min</span></>}
      </div>
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'muted' }) {
  return (
    <div className="flex h-full w-full items-center justify-center px-10">
      <div className={`max-w-lg text-center font-mono text-row ${tone === 'muted' ? 'text-near' : 'text-off-white'}`}>
        {children}
      </div>
    </div>
  );
}
