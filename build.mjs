// Web SDK paketleme: ESM ve CommonJS kütüphane, IIFE (CDN/script etiketi) ve service worker bundle'ı.
import { build, context } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const watch = process.argv.includes('--watch');
const define = { __HS_SDK_VERSION__: JSON.stringify(pkg.version) };

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    format: 'esm',
    bundle: true,
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true,
    define,
  },
  {
    // CommonJS tüketiciler (`require('@herosignal/web')`, eski paketleyiciler, Jest). `dist/cjs/package.json`
    // `type: commonjs` olduğundan aynı dizindeki `.d.ts` dosyaları da CommonJS olarak çözülür.
    entryPoints: ['src/index.ts'],
    outfile: 'dist/cjs/index.cjs',
    format: 'cjs',
    bundle: true,
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true,
    define,
  },
  {
    entryPoints: ['src/entry-iife.ts'],
    outfile: 'dist/HeroSignalSDK.js',
    format: 'iife',
    bundle: true,
    minify: true,
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true,
    define,
  },
  {
    entryPoints: ['src/sw/worker.ts'],
    outfile: 'dist/HeroSignalSDKWorker.js',
    format: 'iife',
    bundle: true,
    minify: true,
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true,
    define,
  },
];

if (watch) {
  for (const t of targets) {
    const ctx = await context(t);
    await ctx.watch();
  }
  console.log('[sdk-web] izleniyor…');
} else {
  for (const t of targets) await build(t);
  mkdirSync('dist/cjs', { recursive: true });
  writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
  console.log('[sdk-web] dist hazır');
}
