import type { PersistedState } from './types.js';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEFAULT_STATE: PersistedState = {
  subscriptionId: null,
  userId: null,
  externalId: null,
  identityHash: null,
  identityJwt: null,
  tags: {},
  optedIn: false,
  consentGiven: false,
  tokenHash: null,
  pushEndpoint: null,
  slidedownDismissedAt: null,
  promptDismissCount: 0,
  welcomeShownFor: null,
  pageViews: 0,
  queue: [],
  contactSubscriptions: [],
  inAppLocal: {},
  inAppLastImpressionAt: null,
  contactPromptAnswered: false,
  contactPromptDismissedAt: null,
  contactPromptDismissCount: 0,
  locationShared: false,
  locationSentAt: null,
  locationPermissionGranted: false,
  regionalApiUrl: null,
  regionalApiSeed: null,
};

/** Bellek içi yedek: localStorage yoksa (gizli mod/kısıtlı tarayıcı) oturum süresince çalışır. */
export class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export function resolveStore(): KeyValueStore {
  try {
    const probe = '__hs_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return new MemoryStore();
  }
}

/** App başına kalıcı SDK durumu (`hs:<appId>` anahtarı). */
export class StateStore {
  private state: PersistedState;
  private readonly key: string;

  constructor(
    appId: string,
    private readonly store: KeyValueStore = resolveStore(),
  ) {
    this.key = `hs:${appId}`;
    this.state = this.load();
  }

  private load(): PersistedState {
    try {
      const raw = this.store.getItem(this.key);
      if (!raw) return { ...DEFAULT_STATE, queue: [], contactSubscriptions: [], inAppLocal: {} };
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        ...DEFAULT_STATE,
        ...parsed,
        tags: parsed.tags ?? {},
        queue: Array.isArray(parsed.queue) ? parsed.queue : [],
        // Eski sürümlerin kaydında bu alanlar yoktur.
        contactSubscriptions: Array.isArray(parsed.contactSubscriptions) ? parsed.contactSubscriptions : [],
        inAppLocal: parsed.inAppLocal && typeof parsed.inAppLocal === 'object' ? parsed.inAppLocal : {},
      };
    } catch {
      return { ...DEFAULT_STATE, queue: [], contactSubscriptions: [], inAppLocal: {} };
    }
  }

  get(): PersistedState {
    return this.state;
  }

  update(patch: Partial<PersistedState>): PersistedState {
    this.state = { ...this.state, ...patch };
    try {
      this.store.setItem(this.key, JSON.stringify(this.state));
    } catch {
      // Depolama dolu/kapalı: bellekte devam.
    }
    return this.state;
  }

  reset(keep: Partial<PersistedState> = {}): PersistedState {
    return this.update({ ...DEFAULT_STATE, queue: [], contactSubscriptions: [], inAppLocal: {}, ...keep });
  }
}
