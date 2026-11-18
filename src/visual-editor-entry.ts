import { startVisualEditor } from './browser/visual-editor.js';

/** CDN girişi (ADR-0083 §4): ana SDK `?pushizo_editor=` gördüğünde bu paketi yükler; ayarlar `__pushizoEditor`'dadır. */
const cfg = (globalThis as unknown as { __pushizoEditor?: { nonce: string; origins: string[] } }).__pushizoEditor;
if (cfg && typeof document !== 'undefined') startVisualEditor(cfg);
