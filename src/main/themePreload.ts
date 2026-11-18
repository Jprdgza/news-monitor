// Preload for news-page frames (bundled with Dark Reader into dist/main/theme-preload.js by
// scripts/copy-assets.js). It runs at document start in every frame of a visible tab, in
// Electron's isolated world, so the theme is in place before the page paints and also covers
// iframes (consent banners, paywall dialogs, embedded charts). Hidden check windows get `null`
// from the main process and do nothing.
//
// Dark Reader needs to read stylesheets served from other domains; the browser blocks that
// (CORS), so those fetches go through the main process instead (see theme.ts).

declare const DarkReader: {
  enable(theme: object, fixes?: object | null): void;
  disable(): void;
  setFetchMethod(fn: (url: string) => Promise<Response>): void;
};

(() => {
  const { ipcRenderer } = require('electron');
  type Payload = { on: boolean; theme: object; fixes: object | null } | null;

  let initial: Payload = null;
  try {
    initial = ipcRenderer.sendSync('nm-theme:get');
  } catch {
    return;
  }
  if (!initial) return;

  let enabled = false;
  const apply = (p: Payload) => {
    if (!p) return;
    try {
      if (p.on) {
        DarkReader.enable(p.theme, p.fixes);
        enabled = true;
      } else if (enabled) {
        DarkReader.disable();
        enabled = false;
      }
    } catch {
      /* a broken page shouldn't take the preload down */
    }
  };

  DarkReader.setFetchMethod(async (url: string) => {
    const r: { type: string; body: Uint8Array } | null = await ipcRenderer.invoke('nm-theme:fetch', String(url));
    if (!r) throw new Error(`Could not load ${url}`);
    return new Response(r.body as BlobPart, { headers: { 'content-type': r.type } });
  });
  // Preloads run before the parser has created <head>, and Dark Reader needs it. Start as soon
  // as it exists, which is still before the first paint.
  const start = () => apply(initial);
  if (document.head) start();
  else {
    const mo = new MutationObserver(() => {
      if (!document.head) return;
      mo.disconnect();
      start();
    });
    mo.observe(document, { childList: true, subtree: true });
  }
  ipcRenderer.on('nm-theme:update', (_e: unknown, p: Payload) => apply(p));
})();
