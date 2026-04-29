/* eslint-disable @typescript-eslint/no-require-imports */

// Strip Prisma 7 dev tooling and non-Postgres WASM compilers from a
// freshly bundled Lambda asset, called from
// LambdaApiConstruct.bundling.commandHooks.afterBundling.
//
// Usage:  node strip-prisma-bloat.cjs <outputDir>
//
// Targets removed:
//   - node_modules/@prisma/studio-core/  (~38 MB, dev UI)
//   - node_modules/@prisma/dev/          (~16 MB, dev tools)
//   - node_modules/@prisma/client/runtime/query_compiler_(fast|small)_bg.{cockroachdb,mysql,sqlite,sqlserver}.*
//
// Silent on missing files so future Prisma layout changes don't break
// the deploy.

const fs = require('node:fs');
const path = require('node:path');

const outputDir = process.argv[2];
if (!outputDir) {
  console.error('strip-prisma-bloat.cjs: missing outputDir argument');
  process.exit(1);
}

function rmdirSafe(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* ignore: ok if folder does not exist */
  }
}

const prismaDir = path.join(outputDir, 'node_modules', '@prisma');
rmdirSafe(path.join(prismaDir, 'studio-core'));
rmdirSafe(path.join(prismaDir, 'dev'));

const runtimeDir = path.join(prismaDir, 'client', 'runtime');
const wasmDropPattern = /^query_compiler_(fast|small)_bg\.(cockroachdb|mysql|sqlite|sqlserver)\./;

try {
  for (const entry of fs.readdirSync(runtimeDir)) {
    if (wasmDropPattern.test(entry)) {
      try {
        fs.unlinkSync(path.join(runtimeDir, entry));
      } catch {
        /* ignore: file already gone */
      }
    }
  }
} catch {
  /* ignore: runtime dir does not exist */
}
