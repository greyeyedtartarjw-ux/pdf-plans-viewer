import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const viewerRoot = resolve(import.meta.dirname, '..');
const buildEnv = { ...process.env };

delete buildEnv.PORT;
delete buildEnv.BASE_PATH;

const build = spawnSync('pnpm', ['run', 'build'], {
  cwd: viewerRoot,
  env: buildEnv,
  stdio: 'inherit',
});

if (build.error) {
  throw build.error;
}

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const indexPath = resolve(viewerRoot, 'dist/public/index.html');
const indexHtml = readFileSync(indexPath, 'utf8');
const localAssetUrls = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map(([, url]) => url)
  .filter((url) => !/^(?:[a-z][a-z\d+.-]*:|\/\/|data:|#)/i.test(url));

if (localAssetUrls.length === 0) {
  throw new Error(`No local asset URLs found in ${indexPath}`);
}

const nonRootAssetUrls = localAssetUrls.filter((url) => !url.startsWith('/'));

if (nonRootAssetUrls.length > 0) {
  throw new Error(
    `Release artifact contains non-root asset URLs: ${nonRootAssetUrls.join(', ')}`,
  );
}

if (!localAssetUrls.some((url) => url.startsWith('/assets/'))) {
  throw new Error(`No root-path /assets/ URL found in ${indexPath}`);
}

console.log(
  `Release build check passed: ${localAssetUrls.length} local asset URL(s) use root paths.`,
);