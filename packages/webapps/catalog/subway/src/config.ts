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

/** Config gate: `stations` is required; `mta_api_key` is optional (MTA no longer
 * enforces keys on the realtime feeds, but a provided key is still sent along). */
export function configState(raw: { stations?: string | null; mta_api_key?: string | null }): 'unconfigured' | 'ready' {
  return parseStationIds(raw.stations).length > 0 ? 'ready' : 'unconfigured';
}
