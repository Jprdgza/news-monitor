// Ranking helpers for the digest. Pure module, unit-tested.
//
// 1. Events: the same story on several front pages is merged into one event.
// 2. Importance: peak score + how many outlets covered it + a small personal boost,
//    discounted for opinion pieces.
// 3. Diversity: Maximal Marginal Relevance (Carbonell & Goldstein, 1998) picks each next item
//    by importance minus its similarity to what's already picked, so a digest isn't five
//    angles on the same story.
import { similarity, tokens } from './match';

export interface Rankable {
  id: string;
  sourceId: string;
  headline: string;
  dek: string;
  maxScore: number;
  firstSeen: number;
  related?: string[];
  duplicateOf?: string;
  opinion?: boolean;
  topic?: string;
}

export interface Event<T extends Rankable> {
  lead: T;
  members: T[];
  sources: string[];
  importance: number;
}

/** Merge stories that are the same event (linked via `related`). The highest-scoring one leads. */
export function groupEvents<T extends Rankable>(stories: T[], boost: (s: T) => number = () => 0): Event<T>[] {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let p = parent.get(id) ?? id;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p)!;
    parent.set(id, p);
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const s of stories) {
    for (const r of s.related ?? []) if (byId.has(r)) union(s.id, r);
    if (s.duplicateOf && byId.has(s.duplicateOf)) union(s.id, s.duplicateOf);
  }
  const groups = new Map<string, T[]>();
  for (const s of stories) {
    const root = find(s.id);
    groups.set(root, [...(groups.get(root) ?? []), s]);
  }
  const events: Event<T>[] = [];
  for (const members of groups.values()) {
    members.sort((a, b) => Number(!!a.opinion) - Number(!!b.opinion) || b.maxScore - a.maxScore || a.firstSeen - b.firstSeen);
    const lead = members[0];
    const sources = [...new Set(members.map((m) => m.sourceId))];
    const importance = lead.maxScore * (lead.opinion ? 0.5 : 1) + Math.min(4, (sources.length - 1) * 1.5) + boost(lead);
    events.push({ lead, members, sources, importance: Math.round(importance * 10) / 10 });
  }
  return events;
}

/** Similarity between two events, 0..1 (word overlap, plus a little for sharing a topic). */
export function eventSimilarity<T extends Rankable>(a: Event<T>, b: Event<T>): number {
  const sim = similarity(tokens(`${a.lead.headline} ${a.lead.dek}`), tokens(`${b.lead.headline} ${b.lead.dek}`));
  const sameTopic = a.lead.topic && a.lead.topic === b.lead.topic && a.lead.topic !== 'other' ? 0.15 : 0;
  return Math.min(1, sim.overlap * 0.85 + sameTopic);
}

/**
 * Pick `k` events by Maximal Marginal Relevance.
 * lambda = 1 ranks purely by importance; lower values favour variety.
 */
export function mmr<T extends Rankable>(events: Event<T>[], k: number, lambda: number, exclude: Set<string> = new Set()): Event<T>[] {
  const pool = events.filter((e) => !exclude.has(e.lead.id));
  if (!pool.length || k <= 0) return [];
  const maxImp = Math.max(...pool.map((e) => e.importance), 1);
  const picked: Event<T>[] = [];
  while (picked.length < k && pool.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const rel = pool[i].importance / maxImp;
      const red = picked.length ? Math.max(...picked.map((p) => eventSimilarity(p, pool[i]))) : 0;
      const val = lambda * rel - (1 - lambda) * red;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    picked.push(pool.splice(bestIdx, 1)[0]);
  }
  return picked;
}
