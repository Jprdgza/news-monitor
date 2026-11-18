// RSS parsing (pure, unit-tested). Regex-based on purpose: feeds are small, and this avoids
// pulling an XML parser into the app.
import { isHttpUrl } from './configCore';
import type { RawHeadline } from './sources/types';

export interface FeedSource {
  livePattern: string;
}

export const isLiveUrl = (s: FeedSource, url: string) => {
  try {
    return new RegExp(s.livePattern, 'i').test(url);
  } catch {
    return false;
  }
};

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeChar(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

const tag = (item: string, name: string) => decodeEntities(item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '');

export function parseFeed(xml: string, source: FeedSource, into: RawHeadline[], seen: Set<string>) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const item of items.slice(0, 20)) {
    const url = tag(item, 'link');
    const headline = tag(item, 'title');
    if (!url || !headline || !isHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    into.push({
      headline: headline.slice(0, 300),
      dek: tag(item, 'description').slice(0, 300),
      url,
      position: into.length + 1,
      fontSize: 0,
      live: isLiveUrl(source, url),
    });
  }
}

