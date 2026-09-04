const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const app = readJson('app.json').expo;
const profiles = readJson('eas.json').build;
const errors = [];

function requireValue(value, message) {
  if (!value) errors.push(message);
}

requireValue(app.ios?.bundleIdentifier, 'Missing iOS bundle identifier');
requireValue(app.ios?.buildNumber, 'Missing iOS build number');
requireValue(app.ios?.supportsTablet, 'iPad support must be enabled');
requireValue(app.android?.package, 'Missing Android package identifier');
requireValue(app.android?.versionCode, 'Missing Android version code');
requireValue(
  profiles.internal?.android?.buildType === 'apk',
  'Internal Android profile must produce an APK',
);
requireValue(
  profiles.store?.android?.buildType === 'app-bundle',
  'Store Android profile must produce an AAB',
);
requireValue(
  profiles.store?.distribution === 'store',
  'Store profile must use store distribution',
);
requireValue(
  profiles.development?.environment === 'development' &&
    profiles.internal?.environment === 'preview' &&
    profiles.store?.environment === 'production',
  'Build profiles must select their matching build environment',
);

const apiDomain = process.env.EXPO_PUBLIC_DOMAIN;
if (!apiDomain) {
  errors.push(
    'EXPO_PUBLIC_DOMAIN is required; set it to the HTTPS API host for this build environment',
  );
} else {
  try {
    const apiUrl = new URL(
      apiDomain.includes('://') ? apiDomain : `https://${apiDomain}`,
    );
    requireValue(
      apiUrl.protocol === 'https:' &&
        Boolean(apiUrl.hostname) &&
        apiUrl.hostname !== 'undefined' &&
        apiUrl.username === '' &&
        apiUrl.password === '' &&
        (apiUrl.pathname === '/' || apiUrl.pathname === ''),
      'EXPO_PUBLIC_DOMAIN must be a valid HTTPS host without credentials or a path',
    );
  } catch {
    errors.push('EXPO_PUBLIC_DOMAIN must be a valid HTTPS host');
  }
}

for (const asset of [
  app.icon,
  app.splash?.image,
  app.android?.adaptiveIcon?.foregroundImage,
  './assets/pdfjs/pdf.min.txt',
  './assets/pdfjs/pdf.worker.min.txt',
]) {
  requireValue(asset, 'A required release asset is not configured');
  if (asset && !fs.existsSync(path.resolve(root, asset))) {
    errors.push(`Missing release asset: ${asset}`);
  }
}

const iosTypes = app.ios?.infoPlist?.CFBundleDocumentTypes ?? [];
requireValue(
  iosTypes.some((type) =>
    type.LSItemContentTypes?.some((uti) =>
      ['com.adobe.pdf', 'public.pdf'].includes(uti),
    ),
  ),
  'iOS PDF document association is missing',
);
const androidFilters = app.android?.intentFilters ?? [];
requireValue(
  androidFilters.some((filter) =>
    filter.data?.some((item) => item.mimeType === 'application/pdf'),
  ),
  'Android PDF intent filter is missing',
);

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log(
  `Release configuration OK: ${app.ios.bundleIdentifier} / ${app.android.package} v${app.version} (${app.ios.buildNumber}/${app.android.versionCode}), API host configured`,
);