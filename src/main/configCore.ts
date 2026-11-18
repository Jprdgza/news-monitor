// Config shape, validation and merging. Pure (no Electron) so it can be unit-tested.
// Anything coming from disk or from the settings panel goes through sanitizeConfig(), which
// keeps the shape of the defaults, clamps numbers to sane ranges and drops unknown junk.

export interface CustomSourceInput {
  id: string;
  name: string;
  homeUrl: string;
  rssUrl?: string;
  articlePattern?: string;
  requiresLogin?: boolean;
}

export interface Config {
  version: number;
  alertThreshold: number;
  overnightThresholdMultiplier: number;
  maxAlertsPerDay: number;
  followUpExtraScore: number;
  dryRun: boolean;
  sources: { enabled: string[]; custom: CustomSourceInput[] };
  polling: {
    timezone: string;
    dayStartHour: number;
    dayEndHour: number;
    dayIntervalMinutes: number;
    dayJitterMinutes: number;
    nightIntervalMinutes: number;
    nightJitterMinutes: number;
  };
  efficiency: {
    blockAds: boolean;
    unloadTabsAfterMinutes: number;
    batteryIntervalMultiplier: number;
    slowerWhenLocked: boolean;
    loadImagesInChecks: boolean;
  };
  digest: { morningStartHour: number; topCount: number; macroCount: number; microCount: number; radarCount: number; diversity: number };
  theme: { enabled: boolean; flavor: string; accent: string; background: string; text: string; themeApp: boolean; perSource: Record<string, boolean> };
  personalization: { enabled: boolean; affectAlerts: boolean };
  weights: {
    leadStory: number;
    topSlot: number;
    topSlotCount: number;
    coverageFirst: number;
    coverageEach: number;
    coverageMax: number;
    topOnMultiple: number;
    liveOrBreaking: number;
    breaking: number;
    liveMaxAgeHours: number;
    freshAtTop: number;
    persistence: number;
    persistenceChecks: number;
    keywordPerCategory: number;
    keywordMax: number;
    opinionMultiplier: number;
    shortHeadlinePenalty: number;
    questionPenalty: number;
    routineLivePenalty: number;
  };
  matching: {
    sameStorySimilarity: number;
    clusterSimilarity: number;
    clusterMinSharedWords: number;
    clusterWindowHours: number;
    alertDedupeHours: number;
  };
  previews: { enabled: boolean; maxPerCheck: number; secondsBetween: number };
  minHeadlinesBeforeFallback: number;
  keywords: Record<string, string[]>;
}

/** Allowed ranges for numeric settings (path → [min, max]). Anything else: [0, 1000]. */
const BOUNDS: Record<string, [number, number]> = {
  alertThreshold: [1, 50],
  overnightThresholdMultiplier: [1, 5],
  maxAlertsPerDay: [0, 100],
  'polling.dayStartHour': [0, 23],
  'polling.dayEndHour': [1, 24],
  'polling.dayIntervalMinutes': [3, 240],
  'polling.nightIntervalMinutes': [5, 600],
  'polling.dayJitterMinutes': [0, 60],
  'polling.nightJitterMinutes': [0, 120],
  'efficiency.unloadTabsAfterMinutes': [0, 1440],
  'efficiency.batteryIntervalMultiplier': [1, 5],
  'digest.morningStartHour': [0, 23],
  'digest.topCount': [0, 30],
  'digest.macroCount': [0, 30],
  'digest.microCount': [0, 30],
  'digest.radarCount': [0, 30],
  'digest.diversity': [0, 1],
  'previews.maxPerCheck': [0, 20],
  'previews.secondsBetween': [1, 120],
  'matching.sameStorySimilarity': [0.1, 1],
  'matching.clusterSimilarity': [0.05, 1],
  'weights.opinionMultiplier': [0, 1],
  minHeadlinesBeforeFallback: [0, 100],
};

export const FLAVORS = ['latte', 'frappe', 'macchiato', 'mocha'];
export const ACCENTS = ['rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach', 'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender'];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function isHttpUrl(s: unknown, httpsOnly = false): boolean {
  if (typeof s !== 'string' || s.length > 2000) return false;
  try {
    const u = new URL(s);
    return httpsOnly ? u.protocol === 'https:' : u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function validRegex(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 500) return false;
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

function sanitizeCustom(list: unknown): CustomSourceInput[] {
  if (!Array.isArray(list)) return [];
  const out: CustomSourceInput[] = [];
  for (const c of list.slice(0, 30)) {
    if (!isObj(c) || !ID.test(String(c.id)) || !isHttpUrl(c.homeUrl, true)) continue;
    out.push({
      id: String(c.id),
      name: String(c.name || c.id).slice(0, 60),
      homeUrl: String(c.homeUrl),
      ...(isHttpUrl(c.rssUrl) ? { rssUrl: String(c.rssUrl) } : {}),
      ...(validRegex(c.articlePattern) && c.articlePattern ? { articlePattern: c.articlePattern } : {}),
      requiresLogin: !!c.requiresLogin,
    });
  }
  return out;
}

/** Recursively coerce `input` to the shape of `defaults`. */
function coerce(defaults: any, input: any, path: string): any {
  if (typeof defaults === 'number') {
    const n = typeof input === 'number' ? input : typeof input === 'string' && input.trim() !== '' ? Number(input) : NaN;
    if (!Number.isFinite(n)) return defaults;
    const [min, max] = BOUNDS[path] ?? [0, 1000];
    return Math.min(max, Math.max(min, n));
  }
  if (typeof defaults === 'boolean') return typeof input === 'boolean' ? input : defaults;
  if (typeof defaults === 'string') return typeof input === 'string' ? input.slice(0, 200) : defaults;
  if (Array.isArray(defaults)) {
    if (!Array.isArray(input)) return defaults;
    return input.filter((x) => typeof x === 'string').map((x: string) => x.slice(0, 100)).slice(0, 300);
  }
  if (isObj(defaults)) {
    const out: any = {};
    for (const key of Object.keys(defaults)) out[key] = coerce(defaults[key], isObj(input) ? input[key] : undefined, path ? `${path}.${key}` : key);
    return out;
  }
  return defaults;
}

export function sanitizeConfig(defaults: Config, input: unknown): Config {
  const raw = isObj(input) ? input : {};
  const cfg = coerce(defaults, raw, '') as Config;

  // Free-form sections the generic coercion can't express.
  if (isObj(raw.keywords)) {
    const kw: Record<string, string[]> = {};
    for (const [cat, words] of Object.entries(raw.keywords).slice(0, 30)) {
      if (!Array.isArray(words)) continue;
      kw[String(cat).slice(0, 40)] = words.filter((w) => typeof w === 'string' && w.trim()).map((w: string) => w.trim().slice(0, 60)).slice(0, 200);
    }
    cfg.keywords = kw;
  }
  cfg.sources.custom = sanitizeCustom(raw.sources?.custom);
  cfg.sources.enabled = [...new Set(cfg.sources.enabled.filter((id) => ID.test(id)))];
  cfg.theme.perSource = {};
  if (isObj(raw.theme?.perSource)) {
    for (const [id, on] of Object.entries(raw.theme.perSource)) if (ID.test(id) && typeof on === 'boolean') cfg.theme.perSource[id] = on;
  }
  if (!FLAVORS.includes(cfg.theme.flavor)) cfg.theme.flavor = defaults.theme.flavor;
  if (!ACCENTS.includes(cfg.theme.accent)) cfg.theme.accent = defaults.theme.accent;
  if (cfg.theme.background && !HEX.test(cfg.theme.background)) cfg.theme.background = '';
  if (cfg.theme.text && !HEX.test(cfg.theme.text)) cfg.theme.text = '';
  try {
    if (cfg.polling.timezone) new Intl.DateTimeFormat('en-US', { timeZone: cfg.polling.timezone });
  } catch {
    cfg.polling.timezone = defaults.polling.timezone;
  }
  if (cfg.polling.dayEndHour <= cfg.polling.dayStartHour) {
    cfg.polling.dayStartHour = defaults.polling.dayStartHour;
    cfg.polling.dayEndHour = defaults.polling.dayEndHour;
  }

  // Version 1 configs had different scoring weights; adopt the new defaults once.
  if (!(Number(raw.version) >= 2)) {
    cfg.weights = { ...defaults.weights };
    cfg.matching = { ...defaults.matching };
    cfg.keywords = structuredClone(defaults.keywords);
  }
  cfg.version = defaults.version;
  return cfg;
}
