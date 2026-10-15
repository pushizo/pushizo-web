import type { Logger } from './logger.js';
import type {
  Channel,
  ContactChannel,
  DeviceInfo,
  InAppMessage,
  PreferenceCategory,
  PreferenceInput,
  SlidedownCollect,
  UserPreference,
  UserPreferences,
} from './types.js';

export interface ApiOptions {
  baseUrl: string;
  appId: string;
  fetch?: typeof fetch;
  logger: Logger;
  /** Testler için: geri çekilme beklemelerini kısaltır. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Geçerli kimlik JWT'si (identity verification `jwt`/`both`); her istekte okunur. */
  identityToken?: () => string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** 5xx/429/ağ hataları yeniden denenebilir; 4xx denenmez. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

const BACKOFF_MS = [500, 1500, 4000];

/** `/sdk/v1/apps/{appId}` uçlarına JSON istek; 429/5xx ve ağ hatalarında üstel geri çekilme. */
export class SdkApi {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly options: ApiOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? BACKOFF_MS.length;
  }

  /**
   * İstek başlıkları. Kimlik JWT'si (ADR-0023 §9) varsa `Authorization: Bearer` ile gider; çerez kullanılmaz
   * (`credentials: 'omit'`), belirteç URL'ye veya gövdeye yazılmaz.
   */
  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (json) headers['content-type'] = 'application/json';
    const jwt = this.options.identityToken?.();
    if (jwt) headers.authorization = `Bearer ${jwt}`;
    return headers;
  }

  get appBase(): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/sdk/v1/apps/${encodeURIComponent(this.options.appId)}`;
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.fetchImpl(`${this.appBase}${path}`, {
          method,
          headers: this.headers(body !== undefined),
          body: body === undefined ? undefined : JSON.stringify(body),
          // Çerez göndermeyiz; SDK app_id ile konuşur.
          credentials: 'omit',
          keepalive: method === 'POST' && path.endsWith('/sessions'),
        });
        if (response.ok) {
          if (response.status === 204) return undefined as T;
          const text = await response.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }
        let envelope: ErrorEnvelope = {};
        try {
          envelope = (await response.json()) as ErrorEnvelope;
        } catch {
          envelope = {};
        }
        const err = new ApiError(response.status, envelope.error?.code ?? `HTTP_${response.status}`, envelope.error?.message ?? `HTTP ${response.status}`, envelope.error?.details);
        if (!err.retryable || attempt >= this.maxRetries) throw err;
        const retryAfter = Number(response.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        // Ağ hatası
        if (attempt >= this.maxRetries) throw new ApiError(0, 'NETWORK', err instanceof Error ? err.message : 'network error');
        this.options.logger.debug('ağ hatası, yeniden deneniyor', err);
        await this.sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!);
      }
      attempt++;
    }
  }
}

/** Sorgu dizesi; tanımsız/boş değerler atlanır. */
export function queryString(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  const text = q.toString();
  return text ? `?${text}` : '';
}

const enc = encodeURIComponent;

/**
 * Abonelik sahiplik kanıtı (ADR-0016): kayıtlı token'ın SHA-256 özeti ve/veya kullanıcının identity_hash'i.
 * `PATCH`/`DELETE subscriptions/{id}` isteklerine eklenir; kanıtla kaydolan abonelik kanıtsız değiştirilemez.
 */
export interface OwnershipProof {
  token_hash?: string;
  identity_hash?: string;
}

export function ownershipProof(
  tokenHash: string | null | undefined,
  identityHash?: string | null,
): OwnershipProof {
  return {
    // crypto.subtle yoksa `digest` özet üretemez; ham değer kanıt olarak gönderilmez.
    ...(tokenHash && /^[0-9a-f]{64}$/.test(tokenHash) ? { token_hash: tokenHash } : {}),
    ...(identityHash ? { identity_hash: identityHash } : {}),
  };
}

// --- Faz 10 SDK uçları (docs/messaging.md §7-§8) ---

/** `POST /subscriptions` ile e-posta/SMS aboneliği (kullanıcı varsa external_id ile bağlanır). */
export function registerContact(
  api: SdkApi,
  body: {
    channel: ContactChannel;
    token: string;
    device: DeviceInfo;
    user: { external_id?: string; identity_hash?: string; subscription_id?: string };
  },
): Promise<RegisterResult> {
  return api.request<RegisterResult>('POST', '/subscriptions', { ...body, ownership_proof: true });
}

/** Aboneliği siler (`User.removeEmail`/`removeSms`); kanıt sorgu parametresiyle gönderilir. */
export function deleteSubscription(
  api: SdkApi,
  subscriptionId: string,
  proof: OwnershipProof = {},
): Promise<void> {
  return api.request<void>('DELETE', `/subscriptions/${enc(subscriptionId)}${queryString({ ...proof })}`);
}

/**
 * Cihaz için gösterilebilir in-app mesajlar. `tokenHash` aboneliğin sahiplik kanıtıdır (ADR-0016); kanıtla
 * kaydolan abonelikler ve e-posta/SMS abonelikleri için sunucu kanıtsız isteği reddeder.
 */
/** Sunucuya bildirilen in-app içerik yetenekleri. */
export const IN_APP_SUPPORTS = 'html,carousel';

export function fetchInAppMessages(
  api: SdkApi,
  subscriptionId: string,
  tokenHash?: string | null,
): Promise<SdkInAppList> {
  return api.request<SdkInAppList>(
    'GET',
    // `supports`: bu SDK HTML in-app (sandbox'lı iframe) ve carousel bloklarını çizebilir (ADR-0027).
    `/in-app${queryString({ subscription_id: subscriptionId, ...ownershipProof(tokenHash), supports: IN_APP_SUPPORTS })}`,
  );
}

/** In-app gösterim / tıklama / kapatma olayı (`click` için `button_id` zorunlu; A/B için `variant_id`). */
export function postInAppEvent(
  api: SdkApi,
  messageId: string,
  body: {
    subscription_id: string;
    /** Aboneliğin sahiplik kanıtı (ADR-0016); varsa gönderilir. */
    token_hash?: string;
    type: 'impression' | 'click' | 'dismiss';
    button_id?: string;
    variant_id?: string;
  },
): Promise<void> {
  return api.request<void>('POST', `/in-app/${enc(messageId)}/events`, body);
}

// --- Kullanıcı tercihleri (ADR-0019 §4) ---

/** Tercih uçlarının yetkilendirmesi: abonelik + sahiplik kanıtı (PATCH subscriptions kurallarıyla aynı). */
export interface PreferencesAuth extends OwnershipProof {
  subscription_id: string;
}

/** `GET /preferences` ve `PUT /preferences` yanıtı (API biçimi). */
export interface SdkPreferences {
  data: {
    category: string;
    channel: string | null;
    opted_in: boolean;
    explicit: boolean;
    source: string | null;
    updated_at: string | null;
  }[];
  categories: SdkCategory[];
}

/** `GET /config` → `categories[]` öğesi. */
export interface SdkCategory {
  key: string;
  name: Record<string, string>;
  description?: Record<string, string> | null;
  channels: string[] | null;
  default_opted_in: boolean;
}

export function fetchPreferences(api: SdkApi, auth: PreferencesAuth): Promise<SdkPreferences> {
  return api.request<SdkPreferences>('GET', `/preferences${queryString({ ...auth })}`);
}

export function putPreferences(
  api: SdkApi,
  auth: PreferencesAuth,
  preferences: PreferenceInput[],
): Promise<SdkPreferences> {
  return api.request<SdkPreferences>('PUT', '/preferences', {
    ...auth,
    preferences: preferences.map((p) => ({
      category: p.category,
      opted_in: p.optedIn,
      ...(p.channel !== undefined ? { channel: p.channel } : {}),
    })),
  });
}

export function categoryFromApi(c: SdkCategory): PreferenceCategory {
  return {
    key: c.key,
    name: c.name ?? {},
    description: c.description ?? {},
    channels: c.channels ?? null,
    defaultOptedIn: c.default_opted_in === true,
  };
}

/** API tercih yanıtını SDK biçimine (camelCase) çevirir. */
export function preferencesFromApi(result: SdkPreferences): UserPreferences {
  const preferences: UserPreference[] = (result.data ?? []).map((p) => ({
    category: p.category,
    channel: (p.channel as Channel | null) ?? null,
    optedIn: p.opted_in,
    explicit: p.explicit,
    source: p.source ?? null,
    updatedAt: p.updated_at ?? null,
  }));
  return { preferences, categories: (result.categories ?? []).map(categoryFromApi) };
}

/**
 * Bildirim kutusu yetkilendirmesi: abonelik kullanıcıya ait olmalı; doğrulama zorunluysa `identity_hash`.
 * `tokenHash` aboneliğin sahiplik kanıtıdır (ADR-0016; push: kayıtlı token, e-posta/SMS: kanonik adres özeti).
 */
export interface InboxAuth {
  userId: string;
  subscriptionId: string;
  identityHash?: string | null;
  tokenHash?: string | null;
}

export function fetchInbox(
  api: SdkApi,
  auth: InboxAuth,
  page: { limit?: number; cursor?: string } = {},
): Promise<SdkInboxPage> {
  const query = queryString({
    subscription_id: auth.subscriptionId,
    ...ownershipProof(auth.tokenHash, auth.identityHash),
    limit: page.limit,
    cursor: page.cursor,
  });
  return api.request<SdkInboxPage>('GET', `/users/${enc(auth.userId)}/inbox${query}`);
}

function inboxActionBody(auth: InboxAuth): { subscription_id: string } & OwnershipProof {
  return {
    subscription_id: auth.subscriptionId,
    ...ownershipProof(auth.tokenHash, auth.identityHash),
  };
}

export function markInboxItemRead(
  api: SdkApi,
  auth: InboxAuth,
  itemId: string,
): Promise<SdkInboxItem> {
  return api.request<SdkInboxItem>(
    'POST',
    `/users/${enc(auth.userId)}/inbox/${enc(itemId)}/read`,
    inboxActionBody(auth),
  );
}

export function markAllInboxRead(
  api: SdkApi,
  auth: InboxAuth,
): Promise<{ updated: number; unread_count: number }> {
  return api.request('POST', `/users/${enc(auth.userId)}/inbox/read-all`, inboxActionBody(auth));
}

export function archiveInboxItem(api: SdkApi, auth: InboxAuth, itemId: string): Promise<void> {
  const query = queryString({
    subscription_id: auth.subscriptionId,
    ...ownershipProof(auth.tokenHash, auth.identityHash),
  });
  return api.request<void>('DELETE', `/users/${enc(auth.userId)}/inbox/${enc(itemId)}${query}`);
}

/** `GET /in-app` yanıtı. */
export interface SdkInAppList {
  language: string;
  data: InAppMessage[];
}

/** Bildirim kutusu öğesi (API biçimi). */
export interface SdkInboxItem {
  id: string;
  message_id: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  image_url: string | null;
  data: Record<string, string>;
  read: boolean;
  read_at: string | null;
  archived_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface SdkInboxPage {
  data: SdkInboxItem[];
  unread_count: number;
  next_cursor: string | null;
  has_more: boolean;
}

/** HeroSignal public app yapılandırması (GET /config). */
export interface SdkConfig {
  app_id: string;
  name: string;
  identity_verification_required: boolean;
  /** Kabul edilen kimlik kanıtı (eski API'lerde yoksa `hmac`). */
  identity_verification_mode?: 'hmac' | 'jwt' | 'both';
  platforms: { ios: boolean; android: boolean; web: boolean; email: boolean; sms: boolean };
  web: {
    vapid_public_key: string | null;
    allowed_origins: string[];
    /** Dashboard'da ayarlanan service worker yolu/kapsamı (init seçenekleri önceliklidir). */
    service_worker_path?: string | null;
    service_worker_scope?: string | null;
    /** Dashboard'dan yönetilen otomatik izin istemi (init `slidedown`/`autoPrompt` verilmemişse). */
    prompt?: RemotePromptConfig | null;
    /** Dashboard web yapılandırması (init seçenekleri önceliklidir). */
    welcome_notification?: RemoteWelcomeConfig | null;
    click_behavior?: { match: 'exact' | 'origin'; action: 'navigate' | 'focus' } | null;
    custom_link?: RemoteCustomLinkConfig | null;
    prompt_backoff_days?: number[] | null;
  };
  session: { timeout_seconds: number };
  /** App geneli in-app aralığı: son gösterimden beri en az bu kadar saniye geçmeden yeni mesaj gösterilmez. */
  in_app?: { min_interval_seconds: number } | null;
  /** Android bildirim kanalları (web'de kullanılmaz; sözleşme bütünlüğü için). */
  android_channels?: {
    id: string;
    name: string;
    description: string | null;
    importance: string;
    sound: string | null;
    vibration: boolean;
    group: string | null;
  }[];
  /** Mesaj kategorileri (tercih merkezi). */
  categories?: SdkCategory[];
}

/** Dil kodu (2 harf) → metin. */
export type LocalizedTexts<T> = Record<string, T>;

/** `GET /config` → `web.welcome_notification`. */
export interface RemoteWelcomeConfig {
  enabled: boolean;
  url?: string;
  texts?: LocalizedTexts<{ title?: string; message?: string }>;
}

/** `GET /config` → `web.custom_link`. */
export interface RemoteCustomLinkConfig {
  enabled: boolean;
  style: 'button' | 'link';
  size: 'small' | 'medium' | 'large';
  color?: { button?: string; text?: string };
  texts?: LocalizedTexts<{ subscribe?: string; unsubscribe?: string; explanation?: string }>;
  unsubscribeEnabled?: boolean;
}

/** `GET /config` → `web.prompt`. */
export interface RemotePromptConfig {
  enabled: boolean;
  type: 'slidedown' | 'native';
  delaySeconds?: number;
  pageViews?: number;
  scrollPercent?: number;
  texts?: LocalizedTexts<{ title?: string; message?: string; accept?: string; cancel?: string }>;
  categories?: { tag: string; label: LocalizedTexts<string> }[];
  /** Kabul düğmesi rengi (#rrggbb). */
  accentColor?: string;
  /** Toplanacak kanal (ADR-0019 §11); yoksa push. */
  collect?: SlidedownCollect;
}

export interface RegisterResult {
  subscription_id: string;
  user_id: string;
  external_id: string | null;
  status: string;
  created: boolean;
}

export interface UserResult {
  user_id: string;
  external_id: string | null;
  tags: Record<string, string>;
}
