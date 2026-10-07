/** `POST /sdk/v1/apps/{appId}/errors` kaydı (sunucu şeması ile aynı alanlar). */
export interface SdkErrorItem {
  level: 'error' | 'warning';
  platform: 'web';
  sdk_version: string;
  code: string;
  message: string;
  subscription_id?: string;
  context?: Record<string, string | number | boolean | null>;
  occurred_at: string;
}

export interface ErrorReporterOptions {
  sdkVersion: string;
  /** Toplu gövdeyi gönderir; hata fırlatırsa yutulur (rapor hatası yeniden raporlanmaz). */
  send: (body: { errors: SdkErrorItem[] }) => Promise<unknown>;
  /** Oturum (sayfa/worker ömrü) başına en fazla rapor (varsayılan 20). */
  maxPerSession?: number;
  /** Toplama gecikmesi (ms, varsayılan 2000); 0 → hemen gönder. */
  flushDelayMs?: number;
}

const MAX_BATCH = 20;
const SECRET_LIKE = /[A-Za-z0-9_\-+/=:]{32,}/g;

/** Token/anahtar benzeri uzun dizileri maskeler. */
export function sanitizeErrorText(text: string): string {
  return text.replace(SECRET_LIKE, '[redacted]');
}

/** Ağ/çevrimdışı hatası mı (raporlanmaz): `status === 0` API hatası veya fetch TypeError'ı. */
export function isNetworkError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err && err.status === 0) return true;
  return err instanceof TypeError && /fetch|network|load failed/i.test(err.message);
}

/** Hata özeti: ham mesaj (PII/token içerebilir) yerine yalnızca tür, HTTP durumu ve kod. */
function describe(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  if (typeof err === 'object' && 'status' in err && 'code' in err) {
    return `HTTP ${String(err.status)} ${String(err.code)}`;
  }
  if (err instanceof Error) return err.name || 'Error';
  return typeof err;
}

/**
 * SDK iç hatalarını toplu ve en iyi çabayla bildirir: aynı kod+mesaj bir kez, oturum başına en fazla
 * `maxPerSession` kayıt; ağ hataları atlanır; gönderim hatası yeniden raporlanmaz.
 */
export class ErrorReporter {
  private readonly pending: SdkErrorItem[] = [];
  private readonly seen = new Set<string>();
  private accepted = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = true;

  constructor(private readonly options: ErrorReporterOptions) {}

  /** KVKK/GDPR onayı yokken raporlama kapatılır. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.pending.length = 0;
  }

  /** @returns Kayıt kuyruğa alındıysa true. */
  record(
    code: string,
    message: string,
    err?: unknown,
    extra: {
      level?: 'error' | 'warning';
      subscriptionId?: string | null;
      context?: Record<string, string | number | boolean | null>;
    } = {},
  ): boolean {
    if (!this.enabled || (err !== undefined && isNetworkError(err))) return false;
    const detail = describe(err);
    const text = sanitizeErrorText(detail ? `${message}: ${detail}` : message)
      .trim()
      .slice(0, 2000);
    if (!text) return false;
    const key = `${code}|${text}`;
    if (this.accepted >= (this.options.maxPerSession ?? 20) || this.seen.has(key)) return false;
    this.seen.add(key);
    this.accepted++;
    const item: SdkErrorItem = {
      level: extra.level ?? 'error',
      platform: 'web',
      sdk_version: this.options.sdkVersion,
      code: code.slice(0, 100),
      message: text,
      occurred_at: new Date().toISOString(),
    };
    if (extra.subscriptionId) item.subscription_id = extra.subscriptionId;
    if (extra.context) {
      const context = Object.fromEntries(
        Object.entries(extra.context).map(([k, v]) => [
          k.slice(0, 64),
          typeof v === 'string' ? sanitizeErrorText(v).slice(0, 256) : v,
        ]),
      );
      if (JSON.stringify(context).length <= 4096) item.context = context;
    }
    this.pending.push(item);
    this.schedule();
    return true;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Bekleyen kayıtları (20'lik gruplar halinde) gönderir; hatalar yutulur. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, MAX_BATCH);
      try {
        await this.options.send({ errors: batch });
      } catch {
        // Rapor gönderilemedi: yeniden raporlanmaz (özyineleme yok).
      }
    }
  }

  private schedule(): void {
    if (this.timer) return;
    const delay = this.options.flushDelayMs ?? 2000;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }
}
