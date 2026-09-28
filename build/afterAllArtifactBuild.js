// Called by electron-builder after every artifact (DMG, ZIP, blockmap) has
// been produced. We staple the notarization ticket onto each DMG so macOS
// can verify the container itself without unpacking it.
//
// The .app INSIDE each container was already stapled during the afterSign
// hook, so this DMG staple is belt-and-suspenders — it means users on the
// most locked-down setups (offline first launch, strict Gatekeeper) never
// need to phone home to Apple to verify the download.
//
// ZIPs can't be stapled (Apple's stapler doesn't support the format), but
// the stapled .app inside the ZIP is enough for electron-updater's flow.

const { execSync } = require('node:child_process');

exports.default = async function afterAllArtifactBuild(context) {
  const dmgs = (context.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  for (const dmg of dmgs) {
    console.log(`\n→ Stapling ${dmg}`);
    execSync(`xcrun stapler staple "${dmg}"`, { stdio: 'inherit' });
    console.log(`✓ ${dmg} stapled`);
  }
  // Return an empty array — no additional artifacts to register.
  return [];
};
