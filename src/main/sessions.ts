// Per-source browser sessions: user agent, permissions, ad/tracker blocking, and the extra
// resource blocking that keeps background checks light.
//
// Ad blocking uses Ghostery's engine with the EasyList + EasyPrivacy based "ads and tracking"
// lists. The compiled engine is cached on disk and refreshed weekly.
import { app, ipcMain, session, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { getConfig } from './config';
import { log } from './log';
import { partitionFor } from './sources';
import { THEME_PRELOAD } from './theme';

/** webContents ids of hidden check windows: these skip images, media and fonts. */
export const lightweightContents = new Set<number>();

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
const CACHE_MAX_AGE = 7 * 86_400_000;

let blocker: ElectronBlocker | null = null;
let blockerLoading: Promise<void> | null = null;
const prepared = new Map<string, { preloadId?: string }>();

export function cleanUserAgent(ua: string): string {
  return ua.replace(/\sElectron\/\S+/, '').replace(/\snews-monitor\/\S+/i, '').replace(/\sNews Monitor\/\S+/i, '');
}

async function loadBlocker() {
  const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
  try {
    if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs > CACHE_MAX_AGE) fs.unlinkSync(cache);
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache,
      read: (p) => fs.promises.readFile(p),
      write: (p, buf) => fs.promises.writeFile(p, buf),
    });
    // The preload script asks the main process for cosmetic filters through these channels.
    ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => blocker!.onInjectCosmeticFilters(e, url, msg));
    ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (e) => blocker!.onIsMutationObserverEnabled(e));
    log.info('Ad and tracker blocking ready');
  } catch (err) {
    log.warn(`Ad blocker unavailable (pages load normally): ${err}`);
  }
}

/** Start loading the blocker (once). Await it before the first check so it applies from the start. */
export function initBlocker(): Promise<void> {
  return (blockerLoading ??= loadBlocker());
}

const HEAVY_TYPES = new Set(['image', 'imageset', 'media', 'font', 'object']);

function attach(ses: Session, id: string) {
  const blockAds = getConfig().efficiency.blockAds && !!blocker;
  const images = getConfig().efficiency.loadImagesInChecks;
  const entry = prepared.get(id) ?? {};

  // Electron allows one listener per webRequest event, so one handler does both jobs.
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (details.webContentsId !== undefined && lightweightContents.has(details.webContentsId)) {
      if (HEAVY_TYPES.has(details.resourceType) && !(images && details.resourceType.startsWith('image'))) return callback({ cancel: true });
    }
    if (blockAds) return blocker!.onBeforeRequest(details, callback);
    callback({});
  });
  if (blockAds) ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => blocker!.onHeadersReceived(d, cb));
  else ses.webRequest.onHeadersReceived(null);

  if (blockAds && !entry.preloadId) {
    entry.preloadId = ses.registerPreloadScript({ type: 'frame', filePath: require.resolve('@ghostery/adblocker-electron-preload') });
  } else if (!blockAds && entry.preloadId) {
    ses.unregisterPreloadScript(entry.preloadId);
    entry.preloadId = undefined;
  }
  prepared.set(id, entry);
}

/** Set up (or refresh) the session for a source. Safe to call repeatedly. */
export function prepareSession(id: string): Session {
  const ses = session.fromPartition(partitionFor(id));
  if (!prepared.has(id)) {
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
    ses.setSpellCheckerEnabled(false);
    // News sites never need the camera, location or notification permission here.
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
    // Reading theme (does nothing outside visible tabs, or while the theme is off).
    ses.registerPreloadScript({ type: 'frame', filePath: THEME_PRELOAD });
    attach(ses, id);
  }
  return ses;
}

/** Re-apply blocking settings to every prepared session (after the config changes). */
export function refreshSessions() {
  for (const id of prepared.keys()) attach(session.fromPartition(partitionFor(id)), id);
}
