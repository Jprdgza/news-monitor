// Copies non-TypeScript renderer files (HTML/CSS) into dist/ after tsc runs.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'src', 'renderer');
const out = path.join(__dirname, '..', 'dist', 'renderer');
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (f.endsWith('.html') || f.endsWith('.css')) fs.copyFileSync(path.join(src, f), path.join(out, f));
}
