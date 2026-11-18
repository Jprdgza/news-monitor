// Local storage as plain JSON files in <userData>/data/.
//   stories.json  - one record per story (headline metadata only, never full articles)
//   state.json    - small app state (last "What's new" visit, sign-in status, etc.)
//   alerts.jsonl  - one line per alert, with the signals that fired it (for tuning)
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { BOILERPLATE_SOURCE, TICKER_SOURCE } from './textClean';
import type { Scope, Topic } from './topics';

export interface Story {
  id: string;
  sourceId: string;
  url: string;
  urls: string[];
  headline: string;
  /** Earlier headlines for the same story (updated headlines). */
  oldHeadlines: string[];
  dek: string;
  firstSeen: number;
  lastSeen: number;
  bestPosition: number;
  lastPosition: number;
  /** Consecutive checks in the top slots. */
  topStreak: number;
  /** Total checks the story has been on the front page. */
  checksSeen: number;
  live: boolean;
  breaking?: boolean;
  opinion?: boolean;
  topic?: Topic;
  scope?: Scope;
  /** Score from the most recent check where the story was on the page. */
  score: number;
  /** Highest score ever reached (used for ranking digests). */
  maxScore: number;
  signals: string[];
  /** Other sources' stories about the same event (ids). */
  related?: string[];
  alertedAt?: number;
  /** Set instead of alertedAt when the story would have alerted during a dry run. */
  dryRunAlertedAt?: number;
  /** Set when this story was suppressed because a matching story already alerted. */
  duplicateOf?: string;
  preview?: string;
  previewTried?: boolean;
  via: 'page' | 'rss';
  openedAt?: number;
  feedback?: 'up' | 'down';
}

export interface LoginState {
  loggedIn: boolean | null;
  reason: string;
  checkedAt?: number;
  lastDefinite?: boolean;
  /** Has this source ever been seen signed in? (Signed-out sources you never used aren't warnings.) */
  everSignedIn?: boolean;
}

export interface AppState {
  lastWhatsNewAt: number;
  onboardingDismissed: boolean;
  lastCheckAt?: number;
  nextCheckAt?: number;
  checking: boolean;
  login: Record<string, LoginState>;
  warnings: string[];
  lastCounts: Record<string, number>;
  /** Alerts newer than this are "missed" (badge count). */
  alertsSeenAt: number;
}

export interface AlertRecord {
  time: string;
  dryRun: boolean;
  storyId: string;
  sourceId: string;
  headline: string;
  url: string;
  score: number;
  threshold: number;
  overnight: boolean;
  followUp?: boolean;
  signals: string[];
}

const dir = () => path.join(app.getPath('userData'), 'data');
const file = (name: string) => path.join(dir(), name);

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(name: string, data: unknown) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file(name)); // atomic replace
}
export const readData = readJson;

const KEEP_DAYS = 45;

const TICKERS = new RegExp(TICKER_SOURCE, 'g');
const JUNK_PREVIEW = new RegExp(BOILERPLATE_SOURCE, 'i');

/** Older versions stored `paper` and `source` (page/rss); rename on load. */
function migrate(s: any): Story {
  if (!s.sourceId && s.paper) s.sourceId = s.paper;
  if (!s.via) s.via = s.source === 'rss' ? 'rss' : 'page';
  if (typeof s.checksSeen !== 'number') s.checksSeen = 1;
  if (s.crossPaperId && !s.related) s.related = [s.crossPaperId];
  if (typeof s.preview === 'string') {
    s.preview = s.preview.replace(TICKERS, '');
    if (JUNK_PREVIEW.test(s.preview)) delete s.preview;
  }
  delete s.paper;
  delete s.source;
  delete s.crossPaperId;
  return s;
}

class Store {
  stories: Story[] = [];
  private byIdMap = new Map<string, Story>();
  state: AppState = {
    lastWhatsNewAt: 0,
    onboardingDismissed: false,
    checking: false,
    login: {},
    warnings: [],
    lastCounts: {},
    alertsSeenAt: 0,
  };

  load() {
    this.stories = readJson<any[]>('stories.json', []).map(migrate);
    this.reindex();
    this.state = { ...this.state, ...readJson<Partial<AppState>>('state.json', {}), checking: false };
    if (!this.state.alertsSeenAt) this.state.alertsSeenAt = Date.now();
    for (const l of Object.values(this.state.login)) if (l.lastDefinite || l.loggedIn) l.everSignedIn = true;
  }

  reindex() {
    this.byIdMap = new Map(this.stories.map((s) => [s.id, s]));
  }

  add(s: Story) {
    this.stories.push(s);
    this.byIdMap.set(s.id, s);
  }

  saveStories() {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    const before = this.stories.length;
    this.stories = this.stories.filter((s) => s.lastSeen >= cutoff);
    if (this.stories.length !== before) this.reindex();
    writeJson('stories.json', this.stories);
  }

  saveState() {
    writeJson('state.json', this.state);
  }

  appendAlertLog(entry: AlertRecord) {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file('alerts.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  /** Alerts from the last `days` days, newest first. */
  recentAlerts(days = 7): AlertRecord[] {
    let text = '';
    try {
      text = fs.readFileSync(file('alerts.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const cutoff = Date.now() - days * 86_400_000;
    const out: AlertRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const a = JSON.parse(line);
        a.sourceId ??= a.paper;
        if (Date.parse(a.time) >= cutoff) out.push(a);
      } catch {
        /* skip a corrupt line */
      }
    }
    return out.reverse();
  }

  byId(id: string) {
    return this.byIdMap.get(id);
  }
}

export const store = new Store();
