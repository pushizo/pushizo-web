// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountChatWidget } from '../chat-widget/widget.js';
import { SdkApi } from '../core/api.js';
import { ChatClient, mergeMessages, randomId, type ChatConfig, type ChatMessage } from '../core/chat.js';
import { Logger } from '../core/logger.js';
import { MemoryStore } from '../core/storage.js';

/** ADR-0040: Web SDK canlı sohbet istemcisi ve widget'ı. */

const msg = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: 'cvm_1',
  seq: 1,
  client_message_id: null,
  sender: 'agent',
  author_name: 'Ayşe',
  text: 'Merhaba',
  attachments: [],
  quick_replies: null,
  status: 'sent',
  created_at: '2026-10-20T10:00:00.000Z',
  ...patch,
});

const config: ChatConfig = {
  enabled: true,
  online: true,
  within_business_hours: true,
  color: '#123456',
  text_color: null,
  position: 'right',
  theme: 'auto',
  title: 'Destek',
  greeting: 'Size nasıl yardımcı olabiliriz?',
  offline_message: null,
  collect_email_offline: true,
  require_email: false,
  attachments: { enabled: true, max_bytes: 10 * 1024 * 1024, types: ['image/png'] },
  language: 'tr',
};

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/** Sahte sunucu: sohbet uçlarını bellekte yanıtlar ve çağrıları kaydeder. */
function fakeServer(opts: { conversationExists?: boolean; failSendTimes?: number } = {}) {
  const calls: Call[] = [];
  let seq = 0;
  let failures = opts.failSendTimes ?? 0;
  const stored = new Map<string, ChatMessage>();
  let conversation = opts.conversationExists
    ? { id: 'cvs_1', status: 'open', last_seq: 0, agent_last_read_seq: 0, visitor_last_read_seq: 0, unread_count: 2, bot_active: false, assignee_name: null, created_at: '2026-10-20T10:00:00.000Z' }
    : null;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? 'GET', url, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/chat/config')) return json(config);
    if (url.includes('/chat/conversation')) return json({ conversation, unread_count: conversation?.unread_count ?? 0 });
    if (url.includes('/chat/messages') && (init?.method ?? 'GET') === 'GET') return json({ data: [...stored.values()], has_more: false });
    if (url.endsWith('/chat/messages') && init?.method === 'POST') {
      if (failures > 0) {
        failures--;
        return json({ error: { code: 'HS_VALIDATION_ERROR', message: 'geçici' } }, 400);
      }
      const cid = body!.client_message_id as string;
      const existing = [...stored.values()].find((m) => m.client_message_id === cid);
      if (existing) return json({ message: existing, conversation, duplicate: true });
      seq++;
      const m = msg({ id: `cvm_${seq}`, seq, client_message_id: cid, sender: 'visitor', author_name: null, text: body!.text as string });
      stored.set(m.id, m);
      conversation = { ...(conversation ?? { id: 'cvs_1', status: 'open', agent_last_read_seq: 0, visitor_last_read_seq: 0, unread_count: 0, bot_active: false, assignee_name: null, created_at: m.created_at }), last_seq: seq };
      return json({ message: m, conversation, duplicate: false });
    }
    if (url.endsWith('/chat/ack')) return json({ conversation: conversation ? { ...conversation, unread_count: 0, visitor_last_read_seq: body!.read_seq } : null, unread_count: 0 });
    if (url.endsWith('/chat/identify')) return json({ user_id: 'usr_1', conversation });
    if (url.endsWith('/chat/offline')) {
      seq++;
      const m = msg({ id: `cvm_${seq}`, seq, client_message_id: body!.client_message_id as string, sender: 'visitor', author_name: null, text: body!.text as string });
      conversation = { id: 'cvs_1', status: 'open', last_seq: seq, agent_last_read_seq: 0, visitor_last_read_seq: 0, unread_count: 0, bot_active: false, assignee_name: null, created_at: m.created_at };
      return json({ message: m, conversation, duplicate: false });
    }
    if (url.endsWith('/chat/typing')) return json({ ok: true });
    return json({ error: { code: 'HS_NOT_FOUND' } }, 404);
  });
  return { calls, fetchImpl, setConversation: (c: typeof conversation) => (conversation = c) };
}

/** Sahte EventSource: testler olay yayınlar. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, ((e: { data: string }) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, cb: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  emit(type: string, data: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}

function client(server: ReturnType<typeof fakeServer>, extra: Partial<ConstructorParameters<typeof ChatClient>[0]> = {}) {
  const logger = new Logger();
  const api = new SdkApi({ baseUrl: 'https://api.test', appId: 'app_1', logger, fetch: server.fetchImpl, sleep: async () => undefined, maxRetries: 0 });
  const storage = new MemoryStore();
  return new ChatClient({
    api: () => api,
    appId: () => 'app_1',
    storage: () => storage,
    logger,
    language: () => 'tr',
    identity: () => ({ externalId: null, identityHash: null, subscriptionId: null, tokenHash: null }),
    allowed: () => true,
    fetch: server.fetchImpl,
    eventSource: FakeEventSource as unknown as typeof EventSource,
    pollMs: 10,
    ...extra,
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  FakeEventSource.last = null;
});

describe('ChatClient', () => {
  it('ziyaretçi kimliği bir kez üretilir ve saklanır; GET belirteci `token`, POST `visitor_token` taşır', async () => {
    const server = fakeServer();
    const c = client(server);
    const v1 = c.visitor();
    expect(v1.visitorId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(v1.token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(c.visitor()).toMatchObject({ visitorId: v1.visitorId, token: v1.token });
    await c.refresh();
    expect(server.calls[0]!.url).toContain(`visitor_id=${v1.visitorId}`);
    expect(server.calls[0]!.url).toContain(`token=${v1.token}`);
    await c.send('Merhaba');
    const post = server.calls.find((x) => x.method === 'POST')!;
    expect(post.body).toMatchObject({ visitor_id: v1.visitorId, visitor_token: v1.token, text: 'Merhaba' });
    expect(post.body!.client_message_id).toMatch(/^web-/);
  });

  it('iyimser mesaj sunucu yanıtıyla birleşir; sıra numarasına göre sıralanır', async () => {
    const server = fakeServer();
    const c = client(server);
    const seen: number[] = [];
    c.on('messages', (list) => seen.push(list.length));
    await c.send('bir');
    await c.send('iki');
    expect(c.messages.map((m) => [m.seq, m.text, m.pending])).toEqual([
      [1, 'bir', false],
      [2, 'iki', false],
    ]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('gönderilemeyen mesaj aynı istemci kimliğiyle yeniden denenir (çift kayıt yok)', async () => {
    const server = fakeServer({ failSendTimes: 1 });
    const c = client(server);
    await expect(c.send('tekrar')).rejects.toThrow();
    const failed = c.messages.find((m) => m.failed)!;
    expect(failed.client_message_id).toBeTruthy();
    await c.retry(failed.client_message_id!);
    const posts = server.calls.filter((x) => x.method === 'POST' && x.url.endsWith('/chat/messages'));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body!.client_message_id).toBe(posts[1]!.body!.client_message_id);
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]).toMatchObject({ seq: 1, failed: false, pending: false });
  });

  it('akış: mesaj, yazıyor ve okundu olayları; temsilci mesajı okunmamışı artırır ve teslim işaretçisi gönderir', async () => {
    const server = fakeServer({ conversationExists: true });
    const c = client(server);
    const typing: boolean[] = [];
    c.on('typing', (d) => typing.push(d.typing));
    await c.connect();
    expect(c.unread).toBe(2);
    const es = FakeEventSource.last!;
    expect(es.url).toContain('/chat/stream?');
    // Widget `messages` olayında okundu işaretler; sayaç bu olaydan önce güncellenmiş olmalı.
    const unreadAtMessages: [number, boolean][] = [];
    c.on('messages', () => unreadAtMessages.push([c.unread, c.hasUnread]));
    es.emit('typing', { typing: true, name: 'Ayşe' });
    es.emit('message', msg({ id: 'cvm_9', seq: 9 }));
    expect(c.messages.map((m) => m.seq)).toEqual([9]);
    expect(c.unread).toBe(3);
    expect(unreadAtMessages[0]).toEqual([3, true]);
    expect(typing).toEqual([true, false]);
    await Promise.resolve();
    expect(server.calls.some((x) => x.url.endsWith('/chat/ack') && x.body?.delivered_seq === 9)).toBe(true);
    // Aynı mesaj ikinci kez gelirse tekrar eklenmez.
    es.emit('message', msg({ id: 'cvm_9', seq: 9 }));
    expect(c.messages).toHaveLength(1);
    await c.markRead();
    expect(c.unread).toBe(0);
    expect(c.hasUnread).toBe(false);
    c.disconnect();
    expect(es.closed).toBe(true);
  });

  it('EventSource yoksa yoklamayla eksik mesajları alır', async () => {
    const server = fakeServer({ conversationExists: true });
    const c = client(server, { eventSource: null });
    const states: string[] = [];
    c.on('connection', (s) => states.push(s));
    await c.connect();
    await new Promise((r) => setTimeout(r, 40));
    expect(states).toContain('polling');
    expect(server.calls.some((x) => x.url.includes('after_seq='))).toBe(true);
    c.disconnect();
  });

  it('kimlik bağlama: login + push aboneliği kanıtıyla tek istek', async () => {
    const server = fakeServer();
    const c = client(server, { identity: () => ({ externalId: 'u-1', identityHash: 'a'.repeat(64), subscriptionId: 'sub_1', tokenHash: 'b'.repeat(64) }) });
    await c.identify();
    await c.identify();
    const calls = server.calls.filter((x) => x.url.endsWith('/chat/identify'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ external_id: 'u-1', identity_hash: 'a'.repeat(64), subscription_id: 'sub_1', token_hash: 'b'.repeat(64) });
  });

  it('gizlilik onayı yoksa istek atılmaz', async () => {
    const server = fakeServer();
    const c = client(server, { allowed: () => false });
    await expect(c.refresh()).rejects.toThrow();
    expect(server.calls).toHaveLength(0);
  });

  it('mergeMessages: bekleyen mesajlar sonda, sunucu kopyası iyimser kaydı değiştirir', () => {
    const pending = msg({ id: 'local-x', seq: Number.MAX_SAFE_INTEGER, client_message_id: 'web-1', sender: 'visitor', pending: true });
    const merged = mergeMessages([pending, msg({ id: 'a', seq: 3 })], [msg({ id: 'b', seq: 2 })]);
    expect(merged.map((m) => m.id)).toEqual(['b', 'a', 'local-x']);
    const replaced = mergeMessages(merged, [msg({ id: 'cvm_5', seq: 5, client_message_id: 'web-1', sender: 'visitor' })]);
    expect(replaced.map((m) => m.id)).toEqual(['b', 'a', 'cvm_5']);
    expect(randomId(10)).toHaveLength(10);
  });
});

describe('sohbet widget\'ı', () => {
  it('başlatıcı erişilebilir; açınca panel, karşılama ve log rolü; Enter gönderir; Esc kapatır', async () => {
    const server = fakeServer();
    const c = client(server);
    const handle = mountChatWidget(c, { config, language: 'tr' });
    const root = document.querySelector('[data-pushizo-chat]')!.shadowRoot!;
    const launcher = root.querySelector<HTMLButtonElement>('[data-testid="pushizo-chat-launcher"]')!;
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
    expect(launcher.getAttribute('aria-label')).toContain('Sohbeti aç');
    launcher.click();
    expect(handle.isOpen()).toBe(true);
    expect(launcher.getAttribute('aria-expanded')).toBe('true');
    const panel = root.querySelector('[role="dialog"]')!;
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('[role="log"]')!.getAttribute('aria-live')).toBe('polite');
    expect(root.textContent).toContain('Size nasıl yardımcı olabiliriz?');
    const input = root.querySelector<HTMLTextAreaElement>('[data-testid="pushizo-chat-input"]')!;
    input.value = 'Siparişim nerede?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="pushizo-chat-message"]').length).toBe(1));
    expect(root.querySelector('[data-testid="pushizo-chat-status"]')!.textContent).toBe('Gönderildi');
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(handle.isOpen()).toBe(false);
    handle.destroy();
    expect(document.querySelector('[data-pushizo-chat]')).toBeNull();
  });

  it('çevrimdışıyken e-posta bırakma formu gösterilir ve gönderilir', async () => {
    const server = fakeServer();
    const c = client(server);
    const handle = mountChatWidget(c, { config: { ...config, online: false, offline_message: 'Mesai dışındayız.' }, language: 'tr' });
    const root = document.querySelector('[data-pushizo-chat]')!.shadowRoot!;
    handle.open();
    expect(root.textContent).toContain('Mesai dışındayız.');
    const email = root.querySelector<HTMLInputElement>('input[type="email"]')!;
    const text = root.querySelector<HTMLTextAreaElement>('.form textarea')!;
    email.value = 'ziyaretci@example.com';
    text.value = 'Yarın arayın lütfen';
    root.querySelector<HTMLFormElement>('.form')!.requestSubmit();
    await vi.waitFor(() => expect(server.calls.some((x) => x.url.endsWith('/chat/offline'))).toBe(true));
    expect(server.calls.find((x) => x.url.endsWith('/chat/offline'))!.body).toMatchObject({ email: 'ziyaretci@example.com', text: 'Yarın arayın lütfen' });
    await vi.waitFor(() => expect(root.textContent).toContain('Teşekkürler'));
    handle.destroy();
  });

  it('temsilci okuyunca ziyaretçi mesajında "Okundu" görünür; geçersiz renk varsayılana düşer', async () => {
    const server = fakeServer({ conversationExists: true });
    const c = client(server);
    const handle = mountChatWidget(c, { config: { ...config, color: 'red;}body{display:none' }, language: 'en' });
    const root = document.querySelector('[data-pushizo-chat]')!.shadowRoot!;
    expect(root.querySelector('style')!.textContent).toContain('--hs-accent:#3b5bdb');
    handle.open();
    await vi.waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    await c.send('hello');
    FakeEventSource.last!.emit('read', { seq: 1 });
    await vi.waitFor(() => expect(root.querySelector('[data-testid="pushizo-chat-status"]')!.textContent).toBe('Read'));
    handle.destroy();
  });
});
