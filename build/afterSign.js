// Called by electron-builder after the .app bundle has been code-signed but
// before it's packaged into a DMG or ZIP. We submit the .app to Apple's
// notary service, wait for approval, and staple the ticket to the .app
// itself so both the DMG (which contains this .app) and the ZIP (used by
// electron-updater for auto-updates) ship a fully offline-verifiable bundle.
//
// Credentials come from the "RoutineTracker" notarytool keychain profile
// (registered once via `xcrun notarytool store-credentials` with a .p8 API
// key). No env vars, no passwords in shell history.

const path = require('node:path');
const { notarize } = require('@electron/notarize');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`\n→ Notarizing ${appPath}`);
  console.log('  (submitting to Apple; typically 2–5 minutes)');

  await notarize({
    tool: 'notarytool',
    appPath,
    keychainProfile: 'RoutineTracker',
  });

  console.log(`✓ ${appName}.app notarized and stapled`);
};
