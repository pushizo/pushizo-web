/**
 * HTML in-app mesajı sandbox'ı ve `PushizoBridge` köprü protokolü (ADR-0027). Web SDK bağımsız paket olduğundan
 * bu dosya `packages/shared/src/html-in-app.ts` ile aynı mantığın kopyasıdır (dashboard önizlemesi aynı belgeyi
 * kullanır); iki kopyanın aynı çıktıyı ürettiği `packages/shared/src/__tests__/html-in-app.test.ts` ile doğrulanır.
 *
 * Güvenlik modeli temizleme değil yalıtımdır: `sandbox="allow-scripts"` (allow-same-origin YOK), CSP meta etiketi
 * (ağ isteği yok, yalnızca https/data görsel) ve yalnızca şeması doğrulanan `postMessage` eylemleri.
 */

/** iframe `sandbox` özniteliği: yalnızca betik; aynı köken, üst gezinme, açılır pencere, form YOK. */
export const HTML_IN_APP_SANDBOX = 'allow-scripts';

/** iframe içindeki belgeye eklenen içerik güvenliği politikası. */
export const HTML_IN_APP_CSP =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** Köprü mesajlarının işareti ve sürümü. */
export const HTML_BRIDGE_MARK = 'pushizo-bridge';
export const HTML_BRIDGE_VERSION = 1;

/** HTML in-app içeriği üst sınırı (karakter). */
export const HTML_IN_APP_MAX_LENGTH = 100_000;

export type HtmlBridgeAction =
  | { type: 'ready' }
  | { type: 'close' }
  | { type: 'click'; actionId: string; url?: string }
  | { type: 'add_tag'; key: string; value: string }
  | { type: 'track_event'; name: string; props: Record<string, string | number | boolean | null> }
  | { type: 'resize'; height: number };

const ACTION_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const TAG_KEY = /^[^\s]{1,128}$/;
const MAX_PROPS = 20;

/** Köprüden gelen URL: http(s) veya uygulama şeması (`myapp://`); javascript:/data:/file: reddedilir. */
export function safeBridgeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  const scheme = v.slice(0, v.indexOf(':')).toLowerCase();
  if (['javascript', 'data', 'vbscript', 'file', 'blob', 'about'].includes(scheme)) return null;
  if (scheme === 'http' || scheme === 'https') return /^https?:\/\/[^\s/]+/i.test(v) ? v : null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * iframe'den gelen `postMessage` verisini doğrular (kaynak penceresi ayrıca çağıran tarafından denetlenmelidir).
 * Geçersiz, başka nonce'lu veya bilinmeyen mesaj → null.
 */
export function parseBridgeMessage(data: unknown, nonce: string): HtmlBridgeAction | null {
  if (!isRecord(data) || data.hs !== HTML_BRIDGE_MARK || data.v !== HTML_BRIDGE_VERSION || data.nonce !== nonce) return null;
  switch (data.type) {
    case 'ready':
      return { type: 'ready' };
    case 'close':
      return { type: 'close' };
    case 'click': {
      if (typeof data.action_id !== 'string' || !ACTION_ID.test(data.action_id)) return null;
      if (data.url === undefined || data.url === null || data.url === '') return { type: 'click', actionId: data.action_id };
      const url = safeBridgeUrl(data.url);
      return url ? { type: 'click', actionId: data.action_id, url } : { type: 'click', actionId: data.action_id };
    }
    case 'add_tag': {
      if (typeof data.key !== 'string' || !TAG_KEY.test(data.key)) return null;
      if (typeof data.value !== 'string' || data.value.length > 255) return null;
      return { type: 'add_tag', key: data.key, value: data.value };
    }
    case 'track_event': {
      if (typeof data.name !== 'string') return null;
      const name = data.name.trim();
      if (!name || name.length > 100) return null;
      const props: Record<string, string | number | boolean | null> = {};
      if (data.props !== undefined && data.props !== null) {
        if (!isRecord(data.props)) return null;
        const entries = Object.entries(data.props);
        if (entries.length > MAX_PROPS) return null;
        for (const [k, v] of entries) {
          if (!k || k.length > 64) return null;
          if (typeof v === 'string') props[k] = v.slice(0, 255);
          else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || v === null) props[k] = v;
          else return null;
        }
      }
      return { type: 'track_event', name, props };
    }
    case 'resize': {
      const h = data.height;
      if (typeof h !== 'number' || !Number.isFinite(h) || h < 1) return null;
      return { type: 'resize', height: Math.min(Math.ceil(h), 5000) };
    }
    default:
      return null;
  }
}

/** Nonce'u yalnızca güvenli karakterlerle sınırlar (betik içine gömülür). */
function cleanNonce(nonce: string): string {
  const n = nonce.replace(/[^A-Za-z0-9_-]/g, '');
  if (n.length < 8) throw new Error('Köprü nonce değeri en az 8 güvenli karakter olmalı.');
  return n.slice(0, 64);
}

/**
 * iframe içinde çalışan köprü betiği. `PushizoBridge` değiştirilemez nesnedir; bağlantı tıklamaları iframe'i
 * gezdirmek yerine `click('link', href)` olur; `data-hs-close` öğeleri kapatır, `data-hs-action="kimlik"` öğeleri
 * tıklama bildirir. Yükseklik değişimleri (banner/modal için) `resize` ile bildirilir.
 */
export function htmlBridgeScript(nonce: string): string {
  const n = cleanNonce(nonce);
  return (
    '(function(){"use strict";var N="' +
    n +
    '",P=window.parent;' +
    'function s(m){m.hs="' +
    HTML_BRIDGE_MARK +
    '";m.v=' +
    HTML_BRIDGE_VERSION +
    ';m.nonce=N;try{P.postMessage(m,"*")}catch(e){}}' +
    'function t(v,x){return typeof v==="string"?v.slice(0,x):""}' +
    'var B=Object.freeze({' +
    'close:function(){s({type:"close"})},' +
    'click:function(a,u){s({type:"click",action_id:t(a,64)||"html",url:typeof u==="string"?u.slice(0,2000):undefined})},' +
    'addTag:function(k,v){s({type:"add_tag",key:t(k,128),value:String(v==null?"":v).slice(0,255)})},' +
    'trackEvent:function(n,p){var o={};try{o=JSON.parse(JSON.stringify(p||{}))}catch(e){}s({type:"track_event",name:t(n,100),props:o})}' +
    '});' +
    'try{Object.defineProperty(window,"PushizoBridge",{value:B,writable:false,configurable:false})}catch(e){}' +
    'document.addEventListener("click",function(e){var el=e.target;if(!el||!el.closest)return;' +
    'var c=el.closest("[data-hs-close]");if(c){e.preventDefault();B.close();return}' +
    'var a=el.closest("[data-hs-action]");var l=el.closest("a[href]");' +
    'if(a){e.preventDefault();B.click(a.getAttribute("data-hs-action"),(l||a).getAttribute("href")||a.getAttribute("data-hs-url")||undefined);return}' +
    'if(l){e.preventDefault();B.click("link",l.getAttribute("href"))}},true);' +
    'document.addEventListener("submit",function(e){e.preventDefault()},true);' +
    'var H=0;function r(){var h=Math.ceil(document.documentElement.scrollHeight||0);if(h&&h!==H){H=h;s({type:"resize",height:h})}}' +
    'window.addEventListener("load",function(){s({type:"ready"});r()});' +
    'if(typeof ResizeObserver==="function"){try{new ResizeObserver(r).observe(document.documentElement)}catch(e){}}' +
    '})();'
  );
}

export interface HtmlInAppDocumentOptions {
  nonce: string;
  /** `<html lang>` (erişilebilirlik). */
  language?: string;
  /** Önizleme: `prefers-color-scheme` simülasyonu için `color-scheme` değeri. */
  colorScheme?: 'light' | 'dark' | 'light dark';
}

/**
 * Sandbox'lı iframe'in `srcdoc` belgesi: CSP meta etiketi en başta (kullanıcı HTML'inden önce), ardından köprü betiği
 * ve kullanıcı HTML'i. Kullanıcı HTML'i tam belge ise (`<html>`) gövdesi ayıklanmadan olduğu gibi `<body>` içine
 * konur; tarayıcı ikinci `<html>/<head>` etiketlerini yok sayar, CSP ilk meta ile zaten yürürlüktedir.
 */
export function buildHtmlInAppDocument(html: string, options: HtmlInAppDocumentOptions): string {
  const lang = (options.language ?? 'en').replace(/[^A-Za-z0-9-]/g, '').slice(0, 10) || 'en';
  const scheme = options.colorScheme ?? 'light dark';
  return (
    '<!doctype html><html lang="' +
    lang +
    '"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
    HTML_IN_APP_CSP +
    '">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="' +
    scheme +
    '">' +
    '<meta name="referrer" content="no-referrer">' +
    '<style>html,body{margin:0;padding:0}body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}</style>' +
    '<script>' +
    htmlBridgeScript(options.nonce) +
    '</script></head><body>' +
    html.slice(0, HTML_IN_APP_MAX_LENGTH) +
    '</body></html>'
  );
}
