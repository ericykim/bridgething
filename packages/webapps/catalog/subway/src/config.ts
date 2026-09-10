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

/** Config gate: `stations` must name at least one station. */
export function configState(stations: string | null | undefined): 'unconfigured' | 'ready' {
  return parseStationIds(stations).length > 0 ? 'ready' : 'unconfigured';
}
