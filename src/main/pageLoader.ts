// Loads a page in a hidden BrowserWindow that shares the site's signed-in session, runs a
// script inside it, and destroys the window. One page at a time, nothing else fetched.
// These windows skip images, video and web fonts (see sessions.ts) and are destroyed right
// after use, so nothing keeps running between checks.
import { BrowserWindow } from 'electron';
import { lightweightContents } from './sessions';
import { partitionFor } from './sources';

const ISOLATED_WORLD = 1066;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runInHiddenPage<T>(
  sourceId: string,
  url: string,
  script: string,
  opts: { settleMs?: number; timeoutMs?: number; images?: boolean } = {}
): Promise<T> {
  const settleMs = opts.settleMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: {
      partition: partitionFor(sourceId),
      backgroundThrottling: false, // hidden windows would otherwise barely run
      sandbox: true,
      contextIsolation: true,
      images: !!opts.images,
      webgl: false,
      spellcheck: false,
      autoplayPolicy: 'document-user-activation-required',
    },
  });
  const id = win.webContents.id;
  lightweightContents.add(id);
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out loading ${url}`)), timeoutMs);
  });
  try {
    const work = (async () => {
      // Don't wait for every script to finish: the DOM being ready plus a short settle time is
      // enough for headlines to render. Redirects can reject loadURL harmlessly.
      const domReady = new Promise<void>((resolve) => win.webContents.once('dom-ready', () => resolve()));
      let loadError: unknown = null;
      win.loadURL(url).catch((err) => (loadError = err));
      await Promise.race([domReady, wait(30_000)]);
      if (!win.webContents.getURL() && loadError) throw loadError;
      await wait(settleMs);
      // Nudge lazy-loaded sections into existence, then go back to the top.
      await win.webContents.executeJavaScript('window.scrollTo(0, 2500)');
      await wait(800);
      await win.webContents.executeJavaScript('window.scrollTo(0, 0)');
      await wait(300);
      // Isolated world: the page shares its DOM with the script but can't tamper with its globals.
      return (await win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: script }])) as T;
    })();
    work.catch(() => {}); // if the timeout wins, work may still reject after the window is destroyed
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    lightweightContents.delete(id);
    if (!win.isDestroyed()) win.destroy();
  }
}
