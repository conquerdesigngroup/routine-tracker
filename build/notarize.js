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

const KEYCHAIN_PROFILE = 'RoutineTracker';
const DIST = 'dist';

function run(cmd) {
  console.log('  $ ' + cmd);
  execSync(cmd, { stdio: 'inherit' });
}

// Scan dist/ for whatever DMGs electron-builder produced — works whether the
// target is arm64+x64, universal, or something new later without editing here.
const dmgs = fs.existsSync(DIST)
  ? fs.readdirSync(DIST).filter(f => f.endsWith('.dmg'))
  : [];

if (dmgs.length === 0) {
  console.error(`✗ No .dmg files found in ${DIST}/ — did electron-builder fail?`);
  process.exit(1);
}

for (const name of dmgs) {
  const dmg = path.join(DIST, name);
  console.log(`\n→ Notarizing ${dmg}`);
  run(`xcrun notarytool submit "${dmg}" --keychain-profile "${KEYCHAIN_PROFILE}" --wait`);
  console.log(`→ Stapling ${dmg}`);
  run(`xcrun stapler staple "${dmg}"`);
}

console.log(`\n✓ ${dmgs.length} DMG(s) notarized and stapled`);
