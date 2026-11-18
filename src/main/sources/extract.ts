// Selector-light front-page extractor. It runs INSIDE the loaded web page (serialized with
// .toString()), so it must not reference anything outside itself.
//
// Strategy (robust to redesigns, no class names):
//   1. Walk every link inside <main> in DOM order.
//   2. Keep links whose URL looks like an article (per-source regex).
//   3. Headline = the largest-font text inside (or wrapping) the link.
//   4. Dek = first paragraph-like text in the story's "card" that isn't the headline.
//   5. Position = order of first appearance; font size helps spot the lead story.
import type { ExtractOptions } from './types';

export function extractFrontPage(opts: ExtractOptions) {
  const re = (src: string) => {
    try {
      return new RegExp(src || '(?!)', 'i');
    } catch {
      return /(?!)/;
    }
  };
  const articleRe = re(opts.articlePattern);
  const liveRe = re(opts.livePattern);
  const excludeRe = re(opts.excludePattern);
  const opinionRe = re(opts.opinionPattern);
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const fontOf = (el: Element) => parseFloat(getComputedStyle(el).fontSize) || 0;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const isNoise = (t: string) =>
    t.length < 25 ||
    /^by /i.test(t) ||
    /^\d+\s*(min|minute)s?\s*read$/i.test(t) ||
    /^(updated|published)\b/i.test(t) ||
    /^(listen|watch|video|audio|photo)/i.test(t);
  // Photo captions and credits sometimes sit inside article links.
  const isCaption = (t: string) =>
    /\b(credit|photograph|photo illustration|getty images|associated press|via reuters|for the new york times)\b/i.test(t) ||
    (/[.]$/.test(t) && t.split(' ').length > 16);
  const normalizeUrl = (href: string) => {
    try {
      const u = new URL(href, location.href);
      u.hash = '';
      u.search = '';
      return u.toString();
    } catch {
      return '';
    }
  };

  // Innermost text blocks inside an element.
  const textBlocks = (root: Element) => {
    const blocks: { el: Element; text: string; size: number }[] = [];
    root.querySelectorAll('h1,h2,h3,h4,h5,p,span,div').forEach((el) => {
      if (el.querySelector('h1,h2,h3,h4,h5,p,div')) return;
      const text = clean((el as HTMLElement).innerText);
      if (text.length >= 10) blocks.push({ el, text, size: fontOf(el) });
    });
    return blocks;
  };
  const LABEL_LIVE = /^(live|live updates|live coverage)$/i;
  const LABEL_BREAKING = /^(breaking|breaking news|just in)$/i;
  const LABEL_OPINION = /^(opinion|commentary|op-ed|editorial|guest essay|column|the big take: opinion)$/i;
  const COLUMNIST = /^[A-Z][\w.'’-]+(?: [A-Z][\w.'’-]+){1,3} \| /; // "Peggy Noonan | Headline"

  const root = document.querySelector('main') || document.body;
  const byUrl = new Map<string, any>();
  const order: string[] = [];

  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const url = normalizeUrl((a as HTMLAnchorElement).href);
    if (!url || !articleRe.test(url) || excludeRe.test(url)) continue;
    if (!visible(a)) continue;

    const wrappingHeading = a.closest('h1,h2,h3,h4');
    let headline = '';
    let size = 0;
    let inLinkDek = '';
    if (wrappingHeading) {
      headline = clean((wrappingHeading as HTMLElement).innerText);
      size = fontOf(wrappingHeading);
    } else {
      const blocks = textBlocks(a).filter((b) => !isCaption(b.text));
      if (blocks.length === 0) {
        headline = clean((a as HTMLElement).innerText);
        size = fontOf(a);
      } else {
        const best = blocks.reduce((m, b) => (b.size > m.size ? b : m), blocks[0]);
        headline = best.text;
        size = best.size;
        const other = blocks.find((b) => b !== best && b.text !== best.text && !isNoise(b.text));
        if (other) inLinkDek = other.text;
      }
    }
    if (headline.length < 15 || isCaption(headline)) continue;
    if (/^(live|watch|listen)\b/i.test(headline) && headline.length < 25) continue;

    // The story "card": climb while the ancestor only links to this one article.
    let card: Element = a;
    for (let i = 0; i < 6 && card.parentElement; i++) {
      const parent: Element = card.parentElement;
      const urls = new Set(
        Array.from(parent.querySelectorAll('a[href]'))
          .map((x) => normalizeUrl((x as HTMLAnchorElement).href))
          .filter((u) => articleRe.test(u))
      );
      if (urls.size > 1) break;
      card = parent;
    }

    let dek = inLinkDek;
    if (!dek) {
      const blocks = textBlocks(card).filter(
        (b) => b.text !== headline && !headline.includes(b.text) && !isNoise(b.text) && !isCaption(b.text) && b.size <= size
      );
      if (blocks[0]) dek = blocks[0].text;
    }

    // Short labels in the card ("LIVE", "Opinion", "Breaking").
    const labels = Array.from(card.querySelectorAll('span,div,p,a'))
      .map((el) => clean((el as HTMLElement).innerText))
      .filter((t) => t.length > 0 && t.length < 30);
    const live = liveRe.test(url) || labels.some((t) => LABEL_LIVE.test(t));
    const breaking = labels.some((t) => LABEL_BREAKING.test(t));
    const opinion = opinionRe.test(url) || COLUMNIST.test(headline) || /^opinion\s*[|:]/i.test(headline) || labels.some((t) => LABEL_OPINION.test(t));

    const existing = byUrl.get(url);
    if (existing) {
      // Same article linked twice (image + headline): keep the more prominent text.
      if (size > existing.fontSize) {
        existing.headline = headline;
        existing.fontSize = size;
      }
      if (!existing.dek && dek) existing.dek = dek;
      existing.live = existing.live || live;
      existing.breaking = existing.breaking || breaking;
      existing.opinion = existing.opinion || opinion;
      continue;
    }
    byUrl.set(url, { headline: headline.slice(0, 300), dek: dek.slice(0, 300), url, fontSize: size, live, breaking, opinion });
    order.push(url);
    if (order.length >= opts.maxHeadlines) break;
  }

  const headlines = order.map((u, i) => ({ ...byUrl.get(u), position: i + 1 }));

  // Sign-in state, judged from the page header only (footers often have a "Sign in" link too).
  const signInRe = re(opts.signInText);
  const accountRe = re(opts.accountText);
  const inHeader = (el: Element) => visible(el) && el.getBoundingClientRect().top < 260;
  const controls = Array.from(document.querySelectorAll('a, button')).slice(0, 600).filter(inHeader);
  const textOf = (el: Element) => clean((el as HTMLElement).innerText);
  const signIn = controls.find((el) => signInRe.test(textOf(el)));
  const account =
    opts.accountSelectors.map((s) => document.querySelector(s)).find((el) => el && visible(el)) ||
    controls.find((el) => accountRe.test(textOf(el)) || accountRe.test(el.getAttribute('aria-label') || ''));
  let login: { loggedIn: boolean | null; reason: string };
  if (account) login = { loggedIn: true, reason: 'found account menu' };
  else if (signIn) login = { loggedIn: false, reason: `found "${textOf(signIn)}" button` };
  // Signed-in pages often show your name instead of an "Account" label. If the page loaded
  // properly and nothing invites you to sign in, you're signed in.
  else if (headlines.length >= 8) login = { loggedIn: true, reason: 'no sign-in prompt on the page' };
  else login = { loggedIn: null, reason: 'page did not load enough to tell' };

  return { headlines, login };
}

/** First 1-2 meaningful paragraphs of an article page (for the digest preview). */
export function extractPreview(patterns: { ticker: string; boilerplate: string }) {
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const root = document.querySelector('article') || document.querySelector('main') || document.body;
  // Stock tickers inline in text ("NVDA -0.44% decrease; down pointing triangle").
  const tickers = new RegExp(patterns.ticker, 'g');
  const paywall = new RegExp(patterns.boilerplate, 'i');
  const paras = Array.from(root.querySelectorAll('p'))
    .filter((p) => !p.closest('figure, figcaption, aside, nav, header, footer, [role="complementary"]'))
    .map((p) => clean((p as HTMLElement).innerText).replace(tickers, ''))
    .filter((t) => t.length > 80 && !/^(advertisement|supported by|by )/i.test(t) && !/\bCredit\b/.test(t) && !paywall.test(t));
  return paras.slice(0, 2).join(' ').slice(0, 400);
}
