/**
 * Regenerates src/fixtures/*.bin from live MTA GTFS-Realtime feeds.
 *
 * Downloads each trip-updates feed group (no valid key needed while MTA's
 * enforcement is lax; if that changes, set MTA_API_KEY in the environment),
 * decodes the protobuf, keeps the feed header plus the first few entities,
 * and re-encodes so the checked-in fixtures stay small but wire-real. Also
 * writes malformed fixtures used by the "keep previous data" tests.
 *
 * Usage: bun scripts/generate-fixtures.ts
 * Source: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/<feed>
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import protobuf from 'protobufjs';
import descriptor from '../src/proto/gtfsrt-descriptor.json';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(scriptDir, '..');
const fixtureDir = join(pkgDir, 'src', 'fixtures');
const cacheDir = join(scriptDir, '.cache', 'feeds');

const FEEDS = [
  'nyct%2Fgtfs',
  'nyct%2Fgtfs-ace',
  'nyct%2Fgtfs-bdfm',
  'nyct%2Fgtfs-g',
  'nyct%2Fgtfs-jz',
  'nyct%2Fgtfs-l',
  'nyct%2Fgtfs-nqrw',
  'nyct%2Fgtfs-si',
] as const;

const BASE_URL = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds';
const ENTITIES_KEPT = 6;

const root = protobuf.Root.fromJSON(descriptor);
const FeedMessageType = root.lookupType('transit_realtime.FeedMessage');

async function download(feed: string): Promise<Uint8Array> {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, feed.replaceAll('%2F', '_'));
  if (existsSync(path) && statSync(path).size > 0) {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  }
  const apiKey = process.env.MTA_API_KEY ?? 'probe-key';
  const res = await fetch(`${BASE_URL}/${feed}`, { headers: { 'x-api-key': apiKey } });
  if (!res.ok) throw new Error(`${feed}: http ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(path, bytes);
  return bytes;
}

async function main() {
  mkdirSync(fixtureDir, { recursive: true });
  for (const feed of FEEDS) {
    const bytes = await download(feed);
    const message = FeedMessageType.decode(bytes) as unknown as {
      header: object;
      entity: object[];
    };
    const trimmed = { header: message.header, entity: message.entity.slice(0, ENTITIES_KEPT) };
    const out = FeedMessageType.encode(FeedMessageType.fromObject(trimmed)).finish();
    const name = feed.replaceAll('%2F', '').replaceAll('-', '');
    const path = join(fixtureDir, `${name}.bin`);
    writeFileSync(path, out);
    console.log(`${name}.bin: ${bytes.length} bytes live -> ${out.length} bytes fixture`);
  }

  // malformed inputs for the "keep previous data" path: a truncated message and garbage
  const live = await download(FEEDS[0]);
  const fixture = FeedMessageType.encode(FeedMessageType.fromObject({
    header: (FeedMessageType.decode(live) as unknown as { header: object }).header,
    entity: [],
  })).finish();
  writeFileSync(join(fixtureDir, 'truncated.bin'), fixture.slice(0, Math.floor(fixture.length * 0.6)));
  writeFileSync(
    join(fixtureDir, 'garbage.bin'),
    new Uint8Array(Array.from({ length: 256 }, (_, i) => (i * 37 + 11) % 256)),
  );
  console.log('wrote truncated.bin and garbage.bin');
}

main();
