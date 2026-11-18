// Reading themes: Catppuccin palettes applied to news pages with Dark Reader's dynamic
// theme engine, and to the app's own interface. Off by default.
// Palette values: https://github.com/catppuccin/palette (MIT).
import fs from 'node:fs';
import type { WebContents } from 'electron';
import type { Config } from './configCore';
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

let darkReaderSource: string | null = null;
function darkReader(): string {
  if (darkReaderSource === null) {
    try {
      darkReaderSource = fs.readFileSync(require.resolve('darkreader/darkreader.js'), 'utf8');
    } catch (err) {
      log.warn(`Dark Reader not available: ${err}`);
      darkReaderSource = '';
    }
  }
  return darkReaderSource;
}

// Run in an isolated JavaScript world: Dark Reader shares the page's DOM but not its globals.
const WORLD_ID = 1077;

/** Apply (or remove) the reading theme on a page. Call on every dom-ready. */
export async function applyPageTheme(wc: WebContents, cfg: Config, on: boolean) {
  if (wc.isDestroyed()) return;
  const src = darkReader();
  if (!src) return;
  const p = palette(cfg);
  const theme = {
    mode: p.dark ? 1 : 0,
    brightness: 100,
    contrast: 100,
    sepia: 0,
    darkSchemeBackgroundColor: p.bg,
    darkSchemeTextColor: p.text,
    lightSchemeBackgroundColor: p.bg,
    lightSchemeTextColor: p.text,
    selectionColor: p.accent,
    scrollbarColor: p.surface2,
  };
  const code = on
    ? `if (typeof DarkReader === 'undefined') { ${src}
       }
       ;(function(){ try { DarkReader.setFetchMethod(window.fetch); DarkReader.enable(${JSON.stringify(theme)}, { css: 'a:hover{color:${p.accent} !important} ::selection{background:${p.accent}55 !important}' }); } catch (e) {} })();`
    : `(function(){ try { if (typeof DarkReader !== 'undefined') DarkReader.disable(); } catch (e) {} })();`;
  try {
    await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]);
  } catch (err) {
    log.warn(`Theme injection failed: ${err}`);
  }
}
