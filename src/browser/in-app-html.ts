import { HTML_IN_APP_SANDBOX, buildHtmlInAppDocument, parseBridgeMessage, type HtmlBridgeAction } from '../core/html-bridge.js';

export interface HtmlFrameOptions {
  html: string;
  language: string;
  /** Erişilebilir ad (iframe `title`). */
  title: string;
  /** Başlangıç yüksekliği (px); `null` ise kapsayıcıyı doldurur (tam ekran). */
  height: number | null;
  /** Yükseklik sınırı (px); banner/modal ekranın %90'ını aşmaz. */
  maxHeight?: number;
  /** Doğrulanmış köprü eylemi. */
  onAction: (action: Exclude<HtmlBridgeAction, { type: 'ready' | 'resize' }>) => void;
  /** iframe kendi içinde gezinmeye çalıştı (bağlantı, `location`, meta refresh): mesaj kapatılmalı. */
  onNavigationAttempt: () => void;
  doc?: Document;
  /** Testler için (varsayılan: kriptografik rastgele). */
  nonce?: string;
}

export interface HtmlFrame {
  iframe: HTMLIFrameElement;
  nonce: string;
  destroy: () => void;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * HTML in-app içeriğini sandbox'lı iframe'de çizer (ADR-0027):
 * - `sandbox="allow-scripts"` (allow-same-origin YOK): opak köken; üst belgenin DOM'u, çerezleri ve depolaması
 *   erişilemez, üst pencere yönlendirilemez, açılır pencere/form yok.
 * - `srcdoc` belgesinin başında CSP meta etiketi: fetch/XHR/WebSocket ve dış betik/stil yok; yalnızca https/data görsel.
 * - Köprü mesajı yalnızca bu iframe'in penceresinden (`event.source`) ve bu gösterime özgü nonce ile kabul edilir;
 *   şema doğrulanır (`parseBridgeMessage`).
 * - İlk yüklemeden sonraki her `load` olayı iframe'in kendi içinde gezindiği anlamına gelir (CSP gezinmeyi
 *   engellemez): içerik dış bir sayfaya gidemesin diye mesaj kapatılır.
 */
export function renderHtmlFrame(options: HtmlFrameOptions): HtmlFrame {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  const nonce = options.nonce ?? randomNonce();
  const iframe = doc.createElement('iframe');
  iframe.setAttribute('sandbox', HTML_IN_APP_SANDBOX);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  // İzin politikası: kamera, mikrofon, konum vb. hiçbir güçlü özellik devredilmez.
  iframe.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; clipboard-read 'none'; clipboard-write 'none'");
  iframe.setAttribute('loading', 'eager');
  iframe.title = options.title;
  iframe.className = 'hs-html-frame';
  const maxHeight = options.maxHeight ?? Math.floor((win.innerHeight || 800) * 0.9);
  const applyHeight = (h: number) => {
    iframe.style.height = `${Math.max(40, Math.min(h, maxHeight))}px`;
  };
  if (options.height !== null) applyHeight(options.height);
  iframe.srcdoc = buildHtmlInAppDocument(options.html, { nonce, language: options.language });

  let loads = 0;
  let destroyed = false;
  const onLoad = (): void => {
    loads += 1;
    if (loads > 1 && !destroyed) options.onNavigationAttempt();
  };
  const onMessage = (event: MessageEvent): void => {
    // Kaynak yalnızca bu iframe'in penceresi olabilir (bağlı değilse `contentWindow` null; null kaynak reddedilir).
    if (destroyed || !iframe.contentWindow || event.source !== iframe.contentWindow) return;
    const action = parseBridgeMessage(event.data, nonce);
    if (!action || action.type === 'ready') return;
    if (action.type === 'resize') {
      if (options.height !== null) applyHeight(action.height);
      return;
    }
    options.onAction(action);
  };
  iframe.addEventListener('load', onLoad);
  win.addEventListener('message', onMessage);
  return {
    iframe,
    nonce,
    destroy: () => {
      destroyed = true;
      iframe.removeEventListener('load', onLoad);
      win.removeEventListener('message', onMessage);
    },
  };
}
