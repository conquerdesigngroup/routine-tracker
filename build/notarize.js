// Post-build notarization for the macOS DMGs.
//
// electron-builder v25's schema doesn't expose `keychainProfile` for
// `mac.notarize`, so we route around it: electron-builder produces signed
// DMGs (with `mac.notarize: false`), and this script submits them to Apple's
// notary service via `xcrun notarytool` using the credentials stored in the
// "RoutineTracker" keychain profile (set up once via
// `xcrun notarytool store-credentials "RoutineTracker"`).
//
// Each DMG is submitted, waited on, and then stapled so the notarization
// ticket is embedded in the artifact for offline Gatekeeper checks.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const version = pkg.version;
const KEYCHAIN_PROFILE = 'RoutineTracker';
const ARCHES = ['arm64', 'x64'];

function run(cmd) {
  console.log('  $ ' + cmd);
  execSync(cmd, { stdio: 'inherit' });
}

for (const arch of ARCHES) {
  const dmg = path.join('dist', `Routine-Tracker-${version}-${arch}.dmg`);
  if (!fs.existsSync(dmg)) {
    console.error(`✗ ${dmg} not found — did electron-builder fail?`);
    process.exit(1);
  }
  console.log(`\n→ Notarizing ${dmg}`);
  run(`xcrun notarytool submit "${dmg}" --keychain-profile "${KEYCHAIN_PROFILE}" --wait`);
  console.log(`→ Stapling ${dmg}`);
  run(`xcrun stapler staple "${dmg}"`);
}

console.log('\n✓ All DMGs notarized and stapled');
