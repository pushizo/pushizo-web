/**
 * Hücre mimarisi (ADR-0032 §4): SDK, app'in veri bölgesindeki API kökünü (`api_url`) yapılandırmadan veya
 * yanlış hücreye giden isteğin 421 `HS_WRONG_CELL` yanıtından öğrenir.
 */

export const WRONG_CELL_STATUS = 421;
export const WRONG_CELL_CODE = 'HS_WRONG_CELL';
/**
 * Global API kökü (mobil SDK'ların ve köprülerin varsayılanı). `init` `apiUrl` bu değerdeyse açık seçim sayılmaz ve
 * config `api_url` benimsenir; böylece Flutter web gibi varsayılanı her zaman ileten köprüler de bölgesel köke geçer.
 */
export const DEFAULT_API_URL = 'https://api.pushizo.com';

/** `init` `apiUrl` geliştiricinin açık (özel alan adı/vekil) seçimi mi? */
export function isExplicitApiUrl(apiUrl: string | undefined): boolean {
  return apiUrl !== undefined && apiUrl.replace(/\/+$/, '') !== DEFAULT_API_URL;
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$|\.localhost$/i;
const SDK_PATH = '/sdk/v1/apps/';

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Sunucunun bildirdiği bölgesel API kökünü doğrular; kabul edilirse sondaki `/` atılmış hâlini döner.
 * Güvenlik kuralı: geçerli mutlak URL, `https` zorunlu (tek istisna: mevcut kök de `http` loopback iken loopback
 * hedef — yerel geliştirme), kullanıcı bilgisi / sorgu / parça içeremez. Alan adı kısıtlaması yoktur: bölgeler ve
 * bayi alan adları farklı üst alan adlarında olabilir; adres yalnızca zaten güvenilen API'nin yanıtından alınır.
 */
export function acceptApiUrl(candidate: unknown, current: string): string | null {
  if (typeof candidate !== 'string' || candidate.length > 2048) return null;
  const url = parse(candidate);
  if (!url || url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== 'https:') {
    const cur = parse(current);
    const local =
      url.protocol === 'http:' &&
      LOOPBACK.test(url.hostname) &&
      cur?.protocol === 'http:' &&
      LOOPBACK.test(cur.hostname);
    if (!local) return null;
  }
  return url.href.replace(/\/+$/, '');
}

/** 421 `HS_WRONG_CELL` hata zarfından kabul edilebilir yeni API kökü (yoksa null). */
export function wrongCellTarget(status: number, envelope: unknown, current: string): string | null {
  if (status !== WRONG_CELL_STATUS || !envelope || typeof envelope !== 'object') return null;
  const error = (envelope as { error?: { code?: unknown; details?: { api_url?: unknown } } }).error;
  if (error?.code !== WRONG_CELL_CODE) return null;
  const next = acceptApiUrl(error.details?.api_url, current);
  return next && next !== current.replace(/\/+$/, '') ? next : null;
}

/** Tam SDK istek adresinin (`<kök>/sdk/v1/apps/…`) kökünü değiştirir; kalıba uymuyorsa null. */
export function rebaseSdkUrl(url: string, base: string): string | null {
  const index = url.indexOf(SDK_PATH);
  return index < 0 ? null : `${base}${url.slice(index)}`;
}

/** SDK istek adresinin API kökü (`/sdk/v1/apps/` öncesi); kalıba uymuyorsa null. */
export function sdkUrlBase(url: string): string | null {
  const index = url.indexOf(SDK_PATH);
  return index < 0 ? null : url.slice(0, index);
}
