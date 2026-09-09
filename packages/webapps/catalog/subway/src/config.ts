/** Parse the comma-separated `stations` config value into a clean, ordered id list. */
export function parseStationIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id && !seen.has(id)) seen.add(id);
  }
  return [...seen];
}

/** Phase-1 gate: both config keys must be present before the app does anything. */
export function configState(raw: { stations?: string | null; mta_api_key?: string | null }): 'unconfigured' | 'ready' {
  const hasStations = parseStationIds(raw.stations).length > 0;
  const hasKey = !!raw.mta_api_key && raw.mta_api_key.trim().length > 0;
  return hasStations && hasKey ? 'ready' : 'unconfigured';
}
