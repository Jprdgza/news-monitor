// Fallback: read a source's public RSS feeds when front-page extraction fails.
// Positions are feed order, which is a much weaker signal than page placement.
import { session } from 'electron';
import { partitionFor, type RawHeadline, type SourceDef } from './sources';
import { parseFeed } from './rssParse';
import { log } from './log';

const MAX_BYTES = 3_000_000;

export async function fetchRss(source: SourceDef): Promise<RawHeadline[]> {
  const ses = session.fromPartition(partitionFor(source.id));
  const out: RawHeadline[] = [];
  const seen = new Set<string>();
  for (const feed of source.rssFeeds) {
    try {
      const res = await ses.fetch(feed, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      if (xml.length > MAX_BYTES) throw new Error('feed too large');
      parseFeed(xml, source, out, seen);
    } catch (err) {
      log.warn(`${source.short} RSS ${feed} failed: ${err}`);
    }
  }
  return out;
}
