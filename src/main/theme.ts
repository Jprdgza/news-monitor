// Reading themes: Catppuccin palettes applied to news pages with Dark Reader's dynamic
// theme engine, and to the app's own interface. Off by default.
//
// Pages are themed by a preload script (themePreload.ts) that runs in every frame of a tab
// before the page paints. This file answers its questions over IPC: which theme to use, the
// per-site fixes, and fetching cross-origin stylesheets it isn't allowed to read itself.
// Palette values: https://github.com/catppuccin/palette (MIT).
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, type WebContents } from 'electron';
import { isPublicHttpUrl, type Config } from './configCore';
import { getConfig } from './config';
import { log } from './log';

export type Flavor = 'latte' | 'frappe' | 'macchiato' | 'mocha';

const BASE: Record<Flavor, { base: string; mantle: string; crust: string; surface0: string; surface1: string; overlay1: string; subtext0: string; text: string }> = {
  latte: { base: '#eff1f5', mantle: '#e6e9ef', crust: '#dce0e8', surface0: '#ccd0da', surface1: '#bcc0cc', overlay1: '#8c8fa1', subtext0: '#6c6f85', text: '#4c4f69' },
  frappe: { base: '#303446', mantle: '#292c3c', crust: '#232634', surface0: '#414559', surface1: '#51576d', overlay1: '#838ba7', subtext0: '#a5adce', text: '#c6d0f5' },
  macchiato: { base: '#24273a', mantle: '#1e2030', crust: '#181926', surface0: '#363a4f', surface1: '#494d64', overlay1: '#8087a2', subtext0: '#a5adcb', text: '#cad3f5' },
  mocha: { base: '#1e1e2e', mantle: '#181825', crust: '#11111b', surface0: '#313244', surface1: '#45475a', overlay1: '#7f849c', subtext0: '#a6adc8', text: '#cdd6f4' },
};

const ACCENT: Record<Flavor, Record<string, string>> = {
  latte: { rosewater: '#dc8a78', flamingo: '#dd7878', pink: '#ea76cb', mauve: '#8839ef', red: '#d20f39', maroon: '#e64553', peach: '#fe640b', yellow: '#df8e1d', green: '#40a02b', teal: '#179299', sky: '#04a5e5', sapphire: '#209fb5', blue: '#1e66f5', lavender: '#7287fd' },
  frappe: { rosewater: '#f2d5cf', flamingo: '#eebebe', pink: '#f4b8e4', mauve: '#ca9ee6', red: '#e78284', maroon: '#ea999c', peach: '#ef9f76', yellow: '#e5c890', green: '#a6d189', teal: '#81c8be', sky: '#99d1db', sapphire: '#85c1dc', blue: '#8caaee', lavender: '#babbf1' },
  macchiato: { rosewater: '#f4dbd6', flamingo: '#f0c6c6', pink: '#f5bde6', mauve: '#c6a0f6', red: '#ed8796', maroon: '#ee99a0', peach: '#f5a97f', yellow: '#eed49f', green: '#a6da95', teal: '#8bd5ca', sky: '#91d7e3', sapphire: '#7dc4e4', blue: '#8aadf4', lavender: '#b7bdf8' },
  mocha: { rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7', red: '#f38ba8', maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af', green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', sapphire: '#74c7ec', blue: '#89b4fa', lavender: '#b4befe' },
};

export interface Palette {
  flavor: Flavor;
  dark: boolean;
  bg: string;
  panel: string;
  crust: string;
  surface: string;
  surface2: string;
  muted: string;
  subtext: string;
  text: string;
  accent: string;
  red: string;
  peach: string;
  green: string;
  yellow: string;
}

export function palette(cfg: Config): Palette {
  const flavor = (cfg.theme.flavor as Flavor) in BASE ? (cfg.theme.flavor as Flavor) : 'mocha';
  const b = BASE[flavor];
  const a = ACCENT[flavor];
  return {
    flavor,
    dark: flavor !== 'latte',
    bg: cfg.theme.background || b.base,
    panel: b.mantle,
    crust: b.crust,
    surface: b.surface0,
    surface2: b.surface1,
    muted: b.overlay1,
    subtext: b.subtext0,
    text: cfg.theme.text || b.text,
    accent: a[cfg.theme.accent] ?? a.mauve,
    red: a.red,
    peach: a.peach,
    green: a.green,
    yellow: a.yellow,
  };
}

/** Colors for the settings panel's flavor and accent pickers. */
export function themeOptions(flavor: string) {
  const f = (flavor as Flavor) in BASE ? (flavor as Flavor) : 'mocha';
  return {
    flavors: (Object.keys(BASE) as Flavor[]).map((id) => ({ id, base: BASE[id].base, text: BASE[id].text, accent: ACCENT[id].mauve })),
    accents: ACCENT[f],
  };
}

/** Is the reading theme on for this source's pages? */
export function themedFor(cfg: Config, sourceId: string): boolean {
  return cfg.theme.perSource[sourceId] ?? cfg.theme.enabled;
}

/** Path of the bundled preload (Dark Reader + themePreload.ts), built by scripts/copy-assets.js. */
export const THEME_PRELOAD = path.join(__dirname, 'theme-preload.js');

interface Fix {
  url: string[];
  invert: string[];
  css: string;
  ignoreInlineStyle: string[];
  ignoreImageAnalysis: string[];
}

// Dark Reader's community fixes for the built-in sources (scripts/update-theme-fixes.js).
let fixList: Fix[] | null = null;
function fixes(): Fix[] {
  if (fixList === null) {
    try {
      fixList = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'theme-fixes.json'), 'utf8'));
    } catch (err) {
      log.warn(`Theme fixes not available: ${err}`);
      fixList = [];
    }
  }
  return fixList!;
}

// Our own fixes for sites Dark Reader's list doesn't cover well (checked with screenshots).
const OWN_FIXES: Fix[] = [
  {
    url: ['ft.com'],
    // The masthead wordmark is a dark inline SVG (and a tinted image at smaller widths).
    invert: ['.o-header__top-logo svg', '.o-header__top-logo.o-header__hide--L', '.o-header__drawer-logo svg'],
    css: '',
    ignoreInlineStyle: [],
    ignoreImageAnalysis: [],
  },
  {
    url: ['barrons.com'],
    // The wordmark is a dark image (data URI).
    invert: ['h1[class*="Logo-module_container"] img'],
    css: '',
    ignoreInlineStyle: [],
    ignoreImageAnalysis: [],
  },
  {
    url: ['bloomberg.com'],
    // Dark Reader inverts the wordmark SVG, which also turns its dark backdrop into a white box.
    // The SVG draws in currentColor, so left alone it already takes the theme's text color.
    invert: [],
    css: '[data-component="bloombergLogo"] { filter: none !important; background-color: transparent !important; }',
    ignoreInlineStyle: [],
    ignoreImageAnalysis: [],
  },
];

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

const matches = (pattern: string, host: string) => {
  const p = pattern.replace(/^\*\./, '').replace(/\/.*$/, '');
  return !!host && (host === p || host.endsWith('.' + p));
};

/** Our own touch-ups, applied on top of Dark Reader on every site. */
function extraCss(p: Palette): string {
  return [
    `::selection { background-color: ${p.accent}55 !important; }`,
    `a:hover { color: ${p.accent} !important; }`,
    // Video players stack see-through layers (captions, posters) over the picture. Dark Reader
    // can fill them with the page color, hiding a video that is actually playing (Bloomberg's
    // Video.js player did this). Keep them see-through; caption boxes keep their own color.
    'video, .video-js .vjs-tech, .video-js .vjs-poster, .video-js .vjs-text-track-display, .video-js .vjs-text-track-display > div { background-color: transparent !important; }',
  ].join('\n');
}

/** The generic fix merged with the fix for this frame's site, as Dark Reader's extension does. */
export function fixFor(frameUrl: string, p: Palette) {
  const host = hostOf(frameUrl);
  const parts = [...fixes(), ...OWN_FIXES].filter((f) => f.url.includes('*') || f.url.some((u) => matches(u, host)));
  return {
    url: [host || '*'],
    invert: parts.flatMap((f) => f.invert),
    css: [...parts.map((f) => f.css), extraCss(p)].filter(Boolean).join('\n'),
    ignoreInlineStyle: parts.flatMap((f) => f.ignoreInlineStyle),
    ignoreImageAnalysis: parts.flatMap((f) => f.ignoreImageAnalysis),
    disableStyleSheetsProxy: false,
  };
}

/** What a frame of this source's tab should do. */
export function themePayload(cfg: Config, sourceId: string, frameUrl: string) {
  const p = palette(cfg);
  if (!themedFor(cfg, sourceId)) return { on: false, theme: {}, fixes: null };
  return {
    on: true,
    theme: {
      mode: p.dark ? 1 : 0,
      brightness: 100,
      contrast: 100,
      sepia: 0,
      grayscale: 0,
      darkSchemeBackgroundColor: p.bg,
      darkSchemeTextColor: p.text,
      lightSchemeBackgroundColor: p.bg,
      lightSchemeTextColor: p.text,
      selectionColor: 'auto',
      scrollbarColor: p.surface2,
    },
    fixes: fixFor(frameUrl, p),
  };
}

/** Send the current theme to every frame of a tab (after the settings change). */
export function pushTheme(wc: WebContents, cfg: Config, sourceId: string) {
  if (wc.isDestroyed()) return;
  for (const frame of wc.mainFrame.framesInSubtree) {
    try {
      frame.send('nm-theme:update', themePayload(cfg, sourceId, frame.url));
    } catch {
      /* frame went away */
    }
  }
}

const FETCH_TYPES = /^(text\/css|image\/)/i;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Answer the preload's questions. `sourceOf` maps a WebContents to the source whose visible tab
 * it is (or undefined for anything else, e.g. hidden check windows, which are never themed).
 */
export function registerThemeIpc(sourceOf: (wc: WebContents) => string | undefined) {
  ipcMain.on('nm-theme:get', (e) => {
    const id = sourceOf(e.sender);
    e.returnValue = id ? themePayload(getConfig(), id, e.senderFrame?.url || e.sender.getURL()) : null;
  });
  ipcMain.handle('nm-theme:fetch', async (e, url: unknown) => {
    const id = sourceOf(e.sender);
    if (!id || typeof url !== 'string' || url.length > 4000 || !isPublicHttpUrl(url) || !themedFor(getConfig(), id)) return null;
    try {
      const res = await e.sender.session.fetch(url, { signal: AbortSignal.timeout(15_000), credentials: 'omit' });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !FETCH_TYPES.test(type) || Number(res.headers.get('content-length') || 0) > FETCH_MAX_BYTES) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > FETCH_MAX_BYTES) return null;
      return { type, body: new Uint8Array(buf) };
    } catch {
      return null;
    }
  });
}
