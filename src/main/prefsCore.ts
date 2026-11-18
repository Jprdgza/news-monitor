// Personalization that stays on this Mac: a tiny, explainable model of what you read.
//
// Each story has features: its topic, its source, and a few distinctive headline words.
// Opening a story, or tapping 👍, counts in favour of its features; 👎 and stories you
// scroll past in a digest count against them. Evidence fades with a 30-day half-life, and
// the affinity is shrunk toward zero until there's enough of it, so one click can't
// reshape your digest. The resulting boost is bounded (±1.5 points) and every boost is
// shown with its reason. Pure module, unit-tested.
import { tokens } from './match';

export interface FeatureStat {
  pos: number;
  neg: number;
  /** When pos/neg were last decayed. */
  t: number;
}

export interface Prefs {
  features: Record<string, FeatureStat>;
  /** storyId → time it was first shown in a digest (so impressions count once). */
  shown: Record<string, number>;
}

export type Feedback = 'open' | 'up' | 'down' | 'skip';

const HALF_LIFE_MS = 30 * 86_400_000;
const AMOUNT: Record<Feedback, { pos: number; neg: number }> = {
  open: { pos: 1, neg: 0 },
  up: { pos: 3, neg: 0 },
  down: { pos: 0, neg: 3 },
  skip: { pos: 0, neg: 0.15 },
};
const TYPE_WEIGHT: Record<string, number> = { topic: 1, src: 0.5, term: 0.8 };
/** Pseudo-count pulling affinity toward 0 when evidence is thin. */
const PRIOR = 8;
export const MAX_BOOST = 1.5;

export const emptyPrefs = (): Prefs => ({ features: {}, shown: {} });

export interface StoryLike {
  sourceId: string;
  headline: string;
  topic?: string;
}

/** Features of a story: topic, source, and up to 4 longer headline words. */
export function featuresOf(s: StoryLike): string[] {
  const f = [`src:${s.sourceId}`];
  if (s.topic && s.topic !== 'other') f.push(`topic:${s.topic}`);
  const words = [...tokens(s.headline)].filter((w) => w.length >= 4 && !/^\d+$/.test(w)).slice(0, 4);
  for (const w of words) f.push(`term:${w}`);
  return f;
}

function decayed(stat: FeatureStat, now: number): FeatureStat {
  const k = Math.pow(0.5, Math.max(0, now - stat.t) / HALF_LIFE_MS);
  return { pos: stat.pos * k, neg: stat.neg * k, t: now };
}

export function record(prefs: Prefs, features: string[], kind: Feedback, now: number) {
  const add = AMOUNT[kind];
  for (const f of features) {
    const s = decayed(prefs.features[f] ?? { pos: 0, neg: 0, t: now }, now);
    s.pos += add.pos;
    s.neg += add.neg;
    prefs.features[f] = s;
  }
}

/** -1..1: how much you favour this feature, shrunk toward 0 with little evidence. */
export function affinity(stat: FeatureStat | undefined, now: number): number {
  if (!stat) return 0;
  const s = decayed(stat, now);
  return (s.pos - s.neg) / (s.pos + s.neg + PRIOR);
}

const LABEL = (f: string) => {
  const [type, value] = f.split(':');
  if (type === 'topic') return `${value[0].toUpperCase()}${value.slice(1)} stories`;
  if (type === 'src') return `this source`;
  return `"${value}"`;
};

/** Boost (−MAX_BOOST..MAX_BOOST) for a story, with a human-readable reason for the biggest factor. */
export function boostFor(prefs: Prefs, s: StoryLike, now: number): { boost: number; reason?: string } {
  let total = 0;
  let best: { f: string; v: number } | undefined;
  const feats = featuresOf(s);
  const termCount = feats.filter((f) => f.startsWith('term:')).length || 1;
  for (const f of feats) {
    const type = f.split(':')[0];
    let v = affinity(prefs.features[f], now) * (TYPE_WEIGHT[type] ?? 0);
    if (type === 'term') v /= Math.sqrt(termCount); // several words shouldn't outweigh the topic
    total += v;
    if (!best || Math.abs(v) > Math.abs(best.v)) best = { f, v };
  }
  const boost = Math.round(Math.max(-MAX_BOOST, Math.min(MAX_BOOST, total)) * 10) / 10;
  if (Math.abs(boost) < 0.1 || !best) return { boost: 0 };
  const reason = boost > 0 ? `you often read ${LABEL(best.f)}` : `you tend to skip ${LABEL(best.f)}`;
  return { boost, reason };
}

/** Drop old impressions and negligible features so the file stays small. */
export function prune(prefs: Prefs, now: number) {
  for (const [id, t] of Object.entries(prefs.shown)) if (now - t > 14 * 86_400_000) delete prefs.shown[id];
  for (const [f, s] of Object.entries(prefs.features)) {
    const d = decayed(s, now);
    if (d.pos + d.neg < 0.05) delete prefs.features[f];
  }
}
