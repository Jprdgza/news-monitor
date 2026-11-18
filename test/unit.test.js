// Unit tests for the pure modules (no Electron needed). Run: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dist = (m) => require(path.join(__dirname, '..', 'dist', 'main', m));
const { sanitizeConfig, isHttpUrl, isPublicHttpUrl } = dist('configCore.js');
const { tokens, Idf, similarity, normalizeUrl } = dist('match.js');
const scoring = dist('scoring.js');
const { classify } = dist('topics.js');
const { groupEvents, mmr } = dist('rank.js');
const prefs = dist('prefsCore.js');
const { nextDelayMs } = dist('schedule.js');
const { decodeEntities, parseFeed } = dist('rssParse.js');
const { PRESETS, customSource } = dist('sources/presets.js');

const DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'default-config.json'), 'utf8'));
const cfg = () => {
  const c = sanitizeConfig(DEFAULTS, structuredClone(DEFAULTS));
  c.polling.timezone = 'America/New_York'; // fixed zone so tests don't depend on the machine
  return c;
};
const NOW = Date.UTC(2026, 10, 17, 18); // midday in the Americas

// ---------- config ----------
test('config: defaults survive sanitizing unchanged', () => {
  assert.deepEqual(sanitizeConfig(DEFAULTS, structuredClone(DEFAULTS)), DEFAULTS);
});

test('config: numbers are clamped and junk falls back to defaults', () => {
  const c = sanitizeConfig(DEFAULTS, { version: 2, alertThreshold: -5, polling: { dayIntervalMinutes: 0.1, timezone: 'Mars/Base' }, dryRun: 'yes' });
  assert.equal(c.alertThreshold, 1);
  assert.equal(c.polling.dayIntervalMinutes, 3);
  assert.equal(c.polling.timezone, DEFAULTS.polling.timezone);
  assert.equal(c.dryRun, false);
});

test('config: custom sources must be https with a sane id and valid regex', () => {
  const c = sanitizeConfig(DEFAULTS, {
    version: 2,
    sources: {
      enabled: ['wsj', '../evil', 'ok-site'],
      custom: [
        { id: 'ok-site', name: 'OK', homeUrl: 'https://example.com/', articlePattern: '([' },
        { id: 'js', name: 'JS', homeUrl: 'javascript:alert(1)' },
        { id: 'plain', name: 'HTTP', homeUrl: 'http://example.com/' },
        { id: 'Bad Id', name: 'x', homeUrl: 'https://example.com/' },
      ],
    },
  });
  assert.deepEqual(c.sources.custom.map((s) => s.id), ['ok-site']);
  assert.equal(c.sources.custom[0].articlePattern, undefined); // invalid regex dropped
  assert.deepEqual(c.sources.enabled, ['wsj', 'ok-site']);
});

test('config: theme colors and names are validated', () => {
  const c = sanitizeConfig(DEFAULTS, { version: 2, theme: { flavor: 'neon', accent: 'mauve', background: 'red; x', text: '#AABBCC', perSource: { wsj: true, 'x y': true, nyt: 'yes' } } });
  assert.equal(c.theme.flavor, 'mocha');
  assert.equal(c.theme.background, '');
  assert.equal(c.theme.text, '#AABBCC');
  assert.deepEqual(c.theme.perSource, { wsj: true });
});

test('config: version 1 files adopt the new scoring weights', () => {
  const c = sanitizeConfig(DEFAULTS, { alertThreshold: 7, weights: { leadStory: 99 } });
  assert.equal(c.alertThreshold, 7);
  assert.equal(c.weights.leadStory, DEFAULTS.weights.leadStory);
});

test('isHttpUrl rejects non-web schemes', () => {
  assert.ok(isHttpUrl('https://a.com/x'));
  assert.ok(!isHttpUrl('javascript:alert(1)'));
  assert.ok(!isHttpUrl('file:///etc/passwd'));
  assert.ok(!isHttpUrl('http://a.com', true));
});

// ---------- matching ----------
test('tokens drop stopwords and stem plurals', () => {
  for (const [a, b] of [['rate', 'rates'], ['raise', 'raised'], ['tax', 'taxes'], ['company', 'companies'], ['strike', 'strikes']]) assert.deepEqual(tokens(a), tokens(b), `${a}/${b}`);
  assert.deepEqual([...tokens('The Fed Raises Rates as Inflation Surges')].sort(), ['fed', 'inflation', 'rais', 'rat', 'surg'].sort());
  assert.ok(tokens('U.S. economy').has('us_'));
});

test('IDF weighting: rare shared words matter more than common ones', () => {
  const docs = ['Trump China tariffs', 'Trump speech', 'Trump rally', 'Bahrain attack Iran', 'China trade'].map(tokens);
  const idf = new Idf(docs);
  const rare = idf.cosine(tokens('Iran attacks Bahrain'), tokens('Bahrain hit by Iran attack'));
  const common = idf.cosine(tokens('Trump visits China'), tokens('Trump China speech'));
  assert.ok(rare.score > common.score);
});

test('similarity and URL normalisation', () => {
  assert.equal(similarity(tokens('a b c'), tokens('a b c')).jaccard, 0); // all stopwords
  assert.equal(similarity(tokens('nvidia earnings beat'), tokens('nvidia earnings beat')).jaccard, 1);
  assert.equal(normalizeUrl('https://x.com/a/?utm=1#top'), 'https://x.com/a');
});

// ---------- scoring ----------
const story = (over = {}) => ({
  id: 's1', sourceId: 'wsj', url: 'https://www.wsj.com/a', headline: 'Fed Cuts Interest Rates by Half a Point in Surprise Move', dek: '',
  firstSeen: NOW - 3_600_000 * 2, lastSeen: NOW, lastPosition: 1, topStreak: 1, live: false, score: 0, maxScore: 0, signals: [], ...over,
});
const ctxFor = (stories, via = 'page') =>
  scoring.buildContext(stories.map((s, i) => ({ headline: s.headline, dek: '', url: s.url, position: s.lastPosition, fontSize: s.font ?? 20 - i, live: false })), via);

test('scoring: lead story in big type scores lead points', () => {
  const s = story({ font: 40 });
  const ctx = ctxFor([s, story({ id: 's2', url: 'https://www.wsj.com/b', lastPosition: 2, font: 20 })]);
  scoring.scoreStory(s, { ctx, related: [] }, cfg(), NOW);
  assert.match(s.signals[0], /lead story/);
  assert.ok(s.score >= cfg().weights.leadStory);
});

test('scoring: small sub-links near the top are not "top stories"', () => {
  const lead = story({ font: 40 });
  const sub = story({ id: 's2', url: 'https://www.wsj.com/sub', headline: 'Interim Chief Executive', lastPosition: 2, font: 13 });
  const ctx = ctxFor([lead, sub]);
  assert.equal(scoring.isTopSlot(sub, ctx, cfg()), false);
  scoring.scoreStory(sub, { ctx, related: [] }, cfg(), NOW);
  assert.ok(sub.signals.some((x) => /short sub-headline/.test(x)));
  assert.equal(sub.score, 0);
});

test('scoring: RSS order never counts as front-page prominence', () => {
  const s = story();
  assert.equal(scoring.isTopSlot(s, ctxFor([s], 'rss'), cfg()), false);
});

test('scoring: opinion pieces are discounted and routine live blogs penalised', () => {
  const op = story({ opinion: true, font: 40 });
  scoring.scoreStory(op, { ctx: ctxFor([op]), related: [] }, cfg(), NOW);
  assert.ok(op.signals.some((x) => /opinion/.test(x)));
  assert.ok(op.score <= cfg().weights.leadStory * cfg().weights.opinionMultiplier + 1);

  const routine = story({ headline: 'Live Markets | Stocks Slip at the Open', live: true, lastPosition: 2, font: 20 });
  scoring.scoreStory(routine, { ctx: ctxFor([story({ font: 40 }), routine]), related: [] }, cfg(), NOW);
  assert.ok(!routine.signals.some((x) => /live coverage/.test(x)));
  assert.ok(routine.signals.some((x) => /routine/.test(x)));
});

test('scoring: coverage by other outlets adds points, capped', () => {
  const s = story({ font: 40 });
  const others = ['nyt', 'ft', 'bloomberg', 'reuters', 'ap', 'cnbc'].map((id) => story({ id, sourceId: id, topStreak: 1 }));
  scoring.scoreStory(s, { ctx: ctxFor([s]), related: others }, cfg(), NOW);
  const cov = s.signals.find((x) => /also covered/.test(x));
  assert.ok(cov.startsWith(`+${cfg().weights.coverageMax} `));
});

test('scoring: generic newsletter links never match other stories', () => {
  const idf = new Idf([tokens('a')]);
  assert.equal(scoring.sameEvent(idf, story({ headline: 'Catch Up on Today’s Biggest Stories' }), story({ headline: 'Catch Up on Today’s Biggest Stories' }), cfg()), false);
});

test('keyword hits respect word boundaries and case for acronyms', () => {
  const kw = { markets: ['CPI', 'rate cut'] };
  assert.deepEqual(scoring.keywordHits('CPI jumps', kw).map((h) => h.word), ['CPI']);
  assert.deepEqual(scoring.keywordHits('epic pie', kw), []);
  assert.deepEqual(scoring.keywordHits('A surprise rate cut', kw).map((h) => h.word), ['rate cut']);
});

// ---------- topics ----------
test('topics: URL sections and headlines map to macro / micro', () => {
  assert.equal(classify('Fed Holds Rates Steady', '', 'https://www.wsj.com/economy/fed-x-1a2b3c4d').scope, 'macro');
  assert.equal(classify('Apple Recalls Chargers', '', 'https://www.wsj.com/business/apple-x-1a2b3c4d').scope, 'micro');
  assert.equal(classify('US loses measles status', '', 'https://www.reuters.com/business/healthcare/x-2026-11-17/').topic !== 'companies', true);
  assert.equal(classify('Tech outage wave reaches US government', '', 'https://www.reuters.com/business/x-2026-11-17/').topic, 'tech');
  assert.equal(classify('A Recipe for Fall Soup', '', 'https://www.nytimes.com/2026/11/17/dining/x.html').scope, 'other');
});

// ---------- ranking ----------
test('rank: related stories collapse into one event; MMR prefers variety', () => {
  const mk = (id, src, headline, maxScore, related = []) => ({ id, sourceId: src, headline, dek: '', maxScore, firstSeen: 1, related, topic: 'tech' });
  const stories = [
    mk('a', 'wsj', 'Nvidia earnings beat forecasts', 9, ['b']),
    mk('b', 'nyt', 'Nvidia earnings top estimates', 8),
    mk('c', 'ft', 'Nvidia earnings beat forecasts again analysts say', 8.5),
    mk('d', 'reuters', 'Ukraine strikes Crimea bridge', 6),
  ];
  const events = groupEvents(stories);
  assert.equal(events.length, 3);
  const ab = events.find((e) => e.lead.id === 'a');
  assert.deepEqual(ab.sources.sort(), ['nyt', 'wsj']);
  const picked = mmr(events, 2, 0.5).map((e) => e.lead.id);
  assert.deepEqual(picked, ['a', 'd']); // the near-duplicate "c" loses to something different
});

// ---------- personalization ----------
test('prefs: feedback moves the boost, bounded and explained', () => {
  const p = prefs.emptyPrefs();
  const s = { sourceId: 'wsj', headline: 'Bond market selloff deepens', topic: 'markets' };
  for (let i = 0; i < 50; i++) prefs.record(p, prefs.featuresOf(s), 'up', NOW);
  const up = prefs.boostFor(p, s, NOW);
  assert.ok(up.boost > 0 && up.boost <= prefs.MAX_BOOST);
  assert.match(up.reason, /you often read/);
  for (let i = 0; i < 200; i++) prefs.record(p, prefs.featuresOf(s), 'down', NOW);
  assert.ok(prefs.boostFor(p, s, NOW).boost < 0);
});

test('prefs: a single open barely matters, and evidence decays', () => {
  const p = prefs.emptyPrefs();
  const s = { sourceId: 'ft', headline: 'Shipping rates climb', topic: 'industries' };
  prefs.record(p, prefs.featuresOf(s), 'open', NOW);
  assert.ok(prefs.boostFor(p, s, NOW).boost <= 0.5);
  const stat = p.features['topic:industries'];
  assert.ok(prefs.affinity(stat, NOW + 365 * 86_400_000) < prefs.affinity(stat, NOW) / 100);
});

// ---------- schedule ----------
test('schedule: battery stretches the interval, locked screen uses the overnight pace', () => {
  const c = cfg();
  const noon = new Date(NOW);
  const mid = () => 0.5; // no jitter
  assert.equal(nextDelayMs(c, noon, {}, mid), c.polling.dayIntervalMinutes * 60_000);
  assert.equal(nextDelayMs(c, noon, { onBattery: true }, mid), c.polling.dayIntervalMinutes * c.efficiency.batteryIntervalMultiplier * 60_000);
  assert.equal(nextDelayMs(c, noon, { locked: true }, mid), c.polling.nightIntervalMinutes * 60_000);
});

// ---------- RSS ----------
test('rss: entities decode once, unsafe links are skipped', () => {
  assert.equal(decodeEntities('Taiwan&#x2019;s &amp;lt;b&amp;gt;'), 'Taiwan’s &lt;b&gt;');
  assert.equal(decodeEntities('<![CDATA[<b>Bold</b> news]]>'), 'Bold news');
  const out = [];
  parseFeed(
    '<rss><item><title>Good</title><link>https://a.com/1</link></item><item><title>Bad</title><link>javascript:alert(1)</link></item></rss>',
    { livePattern: '/live/' },
    out,
    new Set()
  );
  assert.deepEqual(out.map((h) => h.headline), ['Good']);
});

// ---------- sources ----------
const SAMPLES = {
  wsj: ['https://www.wsj.com/tech/ai/nvidia-earnings-1a2b3c4d', 'https://www.wsj.com/world'],
  nyt: ['https://www.nytimes.com/2026/11/17/us/politics/fda-nominee.html', 'https://www.nytimes.com/section/world'],
  ft: ['https://www.ft.com/content/676d1291-3007-4a32-9332-abf803d0f581', 'https://www.ft.com/war-in-ukraine'],
  bloomberg: ['https://www.bloomberg.com/news/articles/2026-11-17/nvidia-delivers-solid-outlook', 'https://www.bloomberg.com/company/what-we-do/'],
  reuters: ['https://www.reuters.com/world/europe/ukraine-strikes-bridge-2026-11-17/', 'https://www.reuters.com/world/ukraine-russia-war/'],
  economist: ['https://www.economist.com/leaders/2026/11/13/the-incredible-shrinking-legacy', 'https://www.economist.com/the-world-in-brief'],
  barrons: ['https://www.barrons.com/articles/nvidia-stock-earnings-5a1b2c3d', 'https://www.barrons.com/topics/economy-and-policy'],
  cnbc: ['https://www.cnbc.com/2026/11/17/stock-market-today.html', 'https://www.cnbc.com/funds-and-etfs/'],
  ap: ['https://apnews.com/article/iran-bahrain-attacks-582e0b5d51be06f0ed630fac24f39b72', 'https://apnews.com/hub/politics'],
  axios: ['https://www.axios.com/2026/11/17/heidi-overton-fda-nomination-dropped', 'https://www.axios.com/the-axios-show'],
  marketwatch: ['https://www.marketwatch.com/story/nvidias-stock-rises-2f20d38a', 'https://www.marketwatch.com/column/new-american-playbook'],
  politico: ['https://www.politico.com/news/2026/11/17/murkowski-appropriations-00123', 'https://www.politico.com/congress-news-updates-analysis'],
};

test('every preset has a sample, matches its articles and rejects section fronts', () => {
  for (const p of PRESETS) {
    const [article, section] = SAMPLES[p.id] ?? [];
    assert.ok(article, `no sample for ${p.id}`);
    const re = new RegExp(p.articlePattern, 'i');
    assert.ok(re.test(article), `${p.id} should match ${article}`);
    assert.ok(!re.test(section), `${p.id} should not match ${section}`);
    assert.ok(p.homeUrl.startsWith('https://'));
  }
});

test('custom sources get a sensible generic article pattern', () => {
  const s = customSource({ id: 'semafor', name: 'Semafor', homeUrl: 'https://www.semafor.com/' });
  const re = new RegExp(s.articlePattern, 'i');
  assert.ok(re.test('https://www.semafor.com/article/11/17/2026/the-fed-holds-rates-steady'));
  assert.ok(!re.test('https://www.semafor.com/vertical/business'));
  assert.ok(!re.test('https://evil.com/semafor.com/a-b-c-d-e'));
  assert.equal(s.short, 'S');
});

// ---------- robustness ----------
test('config: random junk never throws and always yields a valid config', () => {
  const junk = [null, 1, 'x', [], {}, { __proto__: { alertThreshold: 99 } }, { sources: 'all' }, { keywords: { a: 'not-a-list', b: [1, 2, 'ok'] } }];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const values = [undefined, null, NaN, Infinity, -1, 0, 1e9, '', '5', 'x', true, [], {}, ['a'], { a: 1 }];
  const mutate = (o, depth = 0) => {
    for (const k of Object.keys(o)) {
      if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && depth < 3) mutate(o[k], depth + 1);
      else if (rnd() < 0.4) o[k] = values[Math.floor(rnd() * values.length)];
    }
    return o;
  };
  for (let i = 0; i < 300; i++) junk.push(mutate(structuredClone(DEFAULTS)));
  for (const j of junk) {
    const c = sanitizeConfig(DEFAULTS, j);
    assert.ok(Number.isFinite(c.alertThreshold) && c.alertThreshold >= 1);
    assert.ok(Array.isArray(c.sources.enabled) && Array.isArray(c.sources.custom));
    assert.ok(c.polling.dayEndHour > c.polling.dayStartHour);
    for (const words of Object.values(c.keywords)) assert.ok(words.every((w) => typeof w === 'string'));
  }
});

test('matching handles hostile or empty text', () => {
  for (const t of ['', '   ', '<script>alert(1)</script>', '\u0000 ', 'a'.repeat(100000)]) {
    assert.doesNotThrow(() => tokens(t));
  }
  const idf = new Idf([]);
  assert.equal(idf.cosine(new Set(), new Set()).score, 0);
});

// ---------- theme ----------
test('theme stylesheet proxy only accepts public http(s) URLs', () => {
  for (const ok of ['https://static.politico.com/a.css', 'http://cdn.example.co.uk/x.png', 'https://8.8.8.8/a.css']) assert.ok(isPublicHttpUrl(ok), ok);
  for (const bad of [
    'file:///etc/passwd', 'javascript:alert(1)', 'data:text/css,x', 'https://localhost/a.css', 'http://127.0.0.1:8080/', 'http://10.0.0.5/a.css',
    'http://192.168.1.1/', 'http://172.20.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'https://printer.local/',
    'https://user:pw@example.com/a.css', 'http://intranet/', 'not a url',
  ]) assert.ok(!isPublicHttpUrl(bad), bad);
});

test('Dark Reader bundle keeps the paper-tint patch', () => {
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'main', 'theme-preload.js'), 'utf8');
  assert.equal(bundle.split('s * (1 - Math.abs(2 * l - 1)) < 0.16').length - 1, 2);
  assert.ok(bundle.includes("ipcRenderer.sendSync('nm-theme:get')"));
});

// ---------- login safety ----------
test('only real identity providers may open sign-in popups', () => {
  const { isIdentityProvider } = dist('security.js');
  for (const ok of ['https://accounts.google.com/o/oauth2/auth?x=1', 'https://appleid.apple.com/auth/authorize']) assert.ok(isIdentityProvider(ok), ok);
  for (const bad of [
    'https://login.attacker.com/', 'https://accounts.google.com.evil.io/', 'http://accounts.google.com/', 'about:blank', '',
    'https://evil-auth.com/', 'https://sso.fake-wsj.com/', 'javascript:alert(1)',
  ]) assert.ok(!isIdentityProvider(bad), bad);
});

test('update check compares versions and picks the right DMG', () => {
  const { compareVersions, parseRelease } = dist('update.js');
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
  assert.ok(compareVersions('v1.1', '1.0.9') > 0);
  assert.equal(compareVersions('1.0.1', 'v1.0.1'), 0);
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
  const base = 'https://github.com/Jprdgza/news-monitor/releases/download/v1.2.0/';
  const rel = {
    tag_name: 'v1.2.0',
    html_url: 'https://github.com/Jprdgza/news-monitor/releases/tag/v1.2.0',
    assets: ['arm64.dmg', 'x64.dmg', 'arm64.zip'].map((s) => ({ name: `News-Monitor-1.2.0-${s}`, browser_download_url: `${base}News-Monitor-1.2.0-${s}` })),
  };
  assert.equal(parseRelease(rel, '1.0.1', 'arm64').downloadUrl, `${base}News-Monitor-1.2.0-arm64.dmg`);
  assert.equal(parseRelease(rel, '1.0.1', 'x64').downloadUrl, `${base}News-Monitor-1.2.0-x64.dmg`);
  assert.equal(parseRelease(rel, '1.2.0', 'arm64'), null, 'same version is not an update');
  assert.equal(parseRelease({ ...rel, prerelease: true }, '1.0.1', 'arm64'), null);
  assert.equal(parseRelease({ ...rel, tag_name: 'nightly' }, '1.0.1', 'arm64'), null);
  // Links elsewhere are never offered as downloads.
  const evil = { ...rel, html_url: 'https://evil.example/', assets: [{ name: 'News-Monitor-1.2.0-arm64.dmg', browser_download_url: 'https://evil.example/x.dmg' }] };
  assert.equal(parseRelease(evil, '1.0.1', 'arm64').downloadUrl, 'https://github.com/Jprdgza/news-monitor/releases/latest');
});

test('checkForUpdates defaults on and survives sanitizing', () => {
  const { sanitizeConfig } = dist('configCore.js');
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'default-config.json'), 'utf8'));
  assert.equal(defaults.checkForUpdates, true);
  assert.equal(sanitizeConfig(defaults, { ...defaults, checkForUpdates: false }).checkForUpdates, false);
  assert.equal(sanitizeConfig(defaults, { ...defaults, checkForUpdates: 'yes' }).checkForUpdates, true);
});

test('theme keeps video players see-through and fixes the Bloomberg logo', () => {
  // theme.js needs Electron to load, so check the built rules directly.
  const js = fs.readFileSync(path.join(__dirname, '..', 'dist', 'main', 'theme.js'), 'utf8');
  assert.match(js, /\[data-component="bloombergLogo"\] \{ filter: none !important/);
  assert.match(js, /\.video-js \.vjs-text-track-display[^{]*\{ background-color: transparent !important/);
  assert.match(js, /url: \['bloomberg\.com'\]/);
});
