// Called by electron-builder after every artifact (DMG, ZIP, blockmap,
// latest-mac.yml) has been produced. For each DMG we submit it to Apple's
// notary service for its own ticket, then staple that ticket onto the DMG
// file. Combined with the .app-staple that afterSign.js already produced,
// this gives us fully offline-verifiable artifacts at every level:
//
//   - .app inside → stapled via afterSign     → offline-clean launch
//   - .dmg container → stapled here           → offline-clean download check
//   - .zip container → not stapleable, but    → offline-clean auto-update
//     the .app inside it is already stapled
//
// ZIPs can't be stapled (Apple's stapler doesn't accept the format), but
// their internal .app payload is already stapled from afterSign, which is
// what electron-updater actually needs.
//
// Any failure here is caught and logged as a warning rather than thrown —
// a DMG that fails Apple's per-container notarization still ships with a
// stapled .app inside, so users are covered by the primary notarization.
// Failing the whole build over the belt-and-suspenders DMG staple would
// also lose latest-mac.yml (electron-builder writes it AFTER this hook is
// supposed to succeed), which would break auto-updates.

const { execSync } = require('node:child_process');

const KEYCHAIN_PROFILE = 'RoutineTracker';

function run(cmd) {
  console.log('  $ ' + cmd);
  execSync(cmd, { stdio: 'inherit' });
}

exports.default = async function afterAllArtifactBuild(context) {
  const dmgs = (context.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  for (const dmg of dmgs) {
    try {
      console.log(`\n→ Notarizing ${dmg} (container-level, ~2 min)`);
      run(`xcrun notarytool submit "${dmg}" --keychain-profile "${KEYCHAIN_PROFILE}" --wait`);
      console.log(`→ Stapling ${dmg}`);
      run(`xcrun stapler staple "${dmg}"`);
      console.log(`✓ ${dmg} notarized and stapled`);
    } catch (err) {
      console.warn(`⚠ DMG container-level notarization/staple failed for ${dmg}:`);
      console.warn(`  ${err.message || err}`);
      console.warn(`  (The .app inside is still stapled — install still works.)`);
    }
  }
  return [];
};
