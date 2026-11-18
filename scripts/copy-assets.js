// Copies non-TypeScript renderer files (HTML/CSS) into dist/ after tsc runs.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'src', 'renderer');
const out = path.join(__dirname, '..', 'dist', 'renderer');
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (f.endsWith('.html') || f.endsWith('.css')) fs.copyFileSync(path.join(src, f), path.join(out, f));
}

// Bundle Dark Reader with the theme preload. Session preloads run sandboxed and can't require
// node_modules, so both go into one file; Dark Reader's UMD wrapper gets a local `module`.
const main = path.join(__dirname, '..', 'dist', 'main');
let darkReader = fs.readFileSync(require.resolve('darkreader/darkreader.js'), 'utf8');

// Dark Reader keeps the hue of any light background whose HSL saturation is 12% or more. Pale
// "paper" tints (the FT's #fff1e5, cream and wheat panels) have high HSL saturation despite being
// nearly white, so they turned into muddy browns. Treat light colors with little chroma as
// neutral, so they take the theme's own background color instead.
// Same rule for the light flavor (Latte), which has its own mapping.
const PALE_TINT = '(l > 0.82 && s * (1 - Math.abs(2 * l - 1)) < 0.16)';
for (const [find, replace] of [
  ['const isNeutral = s < 0.12 || (l > 0.8 && isBlue);', `const isNeutral = s < 0.12 || (l > 0.8 && isBlue) || ${PALE_TINT};`],
  ['isNeutral = s < 0.24 || (l > 0.8 && isBlue);', `isNeutral = s < 0.24 || (l > 0.8 && isBlue) || ${PALE_TINT};`],
]) {
  const parts = darkReader.split(find);
  if (parts.length !== 2) throw new Error('copy-assets: Dark Reader changed; review the paper-tint patch');
  darkReader = parts.join(replace);
}
const glue = fs.readFileSync(path.join(main, 'themePreload.js'), 'utf8');
fs.writeFileSync(
  path.join(main, 'theme-preload.js'),
  `const DarkReader = (function () { var module = { exports: {} }; var exports = module.exports; var define;\n${darkReader}\nreturn module.exports; })();\n${glue}`,
);
