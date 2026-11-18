// Refreshes assets/theme-fixes.json: Dark Reader's community per-site fixes (MIT,
// https://github.com/darkreader/darkreader) for the built-in sources, plus the generic "*" fix.
// Usage: npm run build && node scripts/update-theme-fixes.js
const fs = require('fs');
const path = require('path');
const { PRESETS } = require('../dist/main/sources/presets');

const URL_ = 'https://raw.githubusercontent.com/darkreader/darkreader/main/src/config/dynamic-theme-fixes.config';
const SECTIONS = { INVERT: 'invert', CSS: 'css', 'IGNORE INLINE STYLE': 'ignoreInlineStyle', 'IGNORE IMAGE ANALYSIS': 'ignoreImageAnalysis' };

function parse(text) {
  const out = [];
  for (const block of text.split(/^={10,}\s*$/m)) {
    const lines = block.replace(/\r/g, '').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    const url = [];
    while (lines.length && lines[0].trim()) url.push(lines.shift().trim());
    if (!url.length) continue;
    const fix = { url, invert: [], css: '', ignoreInlineStyle: [], ignoreImageAnalysis: [] };
    let key = null;
    const css = [];
    for (const line of lines) {
      const t = line.trim();
      if (t in SECTIONS) { key = SECTIONS[t]; continue; }
      if (/^[A-Z][A-Z ]+$/.test(t)) { key = null; continue; } // sections the API doesn't support
      if (!key) continue;
      if (key === 'css') css.push(line);
      else if (t) fix[key].push(t);
    }
    fix.css = css.join('\n').trim();
    out.push(fix);
  }
  return out;
}

const hostMatches = (pattern, host) => {
  const p = pattern.replace(/^\*\./, '').replace(/\/.*$/, '');
  return p === host || host.endsWith('.' + p) || p.endsWith('.' + host);
};

(async () => {
  const text = await (await fetch(URL_)).text();
  const all = parse(text);
  const hosts = PRESETS.flatMap((s) => s.hosts);
  const keep = all.filter((f) => f.url.includes('*') || f.url.some((u) => hosts.some((h) => hostMatches(u, h))));
  const file = path.join(__dirname, '..', 'assets', 'theme-fixes.json');
  fs.writeFileSync(file, JSON.stringify(keep, null, 1) + '\n');
  console.log(`Kept ${keep.length} of ${all.length} fixes: ${keep.map((f) => f.url[0]).join(', ')}`);
})();
