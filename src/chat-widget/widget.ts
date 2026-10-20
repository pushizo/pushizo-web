import type { ChatClient, ChatConfig, ChatMessage, ChatWidgetHandle, ChatWidgetMountOptions } from '../core/chat.js';

/**
 * Canlı sohbet widget'ı (ADR-0040): ayrı paket (`PushizoChatWidget.js` / `@pushizo/web/chat-widget`), ana SDK'ya
 * yük getirmez. Açık Shadow DOM ile sayfa stillerinden yalıtılır. Erişilebilirlik: başlatıcı `aria-expanded`, panel
 * `role="dialog"`, mesaj listesi `role="log"` + `aria-live="polite"`, Esc ile kapanır ve odak başlatıcıya döner;
 * Enter gönderir, Shift+Enter satır ekler. Tema app ayarından (renk, konum, açık/koyu/otomatik).
 */

const TEXT = {
  tr: {
    open: 'Sohbeti aç',
    close: 'Sohbeti kapat',
    unread: (n: number) => `${n} okunmamış mesaj`,
    title: 'Bize yazın',
    online: 'Çevrimiçi',
    offline: 'Şu an çevrimdışıyız',
    placeholder: 'Mesajınızı yazın…',
    send: 'Gönder',
    attach: 'Dosya ekle',
    typing: (name: string | null) => `${name ?? 'Temsilci'} yazıyor…`,
    read: 'Okundu',
    delivered: 'İletildi',
    sent: 'Gönderildi',
    sending: 'Gönderiliyor…',
    failed: 'Gönderilemedi',
    retry: 'Yeniden dene',
    bot: 'Asistan',
    agent: 'Temsilci',
    you: 'Siz',
    offlineDefault: 'Şu anda çevrimdışıyız. E-posta adresinizi bırakın, size dönelim.',
    email: 'E-posta adresiniz',
    name: 'Adınız (isteğe bağlı)',
    message: 'Mesajınız',
    leave: 'Mesaj bırak',
    thanks: 'Teşekkürler! Mesajınızı aldık, e-posta ile döneceğiz.',
    start: 'Sohbete başla',
    emailRequired: 'Sohbete başlamak için e-posta adresinizi girin.',
    invalidEmail: 'Geçerli bir e-posta adresi girin.',
    tooLarge: (mb: number) => `Dosya en fazla ${mb} MB olabilir.`,
    error: 'Bir sorun oluştu. Lütfen tekrar deneyin.',
    download: 'İndir',
    resolved: 'Konuşma çözüldü olarak işaretlendi. Yeni mesajla yeniden açabilirsiniz.',
  },
  en: {
    open: 'Open chat',
    close: 'Close chat',
    unread: (n: number) => `${n} unread message${n === 1 ? '' : 's'}`,
    title: 'Chat with us',
    online: 'Online',
    offline: 'We are offline',
    placeholder: 'Type your message…',
    send: 'Send',
    attach: 'Attach a file',
    typing: (name: string | null) => `${name ?? 'Agent'} is typing…`,
    read: 'Read',
    delivered: 'Delivered',
    sent: 'Sent',
    sending: 'Sending…',
    failed: 'Not sent',
    retry: 'Retry',
    bot: 'Assistant',
    agent: 'Agent',
    you: 'You',
    offlineDefault: "We're offline right now. Leave your email and we'll get back to you.",
    email: 'Your email',
    name: 'Your name (optional)',
    message: 'Your message',
    leave: 'Leave a message',
    thanks: 'Thanks! We received your message and will reply by email.',
    start: 'Start chat',
    emailRequired: 'Enter your email to start the chat.',
    invalidEmail: 'Enter a valid email address.',
    tooLarge: (mb: number) => `Files can be up to ${mb} MB.`,
    error: 'Something went wrong. Please try again.',
    download: 'Download',
    resolved: 'This conversation was marked as resolved. Send a new message to reopen it.',
  },
};
type Strings = (typeof TEXT)['tr'];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Renk: yalnızca #rrggbb kabul edilir (CSS enjeksiyonu yok). */
function safeColor(value: string | null | undefined, fallback: string): string {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function styles(color: string, textColor: string, position: 'right' | 'left', theme: ChatConfig['theme']): string {
  const side = position === 'left' ? 'left' : 'right';
  const dark = `--hs-bg:#1f2329;--hs-fg:#e8eaed;--hs-muted:#9aa0a6;--hs-bubble:#2d3238;--hs-border:#3c4148;--hs-input:#161a1f;`;
  const light = `--hs-bg:#ffffff;--hs-fg:#1f2329;--hs-muted:#5f6368;--hs-bubble:#f1f3f4;--hs-border:#dadce0;--hs-input:#ffffff;`;
  const themeVars = theme === 'dark' ? dark : light;
  const auto = theme === 'auto' ? `@media (prefers-color-scheme: dark){:host{${dark}}}` : '';
  return `
:host{all:initial;${themeVars}--hs-accent:${color};--hs-on-accent:${textColor};font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.4}
${auto}
*{box-sizing:border-box}
.launcher{position:fixed;bottom:20px;${side}:20px;width:56px;height:56px;border-radius:50%;border:0;background:var(--hs-accent);color:var(--hs-on-accent);cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000;display:flex;align-items:center;justify-content:center}
.launcher:focus-visible,button:focus-visible,textarea:focus-visible,input:focus-visible{outline:3px solid var(--hs-accent);outline-offset:2px}
.badge{position:absolute;top:-4px;${side === 'right' ? 'left' : 'right'}:-4px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#d93025;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center}
.badge[hidden]{display:none}
.panel{position:fixed;bottom:88px;${side}:20px;width:min(380px,calc(100vw - 32px));height:min(600px,calc(100vh - 120px));background:var(--hs-bg);color:var(--hs-fg);border:1px solid var(--hs-border);border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;z-index:2147483000}
.panel[hidden]{display:none}
@media (max-width:480px){.panel{bottom:0;${side}:0;width:100vw;height:100dvh;border-radius:0}}
.head{background:var(--hs-accent);color:var(--hs-on-accent);padding:14px 16px;display:flex;align-items:center;gap:8px}
.head h2{font-size:16px;margin:0;flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status{font-size:12px;opacity:.9}
.icon-btn{background:transparent;border:0;color:inherit;cursor:pointer;padding:6px;border-radius:6px;display:flex}
.log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.greeting{color:var(--hs-muted);font-size:13px;text-align:center;padding:4px 8px}
.msg{max-width:82%;display:flex;flex-direction:column;gap:2px}
.msg.mine{align-self:flex-end;align-items:flex-end}
.msg.theirs{align-self:flex-start}
.bubble{padding:8px 12px;border-radius:14px;background:var(--hs-bubble);white-space:pre-wrap;word-break:break-word}
.mine .bubble{background:var(--hs-accent);color:var(--hs-on-accent)}
.meta{font-size:11px;color:var(--hs-muted)}
.att img{max-width:220px;max-height:220px;border-radius:8px;display:block}
.att a{color:inherit}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.chip{border:1px solid var(--hs-accent);color:var(--hs-fg);background:transparent;border-radius:16px;padding:4px 10px;cursor:pointer;font:inherit}
.typing{font-size:12px;color:var(--hs-muted);padding:0 12px 6px;min-height:18px}
.composer{border-top:1px solid var(--hs-border);padding:8px;display:flex;gap:6px;align-items:flex-end}
textarea,input{flex:1;resize:none;border:1px solid var(--hs-border);border-radius:10px;padding:8px 10px;font:inherit;color:var(--hs-fg);background:var(--hs-input);max-height:120px;min-width:0}
.send{background:var(--hs-accent);color:var(--hs-on-accent);border:0;border-radius:10px;padding:8px 12px;cursor:pointer;font:inherit;font-weight:600}
.send:disabled{opacity:.5;cursor:default}
.form{padding:16px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
.form p{margin:0;color:var(--hs-muted)}
.error{color:#d93025;font-size:12px;min-height:16px}
.retry{background:none;border:0;color:#d93025;cursor:pointer;font-size:11px;text-decoration:underline;padding:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
}

const CHAT_ICON = '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/></svg>';
const CLOSE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>';
const CLIP_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M16.5 6.5v10a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10.5a1.5 1.5 0 0 1-3 0V6.5H9v9a3 3 0 0 0 6 0V5a4.5 4.5 0 0 0-9 0v11.5a6 6 0 0 0 12 0v-10z"/></svg>';

/** Widget'ı bağlar; dönen tutamaç aç/kapat/kaldır sağlar. */
export function mountChatWidget(client: ChatClient, options: ChatWidgetMountOptions): ChatWidgetHandle {
  const cfg = options.config;
  const t: Strings = options.language.startsWith('tr') ? TEXT.tr : TEXT.en;
  const host = el('div', { 'data-pushizo-chat': '' });
  (options.container ?? document.body).appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const style = el('style');
  style.textContent = styles(safeColor(options.color ?? cfg.color, '#3b5bdb'), safeColor(cfg.text_color, '#ffffff'), options.position ?? cfg.position, options.theme ?? cfg.theme);
  root.appendChild(style);

  // ---------------------------------------------------------------- iskelet
  const panelId = 'hs-chat-panel';
  const launcher = el('button', { class: 'launcher', type: 'button', 'aria-controls': panelId, 'aria-expanded': 'false', 'aria-label': t.open, 'data-testid': 'pushizo-chat-launcher' });
  launcher.innerHTML = CHAT_ICON;
  const badge = el('span', { class: 'badge', 'aria-hidden': 'true' });
  badge.hidden = true;
  launcher.appendChild(badge);
  if (options.hideLauncher) launcher.style.display = 'none';

  const panel = el('div', { class: 'panel', id: panelId, role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'hs-chat-title' });
  panel.hidden = true;
  const head = el('div', { class: 'head' });
  const titleWrap = el('div', { style: 'flex:1;min-width:0' });
  const title = el('h2', { id: 'hs-chat-title' }, cfg.title ?? t.title);
  const status = el('div', { class: 'status', 'data-testid': 'pushizo-chat-online' }, cfg.online ? t.online : t.offline);
  titleWrap.append(title, status);
  const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': t.close });
  closeBtn.innerHTML = CLOSE_ICON;
  head.append(titleWrap, closeBtn);

  const log = el('div', { class: 'log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', tabindex: '0', 'aria-label': cfg.title ?? t.title });
  const typingLine = el('div', { class: 'typing', 'aria-live': 'polite' });
  const body = el('div', { style: 'flex:1;display:flex;flex-direction:column;min-height:0' });
  body.append(log, typingLine);

  const composer = el('form', { class: 'composer' });
  const fileInput = el('input', { type: 'file', class: 'sr', id: 'hs-chat-file', accept: cfg.attachments.types.join(','), tabindex: '-1', 'aria-hidden': 'true' });
  const attachBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': t.attach, style: 'color:var(--hs-muted)' });
  attachBtn.innerHTML = CLIP_ICON;
  if (!cfg.attachments.enabled) attachBtn.style.display = 'none';
  const input = el('textarea', { rows: '1', placeholder: t.placeholder, 'aria-label': t.placeholder, maxlength: '4000', 'data-testid': 'pushizo-chat-input' });
  const sendBtn = el('button', { class: 'send', type: 'submit', 'data-testid': 'pushizo-chat-send' }, t.send);
  const errorLine = el('div', { class: 'error sr', role: 'alert' });
  composer.append(fileInput, attachBtn, input, sendBtn);
  panel.append(head, body, composer, errorLine);
  root.append(launcher, panel);

  // ---------------------------------------------------------------- durum
  let opened = false;
  let email = options.email ?? null;
  const name = options.name ?? null;
  const unsubs: (() => void)[] = [];

  const showError = (msg: string) => {
    errorLine.textContent = msg;
    errorLine.classList.remove('sr');
    setTimeout(() => {
      errorLine.textContent = '';
      errorLine.classList.add('sr');
    }, 5000);
  };

  const statusText = (m: ChatMessage): string => (m.failed ? t.failed : m.pending ? t.sending : m.status === 'read' ? t.read : m.status === 'delivered' ? t.delivered : t.sent);

  const renderMessage = (m: ChatMessage, isLastMine: boolean): HTMLElement => {
    const mine = m.sender === 'visitor';
    const wrap = el('div', { class: `msg ${mine ? 'mine' : 'theirs'}`, 'data-testid': 'pushizo-chat-message', 'data-seq': String(m.seq), 'data-sender': m.sender });
    if (!mine) wrap.append(el('span', { class: 'meta' }, m.author_name ?? (m.sender === 'bot' ? t.bot : m.sender === 'agent' ? t.agent : '')));
    const bubble = el('div', { class: 'bubble' });
    const isOnlyFileName = m.attachments.length > 0 && m.text === m.attachments[0]!.name;
    if (m.text && !isOnlyFileName) bubble.append(document.createTextNode(m.text));
    for (const a of m.attachments) {
      const att = el('div', { class: 'att' });
      if (a.id !== 'local' && a.type.startsWith('image/')) {
        const img = el('img', { src: client.attachmentUrl(a.id), alt: a.name, loading: 'lazy' });
        att.append(img);
      } else if (a.id !== 'local') {
        att.append(el('a', { href: client.attachmentUrl(a.id, true), target: '_blank', rel: 'noopener noreferrer' }, `${a.name} — ${t.download}`));
      } else att.append(document.createTextNode(a.name));
      bubble.append(att);
    }
    wrap.append(bubble);
    if (m.quick_replies?.length && !mine) {
      const chips = el('div', { class: 'chips' });
      for (const q of m.quick_replies) {
        const chip = el('button', { class: 'chip', type: 'button' }, q.label);
        chip.addEventListener('click', () => void send(q.label, q.id));
        chips.append(chip);
      }
      wrap.append(chips);
    }
    if (mine && (isLastMine || m.failed || m.pending)) {
      const meta = el('span', { class: 'meta', 'data-testid': 'pushizo-chat-status' }, statusText(m));
      if (m.failed && m.client_message_id) {
        const retry = el('button', { class: 'retry', type: 'button' }, t.retry);
        retry.addEventListener('click', () => void client.retry(m.client_message_id!).catch(() => showError(t.error)));
        meta.append(' · ', retry);
      }
      wrap.append(meta);
    }
    return wrap;
  };

  const renderLog = () => {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = '';
    if (cfg.greeting) log.append(el('div', { class: 'greeting' }, cfg.greeting));
    const msgs = client.messages;
    let lastMine = -1;
    msgs.forEach((m, i) => {
      if (m.sender === 'visitor') lastMine = i;
    });
    // Son hızlı yanıtlar yalnızca son mesajda gösterilir (eski bot sorularına tıklanmasın).
    msgs.forEach((m, i) => log.append(renderMessage(i === msgs.length - 1 ? m : { ...m, quick_replies: null }, i === lastMine)));
    if (client.conversation?.status === 'resolved' || client.conversation?.status === 'closed') log.append(el('div', { class: 'greeting' }, t.resolved));
    if (atBottom || msgs[msgs.length - 1]?.sender === 'visitor') log.scrollTop = log.scrollHeight;
  };

  const renderBadge = (n: number) => {
    badge.hidden = n <= 0 || opened;
    badge.textContent = n > 99 ? '99+' : String(n);
    launcher.setAttribute('aria-label', n > 0 ? `${t.open} (${t.unread(n)})` : t.open);
  };

  // ---------------------------------------------------------------- çevrimdışı ve e-posta formları
  const showOfflineForm = () => {
    composer.style.display = 'none';
    body.textContent = '';
    const form = el('form', { class: 'form', 'aria-label': t.leave });
    form.append(el('p', {}, cfg.offline_message ?? t.offlineDefault));
    const emailIn = el('input', { type: 'email', required: '', autocomplete: 'email', 'aria-label': t.email, placeholder: t.email, value: email ?? '' });
    const nameIn = el('input', { type: 'text', autocomplete: 'name', 'aria-label': t.name, placeholder: t.name, value: name ?? '' });
    const msgIn = el('textarea', { rows: '4', required: '', 'aria-label': t.message, placeholder: t.message, maxlength: '4000' });
    const err = el('div', { class: 'error', role: 'alert' });
    const submit = el('button', { class: 'send', type: 'submit' }, t.leave);
    form.append(emailIn, nameIn, msgIn, err, submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!EMAIL.test(emailIn.value.trim())) {
        err.textContent = t.invalidEmail;
        emailIn.focus();
        return;
      }
      if (!msgIn.value.trim()) return;
      submit.disabled = true;
      void client
        .leaveOfflineMessage({ email: emailIn.value.trim(), text: msgIn.value.trim(), ...(nameIn.value.trim() ? { name: nameIn.value.trim() } : {}) })
        .then(() => {
          form.textContent = '';
          form.append(el('p', { role: 'status' }, t.thanks));
        })
        .catch(() => {
          err.textContent = t.error;
          submit.disabled = false;
        });
    });
    body.append(form);
  };

  const requireEmailFirst = (): Promise<boolean> =>
    new Promise((resolve) => {
      if (!cfg.require_email || email || client.conversation) return resolve(true);
      composer.style.display = 'none';
      const form = el('form', { class: 'form' });
      form.append(el('p', {}, t.emailRequired));
      const emailIn = el('input', { type: 'email', required: '', autocomplete: 'email', 'aria-label': t.email, placeholder: t.email });
      const err = el('div', { class: 'error', role: 'alert' });
      const submit = el('button', { class: 'send', type: 'submit' }, t.start);
      form.append(emailIn, err, submit);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!EMAIL.test(emailIn.value.trim())) {
          err.textContent = t.invalidEmail;
          return;
        }
        email = emailIn.value.trim();
        form.remove();
        composer.style.display = '';
        resolve(true);
        input.focus();
      });
      body.insertBefore(form, typingLine);
      emailIn.focus();
    });

  // ---------------------------------------------------------------- gönderim
  async function send(text: string, optionId?: string) {
    const body = text.trim();
    if (!body) return;
    if (!(await requireEmailFirst())) return;
    try {
      await client.send(body, { ...(optionId ? { optionId } : {}), ...(name ? { name } : {}), ...(email ? { email } : {}) });
    } catch {
      showError(t.error);
    }
  }

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value;
    input.value = '';
    client.typing(false);
    void send(value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    client.typing(input.value.length > 0);
    input.style.height = 'auto';
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  });
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > cfg.attachments.max_bytes) {
      showError(t.tooLarge(Math.round(cfg.attachments.max_bytes / 1024 / 1024)));
      return;
    }
    void client.sendFile(file, file.name, input.value.trim()).catch(() => showError(t.error));
    input.value = '';
  });

  // ---------------------------------------------------------------- aç/kapat
  const markReadIfVisible = () => {
    if (opened && document.visibilityState === 'visible' && client.unread > 0) void client.markRead().catch(() => undefined);
  };

  const open = () => {
    if (opened) return;
    opened = true;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    renderBadge(client.unread);
    if (!cfg.online && !client.conversation && cfg.collect_email_offline) showOfflineForm();
    void client
      .connect()
      .then(() => {
        renderLog();
        markReadIfVisible();
      })
      .catch(() => showError(t.error));
    renderLog();
    setTimeout(() => (composer.style.display === 'none' ? panel.querySelector<HTMLInputElement>('input')?.focus() : input.focus()), 0);
  };
  const close = () => {
    if (!opened) return;
    opened = false;
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    renderBadge(client.unread);
    launcher.focus();
  };
  const toggle = () => (opened ? close() : open());

  launcher.addEventListener('click', toggle);
  closeBtn.addEventListener('click', close);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  const onVisibility = () => markReadIfVisible();
  document.addEventListener('visibilitychange', onVisibility);

  unsubs.push(
    client.on('messages', () => {
      renderLog();
      markReadIfVisible();
    }),
    client.on('unread', (n) => renderBadge(n)),
    client.on('typing', (d) => {
      typingLine.textContent = d.typing ? t.typing(d.name) : '';
    }),
    client.on('conversation', () => renderLog()),
  );
  // Kapalıyken de okunmamış sayısı için konuşma durumu okunur (akış açılmaz).
  void client.refresh().then(() => renderBadge(client.unread)).catch(() => undefined);

  return {
    open,
    close,
    toggle,
    isOpen: () => opened,
    destroy: () => {
      for (const u of unsubs) u();
      document.removeEventListener('visibilitychange', onVisibility);
      client.disconnect();
      host.remove();
    },
  };
}
