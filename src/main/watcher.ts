// The watcher: on a schedule, load each front page in a hidden window, extract headlines,
// merge them into the story store, score them, and send alerts for big new stories.
import { EventEmitter } from 'node:events';
import { powerMonitor } from 'electron';
import { getConfig, type Config } from './config';
import { log } from './log';
import { Idf, normalizeUrl, similarity, tokens } from './match';
import { notify } from './notify';
import { runInHiddenPage } from './pageLoader';
import { preferenceBoost } from './prefs';
import { fetchRss } from './rss';
import { isDaytime, nextDelayMs } from './schedule';
import { buildContext, findRelated, isTopSlot, sameEvent, scoreStory, type PageContext } from './scoring';
import { prepareSession } from './sessions';
import { activeSources, extractionScript, isLiveUrl, previewScript, findSource, type ExtractionResult, type RawHeadline, type SourceDef } from './sources';
import { store, type Story } from './store';
import { classify } from './topics';

const MAX_NOTIFICATIONS_PER_CHECK = 3;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Watcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private previewing = false;
  locked = false;
  dryRun = false;

  start() {
    this.scheduleNext();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  scheduleNext() {
    this.stop();
    const delay = nextDelayMs(getConfig(), new Date(), { onBattery: powerMonitor.isOnBatteryPower(), locked: this.locked });
    store.state.nextCheckAt = Date.now() + delay;
    store.saveState();
    this.timer = setTimeout(() => this.runCheck('scheduled'), delay);
    this.emit('update');
  }

  get isDryRun() {
    return this.dryRun || getConfig().dryRun;
  }

  get isRunning() {
    return this.running;
  }

  async runCheck(reason: string): Promise<void> {
    if (this.running) {
      log.info(`Check requested (${reason}) but one is already running`);
      return;
    }
    this.running = true;
    store.state.checking = true;
    this.emit('update');
    const cfg = getConfig();
    const now = Date.now();
    const warnings: string[] = [];
    const t0 = performance.now();
    log.info(`Check started (${reason})${this.isDryRun ? ' [dry run]' : ''}`);

    try {
      // 1. Read each front page (fall back to RSS if extraction looks broken).
      const pages: { source: SourceDef; headlines: RawHeadline[]; via: 'page' | 'rss' }[] = [];
      for (const source of activeSources(cfg)) {
        prepareSession(source.id);
        let result: ExtractionResult | null = null;
        try {
          result = await runInHiddenPage<ExtractionResult>(source.id, source.homeUrl, extractionScript(source), {
            images: cfg.efficiency.loadImagesInChecks,
          });
        } catch (err) {
          log.error(`${source.short} page load/extraction failed: ${err}`);
        }
        let headlines = result?.headlines ?? [];
        let via: 'page' | 'rss' = 'page';
        if (headlines.length < cfg.minHeadlinesBeforeFallback) {
          const msg = source.rssFeeds.length
            ? `${source.short}: front page gave only ${headlines.length} headlines, used RSS instead`
            : `${source.short}: front page gave only ${headlines.length} headlines`;
          log.warn(msg);
          warnings.push(msg);
          if (source.rssFeeds.length) {
            headlines = await fetchRss(source);
            via = 'rss';
            if (headlines.length === 0) warnings.push(`${source.short}: RSS fallback also returned nothing`);
          }
        }
        if (result?.login && source.requiresLogin) this.updateLogin(source, result.login);
        store.state.lastCounts[source.id] = headlines.length;
        pages.push({ source, headlines, via });
        log.info(`${source.short}: ${headlines.length} headlines via ${via}`);
      }

      // 2. Merge into the store (new stories, updated headlines, positions).
      const present: { story: Story; ctx: PageContext }[] = [];
      const index = buildIndex(now);
      for (const page of pages) {
        const ctx = buildContext(page.headlines, page.via);
        const pageUrls = new Set(page.headlines.map((h) => normalizeUrl(h.url)));
        const seenIds = new Set<string>();
        for (const h of page.headlines) {
          const story = upsert(page.source, h, now, pageUrls, page.via, cfg, index);
          if (seenIds.has(story.id)) continue;
          seenIds.add(story.id);
          // Context maps are keyed by the URL as extracted; make sure the story's URL maps too.
          const u = normalizeUrl(h.url);
          ctx.fontRank.set(story.url, ctx.fontRank.get(u) ?? 99);
          ctx.fontSize.set(story.url, ctx.fontSize.get(u) ?? 0);
          present.push({ story, ctx });
        }
        // Stories from this source that dropped off the page lose their top-slot streak.
        if (page.headlines.length > 0) {
          for (const s of store.stories) if (s.sourceId === page.source.id && !seenIds.has(s.id)) s.topStreak = 0;
        }
      }
      for (const { story, ctx } of present) story.topStreak = isTopSlot(story, ctx, cfg) ? story.topStreak + 1 : 0;

      // 3. Score everything currently on a front page.
      const idf = buildIdf(now);
      const recent = store.stories.filter((s) => now - s.lastSeen < cfg.matching.clusterWindowHours * 3_600_000);
      for (const { story, ctx } of present) {
        const related = findRelated(story, recent, idf, cfg, now);
        scoreStory(story, { ctx, related, preference: preferenceBoost(story) }, cfg, now);
      }

      // 4. Decide alerts.
      const toAlert = this.pickAlerts(present.map((p) => p.story), idf, cfg, now);
      if (!this.isDryRun) this.sendAlerts(toAlert);
      if (toAlert.length) this.emit('alerts');
      if (this.isDryRun) printDebug(pages, present, alertThreshold(cfg));

      store.state.warnings = warnings;
      store.state.lastCheckAt = now;
      store.saveStories();
      this.emit('stories');
      log.info(`Check finished in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
      log.error(`Check failed: ${err instanceof Error ? err.stack : err}`);
      store.state.warnings = [`Last check failed: ${err}`];
    } finally {
      this.running = false;
      store.state.checking = false;
      store.saveState();
      this.scheduleNext();
      this.emit('update');
    }
    void this.loadPreviews();
  }

  private pickAlerts(stories: Story[], idf: Idf, cfg: Config, now: number): Story[] {
    const threshold = alertThreshold(cfg);
    const night = !isDaytime(cfg);
    const dedupeMs = cfg.matching.alertDedupeHours * 3_600_000;
    const alertTime = (s: Story) => s.alertedAt ?? s.dryRunAlertedAt;
    const alerted = () => store.stories.filter((s) => alertTime(s) && now - alertTime(s)! < dedupeMs);
    // Dry-run marks don't use up the real budget (and vice versa).
    const budgetTime = (s: Story) => (this.isDryRun ? s.dryRunAlertedAt : s.alertedAt);
    let sentToday = store.stories.filter((s) => budgetTime(s) && now - budgetTime(s)! < 24 * 3_600_000).length;

    const candidates = stories
      .filter((s) => s.score >= threshold && !s.alertedAt && !s.dryRunAlertedAt && !s.duplicateOf && !s.opinion)
      .sort((a, b) => b.score - a.score);
    const out: Story[] = [];
    for (const c of candidates) {
      const prior = alerted().filter((a) => a.id !== c.id);
      // Same story already alerted (other source, or an updated headline on the same source).
      const dup = prior.find(
        (a) =>
          a.related?.includes(c.id) ||
          c.related?.includes(a.id) ||
          (a.sourceId === c.sourceId && [a.headline, ...a.oldHeadlines].some((h) => similarity(tokens(c.headline), tokens(h)).jaccard >= cfg.matching.sameStorySimilarity)) ||
          sameEvent(idf, a, c, cfg)
      );
      if (dup) {
        c.duplicateOf = dup.id;
        log.info(`Skip duplicate alert: "${c.headline}" matches already-alerted "${dup.headline}"`);
        continue;
      }
      // A new angle on an already-alerted saga must clear a higher bar.
      const saga = prior.find((a) => {
        const sim = idf.cosine(tokens(`${a.headline} ${a.dek}`), tokens(`${c.headline} ${c.dek}`));
        return sim.shared >= 2 && sim.score >= 0.15;
      });
      const followUp = !!saga;
      if (followUp && c.score < threshold + cfg.followUpExtraScore) {
        log.info(`Hold follow-up: "${c.headline}" (${c.score}) relates to "${saga!.headline}"; needs ${threshold + cfg.followUpExtraScore}`);
        continue;
      }
      if (sentToday >= cfg.maxAlertsPerDay && c.score < threshold * 1.5) {
        log.info(`Daily alert budget used (${cfg.maxAlertsPerDay}); not alerting "${c.headline}" (${c.score})`);
        continue;
      }
      // Dry run marks stories separately so they're logged once and never fire later.
      if (this.isDryRun) c.dryRunAlertedAt = now;
      else c.alertedAt = now;
      sentToday++;
      out.push(c);
      store.appendAlertLog({
        time: new Date(now).toISOString(),
        dryRun: this.isDryRun,
        storyId: c.id,
        sourceId: c.sourceId,
        headline: c.headline,
        url: c.url,
        score: c.score,
        threshold,
        overnight: night,
        followUp,
        signals: c.signals,
      });
      log.info(`${this.isDryRun ? 'WOULD ALERT' : 'ALERT'}${followUp ? ' (follow-up)' : ''} [${c.score} >= ${threshold}] ${c.sourceId.toUpperCase()}: ${c.headline} | ${c.signals.join('; ')}`);
    }
    return out;
  }

  private sendAlerts(stories: Story[]) {
    const cfg = getConfig();
    for (const s of stories.slice(0, MAX_NOTIFICATIONS_PER_CHECK)) {
      const src = findSource(cfg, s.sourceId);
      const others = (s.related ?? []).map((id) => store.byId(id)?.sourceId.toUpperCase()).filter(Boolean);
      const label = s.breaking ? 'Breaking' : s.live ? 'Live' : others.length ? `Also in ${others.join(', ')}` : '';
      notify({
        title: `${src?.name ?? s.sourceId}${label ? ` · ${label}` : ''}`,
        subtitle: s.headline,
        body: s.dek || ' ',
        sourceId: s.sourceId,
        url: s.url,
        storyId: s.id,
      });
    }
    const rest = stories.slice(MAX_NOTIFICATIONS_PER_CHECK);
    if (rest.length) notify({ title: 'News Monitor', body: `${rest.length} more big stories. Open News Monitor to see them.` });
  }

  private updateLogin(source: SourceDef, login: { loggedIn: boolean | null; reason: string }) {
    const prev = store.state.login[source.id] ?? { loggedIn: null, reason: '' };
    const lastDefinite = login.loggedIn ?? prev.lastDefinite;
    if (login.loggedIn === false && prev.lastDefinite === true) {
      log.warn(`${source.short} session expired (${login.reason})`);
      notify({ title: 'News Monitor', body: `${source.short} session expired. Open News Monitor to sign in.`, sourceId: source.id, url: source.homeUrl });
    }
    const everSignedIn = !!prev.everSignedIn || login.loggedIn === true;
    store.state.login[source.id] = { loggedIn: login.loggedIn, reason: login.reason, checkedAt: Date.now(), lastDefinite, everSignedIn };
  }

  /** Fetch the first lines of a few flagged/top articles, one at a time, politely. */
  private async loadPreviews() {
    const cfg = getConfig();
    if (!cfg.previews.enabled || this.previewing) {
      if (!this.previewing) this.emit('previews-done');
      return;
    }
    this.previewing = true;
    try {
      const since = Date.now() - 24 * 3_600_000;
      // On battery only preview stories that are actually flagged.
      const active = new Set(activeSources(cfg).map((s) => s.id));
      const minScore = powerMonitor.isOnBatteryPower() ? cfg.alertThreshold : cfg.alertThreshold * 0.6;
      const queue = store.stories
        .filter((s) => !s.previewTried && !s.opinion && s.lastSeen >= since && active.has(s.sourceId) && (s.alertedAt || s.score >= minScore))
        .sort((a, b) => b.score - a.score)
        .slice(0, cfg.previews.maxPerCheck);
      for (const s of queue) {
        s.previewTried = true;
        const source = findSource(cfg, s.sourceId);
        if (!source) continue;
        try {
          const text = await runInHiddenPage<string>(source.id, s.url, previewScript(), { settleMs: 2000, timeoutMs: 45_000 });
          if (text) s.preview = text;
          log.info(`Preview ${s.sourceId.toUpperCase()} "${s.headline.slice(0, 50)}": ${text ? text.slice(0, 80) + '…' : '(none)'}`);
        } catch (err) {
          log.warn(`Preview failed for ${s.url}: ${err}`);
        }
        store.saveStories();
        this.emit('stories');
        await wait(cfg.previews.secondsBetween * 1000);
      }
    } finally {
      this.previewing = false;
      this.emit('previews-done');
    }
  }
}

// ---------- helpers ----------

export function alertThreshold(cfg: Config, date = new Date()) {
  return cfg.alertThreshold * (isDaytime(cfg, date) ? 1 : cfg.overnightThresholdMultiplier);
}

/** IDF over the last week of headlines. */
function buildIdf(now: number): Idf {
  const week = now - 7 * 86_400_000;
  return new Idf(store.stories.filter((s) => s.lastSeen >= week).map((s) => tokens(`${s.headline} ${s.dek}`)));
}

interface StoryIndex {
  /** "sourceId|url" → story */
  byUrl: Map<string, Story>;
  /** sourceId → stories seen in the last 24 hours */
  recentBySource: Map<string, Story[]>;
}

/** Lookup tables so merging a few hundred headlines doesn't scan every stored story each time. */
function buildIndex(now: number): StoryIndex {
  const byUrl = new Map<string, Story>();
  const recentBySource = new Map<string, Story[]>();
  for (const s of store.stories) {
    for (const u of s.urls) byUrl.set(`${s.sourceId}|${u}`, s);
    if (now - s.lastSeen < 24 * 3_600_000) recentBySource.set(s.sourceId, [...(recentBySource.get(s.sourceId) ?? []), s]);
  }
  return { byUrl, recentBySource };
}

/** Find (or create) the story for a headline. Same URL = same story; very similar headline = updated story. */
function upsert(source: SourceDef, h: RawHeadline, now: number, pageUrls: Set<string>, via: 'page' | 'rss', cfg: Config, index: StoryIndex): Story {
  const url = normalizeUrl(h.url);
  let story = index.byUrl.get(`${source.id}|${url}`);
  if (!story) {
    const t = tokens(h.headline);
    story = (index.recentBySource.get(source.id) ?? []).find(
      (s) =>
        !s.urls.some((u) => pageUrls.has(u)) &&
        [s.headline, ...s.oldHeadlines].some((old) => similarity(t, tokens(old)).jaccard >= cfg.matching.sameStorySimilarity)
    );
    if (story) {
      story.urls.push(url);
      index.byUrl.set(`${source.id}|${url}`, story);
      log.info(`Matched updated story: "${h.headline}" ~ "${story.headline}"`);
    }
  }
  if (!story) {
    story = {
      id: `${source.id}:${url}`,
      sourceId: source.id,
      url,
      urls: [url],
      headline: h.headline,
      oldHeadlines: [],
      dek: h.dek,
      firstSeen: now,
      lastSeen: now,
      bestPosition: h.position,
      lastPosition: h.position,
      topStreak: 0,
      checksSeen: 0,
      live: h.live,
      score: 0,
      maxScore: 0,
      signals: [],
      via,
    };
    store.add(story);
    index.byUrl.set(`${source.id}|${url}`, story);
  }
  if (story.headline !== h.headline) {
    if (!story.oldHeadlines.includes(story.headline)) story.oldHeadlines.push(story.headline);
    if (story.oldHeadlines.length > 10) story.oldHeadlines.shift();
    story.headline = h.headline;
  }
  if (h.dek) story.dek = h.dek;
  story.url = url;
  story.lastSeen = now;
  story.lastPosition = h.position;
  story.bestPosition = Math.min(story.bestPosition, h.position);
  story.checksSeen++;
  story.live = h.live || isLiveUrl(source, url);
  story.breaking = !!h.breaking;
  story.opinion = !!h.opinion || story.opinion;
  story.via = via;
  const t = classify(story.headline, story.dek, url);
  story.topic = t.topic;
  story.scope = t.scope;
  return story;
}

function printDebug(pages: { source: SourceDef; headlines: RawHeadline[]; via: string }[], present: { story: Story }[], threshold: number) {
  const byUrl = new Map(present.map((p) => [p.story.url, p.story]));
  const lines: string[] = [''];
  for (const page of pages) {
    lines.push(`===== ${page.source.name} (${page.headlines.length} headlines via ${page.via}) — alert threshold ${threshold} =====`);
    for (const h of page.headlines.slice(0, 15)) {
      const s = byUrl.get(normalizeUrl(h.url));
      const flag = s && s.score >= threshold ? '🔴' : '  ';
      const tags = [h.live ? 'LIVE' : '', h.breaking ? 'BREAKING' : '', h.opinion ? 'OPINION' : '', s?.topic ?? ''].filter(Boolean).join(' ');
      lines.push(`${flag} #${String(h.position).padStart(2)}  font ${String(h.fontSize).padStart(4)}px  score ${s?.score ?? '?'}  ${tags}`);
      lines.push(`      ${h.headline}`);
      if (h.dek) lines.push(`      — ${h.dek.slice(0, 140)}`);
      if (s?.signals.length) lines.push(`      signals: ${s.signals.join('; ')}`);
    }
    lines.push('');
  }
  log.info(lines.join('\n'));
}
