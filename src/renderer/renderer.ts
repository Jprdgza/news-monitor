// UI logic for the main window: source tabs, briefing sidebar, alerts, settings and status bar.
// Talks to the main process only through window.api (see src/main/preload.ts).

type Mode = 'day' | 'whatsnew' | 'morning' | 'alerts' | 'settings';

let state: any = null;
let mode: Mode = 'day';
let days: string[] = [];
let dayIndex = 0;
let filter = 'all';
let storiesVersion = -1;
let configVersion = -1;
let themeKey = '';

const fmtDay = (day: string) => new Date(day + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
const fmtSince = (ts: number) => new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

// ---------- static icons ----------
$('nav').innerHTML = (['back', 'forward', 'reload', 'home'] as const)
  .map((a) => `<button class="icon-btn" data-nav="${a}" title="${{ back: 'Back', forward: 'Forward', reload: 'Reload', home: 'Front page' }[a]}">${icon(a, 17)}</button>`)
  .join('');
$('run-now').innerHTML = icon('reload', 17);
$('bell').insertAdjacentHTML('afterbegin', icon('bell', 17));
$('gear').innerHTML = icon('gear', 17);
$('prev-day').innerHTML = icon('chevronLeft');
$('next-day').innerHTML = icon('chevronRight');

// ---------- chrome: tabs, header, status bar ----------
function renderChrome() {
  if (!state) return;
  const key = JSON.stringify(state.theme);
  if (key !== themeKey) {
    themeKey = key;
    applyAppTheme(state.theme);
  }

  const tabs = $('tabs');
  tabs.innerHTML = state.tabs
    .map((t: any) => {
      const li = state.login[t.id];
      const l = li?.loggedIn;
      // Red only when a session you had has expired; grey for subscriptions you haven't signed into.
      const expired = l === false && li?.everSignedIn;
      const dot = t.requiresLogin && l !== true ? `<span class="login ${expired ? '' : 'unknown'}" title="${expired ? 'Signed out: your session expired' : l === false ? 'Not signed in' : 'Sign-in not confirmed yet'}"></span>` : '';
      return `<button class="tab ${t.id === state.activeTab ? 'active' : ''} ${t.loaded ? '' : 'unloaded'}" data-tab="${esc(t.id)}" title="${esc(t.name)}${t.loaded ? '' : ' (not loaded, opens instantly)'}">
        <span class="swatch" data-color="${esc(t.color)}"></span>${esc(t.short)}${dot}</button>`;
    })
    .join('');
  paintColors(tabs);
  $('empty-tabs').hidden = state.tabs.length > 0;

  const active = state.tabs.find((t: any) => t.id === state.activeTab);
  document.querySelector<HTMLButtonElement>('[data-nav="back"]')!.disabled = !active?.canGoBack;
  document.querySelector<HTMLButtonElement>('[data-nav="forward"]')!.disabled = !active?.canGoForward;
  let host = '';
  try {
    host = active?.url ? new URL(active.url).hostname.replace(/^www\./, '') + new URL(active.url).pathname.replace(/\/$/, '') : '';
  } catch {
    /* ignore */
  }
  $('host').textContent = host;

  const needLogin = state.tabs.some((t: any) => t.requiresLogin && state.login[t.id]?.loggedIn === false && !state.login[t.id]?.everSignedIn);
  $('onboarding').hidden = state.onboardingDismissed || !needLogin;
  const pending = state.tabs.filter((t: any) => t.requiresLogin && state.login[t.id]?.loggedIn !== true).map((t: any) => t.short);
  $('onboarding-text').textContent = `Sign in to ${pending.join(', ')} in ${pending.length === 1 ? 'its tab' : 'their tabs'} if you subscribe.`;

  // Header: alert badge + check button.
  const badge = $('badge');
  badge.hidden = !state.unseenAlerts;
  badge.textContent = state.unseenAlerts > 99 ? '99+' : String(state.unseenAlerts);
  $('bell').title = state.unseenAlerts ? `${state.unseenAlerts} alert${state.unseenAlerts === 1 ? '' : 's'} you haven't seen` : 'Alerts';
  $('run-now').classList.toggle('spin', !!state.checking);
  $('run-now').title = state.checking ? 'Checking front pages…' : 'Check front pages now';

  // Status bar.
  const st = $('st-check');
  st.className = `st live-dot ${state.checking ? 'checking' : ''}`;
  st.textContent = state.checking ? 'Checking front pages…' : `Checked ${fmtTime(state.lastCheckAt)} · next ${fmtTime(state.nextCheckAt)}`;
  $('st-sources').innerHTML = state.tabs
    .map((t: any) => {
      const l = state.login[t.id];
      const cls = !t.requiresLogin || l?.loggedIn === true ? 'ok' : l?.loggedIn === false && l?.everSignedIn ? 'bad' : '';
      const status = !t.requiresLogin ? 'free' : l?.loggedIn === true ? 'signed in' : l?.loggedIn === false ? (l?.everSignedIn ? 'session expired' : 'not signed in') : 'sign-in unknown';
      return `<span class="st-src ${cls}" title="${esc(t.name)}: ${esc(status)} · ${esc(state.counts[t.id] ?? 0)} headlines last check${l?.reason ? ` (${esc(l.reason)})` : ''}">${esc(t.short)} ${esc(state.counts[t.id] ?? 0)}</span>`;
    })
    .join('');
  const warn = $('st-warn');
  warn.textContent = state.warnings.length ? `⚠ ${state.warnings[0]}${state.warnings.length > 1 ? ` (+${state.warnings.length - 1})` : ''}` : '';
  warn.title = state.warnings.join('\n');
  $('st-power').textContent = state.onBattery ? 'On battery · checking less often' : '';
  $('st-dry').textContent = state.dryRun ? 'Dry run: no notifications' : '';
}

// ---------- lists ----------
function setMode(m: Mode) {
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('modes').classList.toggle('dim', mode === 'alerts' || mode === 'settings');
  $('bell').classList.toggle('active', mode === 'alerts');
  $('gear').classList.toggle('active', mode === 'settings');
  refreshList();
}

function header(title: string, sub = '') {
  $('side-title').textContent = title;
  $('side-sub').textContent = sub;
}

function hourLabel(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric' });
}

/** Cards grouped under hour headings, newest first. */
function byHour(stories: StoryView[]) {
  let last = '';
  return stories
    .map((s) => {
      const h = hourLabel(s.firstSeen);
      const head = h !== last ? `<div class="hour">${esc(h)}</div>` : '';
      last = h;
      return head + storyCard(s);
    })
    .join('');
}

function renderFilters(stories: StoryView[]) {
  const sources = [...new Map(stories.map((s) => [s.sourceId, s])).values()];
  const flaggedCount = stories.filter((s) => s.flagged).length;
  $('filters').innerHTML = [
    `<button class="filter ${filter === 'all' ? 'on' : ''}" data-filter="all">All ${stories.length}</button>`,
    flaggedCount ? `<button class="filter ${filter === 'flagged' ? 'on' : ''}" data-filter="flagged">Flagged ${flaggedCount}</button>` : '',
    ...sources.map(
      (s) =>
        `<button class="filter ${filter === s.sourceId ? 'on' : ''}" data-filter="${esc(s.sourceId)}"><span class="swatch" data-color="${esc(s.sourceColor)}"></span>${esc(s.sourceShort)}</button>`
    ),
  ].join('');
  paintColors($('filters'));
}

function setList(html: string, caption: string) {
  $('list-caption').textContent = caption;
  const list = $('list');
  list.innerHTML = html;
  paintColors(list);
}

async function refreshList(keepScroll = false) {
  const list = $('list');
  const scroll = list.scrollTop;
  const settings = mode === 'settings';
  list.hidden = settings;
  $('settings').hidden = !settings;
  $('day-nav').hidden = mode !== 'day';
  $('filters').hidden = mode !== 'day';
  $('list-caption').hidden = settings;

  if (mode === 'day') {
    days = await api.days();
    if (state && !days.includes(state.today)) days.unshift(state.today);
    dayIndex = Math.min(dayIndex, days.length - 1);
    const day = days[dayIndex];
    header('Briefing', dayIndex === 0 ? 'Today' : '');
    $('day-label').textContent = fmtDay(day);
    $<HTMLButtonElement>('prev-day').disabled = dayIndex >= days.length - 1;
    $<HTMLButtonElement>('next-day').disabled = dayIndex === 0;
    const all: StoryView[] = await api.dayDigest(day);
    if (filter !== 'all' && filter !== 'flagged' && !all.some((s) => s.sourceId === filter)) filter = 'all';
    renderFilters(all);
    const shown = filter === 'all' ? all : filter === 'flagged' ? all.filter((s) => s.flagged) : all.filter((s) => s.sourceId === filter);
    setList(shown.length ? byHour(shown) : `<div class="empty">No headlines yet for this day.</div>`, '');
  } else if (mode === 'whatsnew') {
    const r = await api.whatsNew();
    header("What's new", `since ${fmtSince(r.since)}`);
    setList(r.stories.length ? r.stories.map((s: StoryView) => storyCard(s)).join('') : `<div class="empty">Nothing new since you last looked.</div>`, 'The most important new stories, one entry per story, with variety.');
  } else if (mode === 'morning') {
    const r = await api.morningDigest();
    header('Morning briefing', `since ${fmtSince(r.since)}`);
    const html = r.sections
      .map((sec: any) => `<div class="section-title"><h2>${esc(sec.title)}</h2><span>${esc(sec.hint)}</span></div>${sec.stories.map((s: StoryView) => storyCard(s)).join('')}`)
      .join('');
    setList(html || `<div class="empty">No stories since last evening yet.</div>`, '');
  } else if (mode === 'alerts') {
    const items: StoryView[] = await api.alerts();
    header('Alerts', 'last 7 days');
    setList(
      items.length ? items.map((s) => storyCard(s, { showDate: true })).join('') : `<div class="empty">No alerts in the last week.<br><span class="hint">Big stories show up here with the reasons they fired.</span></div>`,
      items.some((s) => s.unseen) ? 'Blue dots mark alerts you hadn’t seen.' : ''
    );
    if (state?.unseenAlerts) api.markAlertsSeen();
  } else {
    header('Settings');
    await renderSettings();
  }
  if (keepScroll) list.scrollTop = scroll;
}

// ---------- settings ----------
let editing: any = null;

const toggle = (name: string, label: string, checked: boolean, hint = '') =>
  `<label class="row"><span>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span><input type="checkbox" class="switch" name="${esc(name)}" ${checked ? 'checked' : ''}></label>`;
const num = (name: string, label: string, value: number, opts: { step?: number; min?: number; max?: number; hint?: string } = {}) =>
  `<label class="row"><span>${esc(label)}${opts.hint ? `<small>${esc(opts.hint)}</small>` : ''}</span><input type="number" name="${esc(name)}" value="${esc(value)}" step="${opts.step ?? 1}" min="${opts.min ?? 0}" ${opts.max !== undefined ? `max="${opts.max}"` : ''}></label>`;

async function renderSettings() {
  const cfg = (editing = await api.getConfig());
  const sources = await api.listSources();
  const opts = await api.themeOptions(cfg.theme.flavor);
  const p = cfg.polling;
  const t = cfg.theme;
  const login = state?.login ?? {};
  const form = $<HTMLFormElement>('settings');

  const sourceRows = sources
    .map((s: any) => {
      const on = cfg.sources.enabled.includes(s.id);
      const themed = t.perSource[s.id] ?? t.enabled;
      const l = login[s.id]?.loggedIn;
      const ever = login[s.id]?.everSignedIn;
      const status = !s.requiresLogin ? 'Free to read' : l === true ? 'Signed in' : l === false ? (ever ? 'Session expired: sign in from its tab' : 'Not signed in') : on ? 'Sign in from its tab' : 'Subscription';
      return `<div class="row source-row">
        <span><span class="name"><span class="swatch" data-color="${esc(s.color)}"></span>${esc(s.name)}</span><small>${esc(status)}${s.custom ? ' · custom' : ''}</small></span>
        <span class="tools">
          <label title="Use the reading theme on this site" ${t.enabled || Object.keys(t.perSource).length ? '' : 'hidden'}><input type="checkbox" name="theme:${esc(s.id)}" ${themed ? 'checked' : ''}>Theme</label>
          ${s.custom ? `<button type="button" class="link-btn" data-remove="${esc(s.id)}">Remove</button>` : ''}
          <input type="checkbox" class="switch" name="src:${esc(s.id)}" ${on ? 'checked' : ''} title="Check this front page">
        </span>
      </div>`;
    })
    .join('');

  form.innerHTML = `
    <h3>Sources</h3>
    <div class="group">${sourceRows}
      <div class="row add-source" id="add-source">
        <div class="two"><input type="text" id="new-name" placeholder="Name, e.g. Semafor" maxlength="60"><label class="hint"><input type="checkbox" id="new-login"> Paywalled</label></div>
        <div class="two"><input type="url" id="new-url" placeholder="Front page URL (https://…)"><button type="button" class="btn" id="add-btn">Add</button></div>
        <input type="url" id="new-rss" placeholder="RSS feed URL (optional fallback)">
        <span class="hint" id="add-msg">Any news site with a front page works. More sources = longer checks.</span>
      </div>
    </div>

    <h3>Alerts</h3>
    <div class="group">
      ${num('alertThreshold', 'Alert threshold', cfg.alertThreshold, { step: 0.5, min: 1, hint: 'Higher = only bigger stories' })}
      ${num('overnightThresholdMultiplier', 'Overnight threshold ×', cfg.overnightThresholdMultiplier, { step: 0.1, min: 1 })}
      ${num('maxAlertsPerDay', 'Most alerts per day', cfg.maxAlertsPerDay, { hint: 'Huge stories (1.5× threshold) still get through' })}
      ${num('followUpExtraScore', 'Extra score for follow-ups', cfg.followUpExtraScore, { step: 0.5, hint: 'New angles on a story you were already alerted to' })}
      ${toggle('dryRun', 'Dry run', cfg.dryRun, 'Log alerts without notifying')}
      ${toggle('previews', 'Article previews', cfg.previews.enabled, 'Read the first lines of flagged stories')}
    </div>

    <h3>Morning briefing</h3>
    <div class="group">
      ${num('morningStartHour', 'Covers news since (hour, previous day)', cfg.digest.morningStartHour, { min: 0, max: 23 })}
      ${num('topCount', 'Top stories', cfg.digest.topCount, { max: 30 })}
      ${num('macroCount', 'Macro: economy, markets, world, policy', cfg.digest.macroCount, { max: 30 })}
      ${num('microCount', 'Micro: companies, tech, industries', cfg.digest.microCount, { max: 30 })}
      ${num('radarCount', 'Under the radar', cfg.digest.radarCount, { max: 30 })}
      <label class="row"><span>Variety<small>Left: more variety · Right: strictly by importance</small></span><input type="range" name="diversity" min="0.4" max="1" step="0.05" value="${esc(cfg.digest.diversity)}"></label>
    </div>

    <h3>Reading theme</h3>
    <div class="group">
      ${toggle('themeEnabled', 'Catppuccin theme on news pages', t.enabled, 'Softer colors instead of bright white. Per-site switches are under Sources.')}
      <div class="flavors" id="flavors">${opts.flavors
        .map((f: any) => `<button type="button" data-flavor="${esc(f.id)}" class="${f.id === t.flavor ? 'on' : ''}"><span class="preview-dot" data-color="${esc(f.base)}"></span>${esc(f.id[0].toUpperCase() + f.id.slice(1))}</button>`)
        .join('')}</div>
      <div class="swatches" id="accents">${Object.entries(opts.accents)
        .map(([name, hex]) => `<button type="button" title="${esc(name)}" data-accent="${esc(name)}" data-color="${esc(hex)}" class="${name === t.accent ? 'on' : ''}"></button>`)
        .join('')}</div>
      <label class="row"><span>Custom background<small>Leave unset for the flavor's own</small></span><span class="tools"><input type="color" name="background" value="${esc(t.background || '#1e1e2e')}" ${t.background ? '' : 'data-unset="1"'}><button type="button" class="link-btn" data-clear="background">Reset</button></span></label>
      <label class="row"><span>Custom text color</span><span class="tools"><input type="color" name="text" value="${esc(t.text || '#cdd6f4')}" ${t.text ? '' : 'data-unset="1"'}><button type="button" class="link-btn" data-clear="text">Reset</button></span></label>
      ${toggle('themeApp', 'Use the theme for this app too', t.themeApp)}
    </div>

    <h3>Personalization</h3>
    <div class="group">
      ${toggle('persEnabled', 'Learn from what I read', cfg.personalization.enabled, 'Opens and 👍/👎 gently reorder your briefings. Stays on this Mac.')}
      ${toggle('persAlerts', 'Let it nudge alerts too', cfg.personalization.affectAlerts, 'At most ±0.75 points')}
      <div class="row"><span>Forget everything it learned</span><button type="button" class="btn danger" id="reset-prefs">Reset</button></div>
    </div>

    <h3>Battery &amp; performance</h3>
    <div class="group">
      ${toggle('blockAds', 'Block ads and trackers', cfg.efficiency.blockAds, 'Faster pages, less battery')}
      ${num('unloadTabsAfterMinutes', 'Unload tabs after (minutes hidden)', cfg.efficiency.unloadTabsAfterMinutes, { hint: '0 = keep pages loaded' })}
      ${num('batteryIntervalMultiplier', 'On battery, check less often ×', cfg.efficiency.batteryIntervalMultiplier, { step: 0.25, min: 1 })}
      ${toggle('slowerWhenLocked', 'Slow down while the screen is locked', cfg.efficiency.slowerWhenLocked, 'Checks right away when you unlock')}
      ${toggle('loadImagesInChecks', 'Load images during checks', cfg.efficiency.loadImagesInChecks, 'Not needed to read headlines')}
    </div>

    <h3>Schedule (${esc(p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)})</h3>
    <div class="group">
      ${num('dayStartHour', 'Daytime starts (hour)', p.dayStartHour, { max: 23 })}
      ${num('dayEndHour', 'Daytime ends (hour)', p.dayEndHour, { min: 1, max: 24 })}
      ${num('dayIntervalMinutes', 'Daytime: every … minutes', p.dayIntervalMinutes, { min: 3 })}
      ${num('dayJitterMinutes', 'Daytime jitter ± minutes', p.dayJitterMinutes)}
      ${num('nightIntervalMinutes', 'Overnight: every … minutes', p.nightIntervalMinutes, { min: 5 })}
      ${num('nightJitterMinutes', 'Overnight jitter ± minutes', p.nightJitterMinutes)}
    </div>

    <h3>Keywords</h3>
    <div class="group">${Object.entries(cfg.keywords as Record<string, string[]>)
      .map(([cat, words]) => `<div class="row"><span class="hint">${esc(cat)}</span></div><div class="row"><textarea name="kw:${esc(cat)}">${esc(words.join(', '))}</textarea></div>`)
      .join('')}</div>
    <p class="hint">Scoring weights and matching thresholds are in the config file.</p>
    <div class="buttons">
      <button type="button" class="btn" id="open-config">Open config file</button>
      <button type="button" class="btn" id="open-log">Open log</button>
    </div>
    <div class="save-bar"><button type="submit" class="btn primary">Save</button><span class="status" id="save-status"></span></div>`;
  paintColors(form);

  const pick = (containerId: string, attr: string, fn: (v: string) => void) =>
    $(containerId).addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(`[data-${attr}]`);
      if (!b) return;
      $(containerId).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      fn(b.dataset[attr]!);
    });
  pick('flavors', 'flavor', (v) => {
    editing.theme.flavor = v;
    void refreshAccents(v);
  });
  pick('accents', 'accent', (v) => (editing.theme.accent = v));
  form.querySelectorAll<HTMLElement>('[data-clear]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const input = form.querySelector<HTMLInputElement>(`input[name="${b.dataset.clear}"]`)!;
      input.dataset.unset = '1';
      flash('Will reset on save');
    })
  );
  form.querySelectorAll<HTMLInputElement>('input[type="color"]').forEach((i) => i.addEventListener('input', () => delete i.dataset.unset));
  form.querySelectorAll<HTMLElement>('[data-remove]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.remove!;
      editing.sources.custom = editing.sources.custom.filter((c: any) => c.id !== id);
      editing.sources.enabled = editing.sources.enabled.filter((x: string) => x !== id);
      await api.saveConfig(collect());
      renderSettings();
    })
  );
  $('add-btn').onclick = addSource;
  $('reset-prefs').onclick = async () => {
    await api.resetPrefs();
    flash('Personalization reset');
  };
  $('open-config').onclick = () => api.openConfigFile();
  $('open-log').onclick = () => api.openLog();
  form.onsubmit = async (e) => {
    e.preventDefault();
    await api.saveConfig(collect());
    flash('Saved');
  };
}

async function refreshAccents(flavor: string) {
  const opts = await api.themeOptions(flavor);
  const el = $('accents');
  el.innerHTML = Object.entries(opts.accents)
    .map(([name, hex]) => `<button type="button" title="${esc(name)}" data-accent="${esc(name)}" data-color="${esc(hex)}" class="${name === editing.theme.accent ? 'on' : ''}"></button>`)
    .join('');
  paintColors(el);
}

function flash(msg: string) {
  const s = $('save-status');
  if (!s) return;
  s.textContent = msg;
  setTimeout(() => (s.textContent = ''), 2500);
}

async function addSource() {
  const name = $<HTMLInputElement>('new-name').value.trim();
  const url = $<HTMLInputElement>('new-url').value.trim();
  const rss = $<HTMLInputElement>('new-rss').value.trim();
  const msg = $('add-msg');
  let u: URL;
  try {
    u = new URL(url);
    if (u.protocol !== 'https:') throw new Error();
  } catch {
    msg.textContent = 'Enter the full https:// address of the front page.';
    return;
  }
  const id = (name || u.hostname.replace(/^www\./, '').split('.')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'source';
  const taken = new Set([...(await api.listSources()).map((s: any) => s.id)]);
  let unique = id;
  for (let i = 2; taken.has(unique); i++) unique = `${id}-${i}`;
  const cfg = collect();
  cfg.sources.custom.push({ id: unique, name: name || u.hostname.replace(/^www\./, ''), homeUrl: u.toString(), ...(rss ? { rssUrl: rss } : {}), requiresLogin: $<HTMLInputElement>('new-login').checked });
  cfg.sources.enabled.push(unique);
  await api.saveConfig(cfg);
  await renderSettings();
  flash(`Added ${name || u.hostname}. It's checked from the next run.`);
}

/** Read the form back into the config being edited. */
function collect() {
  const form = $<HTMLFormElement>('settings');
  const fd = new FormData(form);
  const cfg = editing;
  const n = (k: string) => Number(fd.get(k));
  const on = (k: string) => fd.get(k) === 'on';
  cfg.alertThreshold = n('alertThreshold');
  cfg.overnightThresholdMultiplier = n('overnightThresholdMultiplier');
  cfg.maxAlertsPerDay = n('maxAlertsPerDay');
  cfg.followUpExtraScore = n('followUpExtraScore');
  cfg.dryRun = on('dryRun');
  cfg.previews.enabled = on('previews');
  for (const k of ['morningStartHour', 'topCount', 'macroCount', 'microCount', 'radarCount', 'diversity']) cfg.digest[k] = n(k);
  cfg.theme.enabled = on('themeEnabled');
  cfg.theme.themeApp = on('themeApp');
  for (const k of ['background', 'text']) {
    const input = form.querySelector<HTMLInputElement>(`input[name="${k}"]`)!;
    cfg.theme[k] = input.dataset.unset ? '' : input.value;
  }
  cfg.personalization.enabled = on('persEnabled');
  cfg.personalization.affectAlerts = on('persAlerts');
  cfg.efficiency.blockAds = on('blockAds');
  cfg.efficiency.unloadTabsAfterMinutes = n('unloadTabsAfterMinutes');
  cfg.efficiency.batteryIntervalMultiplier = n('batteryIntervalMultiplier');
  cfg.efficiency.slowerWhenLocked = on('slowerWhenLocked');
  cfg.efficiency.loadImagesInChecks = on('loadImagesInChecks');
  for (const k of ['dayStartHour', 'dayEndHour', 'dayIntervalMinutes', 'dayJitterMinutes', 'nightIntervalMinutes', 'nightJitterMinutes']) cfg.polling[k] = n(k);
  for (const cat of Object.keys(cfg.keywords)) {
    cfg.keywords[cat] = String(fd.get(`kw:${cat}`) ?? '')
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean);
  }
  // Sources: keep the existing order, append newly enabled ones.
  const boxes = [...form.querySelectorAll<HTMLInputElement>('input[name^="src:"]')];
  const enabled = boxes.filter((b) => b.checked).map((b) => b.name.slice(4));
  cfg.sources.enabled = [...cfg.sources.enabled.filter((id: string) => enabled.includes(id)), ...enabled.filter((id) => !cfg.sources.enabled.includes(id))];
  // Per-site switches are hidden while the theme is off; only read them when they were shown.
  const boxes2 = [...form.querySelectorAll<HTMLInputElement>('input[name^="theme:"]')];
  if (boxes2.some((b) => !b.closest('label')!.hidden)) {
    cfg.theme.perSource = {};
    for (const b of boxes2) if (b.checked !== cfg.theme.enabled) cfg.theme.perSource[b.name.slice(6)] = b.checked;
  }
  return cfg;
}

// ---------- wiring ----------
document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
$('nav').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
  if (b) api.nav(b.dataset.nav);
});
$('tabs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (b) api.selectTab(b.dataset.tab);
});
$('filters').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]');
  if (!b) return;
  filter = b.dataset.filter!;
  refreshList();
});
$('prev-day').onclick = () => {
  dayIndex++;
  refreshList();
};
$('next-day').onclick = () => {
  dayIndex = Math.max(0, dayIndex - 1);
  refreshList();
};
$('run-now').onclick = () => api.runCheck();
$('bell').onclick = () => setMode(mode === 'alerts' ? 'day' : 'alerts');
$('gear').onclick = () => setMode(mode === 'settings' ? 'day' : 'settings');
$('dismiss-onboarding').onclick = () => api.dismissOnboarding();
wireCards($('list'));
document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key === ',') setMode('settings');
  if (e.metaKey && e.key.toLowerCase() === 'r' && mode !== 'settings') {
    e.preventDefault();
    api.runCheck();
  }
});

api.onState(async (s: any) => {
  const storiesChanged = s.storiesVersion !== storiesVersion;
  const configChanged = s.configVersion !== configVersion;
  state = s;
  storiesVersion = s.storiesVersion;
  configVersion = s.configVersion;
  renderChrome();
  // Refresh the day list or alerts when stories change. Not What's new / Morning:
  // opening those records what you've seen, so they only refresh when you ask.
  if ((storiesChanged && (mode === 'day' || mode === 'alerts')) || (configChanged && mode === 'day')) await refreshList(true);
});

(async () => {
  state = await api.getState();
  storiesVersion = state.storiesVersion;
  configVersion = state.configVersion;
  renderChrome();
  refreshList();
  setInterval(renderChrome, 30_000);
})();
