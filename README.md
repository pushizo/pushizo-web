# @herosignal/web

HeroSignal Web SDK: Web Push izni ve aboneliği, e-posta/SMS aboneliği, kullanıcı/tag/alias yönetimi, olaylar, in-app mesajlar, bildirim kutusu, kullanıcı tercihleri ve service worker. eski sağlayıcı v5 yüzeyiyle uyumludur.

Ayrıntılı kullanım kılavuzu: [`docs/sdk/web.md`](../../docs/sdk/web.md). Örnekler: `examples/web-vanilla`, `examples/web-nextjs`.

## Kurulum

```html
<script src="https://api.example.com/sdk-web/HeroSignalSDK.js" async></script>
<script>
  window.HeroSignalDeferred = window.HeroSignalDeferred || [];
  HeroSignalDeferred.push(async (HeroSignal) => {
    await HeroSignal.init({ appId: 'app_…', apiUrl: 'https://api.example.com' });
  });
</script>
```

```ts
import HeroSignal from '@herosignal/web';
await HeroSignal.init({ appId: 'app_…', apiUrl: 'https://api.example.com' });
```

Site kökünde `HeroSignalSDKWorker.js` bulunmalıdır (içeriği API'deki worker'ı `importScripts` ile yükler).

## API yüzeyi

| Alan | Üyeler |
|------|--------|
| Yaşam döngüsü | `init`, `setConsentGiven`, `login(externalId, identityHash?)`, `logout`, `destroy` |
| `User` | `addTag(s)`, `removeTag(s)`, `getTags`, `setLanguage`, `setProperty`, `addAlias(es)`, `removeAlias`, `addEmail`, `removeEmail`, `addSms`, `removeSms`, `getPreferences()`, `setPreferences([...])`, `getCategories()`, `id`, `externalId`, `pushSubscription.{id, token, optedIn, state, optIn, optOut, addObserver}` |
| `Notifications` | `permission`, `requestPermission`, `addClickListener`, `addForegroundLifecycleListener` |
| `Slidedown` | `promptPush`, `promptEmail`, `promptSms`, `promptEmailAndSms` (hepsi `{ force? }`) |
| `Session` | `sendEvent(name, properties?, value?)` |
| `InAppMessages` | `addTrigger(s)`, `removeTrigger(s)`, `clearTriggers`, `getTriggers`, `setScreen`, `addClickListener`, `addLifecycleListener`, `paused` |
| `Inbox` | `list`, `markRead`, `markAllRead`, `archive`, `unreadCount`, `addObserver` |
| `CustomLink` | `render` |
| `Location` | `setShared(bool)`, `isShared`, `requestPermission(rationale?)` (yalnızca ön plan; ayrıntı `docs/sdk/web.md` "Konum") |

## Faz 12 (ADR-0019) eklemeleri

### Kullanıcı tercihleri
```ts
const { preferences, categories } = await HeroSignal.User.getPreferences();
HeroSignal.User.setPreferences([
  { category: 'promo', optedIn: false },                 // tüm kanallar
  { category: 'news', optedIn: true, channel: 'email' }, // tek kanal
]);
```
`GET/PUT /sdk/v1/apps/{appId}/preferences`; abonelik sahiplik kanıtı (`token_hash`, login'de `identity_hash`) otomatik eklenir. `setPreferences` çevrimdışı kuyruğa yazılır.

### E-posta/SMS toplama istemi
```ts
await HeroSignal.init({ appId: 'app_…', slidedown: { enabled: true, collect: 'email_sms' } });
await HeroSignal.Slidedown.promptEmail();
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
npm run -w sdk/web build       # dist/index.js (ESM), dist/HeroSignalSDK.js (IIFE), dist/HeroSignalSDKWorker.js
npm run -w sdk/web typecheck
npx vitest run --project unit sdk/web
```
Boyut bütçesi: IIFE gzip < 25 KB (~24,0 KB), service worker gzip < 5 KB (~3,9 KB).
