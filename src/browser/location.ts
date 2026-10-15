import { locationFromCoords, type LocationFix } from '../core/location.js';

/** Konum izni: `granted`, `denied`, `prompt` (henüz sorulmadı) veya `unknown` (Permissions API yok). */
export type GeolocationPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export function isGeolocationSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.geolocation;
}

/** İzin durumunu istem göstermeden okur (Permissions API; desteklenmiyorsa `unknown`). */
export async function geolocationPermission(): Promise<GeolocationPermission> {
  if (!isGeolocationSupported()) return 'denied';
  const permissions = navigator.permissions;
  if (!permissions?.query) return 'unknown';
  try {
    const status = await permissions.query({ name: 'geolocation' });
    return status.state;
  } catch {
    return 'unknown';
  }
}

/** `getCurrentPosition` sonucu: konum, izin reddi veya geçici hata (zaman aşımı / konum alınamadı). */
export type PositionResult =
  | { kind: 'fix'; fix: LocationFix }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

/**
 * Tek seferlik konum (düşük doğruluk, 5 dk önbellek, 15 sn zaman aşımı). İzin sorulmamışsa tarayıcı istem gösterir;
 * bu yüzden yalnızca izin verildiği bilinirken veya `Location.requestPermission` içinden çağrılır.
 */
export function currentPosition(): Promise<PositionResult> {
  return new Promise((resolve) => {
    if (!isGeolocationSupported()) {
      resolve({ kind: 'denied' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const fix = locationFromCoords(position.coords);
        resolve(fix ? { kind: 'fix', fix } : { kind: 'unavailable' });
      },
      (error) => resolve(error.code === 1 ? { kind: 'denied' } : { kind: 'unavailable' }),
      { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 15_000 },
    );
  });
}
