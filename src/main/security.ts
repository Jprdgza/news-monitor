// Protecting the sign-in sessions stored for each source.
//
// Threats this covers (beyond the sandboxing in main.ts and sessions.ts):
// - Another program reading the cookie files: cookies are encrypted at rest with a key in the
//   macOS Keychain (the enableCookieEncryption fuse). migrateCookies() re-encrypts cookies that
//   were stored before encryption was turned on, then compacts the database so the old plain-text
//   copies don't linger in free pages.
// - Another program relaunching the app with a remote-debugging port, which would expose every
//   session over DevTools: refused in packaged builds.
// - Phishing through popups: a page (or an ad inside it) opening a window that only looks like a
//   sign-in page. Popups are limited to a short list of identity providers, and their title bar
//   always shows the real host.
// - Losing a fresh login: cookies are flushed to disk after sign-in windows close, after
//   navigation, and before quitting.
import { app, type BrowserWindow, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log';

const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'inspect', 'inspect-brk', 'inspect-port'];

/** Exit at once if a packaged build was started with a debugging switch. Call before anything else. */
export function refuseRemoteDebugging() {
  if (!app.isPackaged) return;
  const bad = DEBUG_SWITCHES.find((s) => app.commandLine.hasSwitch(s)) ?? process.argv.find((a) => /^--(remote-debugging|inspect)/i.test(a));
  if (bad) {
    console.error('News Monitor does not run with debugging switches.');
    app.exit(1);
  }
}

/** Third-party sign-in providers that may open as popups. Publisher sign-in stays inside the tab. */
const IDENTITY_HOSTS = new Set([
  'accounts.google.com',
  'appleid.apple.com',
  'www.facebook.com',
  'm.facebook.com',
  'login.microsoftonline.com',
  'login.live.com',
]);

export function isIdentityProvider(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && IDENTITY_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const POPUP_OPTIONS = {
  width: 520,
  height: 720,
  minimizable: false,
  autoHideMenuBar: true,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
};

/** Show the real host (and whether it's secure) in a sign-in popup's title, whatever the page sets. */
export function labelPopup(child: BrowserWindow, onClosed: () => void) {
  const wc = child.webContents;
  const label = () => {
    try {
      const u = new URL(wc.getURL());
      return u.protocol === 'https:' ? `🔒 ${u.hostname}` : `⚠️ Not secure — ${u.hostname}`;
    } catch {
      return 'Sign in';
    }
  };
  wc.on('page-title-updated', (e) => {
    e.preventDefault();
    child.setTitle(label());
  });
  wc.on('did-navigate', () => child.setTitle(label()));
  child.setTitle(label());
  child.on('closed', onClosed);
}

/** Write cookies to disk now (Chromium otherwise batches writes for up to 30 seconds). */
export async function flushCookies(sessions: Session[], timeoutMs = 2000) {
  await Promise.race([
    Promise.allSettled(sessions.map((s) => s.cookies.flushStore())),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

// ---------- one-time re-encryption of cookies saved before encryption was enabled ----------

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const partitionsDir = () => path.join(app.getPath('userData'), 'Partitions');
const markerFile = () => path.join(app.getPath('userData'), 'data', 'cookie-encryption.json');
const backupDir = () => path.join(app.getPath('userData'), 'cookie-backup');

interface Marker {
  reencrypted?: boolean;
  compacted?: boolean;
  counts?: Record<string, number>;
}

function readMarker(): Marker {
  try {
    return JSON.parse(fs.readFileSync(markerFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeMarker(m: Marker) {
  fs.mkdirSync(path.dirname(markerFile()), { recursive: true });
  fs.writeFileSync(markerFile(), JSON.stringify(m), { mode: 0o600 });
}

function cookieDbs(): { id: string; file: string }[] {
  try {
    return fs
      .readdirSync(partitionsDir())
      .filter((id) => ID.test(id))
      .map((id) => ({ id, file: path.join(partitionsDir(), id, 'Cookies') }))
      .filter((d) => fs.existsSync(d.file));
  } catch {
    return [];
  }
}

function openDb(file: string) {
  // node:sqlite ships with the Node version inside Electron.
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(file);
}

function countRows(file: string): { total: number; plain: number } {
  const db = openDb(file);
  try {
    const row = db.prepare('SELECT count(*) AS total, sum(length(value) > 0) AS plain FROM cookies').get() as { total: number; plain: number | null };
    return { total: Number(row.total), plain: Number(row.plain ?? 0) };
  } finally {
    db.close();
  }
}

/**
 * Phase 1, before any session opens: if cookies were re-encrypted last run, check every
 * database has no plain-text values left, then VACUUM it so the old pages are gone too.
 * Also keeps a private backup of the cookie files before phase 2 runs for the first time.
 */
export function prepareCookieMigration() {
  if (!app.isPackaged) return; // the encryption fuse only exists in packaged builds
  const m = readMarker();
  if (m.compacted) return;
  const dbs = cookieDbs();
  if (!m.reencrypted) {
    // Backup in case the Keychain refuses access during the switch-over (removed once verified).
    if (!fs.existsSync(backupDir()) && dbs.length) {
      fs.mkdirSync(backupDir(), { recursive: true, mode: 0o700 });
      for (const d of dbs) fs.copyFileSync(d.file, path.join(backupDir(), `${d.id}.sqlite`));
      fs.chmodSync(backupDir(), 0o700);
    }
    return;
  }
  let ok = true;
  for (const d of dbs) {
    try {
      // Partitioned (third-party embed) cookies can't be rewritten through Electron's cookie
      // API. They are never sign-in sessions; drop the plain-text ones and sites set them again.
      const pre = openDb(d.file);
      try {
        pre.exec("DELETE FROM cookies WHERE length(value) > 0 AND top_frame_site_key != ''");
      } finally {
        pre.close();
      }
      const { total, plain } = countRows(d.file);
      const before = m.counts?.[d.id] ?? 0;
      if (plain > 0 || total < before * 0.8) {
        ok = false;
        log.warn(`Cookie re-encryption incomplete for ${d.id} (${plain} plain of ${total}, was ${before}); keeping backup`);
        continue;
      }
      const db = openDb(d.file);
      try {
        db.exec('VACUUM');
      } finally {
        db.close();
      }
      for (const extra of ['-journal', '-wal']) fs.rmSync(d.file + extra, { force: true });
    } catch (err) {
      ok = false;
      log.warn(`Could not verify cookies for ${d.id}: ${err}`);
    }
  }
  if (ok) {
    fs.rmSync(backupDir(), { recursive: true, force: true });
    writeMarker({ ...m, compacted: true });
    log.info('Sign-in cookies are encrypted at rest; plain-text copies removed');
  } else {
    writeMarker({ ...m, reencrypted: false }); // try again next launch
  }
}

/** Phase 2, after sessions are ready: rewrite every cookie so Chromium stores it encrypted. */
export async function reencryptCookies(prepare: (id: string) => Session) {
  if (!app.isPackaged) return;
  const m = readMarker();
  if (m.reencrypted || m.compacted) return;
  const counts: Record<string, number> = {};
  for (const { id } of cookieDbs()) {
    const ses = prepare(id);
    const all = await ses.cookies.get({});
    counts[id] = all.filter((c) => !c.session).length; // session cookies aren't kept across launches
    let failed = 0;
    for (const c of all) {
      const host = (c.domain ?? '').replace(/^\./, '');
      if (!host) continue;
      try {
        await ses.cookies.set({
          url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
          name: c.name,
          value: c.value,
          ...(c.hostOnly ? {} : { domain: c.domain }),
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          ...(c.session ? {} : { expirationDate: c.expirationDate }),
          sameSite: c.sameSite,
        });
      } catch {
        failed++;
      }
    }
    await ses.cookies.flushStore();
    if (failed) log.warn(`Re-encrypting ${id}: ${failed} of ${all.length} cookies could not be rewritten`);
  }
  writeMarker({ reencrypted: true, counts });
  log.info('Re-encrypted saved sign-in cookies; old copies are cleaned up on next launch');
}
