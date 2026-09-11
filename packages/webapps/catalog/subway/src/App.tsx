import { BridgethingClient } from '@bridgething/client';
import { daemonUrl } from '@bridgething/webapp-shared/daemon';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertPoller,
  activeAlerts,
  formatActivePeriods,
  matchAlerts,
  type AlertState,
  type TransitAlert,
} from './alerts';
import { buildRows, minutesUntil, scrollDeltaForKey } from './board';
import { configState, parseStationIds } from './config';
import {
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
  | { kind: 'ready'; stationIds: string[] }
  | { kind: 'error'; message: string };

export default function App() {
  const client = useMemo(() => new BridgethingClient({ url: daemonUrl() }), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (cancelled) return;
      try {
        const stationsCfg = await client.config.get({ key: 'stations' });
        if (cancelled) return;

        const stations = stationsCfg.ok ? stationsCfg.response.value : null;
        const state = configState(stations);
        if (state === 'unconfigured') {
          setPhase({ kind: 'unconfigured' });
          return;
        }
        setPhase({ kind: 'ready', stationIds: parseStationIds(stations) });
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
        <Board client={client} stationIds={phase.stationIds} />
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

/** Carousel text: the alert header plus its active windows, e.g.
 * "No [G] between ... · Fri Sep 26 10:45 PM - Mon Sep 28 5:00 AM". */
function alertDisplayText(alert: TransitAlert): string {
  const base = alert.headerText ?? alert.descriptionText ?? alert.id;
  const dates = formatActivePeriods(alert);
  return dates ? `${base} · ${dates}` : base;
}

/**
 * The arrivals board: one row per line for the shown direction, ordered by
 * soonest arrival. Wheel rotation scrolls natively (overflow-y, clamps at the
 * ends); if a webview instead emits rotation as arrow keys, they map to a
 * scroll step of about one viewport. Wheel press arrives as an Enter keydown
 * and flips the direction for every row. Countdowns tick every second; data
 * refreshes on the poller's 30 s cadence. Alerts poll on the slower AlertPoller cadence. Line alerts ride
 * their row as a full-width carousel strip under the card content, rotating
 * through alerts and marquee-scrolling long text so nothing truncates;
 * station-level alerts and alerts on a configured line that currently has no
 * row get their own banner above all rows, each looping its own marquee so
 * long text never truncates. Unrelated
 * alerts are never shown. Stale feeds keep the last known
 * times, dimmed with an "old" marker, and recover automatically on reconnect.
 */
function Board({
  client,
  stationIds,
}: {
  client: BridgethingClient;
  stationIds: string[];
}) {
  const [direction, setDirection] = useState<Direction>('N');
  const [pollerState, setPollerState] = useState<PollerState>({
    arrivals: [],
    health: new Map(),
  });
  const [alertState, setAlertState] = useState<AlertState>({ alerts: [], lastGoodAt: null });
  const now = useNow(1_000);
  const scrollerRef = useRef<HTMLElement | null>(null);

  const platformIndex = useMemo(() => buildPlatformIndex(stationIds), [stationIds]);
  const groups = useMemo(
    () => feedGroupsForRoutes(stationIds.flatMap((id) => getStationById(id)?.routes ?? [])),
    [stationIds],
  );
  // Alerts are re-matched against the 1 s tick so an active_period window
  // expiring drops its indicator between alert polls (cheap: a few alerts × a
  // few stations per tick). React identity churn here is deliberate.
  const matched = useMemo(
    () => matchAlerts(activeAlerts(alertState.alerts, now), stationIds),
    [alertState.alerts, now, stationIds],
  );

  useEffect(() => {
    // The pollers keep fetching until stopped; if this effect re-runs (station
    // set or key changed) an in-flight poll from a previous instance could
    // still resolve and clobber the new pollers' fresh state. Gate onChange on
    // cancellation so stale-line-set data never reaches React.
    let cancelled = false;
    const onChange = (state: PollerState) => {
      if (!cancelled) setPollerState(state);
    };
    const onAlerts = (state: AlertState) => {
      if (!cancelled) setAlertState(state);
    };

    const fetchFeed: FetchFeed = async url => {
      // The MTA realtime and alerts feeds work without an api key.
      const res = await client.net.fetch({
        request: {
          url,
          method: 'GET',
          headers: [],
          body: null,
          timeoutMs: 12_000,
          redirect: 'follow',
        },
      });
      if (!res.ok) throw new Error('network request failed - is the phone connected?');
      if (res.response.response.status >= 400) {
        throw new Error(`mta feed returned ${res.response.response.status}`);
      }
      return new Uint8Array(res.response.response.body);
    };

    const poller = new FeedPoller(groups, platformIndex, fetchFeed, onChange);
    const alertPoller = new AlertPoller(fetchFeed, onAlerts);
    setPollerState(poller.state); // drop arrivals from a previous line set
    setAlertState(alertPoller.state);
    poller.start();
    alertPoller.start();
    return () => {
      cancelled = true;
      poller.stop();
      alertPoller.stop();
    };
  }, [client, groups, platformIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // e.repeat is only suppressed for the direction flip: a held press must
      // not machine-gun flips, but rotation emitted as auto-repeat arrow keys
      // (a possible webview behavior) needs the repeats to scroll smoothly.
      if (e.repeat && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.key === 'Enter') {
        setDirection((d) => (d === 'N' ? 'S' : 'N'));
        return;
      }
      // Wheel-rotation fallback: rotation may arrive as arrow keys instead of
      // native scroll; step the board scroller. preventDefault stops the
      // browser's own arrow-key scroll so the fallback never double-applies.
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const delta = scrollDeltaForKey(e.key, scroller.clientHeight);
      if (delta !== null) {
        e.preventDefault();
        scroller.scrollBy({ top: delta });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const rows = useMemo(
    () => buildRows(pollerState.arrivals, direction, matched.byRoute),
    [pollerState.arrivals, direction, matched],
  );

  // Above all rows: station-level alerts (about a selected station) first,
  // then line-level alerts whose line currently has no row (no trains running
  // on it). Those still belong to a selected line and get a route bullet.
  const topAlerts = useMemo(() => {
    const rowRouteIds = new Set(rows.map((r) => r.routeId));
    const items: Array<{ routeId: string | null; alert: TransitAlert }> = [];
    for (const alert of matched.stationLevel) {
      items.push({ routeId: null, alert });
    }
    for (const [routeId, alerts] of matched.byRoute) {
      if (rowRouteIds.has(routeId)) continue;
      for (const alert of alerts) items.push({ routeId, alert });
    }
    return items;
  }, [rows, matched]);

  // Stale hook for phase 5: every feed group past the staleness window dims the
  // board. Rows only exist once data has arrived, so first-load never shows it.
  const stale =
    groups.length > 0 &&
    rows.length > 0 &&
    [...pollerState.health.values()].every((h) => isStale(h, now));

  const hadData = pollerState.arrivals.length > 0;

  return (
    <>
      <header className="mb-3 border-b border-rule px-3 pt-3 pb-3">
        <div className="font-mono text-eyebrow text-dim font-semibold uppercase w-full flex items-baseline justify-between gap-3">
        <div>
            <span className="text-white">{direction === 'N' ? 'inbound' : 'outbound'}</span>
          </div>
          {stale ? (
            <span className="text-warn">⚠ offline</span>
          ) : (
            <span className="text-ok">● live</span>
          )}
        </div>
      </header>
      <main ref={scrollerRef} className="flex-1 overflow-y-auto px-4 pb-6">
        {topAlerts.map(({ routeId, alert }) => (
          <AlertCarousel
            key={`${routeId ?? 'station'}:${alert.id}`}
            className="mb-2 rounded border border-warn/40 bg-warn/10 px-3 py-2"
            items={[{ routeId, text: alertDisplayText(alert) }]}
          />
        ))}
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
    </>
  );
}

/** Time-pill recession: outlined pills overlap like a card carousel - the
 *  next train is biggest, brightest, and on top; each later train is
 *  smaller, dimmer, and tucked behind (negative margin + lower z-index).
 *  The opaque fill matches the card bg so a pill occludes the one behind
 *  it. Fixed widths keep the front pill at the same x on every row. */
const TIME_SLOTS = [
  { box: 'z-20 h-9 w-20 text-off-white font-display text-row font-bold' },
  { box: 'z-10 -ml-3 h-9 w-20 text-soft font-mono text-row font-semibold' },
  { box: 'z-0 -ml-3 h-9 w-20 text-dim font-mono text-row font-semibold' },
];

function BoardRowView({
  row,
  now,
  stale,
}: {
  row: ReturnType<typeof buildRows>[number];
  now: number;
  stale: boolean;
}) {
  const bulletStyle = row.color ? { backgroundColor: `#${row.color}` } : undefined;
  const bulletText =
    row.textColor != null ? { color: `#${row.textColor}` } : undefined;
  // Departure carousel: a train at 0 min holds "now" for a beat, plays its
  // exit, then leaves the rendered list (the feed only drops it on the next
  // poll) so the pills behind slide forward and a new back pill enters.
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [exitingIds, setExitingIds] = useState<ReadonlySet<string>>(new Set());
  // 3 visible pills; the 4th (FOLLOWING_CAP spare) slides in the moment the
  //  front train is hidden, so the stack never sits short.
  const times = [row.next, ...row.following].filter((a) => !hiddenIds.has(a.tripId)).slice(0, 3);
  const frontId = times[0]?.tripId ?? null;
  const frontM = times[0] ? minutesUntil(times[0].arrivalAt, now) : null;

  useEffect(() => {
    if (frontId == null || frontM !== 0) return;
    let t2: ReturnType<typeof setTimeout> | undefined;
    const t1 = setTimeout(() => {
      setExitingIds((s) => new Set(s).add(frontId));
      t2 = setTimeout(() => setHiddenIds((s) => new Set(s).add(frontId)), 500);
    }, 1000);
    return () => {
      clearTimeout(t1);
      if (t2) clearTimeout(t2);
    };
  }, [frontId, frontM]);

  return (
    <div
      className={`flex flex-col rounded-xl bg-neutral-soft transition-opacity ${
        stale ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-mono text-row font-bold text-white"
          style={bulletStyle}
        >
          <span style={bulletText}>{row.routeId}</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-row text-near font-bold">{row.headsign}</div>
          {row.stationName && (
            <div className="truncate font-mono text-hint text-dim font-semibold">{row.stationName}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center">
          {times.map((a, i) => (
            <TimePill
              key={a.tripId}
              minutes={minutesUntil(a.arrivalAt, now)}
              slotClass={TIME_SLOTS[Math.min(i, TIME_SLOTS.length - 1)]!.box}
              exiting={exitingIds.has(a.tripId)}
            />
          ))}
        </div>
      </div>
      {row.alerts.length > 0 && (
        <AlertCarousel
          className="border-t border-warn/40 bg-warn/10 px-4 py-1.5"
          items={row.alerts.map((a) => ({
            routeId: null,
            text: alertDisplayText(a),
          }))}
        />
      )}
    </div>
  );
}

/** One time pill. Mounts with an enter-from-behind slide; when `exiting`
 *  flips, fades and slides left while its margin collapses to its full
 *  negative width, pulling the pills behind it forward. Slot classes carry
 *  the size/tone; the transition list animates class swaps when a pill is
 *  promoted to a front slot. */
function TimePill({
  minutes,
  slotClass,
  exiting,
}: {
  minutes: number;
  slotClass: string;
  exiting: boolean;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (exiting && el) el.style.marginLeft = `${-el.offsetWidth}px`;
  }, [exiting]);

  const motion = exiting
    ? '-translate-x-4 scale-90 opacity-0'
    : entered
      ? ''
      : 'translate-x-4 scale-90 opacity-0';

  return (
    <span
      ref={ref}
      className={`flex items-center justify-center rounded-full border border-current bg-card-surface px-3 transition-[width,height,margin-left,color,font-size,opacity,transform,translate,scale] duration-500 ease-out ${slotClass} ${motion}`}
    >
      {minutes === 0 ? 'now' : `${minutes} min`}
    </span>
  );
}

/**
 * Carousel of alerts: one item at a time, advancing on its own. Text that
 * fits holds still and rotates to the next item after a beat; text too long
 * for one line marquee-scrolls exactly its overflow (never truncated),
 * pauses at the end, then rotates. A single item loops its own marquee. The
 * route bullet, when present, stays put: the text clips at its own edge so
 * the marquee never slides underneath the bullet.
 */
function AlertCarousel({
  items,
  className,
}: {
  items: Array<{ routeId: string | null; text: string }>;
  className: string;
}) {
  // pos advances forever; the index wraps, so a single alert re-runs its marquee
  const [pos, setPos] = useState(0);
  // Doubled render: long text shows two copies so shifting by exactly one
  // copy width loops seamlessly. Short text stays a single copy; the effect
  // flips this once it has measured an overflow.
  const [doubled, setDoubled] = useState(false);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);

  const item = items[pos % items.length]!;
  const text = item.text;

  useEffect(() => {
    const clip = clipRef.current;
    const span = textRef.current;
    if (!clip || !span) return;
    span.style.animation = '';
    const copyWidth = doubled ? span.scrollWidth / 2 : span.scrollWidth;
    if (copyWidth - clip.clientWidth <= 4) {
      // fits: hold, then rotate to the next item
      if (doubled) setDoubled(false);
      if (items.length > 1) {
        const t = setTimeout(() => setPos((p) => p + 1), 6000);
        return () => clearTimeout(t);
      }
      return;
    }
    if (!doubled) {
      // too long, single copy on screen: re-render doubled, then loop
      setDoubled(true);
      return;
    }
    // too long, doubled: loop the marquee forever like a carousel. The
    // advance timer fires exactly at a loop boundary, so swapping in the
    // next alert (or re-running the same one) is invisible.
    const duration = Math.max(4000, copyWidth * 18);
    span.style.setProperty('--marquee-shift', `${-copyWidth}px`);
    span.style.animation = `alert-marquee ${duration}ms linear infinite`;
    const timer = setTimeout(() => setPos((p) => p + 1), duration);
    return () => {
      clearTimeout(timer);
      span.style.animation = '';
    };
  }, [pos, text, items.length, doubled]);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {item.routeId && (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-warn/40 font-mono text-hint font-bold text-warn">
          {item.routeId}
        </span>
      )}
      <div ref={clipRef} className="min-w-0 flex-1 overflow-hidden">
        <span
          ref={textRef}
          className="inline-block whitespace-nowrap  text-hint text-warn will-change-transform"
        >
          {doubled ? <>{text}&nbsp;&nbsp;·&nbsp;&nbsp;{text}&nbsp;&nbsp;·&nbsp;&nbsp;</> : text}
        </span>
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
