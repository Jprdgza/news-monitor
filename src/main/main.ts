// App entry point: window + browsing tabs, menu bar panel, login item, sleep/wake, IPC.
import { app, BrowserWindow, WebContentsView, Menu, Tray, ipcMain, nativeImage, powerMonitor, screen, shell, dialog } from 'electron';
import path from 'node:path';
import { getConfig, loadConfig, onConfigChange, openConfigFile, saveConfig, watchConfig, getDefaults } from './config';
import { isHttpUrl } from './configCore';
import { alertInbox, availableDays, dayDigest, dayKey, flaggedNow, markAlertsSeen, morningDigest, unseenAlertCount, whatsNew } from './digest';
import { log, openLogFile } from './log';
import { notify, setNotificationClickHandler } from './notify';
import { giveFeedback, resetPrefs } from './prefs';
import { cleanUserAgent, initBlocker, prepareSession, refreshSessions } from './sessions';
import { activeSources, allSources, findSource, ownsUrl, partitionFor, PRESETS, extractionScript, type ExtractionResult } from './sources';
import { runInHiddenPage } from './pageLoader';
import { store } from './store';
import { applyPageTheme, palette, themedFor, themeOptions } from './theme';
import { Watcher } from './watcher';

// Layout constants (must match styles.css).
const TOP_BAR = 48;
const STATUS_BAR = 26;
const SIDEBAR = 420;
const RESTORE_URL_MS = 30 * 60_000; // reopen a tab where you left it if it was unloaded recently

const args = process.argv.slice(1);
/** Sign-in popups (Google/Apple/Facebook, publisher SSO) are recognised by their host. */
const AUTH_HOST = /(^|\.)(accounts\.google\.com|appleid\.apple\.com|facebook\.com)$|(^|[.-])(login|sso|auth|accounts?)[.-]/i;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};
const DRY_RUN = args.includes('--dry-run');
const ONCE = args.includes('--once');
const CHECK_SOURCES = args.includes('--check-sources');

let win: BrowserWindow | null = null;
let popover: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let activeTab = '';
let storiesVersion = 0; // bumped whenever stories change, so the UI knows to refresh
let configVersion = 0;
let hiddenSince = 0;

interface Tab {
  view: WebContentsView | null;
  lastUrl: string;
  lastActive: number;
  unloadedAt: number;
}
const tabs = new Map<string, Tab>();
const watcher = new Watcher();
watcher.dryRun = DRY_RUN;

// Debugging aid: run against a copy of the data folder so tests never touch your real history.
const DEV = !app.isPackaged;
if (DEV && process.env.NEWS_MONITOR_USER_DATA) app.setPath('userData', process.env.NEWS_MONITOR_USER_DATA);

// Only one copy may run: two processes sharing the same data files and sign-in sessions would corrupt them.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log(
    ONCE || CHECK_SOURCES
      ? 'News Monitor is already running. Quit it from the menu bar first, or turn on Dry run in Settings and use "Run check now".'
      : 'News Monitor is already running; showing the existing window.'
  );
  app.exit(0);
}
app.on('second-instance', () => showWindow());

// Defense in depth: no <webview> tags anywhere, and new windows only where we allow them.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  // Default for any page (sign-in popups included); site tabs and app windows set their own.
  contents.setWindowOpenHandler(({ url }) => {
    if (AUTH_HOST.test(hostOf(url))) return { action: 'allow' };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
  loadConfig();
  store.load();
  watchConfig();
  log.info(`News Monitor starting${DRY_RUN ? ' (dry run)' : ''}${ONCE ? ' (single check)' : ''}. userData: ${app.getPath('userData')}`);

  // Start at login only from /Applications (so a copy in a build folder never registers itself).
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: app.isInApplicationsFolder() });

  const blockerReady = initBlocker().then(refreshSessions);

  if (CHECK_SOURCES) {
    await blockerReady;
    await checkSources();
    app.quit();
    return;
  }
  if (ONCE) {
    // Debug mode: run one check, wait for previews, print, quit. No window, no notifications.
    await blockerReady;
    watcher.on('previews-done', () => app.quit());
    watcher.runCheck('--once');
    return;
  }

  setNotificationClickHandler((sourceId, url, storyId) => openStory(sourceId, url, storyId));
  createTray();
  createWindow(!app.getLoginItemSettings().wasOpenedAtLogin);
  if (args.includes('--test-notification')) setTimeout(sendTestNotification, 3000);

  watcher.on('update', pushState);
  watcher.on('stories', () => {
    storiesVersion++;
    pushState();
  });
  watcher.on('alerts', updateBadges);
  onConfigChange(() => {
    configVersion++;
    refreshSessions();
    syncTabs();
    for (const [id, tab] of tabs) {
      if (!tab.view) continue;
      const themed = themedFor(getConfig(), id);
      tab.view.setBackgroundColor(themed ? palette(getConfig()).bg : '#ffffff');
      void applyPageTheme(tab.view.webContents, getConfig(), themed);
    }
    watcher.scheduleNext();
    pushState();
  });
  updateBadges();

  setInterval(sweepTabs, 60_000);
  if (process.env.NEWS_MONITOR_METRICS) startMetrics();

  await blockerReady;
  if (DEV && process.env.NEWS_MONITOR_BENCH) return runBench();
  watcher.start();
  setTimeout(() => watcher.runCheck('startup'), 3000);

  powerMonitor.on('resume', () => {
    log.info('System woke from sleep, checking now');
    setTimeout(() => watcher.runCheck('wake'), 15_000); // give Wi-Fi a moment to reconnect
  });
  powerMonitor.on('lock-screen', () => {
    watcher.locked = true;
    watcher.scheduleNext();
  });
  powerMonitor.on('unlock-screen', () => {
    watcher.locked = false;
    const stale = Date.now() - (store.state.lastCheckAt ?? 0) > getConfig().polling.dayIntervalMinutes * 60_000;
    if (stale) void watcher.runCheck('unlock');
    else watcher.scheduleNext();
  });
  powerMonitor.on('on-battery', () => watcher.scheduleNext());
  powerMonitor.on('on-ac', () => watcher.scheduleNext());
});

app.on('before-quit', () => (quitting = true));
app.on('window-all-closed', () => {
  /* keep running in the menu bar */
});
app.on('activate', () => showWindow());

// ---------- window ----------
function createWindow(show: boolean) {
  const cfg = getConfig();
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1040,
    minHeight: 620,
    show: false,
    title: 'News Monitor',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: cfg.theme.enabled && cfg.theme.themeApp ? palette(cfg).bg : '#16171a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  lockDownAppContents(win);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  syncTabs();
  win.on('resize', layoutViews);

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  const onVisible = () => {
    hiddenSince = 0;
    if (activeTab) ensureView(activeTab);
    layoutViews();
  };
  win.on('show', () => {
    app.dock?.show();
    onVisible();
  });
  win.on('restore', onVisible);
  win.on('hide', () => {
    hiddenSince = Date.now();
    app.dock?.hide();
  });
  win.on('minimize', () => (hiddenSince = Date.now()));

  // Debug: NEWS_MONITOR_SNAPSHOT=/some/dir saves PNGs of the UI (each sidebar view) and the active tab after 25s.
  const snapDir = DEV ? process.env.NEWS_MONITOR_SNAPSHOT : undefined;
  if (snapDir) {
    setTimeout(async () => {
      const fs = await import('node:fs');
      const shot = async (name: string) => fs.writeFileSync(path.join(snapDir, `${name}.png`), (await win!.webContents.capturePage()).toPNG());
      await shot('ui');
      for (const sel of ['[data-mode="whatsnew"]', '[data-mode="morning"]', '#bell', '#gear']) {
        await win!.webContents.executeJavaScript(`document.querySelector('${sel}').click()`);
        await new Promise((r) => setTimeout(r, 1500));
        await shot(`ui-${sel.replace(/[^a-z]/g, '')}`);
      }
      const view = tabs.get(activeTab)?.view;
      if (view) fs.writeFileSync(path.join(snapDir, 'tab.png'), (await view.webContents.capturePage()).toPNG());
      log.info(`Saved debug snapshots to ${snapDir}`);
    }, 25_000);
  }

  if (show) win.once('ready-to-show', () => showWindow());
  else app.dock?.hide();
}

/** The app's own pages never navigate away or open windows. */
function lockDownAppContents(w: BrowserWindow) {
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function showWindow() {
  if (!win) return;
  app.dock?.show();
  win.show();
  win.focus();
  app.focus({ steal: true });
}

/** Make the tab list match the enabled sources. */
function syncTabs() {
  const active = activeSources(getConfig()).map((s) => s.id);
  for (const id of [...tabs.keys()]) {
    if (!active.includes(id)) {
      unloadView(id);
      tabs.delete(id);
    }
  }
  for (const id of active) if (!tabs.has(id)) tabs.set(id, { view: null, lastUrl: '', lastActive: 0, unloadedAt: 0 });
  if (!active.includes(activeTab)) activeTab = active[0] ?? '';
  if (activeTab && win?.isVisible()) ensureView(activeTab);
  layoutViews();
}

/** Create the browsing view for a tab if it isn't loaded. */
function ensureView(id: string) {
  const tab = tabs.get(id);
  const source = findSource(getConfig(), id);
  if (!tab || !source || !win || tab.view) return;
  prepareSession(id);
  const view = new WebContentsView({ webPreferences: { partition: partitionFor(id), contextIsolation: true, sandbox: true, spellcheck: false } });
  const cfg = getConfig();
  view.setBackgroundColor(themedFor(cfg, id) ? palette(cfg).bg : '#ffffff');
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => handleNewWindow(id, url));
  wc.on('will-navigate', (e, url) => {
    if (!/^https?:/i.test(url)) e.preventDefault();
  });
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) {
    wc.on(ev as any, () => {
      tab.lastUrl = wc.getURL();
      pushState();
    });
  }
  wc.on('dom-ready', () => {
    const c = getConfig();
    if (themedFor(c, id)) void applyPageTheme(wc, c, true);
  });
  wc.on('render-process-gone', () => {
    log.warn(`${source.short} tab crashed; it will reload when opened`);
    unloadView(id);
  });
  const restore = tab.lastUrl && Date.now() - tab.unloadedAt < RESTORE_URL_MS && ownsUrl(source, tab.lastUrl) ? tab.lastUrl : source.homeUrl;
  wc.loadURL(restore).catch(() => {});
  tab.view = view;
  win.contentView.addChildView(view);
  layoutViews();
}

function unloadView(id: string) {
  const tab = tabs.get(id);
  if (!tab?.view) return;
  const view = tab.view;
  tab.lastUrl = view.webContents.getURL() || tab.lastUrl;
  tab.unloadedAt = Date.now();
  tab.view = null;
  win?.contentView.removeChildView(view);
  view.webContents.close();
}

/**
 * Free memory and CPU: when the window has been hidden for a while, unload every tab;
 * while it's open, unload tabs you haven't looked at for a while (min 5 minutes).
 */
function sweepTabs() {
  const minutes = getConfig().efficiency.unloadTabsAfterMinutes;
  if (!minutes) return; // 0 = keep tabs loaded
  const now = Date.now();
  const hidden = !win?.isVisible();
  let changed = false;
  for (const [id, tab] of tabs) {
    if (!tab.view) continue;
    const expired = hidden
      ? now - hiddenSince >= minutes * 60_000
      : id !== activeTab && now - tab.lastActive >= Math.max(5, minutes) * 60_000;
    if (expired) {
      log.info(`Unloaded ${id} tab to save memory`);
      unloadView(id);
      changed = true;
    }
  }
  if (changed) pushState();
}

function layoutViews() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  for (const [id, tab] of tabs) {
    if (!tab.view) continue;
    tab.view.setBounds({ x: 0, y: TOP_BAR, width: w - SIDEBAR, height: h - TOP_BAR - STATUS_BAR });
    tab.view.setVisible(id === activeTab);
  }
}

function selectTab(id: string) {
  if (!tabs.has(id)) return;
  const prev = tabs.get(activeTab);
  if (prev) prev.lastActive = Date.now();
  activeTab = id;
  tabs.get(id)!.lastActive = Date.now();
  ensureView(id);
  layoutViews();
  pushState();
}

function openStory(sourceId: string, url: string, storyId?: string) {
  if (storyId) {
    const s = store.byId(storyId);
    if (s) giveFeedback(s, 'open');
  }
  const source = findSource(getConfig(), sourceId);
  if (!sourceId) return showWindow(); // e.g. the "N more stories" notification
  // Disabled sources and unexpected URLs open in your browser instead.
  if (!tabs.has(sourceId) || !source) {
    if (isHttpUrl(url)) shell.openExternal(url);
    return;
  }
  showWindow();
  selectTab(sourceId);
  if (url && ownsUrl(source, url)) tabs.get(sourceId)!.view?.webContents.loadURL(url).catch(() => {});
}

/** Links that open a new window: keep a source's links in its tab, allow sign-in popups, send the rest to the browser. */
function handleNewWindow(sourceId: string, url: string): { action: 'allow' | 'deny' } {
  let host = '';
  let protocol = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    protocol = u.protocol;
  } catch {
    /* about:blank etc. */
  }
  const source = findSource(getConfig(), sourceId);
  if (!host || AUTH_HOST.test(host)) return { action: 'allow' };
  if (source && ownsUrl(source, url)) {
    tabs.get(sourceId)?.view?.webContents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  }
  if (protocol === 'https:' || protocol === 'http:') shell.openExternal(url);
  return { action: 'deny' };
}

// ---------- state for the renderer ----------
function pushState() {
  const s = buildState();
  if (win && !win.isDestroyed()) win.webContents.send('state', s);
  if (popover && !popover.isDestroyed() && popover.isVisible()) popover.webContents.send('state', s);
}

function buildState() {
  const cfg = getConfig();
  const sources = activeSources(cfg);
  return {
    activeTab,
    tabs: sources.map((s) => {
      const wc = tabs.get(s.id)?.view?.webContents;
      return {
        id: s.id,
        name: s.name,
        short: s.short,
        color: s.color,
        requiresLogin: s.requiresLogin,
        loaded: !!wc,
        url: wc?.getURL() ?? '',
        canGoBack: wc?.navigationHistory.canGoBack() ?? false,
        canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      };
    }),
    lastCheckAt: store.state.lastCheckAt,
    nextCheckAt: store.state.nextCheckAt,
    checking: store.state.checking,
    login: store.state.login,
    warnings: store.state.warnings,
    counts: store.state.lastCounts,
    dryRun: watcher.isDryRun,
    onboardingDismissed: store.state.onboardingDismissed,
    today: dayKey(Date.now()),
    unseenAlerts: unseenCount,
    theme: cfg.theme.enabled && cfg.theme.themeApp ? palette(cfg) : null,
    onBattery: powerMonitor.isOnBatteryPower(),
    storiesVersion,
    configVersion,
  };
}

/** Missed-alert count, cached: it only changes when alerts fire or are marked seen. */
let unseenCount = 0;
function updateBadges() {
  const n = (unseenCount = unseenAlertCount());
  tray?.setTitle(n ? ` ${n}` : '', { fontType: 'monospacedDigit' });
  app.setBadgeCount(n);
  pushState();
}

// ---------- IPC (see preload.ts for the renderer-side API). Every argument is validated. ----------
/** Only the app's own pages (main window, menu bar panel) may call the API. */
function fromApp(e: Electron.IpcMainInvokeEvent): boolean {
  const ok = (w: BrowserWindow | null) => !!w && !w.isDestroyed() && e.sender === w.webContents;
  return (ok(win) || ok(popover)) && (e.senderFrame?.url ?? '').startsWith('file://');
}
function handle(channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) {
      log.warn(`Ignored IPC "${channel}" from an unexpected sender`);
      return undefined;
    }
    return fn(e, ...args);
  });
}
const str = (v: unknown, max = 2000) => (typeof v === 'string' && v.length <= max ? v : '');
const isKnownSource = (id: unknown) => typeof id === 'string' && !!findSource(getConfig(), id);

handle('getState', () => buildState());
handle('selectTab', (_e, id: unknown) => {
  if (isKnownSource(id)) selectTab(id as string);
});
handle('nav', (_e, action: unknown) => {
  const wc = tabs.get(activeTab)?.view?.webContents;
  if (!wc) return;
  if (action === 'back') wc.navigationHistory.goBack();
  else if (action === 'forward') wc.navigationHistory.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'home') wc.loadURL(findSource(getConfig(), activeTab)!.homeUrl).catch(() => {});
});
handle('openStory', (_e, sourceId: unknown, url: unknown, storyId: unknown) => {
  if (!isKnownSource(sourceId) || !isHttpUrl(url)) return;
  popover?.hide();
  openStory(sourceId as string, url as string, str(storyId, 3000) || undefined);
});
handle('feedback', (_e, storyId: unknown, kind: unknown) => {
  const s = store.byId(str(storyId, 3000));
  if (s && (kind === 'up' || kind === 'down')) {
    giveFeedback(s, kind);
    store.saveStories();
  }
});
handle('days', () => availableDays());
handle('dayDigest', (_e, day: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(day, 10)) ? dayDigest(day as string) : []));
handle('whatsNew', () => whatsNew());
handle('morningDigest', () => morningDigest());
handle('alerts', () => alertInbox());
handle('markAlertsSeen', () => {
  markAlertsSeen();
  updateBadges();
});
handle('flaggedNow', () => flaggedNow());
handle('runCheck', () => {
  void watcher.runCheck('manual');
});
handle('getConfig', () => getConfig());
handle('getDefaults', () => getDefaults());
handle('saveConfig', (_e, cfg: unknown) => saveConfig(cfg));
handle('listSources', () => {
  const cfg = getConfig();
  return allSources(cfg).map((s) => ({ id: s.id, name: s.name, short: s.short, color: s.color, homeUrl: s.homeUrl, custom: !!s.custom, requiresLogin: s.requiresLogin, preset: PRESETS.some((p) => p.id === s.id) }));
});
handle('themeOptions', (_e, flavor: unknown) => themeOptions(str(flavor, 20)));
handle('resetPrefs', () => {
  resetPrefs();
  storiesVersion++;
  pushState();
});
handle('openConfigFile', () => openConfigFile());
handle('openLog', () => openLogFile());
handle('showWindow', () => {
  popover?.hide();
  showWindow();
});
handle('dismissOnboarding', () => {
  store.state.onboardingDismissed = true;
  store.saveState();
  pushState();
});

function sendTestNotification() {
  log.info('Sending test notification');
  const first = activeSources(getConfig())[0];
  notify({ title: 'News Monitor', subtitle: 'Notifications are working', body: 'Click to open the app.', sourceId: first?.id, url: first?.homeUrl });
}

// ---------- menu bar: left click opens the panel, right click the menu ----------
function createTray() {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('News Monitor');
  tray.on('click', () => togglePopover());
  tray.on('right-click', () => tray!.popUpContextMenu(trayMenu()));
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open News Monitor', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Run check now', click: () => watcher.runCheck('tray') },
    { label: 'Send test notification', click: () => sendTestNotification() },
    { type: 'separator' },
    { label: 'Open config file', click: () => openConfigFile() },
    { label: 'Open log file', click: () => openLogFile() },
    {
      label: 'About',
      click: () => dialog.showMessageBox({ message: 'News Monitor', detail: `Version ${app.getVersion()}\nData folder: ${app.getPath('userData')}` }),
    },
    { type: 'separator' },
    {
      label: 'Quit News Monitor',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

let popoverHiddenAt = 0;
function togglePopover() {
  if (popover?.isVisible()) {
    popover.hide();
    return;
  }
  // Clicking the icon while the panel is open blurs (hides) it first; don't reopen it.
  if (Date.now() - popoverHiddenAt < 300) return;
  if (!popover) {
    popover = new BrowserWindow({
      width: 380,
      height: 540,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      vibrancy: 'popover',
      visualEffectState: 'active',
      roundedCorners: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
    });
    lockDownAppContents(popover);
    popover.loadFile(path.join(__dirname, '..', 'renderer', 'popover.html'));
    popover.on('blur', () => popover?.hide());
    popover.on('hide', () => (popoverHiddenAt = Date.now()));
  }
  const t = tray!.getBounds();
  const area = screen.getDisplayNearestPoint({ x: t.x, y: t.y }).workArea;
  const [w] = popover.getSize();
  const x = Math.round(Math.min(Math.max(t.x + t.width / 2 - w / 2, area.x + 8), area.x + area.width - w - 8));
  const y = Math.round(t.y + t.height + 4);
  popover.setPosition(x, y, false);
  popover.show();
  popover.webContents.send('state', buildState());
}

// ---------- diagnostics ----------
/** `--check-sources`: read every built-in front page once and report what was found. */
async function checkSources() {
  for (const source of PRESETS) {
    prepareSession(source.id);
    const t0 = Date.now();
    try {
      const r = await runInHiddenPage<ExtractionResult>(source.id, source.homeUrl, extractionScript(source));
      const top = r.headlines.slice(0, 4).map((h) => `      #${h.position} ${h.fontSize}px ${h.opinion ? '[opinion] ' : ''}${h.live ? '[live] ' : ''}${h.headline.slice(0, 90)}`);
      console.log(`${source.short.padEnd(5)} ${String(r.headlines.length).padStart(3)} headlines  ${r.headlines.filter((h) => h.dek).length} with deks  ${((Date.now() - t0) / 1000).toFixed(1)}s  login: ${r.login.loggedIn} (${r.login.reason})\n${top.join('\n')}`);
    } catch (err) {
      console.log(`${source.short.padEnd(5)} FAILED: ${err}`);
    }
  }
}

/**
 * NEWS_MONITOR_BENCH=1 (with NEWS_MONITOR_METRICS=1): open every tab, hide the window, and
 * log resource use, with no checks running. Used to measure what idle tabs cost.
 */
async function runBench() {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const id of tabs.keys()) {
    selectTab(id);
    await wait(8000);
  }
  win?.hide();
  log.info('BENCH window hidden');
}

/** NEWS_MONITOR_METRICS=1: log the app's total CPU and memory every 30 seconds. */
function startMetrics() {
  setInterval(() => {
    const m = app.getAppMetrics();
    const cpu = m.reduce((a, p) => a + p.cpu.percentCPUUsage, 0);
    const mem = m.reduce((a, p) => a + p.memory.workingSetSize, 0) / 1024;
    log.info(`METRICS processes=${m.length} cpu=${cpu.toFixed(1)}% memory=${mem.toFixed(0)}MB views=${[...tabs.values()].filter((t) => t.view).length} visible=${!!win?.isVisible()}`);
  }, 30_000);
}

