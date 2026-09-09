import { BridgethingClient } from '@bridgething/client';
import { daemonUrl } from '@bridgething/webapp-shared/daemon';
import { useEffect, useMemo, useState } from 'react';
import { configState, parseStationIds } from './config';

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
        const [stationsCfg, keyCfg] = await Promise.all([
          client.config.get({ key: 'stations' }),
          client.config.get({ key: 'mta_api_key' }),
        ]);
        if (cancelled) return;

        const stations = stationsCfg.ok ? stationsCfg.response.value : null;
        const apiKey = keyCfg.ok ? keyCfg.response.value : null;
        const state = configState({ stations, mta_api_key: apiKey });
        if (state === 'unconfigured') {
          setPhase({ kind: 'unconfigured' });
          return;
        }
        // Feed pipeline arrives in a later phase; config plumbing is what phase 1 proves.
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
          no stations yet - set stations and your mta api key in the companion app settings.
        </Centered>
      )}
      {phase.kind === 'error' && <Centered tone="muted">{phase.message}</Centered>}
      {phase.kind === 'ready' && <Board stationIds={phase.stationIds} />}
    </div>
  );
}

/**
 * Phase-1 stand-in for the arrivals board (built in phase 4): a scrollable list to
 * confirm wheel rotation scrolls natively, plus a keydown probe to confirm the wheel
 * press reaches the app as a DOM keydown.
 */
function Board({ stationIds }: { stationIds: string[] }) {
  const [lastPress, setLastPress] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key.startsWith('Arrow')) setLastPress(e.key);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <header className="mb-3 flex items-baseline justify-between border-b border-rule px-8 pt-6 pb-3">
        <div className="font-display text-hero font-medium tracking-display">subway</div>
        <div className="font-mono text-eyebrow tracking-[0.25em] text-dim uppercase">
          {stationIds.length} station{stationIds.length === 1 ? '' : 's'}
        </div>
      </header>
      <main className="flex-1 overflow-y-auto px-8 pb-6">
        <div className="mb-3 font-mono text-hint tracking-[0.08em] text-dim lowercase">
          configured: {stationIds.join(', ')} — arrivals arrive in a later phase
        </div>
        <div className="flex flex-col gap-2">
          {Array.from({ length: 20 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 border border-rule bg-screen px-4 py-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#0039A6] font-mono text-sm font-bold text-white">
                {i % 2 === 0 ? 'A' : '1'}
              </div>
              <div className="font-mono text-row text-near">test row {i + 1}</div>
            </div>
          ))}
        </div>
      </main>
      <footer className="border-t border-rule px-8 py-2 font-mono text-hint tracking-[0.08em] text-dim uppercase">
        {lastPress ? `last press: ${lastPress}` : 'wheel press probe: press the wheel'}
      </footer>
    </>
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
