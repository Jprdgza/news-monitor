// Re-signs the packaged app with a local code-signing certificate, if you have one.
//
// Why: sign-in cookies are encrypted with a key kept in the macOS Keychain, and the Keychain
// only hands that key to "the same app". An ad-hoc signature changes with every build, so each
// update would ask for Keychain access again. A self-signed certificate gives every build the
// same identity. Without one, the app keeps electron-builder's ad-hoc signature.
//
// Create the certificate once with Keychain Access → Certificate Assistant → Create a
// Certificate…, name "News Monitor Local Signing", type "Code Signing".
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NAME = process.env.NEWS_MONITOR_SIGNING_IDENTITY || 'News Monitor Local Signing';

function identity() {
  try {
    const out = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.includes(`"${NAME}"`));
    return line ? line.trim().split(/\s+/)[1] : null;
  } catch {
    return null;
  }
}

function signApp(app) {
  const id = identity();
  if (!id) {
    console.log(`sign-local: no "${NAME}" certificate; keeping the ad-hoc signature.`);
    return;
  }
  const sign = (target, deep) =>
    execFileSync('codesign', ['--force', ...(deep ? ['--deep'] : []), '--timestamp=none', '--sign', id, target], { stdio: 'inherit' });
  // Inside-out: helpers and frameworks first, then the app itself.
  const frameworks = path.join(app, 'Contents', 'Frameworks');
  for (const item of fs.readdirSync(frameworks)) sign(path.join(frameworks, item), true);
  sign(app, false);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`sign-local: signed ${path.basename(app)} with "${NAME}"`);
}

// electron-builder `afterSign` hook: runs after packaging and before the DMG/zip is made.
exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  signApp(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
};

// Or run directly on an already-packaged app: node scripts/sign-local.js [path/to/App.app]
if (require.main === module) {
  signApp(process.argv[2] || path.join(__dirname, '..', 'release', `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, 'News Monitor.app'));
}
