import { ApiError, ownershipProof, type RegisterResult, type SdkApi } from './api.js';
import type { StateStore } from './storage.js';
import type { DeviceInfo } from './types.js';

/** Token'ın SHA-256 özeti (değişiklik tespiti; token düz metin saklanmaz). */
export async function digest(value: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return value;
}

export interface TokenSyncInput {
  token: string;
  /** Gerçek PushSubscription endpoint'i (`pushSubscription.token` olarak sunulur). */
  endpoint: string | null;
  device: DeviceInfo;
  /** İlk kayıtta kullanıcıya bağlanacak kimlik (login, abonelik yokken). */
  user?: { external_id?: string; identity_hash?: string };
}

/** `created`: yeni abonelik; `updated`: mevcut aboneliğin token'ı yenilendi; `unchanged`: değişiklik yok. */
export type TokenSyncResult = 'created' | 'updated' | 'unchanged';

interface SubscriptionView {
  id: string;
  status?: string;
}

/**
 * Push token'ını sunucuyla eşitler. Kayıtlı abonelik varsa token değişikliğinde yeni abonelik açılmaz;
 * `PATCH subscriptions/{id}` ile token yerinde güncellenir (docs/plan/06 "Token yaşam döngüsü").
 * Abonelik sunucuda silinmişse (404) `POST subscriptions` ile yeniden oluşturulur.
 */
export async function syncPushToken(
  api: SdkApi,
  store: StateStore,
  input: TokenSyncInput,
): Promise<TokenSyncResult> {
  const state = store.get();
  const hash = await digest(input.token);
  if (state.subscriptionId && state.tokenHash === hash) {
    if (input.endpoint && state.pushEndpoint !== input.endpoint)
      store.update({ pushEndpoint: input.endpoint });
    return 'unchanged';
  }
  if (state.subscriptionId) {
    try {
      // Kanıt: sunucudaki (eski) token'ın özeti; yeni token bu istekle kaydedilir.
      await api.request<SubscriptionView>('PATCH', `/subscriptions/${state.subscriptionId}`, {
        token: input.token,
        device: input.device,
        ...ownershipProof(state.tokenHash),
      });
      store.update({ tokenHash: hash, pushEndpoint: input.endpoint });
      return 'updated';
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
      // Abonelik sunucuda yok: aşağıda yeniden oluşturulur.
    }
  }
  const user = input.user?.external_id
    ? {
        external_id: input.user.external_id,
        ...(input.user.identity_hash ? { identity_hash: input.user.identity_hash } : {}),
      }
    : state.externalId
      ? {
          external_id: state.externalId,
          ...(state.identityHash ? { identity_hash: state.identityHash } : {}),
        }
      : {};
  const result = await api.request<RegisterResult>('POST', '/subscriptions', {
    channel: 'web_push',
    token: input.token,
    device: input.device,
    user,
    ownership_proof: true,
  });
  store.update({
    subscriptionId: result.subscription_id,
    userId: result.user_id,
    externalId: result.external_id,
    optedIn: result.status === 'subscribed',
    tokenHash: hash,
    pushEndpoint: input.endpoint,
  });
  return 'created';
}
