// Transparent scoring rules. Every point added comes with a human-readable signal string,
// so alerts.jsonl and the "Why?" view show exactly why a story scored what it did.
// Pure module (no Electron) so it can be unit-tested.
import type { Config } from './configCore';
import { Idf, normalizeUrl, tokens } from './match';
import type { RawHeadline } from './sources/types';

/** The subset of Story that scoring reads and writes. */
export interface ScoredStory {
  id: string;
  sourceId: string;
  url: string;
  headline: string;
  dek: string;
  firstSeen: number;
  lastSeen: number;
  lastPosition: number;
  topStreak: number;
  live: boolean;
  breaking?: boolean;
  opinion?: boolean;
  score: number;
  maxScore: number;
  signals: string[];
  related?: string[];
}

export interface PageContext {
  /** Font-size rank of each URL on its page: 1 = largest headline text. */
  fontRank: Map<string, number>;
  fontSize: Map<string, number>;
  /** Number of headlines sharing the largest font size on the page. */
  largestFontCount: number;
  maxFont: number;
  via: 'page' | 'rss';
}

export function buildContext(headlines: RawHeadline[], via: 'page' | 'rss'): PageContext {
  const sizes = headlines.map((h) => h.fontSize);
  const max = Math.max(0, ...sizes);
  const fontRank = new Map<string, number>();
  const fontSize = new Map<string, number>();
  for (const h of headlines) {
    const u = normalizeUrl(h.url);
    fontRank.set(u, 1 + sizes.filter((s) => s > h.fontSize).length);
    fontSize.set(u, h.fontSize);
  }
  return { fontRank, fontSize, largestFontCount: max > 0 ? sizes.filter((s) => s === max).length : 99, maxFont: max, via };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type CompiledKeywords = { category: string; words: { word: string; re: RegExp }[] }[];
// Compiled once per loaded config (a config reload creates a new keywords object).
const compiledCache = new WeakMap<Record<string, string[]>, CompiledKeywords>();

function compile(keywords: Record<string, string[]>): CompiledKeywords {
  let c = compiledCache.get(keywords);
  if (!c) {
    c = Object.entries(keywords).map(([category, words]) => ({
      category,
      words: words.map((w) => {
        // All-caps short keywords (CPI, IPO, OPEC) are matched case-sensitively.
        const caseSensitive = w.length <= 5 && w === w.toUpperCase() && /[A-Z]/.test(w);
        return { word: w, re: new RegExp(`(^|[^A-Za-z])${escapeRe(w)}($|[^A-Za-z])`, caseSensitive ? '' : 'i') };
      }),
    }));
    compiledCache.set(keywords, c);
  }
  return c;
}

/** Keyword categories hit by the text (one hit per category). */
export function keywordHits(text: string, keywords: Record<string, string[]>): { category: string; word: string }[] {
  const hits: { category: string; word: string }[] = [];
  for (const { category, words } of compile(keywords)) {
    const hit = words.find((w) => w.re.test(text));
    if (hit) hits.push({ category, word: hit.word });
  }
  return hits;
}

const ROUTINE_LIVE = /(live markets|stock market today|stock-market-today|markets? (live|wrap)|dow jones today|stocks? (live|today)|live updates: stocks|morning briefing|evening briefing|the latest:)/i;
const GENERIC = /^(catch up on|today[’']s (biggest|top) stories|the morning|the evening|your (morning|evening) briefing|what to know|read the)/i;

export const isRoutine = (s: { headline: string; url: string }) => ROUTINE_LIVE.test(s.headline) || ROUTINE_LIVE.test(s.url);
export const isGeneric = (s: { headline: string }) => GENERIC.test(s.headline);
const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

function fontShare(story: ScoredStory, ctx: PageContext): number {
  if (ctx.via !== 'page' || !ctx.maxFont) return 1;
  return (ctx.fontSize.get(story.url) ?? 0) / ctx.maxFont;
}

/** In the top few stories on the page: early in the page AND set in large type, or among the largest headlines. */
export function isTopSlot(story: ScoredStory, ctx: PageContext, cfg: Config): boolean {
  const n = cfg.weights.topSlotCount;
  // Feed order is mostly recency, not editorial prominence.
  if (ctx.via === 'rss') return false;
  const rank = ctx.fontRank.get(story.url) ?? 99;
  return (story.lastPosition <= n && fontShare(story, ctx) >= 0.7) || (rank <= n && ctx.largestFontCount <= n && story.lastPosition <= n * 2 && fontShare(story, ctx) >= 0.6);
}

export function isLead(story: ScoredStory, ctx: PageContext): boolean {
  if (ctx.via !== 'page') return false;
  const rank = ctx.fontRank.get(story.url) ?? 99;
  return (story.lastPosition === 1 && fontShare(story, ctx) >= 0.85) || (rank === 1 && ctx.largestFontCount === 1);
}

/** Does this pair of headlines describe the same event? */
export function sameEvent(idf: Idf, a: ScoredStory, b: ScoredStory, cfg: Config): boolean {
  if (isGeneric(a) || isGeneric(b)) return false;
  const m = cfg.matching;
  const c = idf.cosine(tokens(`${a.headline} ${a.dek}`), tokens(`${b.headline} ${b.dek}`));
  return (c.shared >= m.clusterMinSharedWords && c.score >= m.clusterSimilarity) || (c.shared >= 2 && c.score >= 0.4);
}

/** Best-matching story from each other source, seen within the cluster window. */
export function findRelated<T extends ScoredStory>(story: T, candidates: T[], idf: Idf, cfg: Config, now: number): T[] {
  const windowMs = cfg.matching.clusterWindowHours * 3_600_000;
  const mine = tokens(`${story.headline} ${story.dek}`);
  const best = new Map<string, { s: T; score: number }>();
  for (const o of candidates) {
    if (o.sourceId === story.sourceId || now - o.lastSeen > windowMs || o.opinion) continue;
    if (!sameEvent(idf, story, o, cfg)) continue;
    const score = idf.cosine(mine, tokens(`${o.headline} ${o.dek}`)).score;
    const prev = best.get(o.sourceId);
    if (!prev || score > prev.score) best.set(o.sourceId, { s: o, score });
  }
  return [...best.values()].map((b) => b.s);
}

export interface ScoreInput {
  ctx: PageContext;
  /** Same-event stories from other sources (see findRelated). */
  related: ScoredStory[];
  /** Personal boost; only applied when the config allows it to affect alerts. */
  preference?: { boost: number; reason?: string };
}

export function scoreStory(story: ScoredStory, input: ScoreInput, cfg: Config, now: number) {
  const w = cfg.weights;
  const { ctx, related } = input;
  const signals: string[] = [];
  let score = 0;
  const add = (pts: number, why: string) => {
    if (!pts) return;
    score += pts;
    signals.push(`${pts > 0 ? '+' : ''}${pts} ${why}`);
  };
  const top = isTopSlot(story, ctx, cfg);
  const routine = isRoutine(story);
  const ageH = (now - story.firstSeen) / 3_600_000;

  if (isLead(story, ctx)) add(w.leadStory, `lead story (position ${story.lastPosition})`);
  else if (top) add(w.topSlot, `top ${w.topSlotCount} story (position ${story.lastPosition}${ctx.via === 'rss' ? ', feed order' : ''})`);

  story.related = related.map((r) => r.id);
  if (related.length) {
    const pts = Math.min(w.coverageMax, w.coverageFirst + (related.length - 1) * w.coverageEach);
    const names = [...new Set(related.map((r) => r.sourceId.toUpperCase()))].join(', ');
    add(pts, `also covered by ${names}`);
    if (top && related.some((r) => r.topStreak > 0)) add(w.topOnMultiple, 'top story on more than one front page');
  }

  if (story.breaking) add(w.breaking, '"Breaking" label');
  else if (story.live && !routine && ageH <= w.liveMaxAgeHours) add(w.liveOrBreaking, 'new live coverage');
  if (top && ageH <= 0.75 && !routine) add(w.freshAtTop, 'just landed near the top');
  if (story.topStreak >= w.persistenceChecks) add(w.persistence, `in top slots for ${story.topStreak} checks`);

  const hits = keywordHits(`${story.headline} ${story.dek}`, cfg.keywords);
  if (hits.length) add(Math.min(w.keywordMax, hits.length * w.keywordPerCategory), `keywords: ${hits.map((h) => `${h.word} (${h.category})`).join(', ')}`);

  if (routine) add(-w.routineLivePenalty, 'routine live blog');
  if (wordCount(story.headline) <= 4) add(-w.shortHeadlinePenalty, 'short sub-headline');
  if (/\?\s*$/.test(story.headline)) add(-w.questionPenalty, 'explainer-style question');
  if (input.preference && input.preference.boost && cfg.personalization.affectAlerts) {
    const b = Math.round(input.preference.boost * 0.5 * 10) / 10;
    add(b, `personal: ${input.preference.reason ?? 'reading habits'}`);
  }

  if (story.opinion) {
    score *= w.opinionMultiplier;
    signals.push(`×${w.opinionMultiplier} opinion piece`);
  }

  story.score = Math.max(0, Math.round(score * 10) / 10);
  story.maxScore = Math.max(story.maxScore, story.score);
  story.signals = signals;
}
