import type { SdkApi } from './api.js';

/**
 * Site içi arama (ADR-0093). İstemci ana pakettedir (başsız kullanım: `Pushizo.Search.query()`); hazır arama penceresi
 * ayrı pakettir (`PushizoSearch.js` / `@pushizo/web/search-widget`) ve `Pushizo.Search.open()` ile tembel yüklenir.
 * Ziyaretçi kimliği veya abonelik gönderilmez.
 */

export interface SearchResult {
  /** Belge kimliği. */
  id: string;
  url: string;
  title: string;
  /** Eşleşen bölümün başlığı (yoksa boş). */
  heading: string;
  /** Eşleşen bölümden düz metin kesit. */
  snippet: string;
  /** Aynı kesit, HTML kaçışlı; eşleşen sözcükler `<mark>` içinde. */
  snippet_html: string;
}

export interface SearchAnswer {
  text: string;
  sources: { id: string; url: string; title: string }[];
}

export interface SearchResponse {
  query_id: string;
  /** Sunulan mod: AI yanıtı verilemediyse `search`. */
  mode: 'search' | 'answer';
  results: SearchResult[];
  answer: SearchAnswer | null;
  /** `not_found`: sitenin içeriğinde yanıt yok. */
  answer_status: 'answered' | 'not_found' | null;
  /** App ayarında AI yanıtı açık mı. */
  answers_available: boolean;
}

export interface SearchQueryOptions {
  /** `answer`: sonuçlara ek olarak sitenin içeriğinden AI yanıtı istenir (verilemezse yalnız sonuçlar döner). */
  mode?: 'search' | 'answer';
  /** Sonuç sayısı (1–20; varsayılan 8). */
  limit?: number;
  /** Yanıt dili (varsayılan SDK dili). */
  language?: string;
}

export interface SearchDeps {
  api: () => SdkApi | null;
  language: () => string;
  fetch?: typeof fetch;
}

export class SearchClient {
  constructor(private readonly deps: SearchDeps) {}

  private api(): SdkApi {
    const api = this.deps.api();
    if (!api) throw new Error('Pushizo.init önce çağrılmalı.');
    return api;
  }

  /** Arama (ve istenirse AI yanıtı). Sorgu 2–200 karakter olmalıdır. */
  query(text: string, options: SearchQueryOptions = {}): Promise<SearchResponse> {
    const body: Record<string, unknown> = { query: text.trim(), mode: options.mode ?? 'search', language: options.language ?? this.deps.language() };
    if (options.limit !== undefined) body.limit = options.limit;
    return this.api().request<SearchResponse>('POST', '/search', body);
  }

  /**
   * Tıklanan sonucu bildirir (rapor: tıklama oranı). Sayfa değişirken de gitsin diye `keepalive` ile gönderilir; hata
   * yutulur (ölçüm, kullanıcı akışını etkilemez).
   */
  trackClick(queryId: string, url: string, position?: number): Promise<void> {
    const api = this.deps.api();
    if (!api || !queryId) return Promise.resolve();
    const send = this.deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    return send(`${api.appBase}/search/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query_id: queryId, type: 'click', url, ...(position ? { position } : {}) }),
      credentials: 'omit',
      keepalive: true,
    }).then(
      () => undefined,
      () => undefined,
    );
  }
}

// ---------------------------------------------------------------- pencere sözleşmesi

/** Arama penceresi seçenekleri (`Pushizo.Search.open` / `attach`). */
export interface SearchWidgetOptions {
  /** Pencere paketinin adresi; varsayılan `<api>/sdk-web/PushizoSearch.js`. */
  widgetUrl?: string;
  /** CSP `script-src` nonce'u (tembel yüklenen pencere betiği için). */
  nonce?: string;
  /** Paketi betik etiketi yerine doğrudan vermek için (`import { mountSearchWidget } from '@pushizo/web/search-widget'`). */
  mount?: SearchWidgetModule['mount'];
  /** "Soru sor" (AI yanıtı) seçeneği: verilmezse app ayarına göre gösterilir. */
  answers?: boolean;
  placeholder?: string;
  /** Vurgu rengi (`#rrggbb`). */
  color?: string;
  theme?: 'light' | 'dark' | 'auto';
  /** Sonuç yeni sekmede açılsın. */
  newTab?: boolean;
  /** Ctrl/⌘+K ile açılsın. */
  hotkey?: boolean;
  /** Açılışta doldurulacak sorgu. */
  query?: string;
  /** Sonuç seçildiğinde; `false` dönerse SDK sayfaya gitmez (tek sayfa uygulamalarında yönlendirmeyi site yapar). */
  onSelect?: (result: { url: string; title: string }) => boolean | void;
  /** Pencerenin ekleneceği öğe (varsayılan `document.body`). */
  container?: HTMLElement;
}

export interface SearchWidgetHandle {
  open(query?: string): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

export interface SearchWidgetMountOptions extends SearchWidgetOptions {
  language: string;
  dir: 'ltr' | 'rtl';
  /** tr/en dışındaki dilin metinleri (ADR-0084; SDK yüklediği katalogdan aktarır). */
  strings?: Record<string, string>;
}

export interface SearchWidgetModule {
  mount(client: SearchClient, options: SearchWidgetMountOptions): SearchWidgetHandle;
}

/** Pencere betiğini tembel yükler (`window.PushizoSearchWidget`); aynı sayfada tek yükleme. */
export function loadSearchWidget(url: string, nonce?: string): Promise<SearchWidgetModule> {
  const w = globalThis as unknown as { PushizoSearchWidget?: SearchWidgetModule; __hsSearchWidgetLoad?: Promise<SearchWidgetModule> };
  if (w.PushizoSearchWidget) return Promise.resolve(w.PushizoSearchWidget);
  if (w.__hsSearchWidgetLoad) return w.__hsSearchWidgetLoad;
  w.__hsSearchWidgetLoad = new Promise<SearchWidgetModule>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.crossOrigin = 'anonymous';
    if (nonce) script.nonce = nonce;
    script.onload = () => (w.PushizoSearchWidget ? resolve(w.PushizoSearchWidget) : reject(new Error('Arama penceresi paketi yüklenemedi.')));
    script.onerror = () => {
      w.__hsSearchWidgetLoad = undefined;
      reject(new Error(`Arama penceresi paketi yüklenemedi: ${url}`));
    };
    document.head.appendChild(script);
  });
  return w.__hsSearchWidgetLoad;
}
