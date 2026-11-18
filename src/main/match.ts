// Fuzzy headline matching. Text becomes a set of word stems; two stories are compared with
// an IDF-weighted cosine, so rare words ("Bahrain", "measles") count for much more than
// words that appear in half of all headlines ("Trump", "China", "says").
// Pure module (no Electron) so it can be unit-tested.

const STOPWORDS = new Set(
  ('a an the and or but of to in on at for from by with as is are was were be been being it its this that these those ' +
    'after before over under into about than then so if not no new says say said will would could can may might just more most ' +
    'what why how who when where which while amid against his her their our your my he she they we you i us them up down out ' +
    'has have had do does did get gets got live updates update latest news here there now one two first last back off ' +
    'week weeks day days year years time today yesterday tomorrow make makes made take takes took')
    .split(' ')
);

/** Light suffix stripping so "rate", "rates", "rated" and "rating" share one stem. */
function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (/(ss|x|ch|sh|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  else if (w.endsWith('ied') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  // Drop a final "e" so "raise"/"raised"/"raises" all become "rais".
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

// The same headlines are compared many times per check; remember their tokens.
const tokenCache = new Map<string, Set<string>>();

export function tokens(text: string): Set<string> {
  let cached = tokenCache.get(text);
  if (!cached) {
    if (tokenCache.size > 8000) tokenCache.clear();
    tokenCache.set(text, (cached = computeTokens(text)));
  }
  return cached;
}

function computeTokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/\b(u)\.(s)\.?/g, 'us_')
    .replace(/\b(a)\.(i)\.?/g, 'ai')
    .replace(/[^a-z0-9_$%. -]/g, ' ')
    .split(/[\s.-]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words.map(stem));
}

export interface Similarity {
  shared: number;
  /** shared / smaller set size (0..1). Forgiving of one headline being longer. */
  overlap: number;
  /** shared / union size (0..1). Stricter. */
  jaccard: number;
}

export function similarity(a: Set<string>, b: Set<string>): Similarity {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const min = Math.min(a.size, b.size) || 1;
  const union = a.size + b.size - shared || 1;
  return { shared, overlap: shared / min, jaccard: shared / union };
}

/** Inverse document frequency over a corpus of recent headlines. */
export class Idf {
  private df = new Map<string, number>();
  private n = 0;

  constructor(docs: Iterable<Set<string>>) {
    for (const d of docs) {
      this.n++;
      for (const t of d) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
  }

  weight(t: string): number {
    return Math.log((this.n + 1) / ((this.df.get(t) ?? 0) + 1)) + 1;
  }

  /** IDF-weighted cosine similarity (0..1) plus the number of shared words. */
  cosine(a: Set<string>, b: Set<string>): { score: number; shared: number } {
    let dot = 0;
    let na = 0;
    let nb = 0;
    let shared = 0;
    for (const t of a) {
      const w = this.weight(t) ** 2;
      na += w;
      if (b.has(t)) {
        dot += w;
        shared++;
      }
    }
    for (const t of b) nb += this.weight(t) ** 2;
    return { score: na && nb ? dot / Math.sqrt(na * nb) : 0, shared };
  }
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}
