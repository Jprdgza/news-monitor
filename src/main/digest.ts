// Queries behind the sidebar and the menu bar panel: a day's list, "What's new",
// the sectioned morning briefing, the alert inbox, and what's flagged right now.
import { getConfig } from './config';
import { noteShown, preferenceBoost } from './prefs';
import { groupEvents, mmr, type Event } from './rank';
import { formatter } from './schedule';
import { isGeneric, isRoutine } from './scoring';
import { findSource } from './sources';
import { store, type AlertRecord, type Story } from './store';
import { TOPIC_LABEL } from './topics';

export interface StoryView {
  id: string;
  sourceId: string;
  sourceShort: string;
  sourceColor: string;
  url: string;
  headline: string;
  dek: string;
  preview?: string;
  firstSeen: number;
  score: number;
  flagged: boolean;
  alerted: boolean;
  live: boolean;
  breaking: boolean;
  opinion: boolean;
  topic: string;
  signals: string[];
  /** Short names of other outlets running the same story. */
  alsoIn: string[];
  feedback?: 'up' | 'down';
  opened: boolean;
  personal?: string;
  alertTime?: number;
  unseen?: boolean;
  followUp?: boolean;
}

export interface Section {
  id: string;
  title: string;
  hint: string;
  stories: StoryView[];
}

const TZ = () => getConfig().polling.timezone;

/** YYYY-MM-DD for a timestamp, in the configured timezone. */
export function dayKey(ts: number): string {
  return formatter(TZ(), 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
}

/** UTC timestamp of a wall-clock time in the configured timezone. */
function wallTime(day: string, hour: number): number {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const parts = formatter(TZ(), 'en-US', { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return guess - (asIfUtc - guess);
}

function toView(s: Story, alsoIn: string[] = []): StoryView {
  const cfg = getConfig();
  const src = findSource(cfg, s.sourceId);
  const pref = preferenceBoost(s);
  if (!alsoIn.length && s.related?.length) {
    alsoIn = [...new Set(s.related.map((id) => store.byId(id)?.sourceId).filter((x): x is string => !!x && x !== s.sourceId))];
  }
  return {
    id: s.id,
    sourceId: s.sourceId,
    sourceShort: src?.short ?? s.sourceId.toUpperCase(),
    sourceColor: src?.color ?? '#888888',
    url: s.url,
    headline: s.headline,
    dek: s.dek,
    preview: s.preview,
    firstSeen: s.firstSeen,
    score: s.maxScore,
    flagged: !!s.alertedAt || (s.maxScore >= cfg.alertThreshold && !s.opinion),
    alerted: !!s.alertedAt,
    live: s.live,
    breaking: !!s.breaking,
    opinion: !!s.opinion,
    topic: TOPIC_LABEL[s.topic ?? 'other'] ?? 'Other',
    signals: s.signals,
    alsoIn: alsoIn.map((id) => findSource(cfg, id)?.short ?? id.toUpperCase()),
    feedback: s.feedback,
    opened: !!s.openedAt,
    personal: pref.boost ? `${pref.boost > 0 ? '+' : ''}${pref.boost} ${pref.reason}` : undefined,
  };
}

const eventView = (e: Event<Story>) => toView(e.lead, e.sources.filter((id) => id !== e.lead.sourceId));

/** Stories worth listing: ever near the top, or scored well. Skips the long tail of minor links. */
const notable = (s: Story) =>
  (s.bestPosition <= 15 || s.maxScore >= getConfig().alertThreshold * 0.5 || !!s.alertedAt) && !isGeneric(s) && !isRoutine(s);

const boost = (s: Story) => preferenceBoost(s).boost;

export function availableDays(): string[] {
  return [...new Set(store.stories.map((s) => dayKey(s.firstSeen)))].sort().reverse();
}

/** Every notable story first seen on a day, newest first. */
export function dayDigest(day: string): StoryView[] {
  return store.stories
    .filter((s) => dayKey(s.firstSeen) === day && notable(s))
    .sort((a, b) => b.firstSeen - a.firstSeen)
    .map((s) => toView(s));
}

/** The most important new events since you last looked, with variety. */
export function whatsNew(): { since: number; stories: StoryView[] } {
  const since = store.state.lastWhatsNewAt || Date.now() - 24 * 3_600_000;
  const events = groupEvents(store.stories.filter((s) => s.firstSeen > since && notable(s)), boost);
  const picked = mmr(events, 20, 0.75);
  noteShown(picked.map((e) => e.lead));
  store.state.lastWhatsNewAt = Date.now();
  store.saveState();
  return { since, stories: picked.map(eventView) };
}

/**
 * The morning briefing since last evening: the biggest stories, then the macro picture
 * (economy, markets, world, policy), the micro picture (companies, tech, industries), and a
 * few smaller stories that stayed up all night but never made the top.
 */
export function morningDigest(): { since: number; sections: Section[] } {
  const cfg = getConfig().digest;
  const threshold = getConfig().alertThreshold;
  const yesterday = dayKey(wallTime(dayKey(Date.now()), 12) - 86_400_000);
  const since = wallTime(yesterday, cfg.morningStartHour);
  const events = groupEvents(store.stories.filter((s) => s.firstSeen >= since && notable(s)), boost);
  const used = new Set<string>();
  const take = (pool: Event<Story>[], k: number) => {
    const picked = mmr(pool, k, cfg.diversity, used);
    for (const e of picked) used.add(e.lead.id);
    return picked;
  };
  const nonOpinion = events.filter((e) => !e.lead.opinion);
  const top = take(nonOpinion, cfg.topCount);
  const macro = take(nonOpinion.filter((e) => e.lead.scope === 'macro'), cfg.macroCount);
  const micro = take(nonOpinion.filter((e) => e.lead.scope === 'micro'), cfg.microCount);
  // Under the radar: one outlet only, never big, but it held a front-page spot for a while.
  const radarPool = nonOpinion
    .filter((e) => e.sources.length === 1 && e.lead.maxScore < threshold * 0.6 && e.lead.scope !== 'other' && e.lead.checksSeen >= 3)
    .map((e) => ({ ...e, importance: Math.log2(1 + e.lead.checksSeen) + boost(e.lead) }));
  const radar = take(radarPool, cfg.radarCount);

  noteShown([...top, ...macro, ...micro, ...radar].map((e) => e.lead));
  const sections: Section[] = [
    { id: 'top', title: 'Top stories', hint: 'By prominence and coverage', stories: top.map(eventView) },
    { id: 'macro', title: 'Macro', hint: 'Economy, markets, world and policy', stories: macro.map(eventView) },
    { id: 'micro', title: 'Micro', hint: 'Companies, tech and industries', stories: micro.map(eventView) },
    { id: 'radar', title: 'Under the radar', hint: 'Smaller stories that stayed up for hours', stories: radar.map(eventView) },
  ];
  return { since, sections: sections.filter((s) => s.stories.length) };
}

/** Alerts from the last week, newest first, with "missed" marking. */
export function alertInbox(): StoryView[] {
  const seenAt = store.state.alertsSeenAt;
  return store
    .recentAlerts(7)
    .filter((a) => !a.dryRun)
    .map((a) => {
      const s = store.byId(a.storyId ?? `${a.sourceId}:${a.url}`);
      const v = s ? toView(s) : fallbackView(a);
      return { ...v, alertTime: Date.parse(a.time), unseen: Date.parse(a.time) > seenAt, followUp: !!a.followUp, signals: a.signals, score: a.score };
    });
}

function fallbackView(a: AlertRecord): StoryView {
  const src = findSource(getConfig(), a.sourceId);
  return {
    id: a.storyId ?? a.url,
    sourceId: a.sourceId,
    sourceShort: src?.short ?? a.sourceId.toUpperCase(),
    sourceColor: src?.color ?? '#888888',
    url: a.url,
    headline: a.headline,
    dek: '',
    firstSeen: Date.parse(a.time),
    score: a.score,
    flagged: true,
    alerted: true,
    live: false,
    breaking: false,
    opinion: false,
    topic: '',
    signals: a.signals,
    alsoIn: [],
    opened: false,
  };
}

export function unseenAlertCount(): number {
  const seenAt = store.state.alertsSeenAt;
  return store.stories.filter((s) => s.alertedAt && s.alertedAt > seenAt).length;
}

export function markAlertsSeen() {
  store.state.alertsSeenAt = Date.now();
  store.saveState();
}

/** What's big on the front pages right now (for the menu bar panel). */
export function flaggedNow(limit = 8): StoryView[] {
  const cfg = getConfig();
  const lastCheck = store.state.lastCheckAt ?? 0;
  const live = store.stories.filter(
    (s) =>
      !s.opinion &&
      ((s.lastSeen >= lastCheck - 60_000 && s.score >= cfg.alertThreshold * 0.75) || (s.alertedAt && Date.now() - s.alertedAt < 12 * 3_600_000))
  );
  return groupEvents(live, boost)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, limit)
    .map(eventView);
}
