<!-- pushizo:header -->
<p align="center">
  <a href="https://pushizo.com"><img src="https://raw.githubusercontent.com/pushizo/.github/main/profile/assets/mark.svg" alt="Pushizo" width="56" height="56"></a>
</p>
<p align="center">
  <a href="https://docs.pushizo.com/docs/sdk/web"><img src="https://img.shields.io/badge/docs-docs.pushizo.com-5b4bdb" alt="Docs"></a>
  <a href="https://docs.pushizo.com/docs/api"><img src="https://img.shields.io/badge/API-reference-b44fc4" alt="API reference"></a>
  <a href="https://github.com/pushizo/pushizo-web/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-16130f" alt="License: MIT"></a>
</p>
<p align="center"><a href="#english">English</a> · <a href="#türkçe">Türkçe</a></p>

## English

**Pushizo Web SDK** — Web push permission and subscription (VAPID), email and SMS subscriptions, users, tags and aliases, events, in-app messages, notification inbox, user preferences and the service worker. The API surface is compatible with eski sağlayıcı v5.

> **Status:** The script tag is served by the Pushizo API today; the npm package is being published.<br>
> **Durum:** Script etiketi bugün Pushizo API'sinden sunulur; npm paketinin yayını hazırlanıyor.

**Install from GitHub until then · O zamana kadar GitHub'dan kurulum:**

```bash
npm install https://github.com/pushizo/pushizo-web/releases/download/v0.1.0/pushizo-web-0.1.0.tgz
```

**After publication · Yayından sonra:**

```html
<script src="https://api.pushizo.com/sdk-web/PushizoSDK.js" async></script>
<script>
  window.PushizoDeferred = window.PushizoDeferred || [];
  PushizoDeferred.push((Pushizo) => Pushizo.init({ appId: 'app_…' }));
</script>
```

```bash
npm install @pushizo/web
```

The detailed guide below is in Turkish; code samples are language-neutral. Full documentation:
[docs.pushizo.com/docs/sdk/web](https://docs.pushizo.com/docs/sdk/web) · API reference: [docs.pushizo.com/docs/api](https://docs.pushizo.com/docs/api).

## Türkçe
<!-- /pushizo:header -->

# @pushizo/web

Pushizo Web SDK: Web Push izni ve aboneliği, e-posta/SMS aboneliği, kullanıcı/tag/alias yönetimi, olaylar, in-app mesajlar, bildirim kutusu, kullanıcı tercihleri ve service worker. eski sağlayıcı v5 yüzeyiyle uyumludur.

Ayrıntılı kullanım kılavuzu: [docs.pushizo.com/docs/sdk/web](https://docs.pushizo.com/docs/sdk/web).

## Kurulum

```html
<script src="https://api.example.com/sdk-web/PushizoSDK.js" async></script>
<script>
  window.PushizoDeferred = window.PushizoDeferred || [];
  PushizoDeferred.push(async (Pushizo) => {
    await Pushizo.init({ appId: 'app_…', apiUrl: 'https://api.example.com' });
  });
</script>
```

```ts
import Pushizo from '@pushizo/web';
await Pushizo.init({ appId: 'app_…', apiUrl: 'https://api.example.com' });
```

CommonJS (eski paketleyiciler, Jest): paket `require` koşulunda `dist/cjs/index.cjs` ve CommonJS tür tanımlarını sunar.

```js
const { Pushizo } = require('@pushizo/web'); // veya require('@pushizo/web').default
```

Paket boyutu bütçesi `size-budget.json`'dadır (gzip); `npm run size -w @pushizo/web` derlenmiş çıktıyı denetler ve CI
aşımda başarısız olur.

Site kökünde `PushizoSDKWorker.js` bulunmalıdır (içeriği API'deki worker'ı `importScripts` ile yükler).

## API yüzeyi

| Alan | Üyeler |
|------|--------|
| Yaşam döngüsü | `init`, `setConsentGiven`, `login(externalId, identityHash?)`, `logout`, `destroy` |
| `User` | `addTag(s)`, `removeTag(s)`, `getTags`, `setLanguage`, `setProperty`, `addAlias(es)`, `removeAlias`, `addEmail`, `removeEmail`, `addSms`, `removeSms`, `getPreferences()`, `setPreferences([...])`, `getCategories()`, `setAdsPersonalizationConsent(bool)`, `getConsents()`, `id`, `externalId`, `pushSubscription.{id, token, optedIn, state, optIn, optOut, addObserver}` |
| `Notifications` | `permission`, `requestPermission`, `addClickListener`, `addForegroundLifecycleListener` |
| `Slidedown` | `promptPush`, `promptEmail`, `promptSms`, `promptEmailAndSms` (hepsi `{ force? }`) |
| `Session` | `sendEvent(name, properties?, value?, { eventId? })` — `eventId`: tarayıcı pikseliyle aynı kimlik (Conversions API tekilleştirmesi, docs/guides/conversions-api.md) |
| `InAppMessages` | `addTrigger(s)`, `removeTrigger(s)`, `clearTriggers`, `getTriggers`, `setScreen`, `addClickListener`, `addLifecycleListener`, `paused` |
| `Inbox` | `list`, `markRead`, `markAllRead`, `archive`, `unreadCount`, `addObserver` |
| `CustomLink` | `render` |
| `Location` | `setShared(bool)`, `isShared`, `requestPermission(rationale?)` (yalnızca ön plan; ayrıntı [web rehberi](https://docs.pushizo.com/docs/sdk/web) "Konum") |
| `Attribution` | `get(): { first, last }` (UTM / tıklama kimliği dokunuşları; aşağıdaki bölüm) |

## Atribüsyon (UTM ve tıklama kimlikleri)

SDK her sayfa açılışında adresteki `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id` ve
reklam tıklama kimliklerini (`fbclid`, `gclid`, `gbraid`, `wbraid`, `ttclid`, `li_fat_id`, `msclkid`; birden çoksa bu
sırayla ilki) okur ve bir **dokunuş** kaydeder.

```ts
await Pushizo.init({
  appId: 'app_…',
  attribution: { enabled: true, windowDays: 30, captureClickIds: true }, // varsayılanlar
});
const { first, last } = Pushizo.Attribution.get(); // ilk ve son dokunuş (yoksa null)
```

- `enabled: false`: hiçbir parametre okunmaz, saklanmaz, gönderilmez. `windowDays` 1–90 aralığına kırpılır;
  `captureClickIds: false` iken yalnızca UTM parametreleri dokunuş üretir.
- **Saklama**: çerez yazılmaz; ilk ve son dokunuş SDK'nın yerel deposunda (`localStorage`, `hs:<appId>`) tutulur ve
  `windowDays`'ten eski kayıtlar okunurken silinir. Aynı parametrelerle 30 dakika içindeki yeniden yükleme yeni dokunuş
  sayılmaz.
- **Kişisel veri**: `landing_url` yalnızca origin + yoldur (sorgu ve hash alınmaz); `referrer` yalnızca yönlendiren
  sitenin host'udur, sitenin kendi host'u gönderilmez.
- **Rıza**: `requiresPrivacyConsent` açıkken onay verilene kadar hiçbir şey yakalanmaz; `setConsentGiven(false)`
  atribüsyon kayıtlarını ve bekleyen dokunuşları siler.
- **Gönderim**: dokunuşlar çevrimdışı kuyrukla `POST /sdk/v1/apps/{appId}/attribution`'a gider; abonelik varsa
  `subscription_id` + sahiplik kanıtı (`token_hash` / `identity_hash`), yoksa `login` ile verilen `external_id`
  kullanılır. İkisi de yoksa dokunuş cihazda bekler, abonelik oluşunca veya `login` sonrası gönderilir. `touch_id`
  yeniden denemelerde aynı kalır (sunucu tekilleştirir).

Önerilen reklam URL parametreleri (izleme şablonu / URL parametreleri alanı):

| Platform | Parametreler |
|----------|--------------|
| Meta | `utm_source=facebook&utm_campaign={{campaign.id}}&utm_content={{adset.id}}` (`fbclid` otomatik eklenir) |
| Google Ads | `utm_source=google&utm_campaign={campaignid}&utm_content={adgroupid}` (otomatik etiketleme açıkken `gclid` / `gbraid` / `wbraid` gelir) |
| TikTok | `utm_source=tiktok&utm_campaign=__CAMPAIGN_ID__&utm_content=__AID__` (`ttclid` otomatik eklenir) |

## Tercihler, kategoriler ve diğer özellikler

### Kullanıcı tercihleri
```ts
const { preferences, categories } = await Pushizo.User.getPreferences();
Pushizo.User.setPreferences([
  { category: 'promo', optedIn: false },                 // tüm kanallar
  { category: 'news', optedIn: true, channel: 'email' }, // tek kanal
]);
```
`GET/PUT /sdk/v1/apps/{appId}/preferences`; abonelik sahiplik kanıtı (`token_hash`, login'de `identity_hash`) otomatik eklenir. `setPreferences` çevrimdışı kuyruğa yazılır.

Reklam kişiselleştirme rızası: `Pushizo.User.setAdsPersonalizationConsent(true)` kullanıcının e-posta/telefon SHA-256 özetinin app'in bağladığı reklam platformu kitlelerine gönderilmesine izin verir; `false` geri alır (sonraki senkronda kitlelerden çıkarılır). `getConsents()` rıza kayıtlarını döner. Rehber: `docs/guides/ad-audiences.md`.

### E-posta/SMS toplama istemi
```ts
await Pushizo.init({ appId: 'app_…', slidedown: { enabled: true, collect: 'email_sms' } });
await Pushizo.Slidedown.promptEmail();
```
`collect: 'push' | 'email' | 'sms' | 'email_sms'` (init ya da dashboard istemi `prompt.collect`). E-posta/SMS için adres alanı + kabul düğmesi; doğrulama `addEmail`/`addSms` ile aynı. Kabulde adres kaydedilir ve istem bir daha gösterilmez; ret push istemiyle aynı geri çekilme takvimine uyar. `collect` yoksa push davranışı değişmez.

### In-app
- `trigger_groups`: gruplar VEYA, grup içi VE (`triggers` ilk grup).
- Yeni tetik `session_duration { seconds }`: oturum süresi eşiğe ulaşınca zamanlayıcıyla gösterilir.
- Yeni düğme aksiyonları `push_prompt` (yerel izin istemi) ve `outcome { name, value? }` (olay gönderir).
- `variant_id` (A/B görünüm varyantı) her gösterim/tıklama/kapatma olayıyla geri gider.
- App geneli aralık `config.in_app.min_interval_seconds`: herhangi bir in-app mesajın son gösteriminden beri süre dolmadan yeni mesaj gösterilmez (kalıcı).

### Oturum süresi
`pagehide` ve zaman aşımında `POST /sessions { duration_seconds }` kuyruğu beklemeden `keepalive` fetch ile gönderilir; geçici hatada kuyruğa düşer.

## Geliştirme

```bash
npm run -w sdk/web build       # dist/index.js (ESM), dist/PushizoSDK.js (IIFE), dist/PushizoSDKWorker.js
npm run -w sdk/web typecheck
npx vitest run --project unit sdk/web
```
Boyut bütçesi: IIFE gzip < 25 KB (~24,0 KB), service worker gzip < 5 KB (~3,9 KB).

<!-- pushizo:footer -->
---

## Support · Destek

- **Guide · Rehber:** [docs.pushizo.com/docs/sdk/web](https://docs.pushizo.com/docs/sdk/web)
- **API reference & OpenAPI · API referansı ve OpenAPI:** [docs.pushizo.com/docs/api](https://docs.pushizo.com/docs/api) ·
  [pushizo-openapi](https://github.com/pushizo/pushizo-openapi)
- **Bugs & ideas · Hata ve öneri:** [Issues](https://github.com/pushizo/pushizo-web/issues)
- **Security · Güvenlik:** please do not open public issues; email [security@pushizo.com](mailto:security@pushizo.com) ·
  herkese açık issue açmayın, bu adrese yazın.
- **Help · Destek:** [support@pushizo.com](mailto:support@pushizo.com)

This repository is mirrored automatically from the Pushizo main repository on every release. Please open an issue
instead of a pull request; fixes land in the main repository and ship with the next release.
Bu depo her sürümde Pushizo ana deposundan otomatik yansıtılır. Pull request yerine issue açın; düzeltmeler ana depoda
yapılır ve bir sonraki sürümle buraya gelir.

Released under the MIT License · MIT lisanslıdır — [LICENSE](https://github.com/pushizo/pushizo-web/blob/main/LICENSE).
<!-- /pushizo:footer -->
