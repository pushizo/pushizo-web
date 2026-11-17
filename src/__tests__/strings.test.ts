import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAMPAIGN_TEXT } from '../browser/web-campaign-render.js';
import { CHAT_TEXT } from '../chat-widget/widget.js';
import { SEARCH_TEXT } from '../search-widget/widget.js';
import { BUILTIN_STRINGS, SDK_LOCALES, fmt, loadSdkStrings, loadedSection, resetSdkStrings, resolveSdkLocale, sdkStrings } from '../core/strings.js';

// Paket tsconfig'i Node tiplerini içermez; Vitest (Node) çalışma zamanında modülleri ve __dirname'i sağlar.
declare const __dirname: string;
const fs = await vi.importActual<{ readFileSync(path: string, encoding: 'utf8'): string; readdirSync(path: string): string[] }>('node:fs');
const path = await vi.importActual<{ resolve(...parts: string[]): string; join(...parts: string[]): string }>('node:path');
const dir = path.resolve(__dirname, '../../i18n');
// Ortak dil tablosu (`packages/shared/src/locales.ts`) kaynağından okunur: SDK bağımsız paket, tiplere bağlanmaz.
const sharedLocales = [...fs.readFileSync(path.resolve(__dirname, '../../../../packages/shared/src/locales.ts'), 'utf8').matchAll(/\{ code: '([^']+)'/g)].map((m) => m[1]);
type Catalog = Record<string, Record<string, string>>;
const read = (code: string) => JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8')) as Catalog;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('web SDK metin kataloğu (ADR-0084)', () => {
  afterEach(() => resetSdkStrings());

  it('dil listesi ortak tabloyla aynı', () => {
    expect([...SDK_LOCALES]).toEqual(sharedLocales);
  });

  it('koddaki tr/en metinleri kaynak kataloglarla birebir eşit', () => {
    for (const l of ['tr', 'en'] as const) expect(read(l)).toEqual({ ...BUILTIN_STRINGS[l], campaign: CAMPAIGN_TEXT[l], chat: CHAT_TEXT[l], search: SEARCH_TEXT[l] });
  });

  it('22 dilin her biri: aynı bölüm/anahtar, aynı yer tutucular, boş değer yok', () => {
    const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json')).map((f: string) => f.slice(0, -5)).sort();
    expect(files).toEqual([...SDK_LOCALES].sort());
    const en = read('en');
    for (const code of SDK_LOCALES) {
      const cat = read(code);
      expect(Object.keys(cat).sort(), code).toEqual(Object.keys(en).sort());
      for (const [section, entries] of Object.entries(en)) {
        expect(Object.keys(cat[section]!).sort(), `${code}.${section}`).toEqual(Object.keys(entries).sort());
        for (const [key, value] of Object.entries(entries)) {
          const got = cat[section]![key]!;
          expect(typeof got === 'string' && got.trim().length > 0, `${code}.${section}.${key} boş`).toBe(true);
          expect(placeholders(got), `${code}.${section}.${key} yer tutucu`).toEqual(placeholders(value));
        }
      }
    }
  });

  it('dil etiketi eşleme ve biçimleme', () => {
    expect(resolveSdkLocale('de-AT')).toBe('de');
    expect(resolveSdkLocale('pt')).toBe('pt-BR');
    expect(resolveSdkLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveSdkLocale('zh-TW')).toBe('en');
    expect(resolveSdkLocale('fi')).toBe('en');
    expect(resolveSdkLocale(undefined)).toBe('en');
    expect(fmt('Kart {n}/{total} {x}', { n: 1, total: 3 })).toBe('Kart 1/3 {x}');
  });

  it('katalog yüklenene kadar İngilizce; yüklenince dil metinleri, ayrı paket bölümleri aktarılır', async () => {
    expect(sdkStrings('de-DE').prompt.accept).toBe('Allow');
    const de = read('de');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(de), { status: 200 })) as unknown as typeof fetch;
    await Promise.all([loadSdkStrings('https://api.test/', 'de-DE', fetchImpl), loadSdkStrings('https://api.test', 'de', fetchImpl)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe('https://api.test/sdk-web/i18n/de.json');
    expect(sdkStrings('de').prompt.accept).toBe(de.prompt!.accept);
    expect(loadedSection('de', 'chat')?.send).toBe(de.chat!.send);
    // tr/en için ağ isteği yok, ayrı paketler kendi metnini kullanır.
    await loadSdkStrings('https://api.test', 'tr', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(loadedSection('tr', 'chat')).toBeUndefined();
  });

  it('yükleme hatası İngilizcede bırakır', async () => {
    const failing = vi.fn(async () => new Response('x', { status: 404 })) as unknown as typeof fetch;
    await loadSdkStrings('https://api.test', 'ja', failing);
    expect(sdkStrings('ja').inApp.close).toBe('Close');
  });
});
