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
    // CommonJS tüketiciler (`require('@pushizo/web')`, eski paketleyiciler, Jest). `dist/cjs/package.json`
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
    outfile: 'dist/PushizoSDK.js',
    format: 'iife',
    bundle: true,
    minify: true,
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true,
    // Web kampanyası çizimi (ADR-0039) CDN derlemesinde ayrı pakettir (`PushizoWebCampaigns.js`, tembel yükleme).
    define: { ...define, __HS_LAZY_WC__: 'true' },
  },
  {
    entryPoints: ['src/web-campaigns-entry.ts'],
    outfile: 'dist/PushizoWebCampaigns.js',
    format: 'iife',
    bundle: true,
    minify: true,
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true,
    define,
  },
  {
    // Canlı sohbet widget'ı (ADR-0040): ana SDK'dan ayrı, `Pushizo.Chat.show()` ile tembel yüklenir.
    entryPoints: ['src/chat-widget/entry-iife.ts'],
    outfile: 'dist/PushizoChatWidget.js',
    format: 'iife',
    bundle: true,
    minify: true,
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true,
    define,
  },
  {
    // Paketleyiciler için widget (`@pushizo/web/chat-widget`; CSP'de harici betik istemeyenler).
    entryPoints: ['src/chat-widget/index.ts'],
    outfile: 'dist/chat-widget.js',
    format: 'esm',
    bundle: true,
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true,
    define,
  },
  {
    entryPoints: ['src/sw/worker.ts'],
    outfile: 'dist/PushizoSDKWorker.js',
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
