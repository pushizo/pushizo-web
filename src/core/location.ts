import type { LocationFix } from './types.js';

/**
 * Konum paylaşımının tarayıcıdan bağımsız kuralları (v2 Faz 17b): yalnızca ön planda, kullanıcı izniyle ve
 * `Location.setShared(true)` sonrasında en sık `LOCATION_MIN_INTERVAL_MS` aralıkla gönderilir. Paylaşım kapatılınca
 * `location: null` gönderilir; sunucu konumu ve KVKK rıza kaydını hemen siler.
 */

/** İki konum gönderimi arasındaki en kısa süre (5 dakika). */
export const LOCATION_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** Sunucunun kabul ettiği en büyük doğruluk yarıçapı (metre). */
export const LOCATION_MAX_ACCURACY_M = 100_000;

export type { LocationFix };

/** Tarayıcı `GeolocationCoordinates` alt kümesi. */
export interface CoordinatesLike {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

/**
 * Koordinatları sunucu sözleşmesine çevirir: enlem -90..90, boylam -180..180 (aralık dışı/sonlu olmayan değerde null).
 * Koordinatlar 6 ondalığa (~11 cm) yuvarlanır; doğruluk 0..100000 m aralığına sıkıştırılır, bilinmiyorsa gönderilmez.
 */
export function locationFromCoords(coords: CoordinatesLike): LocationFix | null {
  const { latitude, longitude, accuracy } = coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  const fix: LocationFix = { lat: round6(latitude), lng: round6(longitude) };
  if (typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0) {
    fix.accuracy_m = Math.min(LOCATION_MAX_ACCURACY_M, Math.round(accuracy * 10) / 10);
  }
  return fix;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Yeni konum alınıp gönderilmeli mi: paylaşım açık, aralık dolmuş (veya `force`). İzin/onay ayrıca denetlenir. */
export function locationRefreshDue(
  shared: boolean,
  lastSentAt: number | null,
  now: number,
  force = false,
): boolean {
  if (!shared) return false;
  if (force || lastSentAt === null) return true;
  // Saat geri alınmışsa (gelecekteki kayıt) bekleme yeniden başlamaz, hemen gönderilir.
  return now - lastSentAt >= LOCATION_MIN_INTERVAL_MS || now < lastSentAt;
}
