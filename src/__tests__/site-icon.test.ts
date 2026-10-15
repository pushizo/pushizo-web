// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { detectSiteIcon } from '../browser/push.js';
import { parsePushPayload, toNotificationOptions } from '../sw/payload.js';

describe('varsayılan bildirim ikonu', () => {
  it('payload ikonu yoksa site ikonu kullanılır; payload ikonu önceliklidir', () => {
    const p = parsePushPayload(JSON.stringify({ title: 'Merhaba', body: 'x' }));
    expect(toNotificationOptions(p, 'https://site.example/apple-touch-icon.png').options.icon).toBe('https://site.example/apple-touch-icon.png');
    const withIcon = parsePushPayload(JSON.stringify({ title: 'Merhaba', icon: 'https://cdn.example/own.png' }));
    expect(toNotificationOptions(withIcon, 'https://site.example/i.png').options.icon).toBe('https://cdn.example/own.png');
  });

  it('detectSiteIcon: apple-touch-icon > en büyük icon > /favicon.ico; data: adres reddedilir', () => {
    document.head.innerHTML = '<link rel="icon" sizes="32x32" href="/i32.png"><link rel="icon" sizes="192x192" href="/i192.png">';
    expect(detectSiteIcon(document)).toBe(new URL('/i192.png', document.baseURI).href);
    document.head.innerHTML += '<link rel="apple-touch-icon" href="/apple.png">';
    expect(detectSiteIcon(document)).toBe(new URL('/apple.png', document.baseURI).href);
    document.head.innerHTML = '';
    expect(detectSiteIcon(document)).toBe(new URL('/favicon.ico', document.baseURI).href);
    document.head.innerHTML = '<link rel="icon" href="data:image/png;base64,AAAA">';
    expect(detectSiteIcon(document)).toBeUndefined();
    document.head.innerHTML = '';
  });
});
