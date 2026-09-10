import { settings, type SettingsContext } from '@bridgething/client/settings';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { parseStationIds } from '../src/config';
import { getRoute, getStationById, normalizeStationName } from '../src/static-data.ts';
import { searchStations, serializeStations, type StationGroup } from './picker';
import './style.css';

const STATIONS_KEY = 'stations';

function RouteBullets({ routes }: { routes: string[] }) {
  return (
    <span className="routes">
      {routes.map(id => {
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

/**
 * Combobox for looking up stations by name (or id). Typing opens a dropdown
 * of matching stations; picking one toggles it in the selection. Stations
 * that share a name (e.g. Borough Hall's 4/5 and 2/3 entries) show as one
 * option with all of their trains and toggle together. Fully keyboard
 * navigable (arrows + enter + escape) and closes on outside click.
 */
function StationAutocomplete({ selected, onToggle }: { selected: Set<string>; onToggle: (ids: string[]) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return searchStations(query);
  }, [query]);

  // Close the dropdown when clicking anywhere else on the page.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function choose(group: StationGroup) {
    onToggle(group.ids);
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
      setOpen(true);
      setActiveIndex(i => (e.key === 'ArrowDown' ? Math.min(i + 1, results.length - 1) : Math.max(i - 1, 0)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const station = results[activeIndex];
      if (open && station) choose(station);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  }

  const showDropdown = open && query.trim() !== '';
  const listId = 'station-listbox';

  return (
    <div className="autocomplete" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="search">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showDropdown && results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showDropdown && results[activeIndex] ? `station-option-${activeIndex}` : undefined}
          aria-label="search stations"
          placeholder="search stations by name or id..."
          value={query}
          autoCapitalize="none"
          onInput={e => {
            setQuery((e.target as HTMLInputElement).value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => {
            if (query.trim()) setOpen(true);
          }}
        />
      </div>

      {showDropdown && (
        <ul id={listId} role="listbox" aria-label="station results" className="dropdown">
          {results.length === 0 ? (
            <li className="hint no-match">no stations match "{query}".</li>
          ) : (
            results.map((g, i) => {
              const allSelected = g.ids.every(id => selected.has(id));
              return (
                <li
                  key={g.name}
                  id={`station-option-${i}`}
                  role="option"
                  aria-selected={allSelected}
                  className={`option${i === activeIndex ? ' active' : ''}`}
                  // Keep the input focused so the dropdown doesn't flicker.
                  onPointerDown={e => e.preventDefault()}
                  onClick={() => choose(g)}>
                  <span className="name">{g.name}</span>
                  <RouteBullets routes={g.routes} />
                  {allSelected && <span className="check">✓</span>}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

function Settings() {
  const [ctx, setCtx] = useState<SettingsContext | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setCtx(await settings.context());
        const entries = await settings.config.list();
        const byKey = Object.fromEntries(entries.map(e => [e.key, e.value]));
        const stations = new Set(parseStationIds(byKey[STATIONS_KEY]));
        setSelected(stations);
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

  /** Toggle a group: select every missing id, or clear the group entirely. */
  function toggle(ids: string[]) {
    const next = new Set(selected);
    const allSelected = ids.every(id => next.has(id));
    for (const id of ids) {
      if (allSelected) next.delete(id);
      else next.add(id);
    }
    void saveStations(next);
  }

  // One chip per station name, even when several selected ids share a name.
  const selectedChips = useMemo(() => {
    const byName = new Map<string, { name: string; ids: string[] }>();
    for (const id of selected) {
      const station = getStationById(id);
      if (!station) continue;
      const key = normalizeStationName(station.name);
      const chip = byName.get(key);
      if (chip) chip.ids.push(id);
      else byName.set(key, { name: station.name, ids: [id] });
    }
    return [...byName.values()];
  }, [selected]);

  return (
    <main>
      <header>
        <h1>{ctx ? `${ctx.name} settings` : 'Subway settings'}</h1>
        <p className="hint">{status}</p>
      </header>

      <section className="picker">
        <StationAutocomplete selected={selected} onToggle={toggle} />

        {selectedChips.length > 0 && (
          <div className="chips">
            {selectedChips.map(chip => (
              <span className="chip" key={chip.name}>
                <span className="chip-name">{chip.name}</span>
                <button
                  type="button"
                  className="remove"
                  aria-label={`remove ${chip.name}`}
                  onClick={() => toggle(chip.ids)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      <footer>
        <button type="button" onClick={() => settings.done()}>
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
