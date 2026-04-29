/* eslint-disable @typescript-eslint/no-require-imports */

// Copy runtime asset files (e.g. the Supabase root CA cert) from
// infrastructure/assets/ into a freshly bundled Lambda outputDir,
// called from LambdaApiConstruct.bundling.commandHooks.afterBundling.
//
// Usage:  node copy-runtime-assets.cjs <outputDir>
//
// Files copied:
//   - infrastructure/assets/supabase-ca.crt → <outputDir>/supabase-ca.crt
//
// Fails fast (exit 1) if a source file is missing or the destination
// ends up empty after copy — both are signs the bundle is broken and
// the Lambda would fail at TLS handshake time anyway.

const fs = require('node:fs');
const path = require('node:path');

const outputDir = process.argv[2];
if (!outputDir) {
  console.error('copy-runtime-assets.cjs: missing outputDir argument');
  process.exit(1);
}

const assetsDir = path.resolve(__dirname, '..', 'assets');

const assets = [{ src: 'supabase-ca.crt', dest: 'supabase-ca.crt' }];

for (const { src, dest } of assets) {
  const srcPath = path.join(assetsDir, src);
  const destPath = path.join(outputDir, dest);

  if (!fs.existsSync(srcPath)) {
    console.error(`copy-runtime-assets.cjs: source not found: ${srcPath}`);
    process.exit(1);
  }

  fs.copyFileSync(srcPath, destPath);

  const stat = fs.statSync(destPath);
  if (stat.size === 0) {
    console.error(`copy-runtime-assets.cjs: destination empty after copy: ${destPath}`);
    process.exit(1);
  }

  console.log(
    `copy-runtime-assets.cjs: ${src} (${stat.size} bytes) → ${path.relative(process.cwd(), destPath)}`,
  );
}
