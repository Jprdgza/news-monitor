// Updates, without an auto-updater:
// - Notice: about once a day, ask GitHub for the latest release. If it's newer, the app shows a
//   notice whose button downloads the right DMG. Nothing is installed without you.
// - Installer: open the downloaded DMG and double-click News Monitor. Run from a disk image (or
//   from a download macOS has moved aside, "App Translocation"), the app offers to install or
//   update itself: it quits the copy that's running (which saves sign-ins on the way out),
//   replaces the app in Applications, ejects the disk image and opens the new version. Sources,
//   settings and sign-ins live in ~/Library/Application Support, so they carry over.
import { app, dialog, net, shell } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './log';

const REPO = 'Jprdgza/news-monitor';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const EXE_SUFFIX = '/News Monitor.app/Contents/MacOS/News Monitor';
const DAY = 24 * 3_600_000;

// ---------- version helpers ----------

/** Compare dotted versions ("1.0.10" > "1.0.9"). Returns >0 if a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export interface AvailableUpdate {
  version: string;
  /** The DMG for this Mac's processor, or the release page if there isn't one. */
  downloadUrl: string;
  pageUrl: string;
}

/** Pick out the newer version (if any) from a GitHub "latest release" response. */
export function parseRelease(json: unknown, current: string, arch: string): AvailableUpdate | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (typeof r.tag_name !== 'string' || r.draft || r.prerelease) return null;
  const version = r.tag_name.replace(/^v/i, '');
  if (!/^\d+(\.\d+){0,3}$/.test(version) || compareVersions(version, current) <= 0) return null;
  const pageUrl = typeof r.html_url === 'string' && r.html_url.startsWith(`https://github.com/${REPO}/`) ? r.html_url : RELEASES_PAGE;
  const want = arch === 'arm64' ? '-arm64.dmg' : '-x64.dmg';
  const assets = Array.isArray(r.assets) ? r.assets : [];
  const dmg = assets.find(
    (a: any) =>
      typeof a?.name === 'string' &&
      a.name.endsWith(want) &&
      typeof a.browser_download_url === 'string' &&
      a.browser_download_url.startsWith(`https://github.com/${REPO}/releases/download/`)
  ) as { browser_download_url: string } | undefined;
  return { version, downloadUrl: dmg?.browser_download_url ?? pageUrl, pageUrl };
}

// ---------- the notice ----------

let available: AvailableUpdate | null = null;
// Development only: NEWS_MONITOR_PRETEND_VERSION=1.0.0 makes a dev run look for updates as that version.
const pretendVersion = () => (!app.isPackaged ? process.env.NEWS_MONITOR_PRETEND_VERSION : undefined);
let timer: NodeJS.Timeout | null = null;

export const availableUpdate = () => available;

/** Check now and then daily. `onFound` runs when a newer version first turns up. */
export function startUpdateChecks(enabled: () => boolean, onFound: (u: AvailableUpdate) => void) {
  const pretend = pretendVersion();
  if ((!app.isPackaged && !pretend) || timer) return;
  const run = async () => {
    if (!enabled()) return;
    try {
      const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'News-Monitor-update-check' },
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const found = parseRelease(await res.json(), pretend ?? app.getVersion(), process.arch);
      const isNew = !!found && found.version !== available?.version;
      available = found;
      if (found && isNew) {
        log.info(`Update available: ${found.version}`);
        onFound(found);
      }
    } catch (err) {
      log.warn(`Update check failed: ${err}`);
    }
  };
  setTimeout(run, pretend ? 5000 : 60_000); // after the first check of the news, not during it
  timer = setInterval(run, DAY);
}

/** Download the new DMG in the browser (Safari etc. save it to Downloads). */
export function downloadUpdate() {
  if (available) void shell.openExternal(available.downloadUrl);
}

// ---------- installing from a disk image ----------

const bundleOf = (exe: string) => path.resolve(exe, '..', '..', '..');

/** Is this copy running from a DMG (or a quarantined download macOS translocated)? */
export function runningFromDiskImage(): boolean {
  if (!app.isPackaged || process.platform !== 'darwin') return false;
  const exe = app.getPath('exe');
  return exe.startsWith('/Volumes/') || exe.includes('/AppTranslocation/');
}

function installedCopy(): string | null {
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    const p = path.join(dir, 'News Monitor.app');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function versionOf(bundle: string): string {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Other running News Monitor main processes (any copy, any version). */
function otherInstances(): number[] {
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m && m[2].endsWith(EXE_SUFFIX) && Number(m[1]) !== process.pid)
      .map((m) => Number(m[1]));
  } catch {
    return [];
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask running copies to quit (they flush sign-in cookies on the way out) and wait for them. */
async function quitOtherInstances(): Promise<boolean> {
  const pids = otherInstances();
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 75 && pids.some(alive); i++) await wait(200);
  return !pids.some(alive);
}

/** Where a translocated or DMG copy really lives: the mounted volume to eject afterwards. */
function sourceVolume(bundle: string): string | null {
  if (bundle.startsWith('/Volumes/')) return bundle.split('/').slice(0, 3).join('/');
  try {
    // A translocated app is a read-only mirror; `mount` names what it mirrors.
    const mirror = path.dirname(bundle);
    const line = execFileSync('/sbin/mount', { encoding: 'utf8' })
      .split('\n')
      .find((l) => l.includes(` on ${mirror} (`));
    const src = line?.split(' on ')[0] ?? '';
    return src.startsWith('/Volumes/') ? src.split('/').slice(0, 3).join('/') : null;
  } catch {
    return null;
  }
}

/** Copy this app over the installed one, swapping it in only once the copy is complete. */
function replaceInstalled(source: string, target: string) {
  const fresh = `${target}.installing`;
  const old = `${target}.previous`;
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  execFileSync('/usr/bin/ditto', [source, fresh]);
  // You already approved this exact app when you opened it; don't make macOS ask again.
  execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', fresh]);
  if (fs.existsSync(target)) fs.renameSync(target, old);
  try {
    fs.renameSync(fresh, target);
  } catch (err) {
    if (fs.existsSync(old)) fs.renameSync(old, target); // put the old version back
    throw err;
  }
  fs.rmSync(old, { recursive: true, force: true });
}

/**
 * Run instead of the normal startup when the app was opened from a DMG. Always ends by exiting:
 * either the installed copy is opened, or nothing changes.
 */
export async function runInstaller() {
  const source = bundleOf(app.getPath('exe'));
  const current = app.getVersion();
  const installed = installedCopy();
  const installedVersion = installed ? versionOf(installed) : '';
  const target = installed ?? '/Applications/News Monitor.app';
  const openInstalled = () => spawn('/usr/bin/open', [target], { detached: true, stdio: 'ignore' }).unref();

  if (installed && installedVersion && compareVersions(installedVersion, current) >= 0) {
    const same = compareVersions(installedVersion, current) === 0;
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: same ? `News Monitor ${current} is already installed.` : `A newer version (${installedVersion}) is already installed.`,
      detail: 'You can eject this disk image.',
      buttons: ['Open News Monitor', 'Close'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      app.releaseSingleInstanceLock();
      openInstalled();
    }
    return app.exit(0);
  }

  const updating = !!installed;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: updating ? `Update News Monitor to ${current}?` : 'Install News Monitor?',
    detail: updating
      ? `This replaces version ${installedVersion || 'installed'} in ${path.dirname(target)}. Your sources, settings and sign-ins are kept.${otherInstances().length ? ' News Monitor will quit and reopen.' : ''}\n\n` +
        'macOS will then ask for your Mac password once so the new version can unlock your saved sign-ins. Enter it and click Always Allow (Deny would sign you out of your papers).'
      : 'News Monitor will be copied to your Applications folder and opened.',
    buttons: [updating ? 'Update' : 'Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return app.exit(0);

  try {
    if (!(await quitOtherInstances())) throw new Error('The running copy of News Monitor did not quit. Quit it from its menu bar icon and try again.');
    replaceInstalled(source, target);
    log.info(`${updating ? 'Updated' : 'Installed'} News Monitor ${current} at ${target}`);
  } catch (err) {
    log.error(`Install failed: ${err}`);
    await dialog.showMessageBox({
      type: 'warning',
      message: `Couldn't ${updating ? 'update' : 'install'} News Monitor.`,
      detail: `${err instanceof Error ? err.message : err}\n\nYou can drag News Monitor into the Applications folder instead.`,
    });
    return app.exit(1);
  }

  app.releaseSingleInstanceLock();
  openInstalled();
  const volume = sourceVolume(source);
  if (volume) spawn('/bin/sh', ['-c', 'sleep 3; /usr/bin/hdiutil detach "$1" -quiet', 'sh', volume], { detached: true, stdio: 'ignore' }).unref();
  app.exit(0);
}
