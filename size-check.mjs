// Web SDK paket boyutu denetimi: `size-budget.json`'daki her dosyanın gzip (-9) boyutu bütçeyi aşarsa çıkış kodu 1.
// Brotli boyutu bilgi amaçlı yazdırılır (CDN'ler çoğunlukla brotli sunar; bütçe daha kötümser olan gzip'tir).
import { existsSync, readFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const budget = JSON.parse(readFileSync(new URL('./size-budget.json', import.meta.url), 'utf8'));
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
let failed = false;

for (const [file, limit] of Object.entries(budget.files)) {
  const path = new URL(`./${file}`, import.meta.url);
  if (!existsSync(path)) {
    console.error(`✘ ${file}: bulunamadı (önce \`npm run build -w @pushizo/web\`)`);
    failed = true;
    continue;
  }
  const raw = readFileSync(path);
  const gz = gzipSync(raw, { level: 9 }).length;
  const br = brotliCompressSync(raw).length;
  const ok = gz <= limit;
  if (!ok) failed = true;
  const pct = Math.round((gz / limit) * 100);
  console.log(`${ok ? '✔' : '✘'} ${file}: ${kb(raw.length)} ham, ${kb(gz)} gzip, ${kb(br)} brotli — bütçe ${kb(limit)} (%${pct})`);
}

if (failed) {
  console.error('Web SDK paket boyutu bütçesi aşıldı (sdk/web/size-budget.json).');
  process.exit(1);
}
