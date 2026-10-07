/**
 * Oturum takibi: sayfa görünür olunca `session_start`, gizlenince/kapatılınca süre ile `session_end`.
 * 30 sn içinde geri dönülürse yeni oturum başlatılmaz (plan: oturum zaman aşımı).
 */
export class SessionTracker {
  private startedAt: number | null = null;
  private hiddenAt: number | null = null;
  private readonly timeoutMs: number;

  constructor(
    private readonly onStart: () => void,
    private readonly onEnd: (durationSeconds: number) => void,
    timeoutSeconds = 30,
  ) {
    this.timeoutMs = timeoutSeconds * 1000;
  }

  attach(): () => void {
    if (typeof document === 'undefined') return () => undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') this.resume();
      else this.pause();
    };
    const onPageHide = () => this.end();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    if (document.visibilityState === 'visible') this.resume();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }

  private resume(): void {
    if (this.startedAt !== null) {
      if (this.hiddenAt !== null && Date.now() - this.hiddenAt > this.timeoutMs) {
        this.end();
      } else {
        this.hiddenAt = null;
        return;
      }
    }
    this.startedAt = Date.now();
    this.hiddenAt = null;
    this.onStart();
  }

  private pause(): void {
    if (this.startedAt !== null) this.hiddenAt = Date.now();
  }

  end(): void {
    if (this.startedAt === null) return;
    const endAt = this.hiddenAt ?? Date.now();
    const duration = Math.max(0, Math.round((endAt - this.startedAt) / 1000));
    this.startedAt = null;
    this.hiddenAt = null;
    this.onEnd(duration);
  }
}
