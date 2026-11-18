// Shared UI helpers for the main window and the menu bar panel (loaded as a plain script).
// Everything that puts text into HTML goes through esc().

declare const api: any;

interface StoryView {
  id: string;
  sourceId: string;
  sourceShort: string;
  sourceColor: string;
  url: string;
  headline: string;
  dek: string;
  preview?: string;
  firstSeen: number;
  score: number;
  flagged: boolean;
  alerted: boolean;
  live: boolean;
  breaking: boolean;
  opinion: boolean;
  topic: string;
  signals: string[];
  alsoIn: string[];
  feedback?: 'up' | 'down';
  opened: boolean;
  personal?: string;
  alertTime?: number;
  unseen?: boolean;
  followUp?: boolean;
}

interface Palette {
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

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Only #rrggbb colors reach a style attribute. */
const safeColor = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#888888');

const fmtTime = (ts?: number) => (ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');

function timeAgo(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Small line icons (24×24 viewBox, drawn with currentColor).
const ICON_PATHS: Record<string, string> = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  forward: '<path d="M9 18l6-6-6-6"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  up: '<path d="M7 11v9H4v-9z"/><path d="M7 11l4-8a2 2 0 0 1 2.6 2.3L13 9h5.6a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17.2 20H7"/>',
  down: '<path d="M17 13V4h3v9z"/><path d="M17 13l-4 8a2 2 0 0 1-2.6-2.3L11 15H5.4a2 2 0 0 1-2-2.4l1.4-7A2 2 0 0 1 6.8 4H17"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
  chevronRight: '<path d="M9 18l6-6-6-6"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
};
const icon = (name: string, size = 16) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ''}</svg>`;

function actionsHtml(s: StoryView) {
  const why = s.signals.length || s.personal;
  return `<span class="actions">
    <button class="act ${s.feedback === 'up' ? 'on' : ''}" data-act="up" title="More like this">${icon('up', 13)}</button>
    <button class="act ${s.feedback === 'down' ? 'on' : ''}" data-act="down" title="Less like this">${icon('down', 13)}</button>
    ${why ? `<button class="act" data-act="why" title="Why is this here?">${icon('info', 13)}</button>` : ''}
  </span>`;
}

/** One story card. `compact` is used in the menu bar panel. */
function storyCard(s: StoryView, opts: { compact?: boolean; showDate?: boolean } = {}) {
  const chips = [
    s.breaking ? '<span class="chip chip-hot">Breaking</span>' : '',
    s.live && !s.breaking ? '<span class="chip chip-live"><i></i>Live</span>' : '',
    s.followUp ? '<span class="chip">Update</span>' : '',
    s.opinion ? '<span class="chip">Opinion</span>' : '',
    s.alsoIn.length ? `<span class="chip chip-also" title="Same story on other front pages">Also in ${esc(s.alsoIn.join(', '))}</span>` : '',
  ].join('');
  const when = s.alertTime ?? s.firstSeen;
  const meta = `<span class="src" data-color="${esc(safeColor(s.sourceColor))}">${esc(s.sourceShort)}</span>
    <span class="dot-sep">${opts.showDate ? esc(timeAgo(when)) : esc(fmtTime(when))}</span>
    ${s.topic && s.topic !== 'Other' ? `<span class="dot-sep">${esc(s.topic)}</span>` : ''}
    <span class="grow"></span>
    ${opts.compact ? '' : actionsHtml(s)}
    ${s.flagged ? `<span class="score ${s.alerted ? 'alerted' : ''}" title="${s.alerted ? 'You were notified' : 'Above the alert threshold'}">${s.alerted ? icon('bell', 11) : ''}${esc(s.score)}</span>` : s.score >= 1 ? `<span class="score quiet" title="Score">${esc(s.score)}</span>` : ''}`;
  if (opts.compact) {
    return `<article class="card compact ${s.flagged ? 'flagged' : ''} ${s.unseen ? 'unseen' : ''}" data-id="${esc(s.id)}" data-source="${esc(s.sourceId)}" data-url="${esc(s.url)}" tabindex="0">
      <div class="meta">${meta}</div>
      <h3>${esc(s.headline)}</h3>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
    </article>`;
  }
  const why = [...s.signals, ...(s.personal ? [s.personal] : [])];
  return `<article class="card ${s.flagged ? 'flagged' : ''} ${s.unseen ? 'unseen' : ''} ${s.opened ? 'opened' : ''}" data-id="${esc(s.id)}" data-source="${esc(s.sourceId)}" data-url="${esc(s.url)}" tabindex="0">
    <div class="meta">${meta}</div>
    <h3>${esc(s.headline)}</h3>
    ${s.dek ? `<p class="dek">${esc(s.dek)}</p>` : ''}
    ${s.preview ? `<p class="preview">${esc(s.preview)}</p>` : ''}
    ${chips ? `<div class="card-foot"><div class="chips">${chips}</div></div>` : ''}
    ${why.length ? `<ul class="why" hidden>${why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  </article>`;
}

/** Inline style attributes are blocked by the page's CSP, so colors are set through the CSSOM. */
function paintColors(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>('[data-color]').forEach((el) => el.style.setProperty('--src', safeColor(el.dataset.color ?? '')));
}

/** Card clicks: open the story, or handle 👍 / 👎 / Why?. */
function wireCards(container: HTMLElement, onChange?: () => void) {
  container.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>('.card');
    if (!card) return;
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'why') {
      const why = card.querySelector<HTMLElement>('.why');
      if (why) why.hidden = !why.hidden;
      return;
    }
    if (act === 'up' || act === 'down') {
      await api.feedback(card.dataset.id, act);
      card.querySelectorAll('[data-act="up"],[data-act="down"]').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.act === act));
      onChange?.();
      return;
    }
    if (target.closest('a,button,ul')) return;
    card.classList.add('opened');
    api.openStory(card.dataset.source, card.dataset.url, card.dataset.id);
  });
  container.addEventListener('keydown', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
    if (card && e.key === 'Enter' && e.target === card) api.openStory(card.dataset.source, card.dataset.url, card.dataset.id);
  });
}

/** Apply the Catppuccin palette to the interface (or go back to the default look). */
function applyAppTheme(p: Palette | null) {
  const root = document.documentElement;
  const vars: Record<string, string> = p
    ? {
        '--bg': p.bg,
        '--panel': p.panel,
        '--elev': p.surface,
        '--hover': `color-mix(in srgb, ${p.surface} 70%, transparent)`,
        '--border': `color-mix(in srgb, ${p.surface2} 70%, transparent)`,
        '--text': p.text,
        '--muted': p.subtext,
        '--subtle': p.muted,
        '--accent': p.accent,
        '--accent-fg': p.dark ? p.crust : '#ffffff',
        '--hot': p.red,
        '--live': p.peach,
        '--ok': p.green,
        '--warn': p.yellow,
      }
    : {};
  for (const name of ['--bg', '--panel', '--elev', '--hover', '--border', '--text', '--muted', '--subtle', '--accent', '--accent-fg', '--hot', '--live', '--ok', '--warn']) {
    if (vars[name]) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
  root.dataset.scheme = p ? (p.dark ? 'dark' : 'light') : '';
}
