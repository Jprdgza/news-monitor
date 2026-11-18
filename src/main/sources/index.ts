// The list of sources currently turned on, built from presets + custom sources in the config.
import type { Config } from '../configCore';
import { BOILERPLATE_SOURCE, TICKER_SOURCE } from '../textClean';
import { extractFrontPage, extractPreview } from './extract';
import { PRESETS, customSource } from './presets';
import type { ExtractOptions, SourceDef } from './types';

export type { SourceDef, SourceId, RawHeadline, LoginStatus, ExtractionResult } from './types';
export { PRESETS, DEFAULT_ENABLED } from './presets';

let cacheKey = '';
let cache: { all: SourceDef[]; active: SourceDef[] } = { all: [], active: [] };

function build(cfg: Config) {
  const key = JSON.stringify(cfg.sources);
  if (key === cacheKey) return cache;
  const customs: SourceDef[] = [];
  for (const c of cfg.sources.custom) {
    if (PRESETS.some((p) => p.id === c.id)) continue;
    try {
      customs.push(customSource(c));
    } catch {
      /* invalid URL: skipped (sanitizeConfig already filters these) */
    }
  }
  const all = [...PRESETS, ...customs];
  const active = cfg.sources.enabled.map((id) => all.find((s) => s.id === id)).filter((s): s is SourceDef => !!s);
  cacheKey = key;
  cache = { all, active };
  return cache;
}

/** Every known source (presets + custom), in display order. */
export const allSources = (cfg: Config) => build(cfg).all;
/** Sources the watcher checks and the window shows as tabs. */
export const activeSources = (cfg: Config) => build(cfg).active;
export const findSource = (cfg: Config, id: string) => build(cfg).all.find((s) => s.id === id);

export const partitionFor = (id: string) => `persist:${id}`;

export function extractionScript(s: SourceDef): string {
  const opts: ExtractOptions = {
    articlePattern: s.articlePattern,
    livePattern: s.livePattern,
    excludePattern: s.excludePattern,
    opinionPattern: s.opinionPattern,
    signInText: s.signInText,
    accountText: s.accountText,
    accountSelectors: s.accountSelectors,
    maxHeadlines: s.maxHeadlines,
  };
  return `(${extractFrontPage.toString()})(${JSON.stringify(opts)})`;
}

export const previewScript = () =>
  `(${extractPreview.toString()})(${JSON.stringify({ ticker: TICKER_SOURCE, boilerplate: BOILERPLATE_SOURCE })})`;

export { isLiveUrl } from '../rssParse';

/** Does this URL belong to the source's site? */
export function ownsUrl(s: SourceDef, url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return s.hosts.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}
