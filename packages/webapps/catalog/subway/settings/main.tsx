import { settings, type SettingsContext } from '@bridgething/client/settings';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseStationIds } from '../src/config';
import { getRoute, getStationById, type StaticStation } from '../src/static-data.ts';
import { searchStations, serializeStations } from './picker';
import './style.css';

const STATIONS_KEY = 'stations';
const API_KEY_FIELD = 'mta_api_key';

function RouteBullets({ station }: { station: StaticStation }) {
  return (
    <span className="routes">
      {station.routes.map(id => {
        const route = getRoute(id);
        return (
          <span
            key={id}
            className="bullet"
            style={{ background: route ? `#${route.color}` : '#666', color: route ? `#${route.textColor}` : '#fff' }}>
            {id}
          </span>
        );
      })}
    </span>
  );
}

function Settings() {
  const [ctx, setCtx] = useState<SettingsContext | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [apiKey, setApiKey] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');

  // The last value we wrote or loaded, so the Save button can skip no-op writes.
  const savedApiKey = useRef('');

  useEffect(() => {
    (async () => {
      try {
        setCtx(await settings.context());
        const entries = await settings.config.list();
        const byKey = Object.fromEntries(entries.map(e => [e.key, e.value]));
        const stations = new Set(parseStationIds(byKey[STATIONS_KEY]));
        setSelected(stations);
        savedApiKey.current = byKey[API_KEY_FIELD] ?? '';
        setApiKey(savedApiKey.current);
        setStatus(`${stations.size ? '' : 'pick at least one station. '}${stations.size} selected`);
      } catch (err) {
        setStatus(errText(err));
      }
    })();
  }, []);

  async function saveStations(next: Set<string>) {
    setSelected(next);
    try {
      await settings.config.set(STATIONS_KEY, serializeStations([...next]));
      setStatus(`${next.size} ${next.size === 1 ? 'station' : 'stations'} saved`);
    } catch (err) {
      setStatus(errText(err));
    }
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    void saveStations(next);
  }

  async function saveApiKey() {
    if (apiKey === savedApiKey.current) return;
    try {
      await settings.config.set(API_KEY_FIELD, apiKey);
      savedApiKey.current = apiKey;
      setStatus('api key saved');
    } catch (err) {
      setStatus(errText(err));
    }
  }

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return searchStations(query);
  }, [query]);

  const selectedStations = useMemo(
    () => [...selected].map(id => getStationById(id)).filter((s): s is StaticStation => s !== undefined),
    [selected],
  );

  return (
    <main>
      <header>
        <h1>{ctx ? `${ctx.name} settings` : 'Subway settings'}</h1>
        <p className="hint">{status}</p>
      </header>

      <section className="picker">
        <div className="search">
          <input
            type="search"
            placeholder="search stations by name or id..."
            value={query}
            onInput={e => setQuery((e.target as HTMLInputElement).value)}
            autoCapitalize="none"
          />
        </div>

        {selectedStations.length > 0 && (
          <div className="chips">
            {selectedStations.map(s => (
              <button type="button" key={s.id} className="chip" onClick={() => toggle(s.id)}>
                {s.name} <span className="remove">×</span>
              </button>
            ))}
          </div>
        )}

        <div className="list">
          {query.trim() === '' ? (
            <p className="hint">search to find stations; tap a result to add or remove it.</p>
          ) : results.length === 0 ? (
            <p className="hint">no stations match "{query}".</p>
          ) : (
            results.map(s => (
              <label className="station" key={s.id}>
                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                <span className="name">{s.name}</span>
                <RouteBullets station={s} />
              </label>
            ))
          )}
        </div>
      </section>

      <section className="creds">
        <div className="field">
          <label htmlFor="mta_api_key">MTA API key (optional)</label>
          <input
            id="mta_api_key"
            type="text"
            placeholder="paste a key from api.mta.info"
            value={apiKey}
            onInput={e => setApiKey((e.target as HTMLInputElement).value)}
            onBlur={saveApiKey}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
      </section>

      <footer>
        <button type="button" onClick={saveApiKey}>
          Save
        </button>
        <button type="button" className="secondary" onClick={() => settings.done()}>
          Done
        </button>
      </footer>
    </main>
  );
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

createRoot(document.getElementById('root')!).render(<Settings />);
