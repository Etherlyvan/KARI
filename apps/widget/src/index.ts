import { styles } from './styles.js';
import { CharacterController } from './companion/CharacterController.js';
import { DragController } from './companion/DragController.js';
import type { BehaviorConfig, Rect } from './companion/types.js';
export { PixelKariRenderer, buildPixelFrame, PIXEL_PALETTE } from './pixel-art.js';
export { BehaviorSystem, DEFAULT_BEHAVIOR_CONFIG } from './companion/BehaviorSystem.js';
export { AnimationController } from './companion/AnimationController.js';
export { SpriteRenderer } from './companion/SpriteRenderer.js';

type Anchor = 'bottom-right' | 'bottom-left' | 'middle-right' | 'middle-left';
type State = 'idle' | 'think' | 'talk' | 'happy' | 'error';
type Reply = { text: string; sources?: Array<{ title: string; url: string }>; mode?: string; emotion?: unknown; intent?: unknown };
type FreePosition = { right: number; bottom: number };
const anchors: Anchor[] = ['bottom-right', 'bottom-left', 'middle-right', 'middle-left'];
const moduleUrl = new URL(import.meta.url);
const defaultApi = new URL('/kari/api', moduleUrl).href;
const defaultAvatar = new URL('assets/kari.png', moduleUrl).href;
const greeting = 'Hai! Aku KARI. Ada yang bisa kubantu?';

function allowedUrl(value: string, base: string): URL {
  const url = new URL(value, base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || !['https:', ...(local ? ['http:'] : [])].includes(url.protocol)) throw new Error('URL KARI harus HTTPS.');
  return url;
}
function normalize(value: string) { return value.toLowerCase().normalize('NFKC').replace(/[.,!?]/gu, '').trim().replace(/\s+/gu, ' '); }

/** Framework-independent, public-only companion. Attributes never grant owner access. */
export class KariWidget extends HTMLElement {
  static observedAttributes = ['api-base', 'site-id', 'position', 'avatar-src', 'appearance', 'behavior-config'];
  private root: ShadowRoot;
  private cleanups: Array<() => void> = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private requestTimer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private observer?: ResizeObserver;
  private token?: string;
  private expires = 0;
  private anchor: Anchor = 'bottom-right';
  private state: State = 'idle';
  private open = false;
  private hiddenByUser = false;
  private pinned = false;
  private busy = false;
  private composing = false;
  private pointing = false;
  private hovering = false;
  private reduced = false;
  private mobile = false;
  private roamingOptIn = false;
  private calm = false;
  private lastGlitch = 0;
  private lastInteraction = 0;
  private lastInputAt = 0;
  private requestSequence = 0;
  private apiBase = defaultApi;
  private siteId = 'portfolio';
  private configError = false;
  private character?: CharacterController;
  private pixelObserver?: MutationObserver;
  private freePosition?: FreePosition;
  private dragController?: DragController;
  private dragPrevious?: FreePosition;
  private dropTimer?: ReturnType<typeof setTimeout>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private effectsSuppressedUntil = 0;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    // This string contains only developer-authored UI. All network/user text uses textContent.
    this.root.innerHTML = `<style>${styles}</style><div class="unit"><div class="conversation" hidden>
      <div class="speech" id="kari-speech" role="region" aria-label="Jawaban KARI" hidden><button class="close" type="button" aria-label="Tutup bubble">×</button><p class="text"></p><div class="sources"></div></div>
      <form class="input-wrap" hidden><label class="sr-only" for="kari-message">Pesan untuk KARI</label><input id="kari-message" name="message" maxlength="1200" autocomplete="off" placeholder="Ngobrol sama KARI..."/><button class="send" type="submit" aria-label="Kirim pesan">➤</button><button class="stop" type="button" hidden>Stop</button></form>
      </div><div class="base"><button class="launcher" type="button" aria-label="Buka chat KARI" aria-controls="kari-speech" aria-expanded="false"><span class="figure"><canvas class="pixel-avatar" width="48" height="72" aria-hidden="true" hidden></canvas><img class="avatar" alt="" draggable="false"/><span class="fallback" aria-hidden="true"><span class="hair"></span><span class="body"></span><span class="core"></span><span class="face"><span class="eyes"></span><span class="smile"></span></span><i class="fragment f1"></i><i class="fragment f2"></i><i class="fragment f3"></i></span></span><span class="status-dot" aria-hidden="true"></span><span class="hint" aria-hidden="true"></span></button></div>
      <button class="reopen" type="button" hidden>Buka KARI</button><div class="sr-only live" role="status" aria-live="polite" aria-atomic="true"></div>
    </div>`;
    this.text.textContent = greeting;
  }
  private element<T extends Element>(selector: string): T { return this.root.querySelector(selector) as T; }
  private get input() { return this.element<HTMLInputElement>('input'); }
  private get text() { return this.element<HTMLParagraphElement>('.text'); }
  private get launcher() { return this.element<HTMLButtonElement>('.launcher'); }
  private get live() { return this.element<HTMLDivElement>('.live'); }
  private get drag() { return this.dragController?.session; }

  connectedCallback() {
    if (this.cleanups.length) return;
    this.lastInteraction = Date.now();
    this.readConfig();
    this.anchor = anchors.includes(this.getAttribute('position') as Anchor) ? this.getAttribute('position') as Anchor : 'bottom-right';
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const mobile = window.matchMedia?.('(max-width: 640px)');
    const preferences = () => { this.reduced = motion?.matches ?? false; this.mobile = mobile?.matches ?? false; this.sync(); this.restartMotion(); };
    this.dragController = new DragController(this.launcher, {
      bounds: () => this.currentBounds(),
      begin: () => { this.touch(); this.clearDrop(); this.dragPrevious = this.freePosition ? { ...this.freePosition } : undefined; },
      lift: () => {
        this.setAttribute('data-dragging', ''); this.removeAttribute('data-glitch'); this.effectsSuppressedUntil = Date.now() + 5000;
        this.character?.dragStart();
        const drag = this.drag!; this.setFreePosition(drag.left, drag.top);
        this.live.textContent = 'KARI diangkat. Seret untuk memindahkan, lepas untuk menaruh, atau Escape untuk membatalkan.';
      },
      move: (point, velocity) => { this.touch(); this.setFreePosition(point.x, point.y); this.character?.dragVelocity(velocity); },
      release: (cancelled, drag) => {
        this.pointing = false; this.removeAttribute('data-dragging');
        if (!drag.active) return;
        this.removeAttribute('data-glitch'); this.effectsSuppressedUntil = Date.now() + 5000;
        if (cancelled) {
          this.freePosition = this.dragPrevious; this.toggleAttribute('data-free-position', !!this.freePosition); this.place(this.anchor);
          this.live.textContent = 'Pemindahan KARI dibatalkan.';
        } else {
          this.place(this.anchor); this.pinned = false; this.touch(); this.sync();
          this.live.textContent = 'KARI diletakkan. Ia akan kembali ke tepi setelah beberapa saat tanpa interaksi.';
          if (!this.character && !this.reduced && !this.calm && this.isConnected && document.visibilityState !== 'hidden') {
            this.setAttribute('data-dropped', '');
            this.dropTimer = setTimeout(() => { this.dropTimer = undefined; this.removeAttribute('data-dropped'); }, 480);
          }
        }
        this.character?.dragEnd(cancelled, drag.velocityY);
      },
    });
    this.listen(motion, 'change', preferences); this.listen(mobile, 'change', preferences);
    this.launcher.title = 'Klik untuk chat. Tahan dan seret untuk mengangkat. Shift + tombol panah untuk memindahkan.';
    this.launcher.setAttribute('aria-keyshortcuts', 'Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight');
    this.listen(this.launcher, 'click', event => {
      if (this.dragController?.consumeClick(event as MouseEvent)) { event.preventDefault(); return; }
      this.touch(); this.setOpen(!this.open);
    });
    this.listen(this.launcher, 'pointerdown', event => this.beginDrag(event as PointerEvent));
    this.listen(window, 'pointermove', event => this.moveDrag(event as PointerEvent));
    this.listen(window, 'pointermove', event => { const pointer = event as PointerEvent; this.character?.cursor(pointer.clientX, pointer.clientY); });
    this.listen(window, 'pointerup', event => { if (this.drag?.id === (event as PointerEvent).pointerId) this.endDrag(false); if (!this.drag) this.pointing = false; });
    this.listen(window, 'pointercancel', event => { if (this.drag?.id === (event as PointerEvent).pointerId) this.endDrag(true); if (!this.drag) this.pointing = false; });
    this.listen(this.launcher, 'lostpointercapture', event => { if (this.drag?.id === (event as PointerEvent).pointerId) this.endDrag(true); });
    this.listen(window, 'blur', () => { this.endDrag(true); this.pointing = false; });
    this.listen(this.launcher, 'keydown', event => {
      const key = event as KeyboardEvent;
      const offsets: Record<string, [number, number]> = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] };
      if (!key.shiftKey || key.altKey || key.ctrlKey || key.metaKey || !offsets[key.key] || this.drag) return;
      key.preventDefault(); const [x, y] = offsets[key.key]; const rect = this.currentBounds();
      this.setFreePosition(rect.left + x, rect.top + y); this.pinDrop(); this.touch(); this.sync();
      this.live.textContent = 'Posisi KARI dipindahkan. Gunakan Shift dan tombol panah untuk menggeser lagi.';
    });
    this.listen(this.element('.close'), 'click', () => this.setOpen(false));
    this.listen(this.element('form'), 'submit', event => { event.preventDefault(); void this.submit(); });
    this.listen(this.element('.stop'), 'click', () => this.stop());
    this.listen(this.element('.reopen'), 'click', () => { this.hiddenByUser = false; this.sync(); this.restartMotion(); this.place(this.anchor); this.launcher.focus(); });
    this.listen(this.root, 'keydown', event => { const key = event as KeyboardEvent; if (key.key === 'Escape' && this.drag) { key.preventDefault(); this.endDrag(true); } else if (key.key === 'Escape' && this.open && !this.hiddenByUser) { key.preventDefault(); this.setOpen(false); } });
    this.listen(this.root, 'focusin', () => this.touch());
    this.listen(this.input, 'input', () => { this.lastInputAt = Date.now(); this.touch(); this.character?.activity(true); });
    this.listen(this.input, 'compositionstart', () => { this.composing = true; this.lastInputAt = Date.now(); this.touch(); });
    this.listen(this.input, 'compositionend', () => { this.composing = false; this.touch(); });
    this.listen(this, 'pointerenter', () => { this.hovering = true; this.touch(); });
    this.listen(this, 'pointerleave', () => { this.hovering = false; });
    this.listen(this, 'pointerdown', () => { this.pointing = true; this.touch(); });
    this.listen(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') this.endDrag(true); this.sync(); this.restartMotion(); });
    this.listen(window, 'resize', () => { this.place(this.anchor); this.character?.geometryChanged(); });
    this.listen(window.visualViewport, 'resize', () => { this.place(this.anchor); this.character?.geometryChanged(); });
    this.listen(window.visualViewport, 'scroll', () => this.place(this.anchor));
    const image = this.element<HTMLImageElement>('.avatar');
    this.listen(image, 'error', () => this.launcher.classList.add('image-missing'));
    this.listen(image, 'load', () => this.launcher.classList.remove('image-missing'));
    this.setAvatar();
    this.pixelObserver = new window.MutationObserver(() => this.refreshPixels());
    this.pixelObserver.observe(this, { attributes: true, attributeFilter: ['data-state', 'data-blink', 'data-glitch', 'data-quiet', 'data-suspended', 'data-dragging'] });
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(entries => { if (entries.some(entry => entry.target === this)) this.place(this.anchor); else this.layoutConversation(); });
      this.observer.observe(this); this.observer.observe(this.element('.conversation'));
    }
    preferences(); this.sync(); this.place(this.anchor);
  }
  disconnectedCallback() {
    this.endDrag(true); this.clearDrop();
    this.dragController?.destroy(); this.dragController = undefined;
    this.character?.destroy(); this.character = undefined;
    if (this.wakeTimer) clearTimeout(this.wakeTimer); this.wakeTimer = undefined;
    this.requestSequence++;
    this.controller?.abort(); this.controller = undefined;
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = undefined;
    this.clearMotion(); this.observer?.disconnect(); this.observer = undefined;
    this.pixelObserver?.disconnect(); this.pixelObserver = undefined;
    this.cleanups.splice(0).forEach(cleanup => cleanup());
    this.token = undefined; this.expires = 0; this.busy = false; this.composing = false; this.pointing = false; this.hovering = false; this.state = 'idle';
  }
  attributeChangedCallback(name: string, previous: string | null, next: string | null) {
    if (previous === next || !this.isConnected) return;
    if (name === 'appearance') {
      this.endDrag(true); this.clearMotion(); if (!this.calm) this.removeAttribute('data-quiet');
      this.setAvatar(); this.sync(); this.place(this.anchor); this.restartMotion(); return;
    }
    if (name === 'behavior-config') { this.character?.destroy(); this.character = undefined; this.setAvatar(); this.sync(); return; }
    if (name === 'avatar-src') { this.setAvatar(); return; }
    if (name === 'position') { if (anchors.includes(next as Anchor)) { this.endDrag(true); this.moveTo(next as Anchor); } return; }
    this.stop(false); this.token = undefined; this.expires = 0; this.readConfig(); this.say(this.configError ? 'Konfigurasi KARI belum valid.' : greeting); this.element('.sources').replaceChildren();
  }
  private listen(target: EventTarget | undefined | null, type: string, handler: EventListener) {
    if (!target) return;
    target.addEventListener(type, handler); this.cleanups.push(() => target.removeEventListener(type, handler));
  }
  private readConfig() {
    try {
      const base = allowedUrl(this.getAttribute('api-base') || defaultApi, document.baseURI);
      if (base.search) throw new Error('API base cannot contain query parameters.');
      this.apiBase = base.href.replace(/\/$/u, '');
      this.siteId = this.getAttribute('site-id') || 'portfolio';
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(this.siteId)) throw new Error('Site ID tidak valid.');
      this.configError = false;
    } catch { this.configError = true; this.say('Konfigurasi KARI belum valid.'); }
  }
  private setAvatar() {
    this.launcher.classList.remove('image-missing');
    const pixel = this.getAttribute('appearance') === 'pixel';
    this.toggleAttribute('data-pixel', pixel);
    this.element<HTMLCanvasElement>('.pixel-avatar').hidden = !pixel;
    this.element<HTMLImageElement>('.avatar').hidden = pixel;
    if (pixel) {
      this.element('.avatar').removeAttribute('src');
      this.character ??= new CharacterController({
        canvas: this.element('.pixel-avatar'), host: this,
        position: () => this.currentBounds(), viewport: () => this.viewport(),
        move: point => this.setFreePosition(point.x, point.y),
        exclusions: () => this.exclusions(), canPlace: rect => this.safePlacement(rect),
        interactionBlocked: () => this.busy || this.composing || this.pointing || (this.open && !!this.input.value.trim()) || Date.now() - this.lastInteraction < 3000,
        glitch: () => this.hasAttribute('data-glitch'), stateChanged: () => {},
      }, this.behaviorConfig());
      this.character.start();
      this.refreshPixels();
      return;
    }
    this.character?.destroy(); this.character = undefined;
    try { this.element<HTMLImageElement>('.avatar').src = allowedUrl(this.getAttribute('avatar-src') || defaultAvatar, document.baseURI).href; }
    catch { this.launcher.classList.add('image-missing'); }
  }
  private refreshPixels() {
    this.character?.redraw();
  }
  private touch() { this.lastInteraction = Date.now(); if (!this.calm) this.removeAttribute('data-quiet'); this.character?.activity(); }
  private setOpen(value: boolean) {
    if (!value && this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = undefined; }
    if (value && !this.open && this.character) {
      if (this.wakeTimer) return;
      const wait = this.character.wake();
      if (wait > 0) { this.wakeTimer = setTimeout(() => { this.wakeTimer = undefined; if (this.isConnected && !this.hiddenByUser) this.setOpen(true); }, wait); return; }
    }
    this.open = value; this.touch(); this.sync(); this.place(this.anchor);
    if (value) this.input.focus({ preventScroll: true }); else this.launcher.focus({ preventScroll: true });
  }
  private sync() {
    this.toggleAttribute('data-open', this.open && !this.hiddenByUser);
    this.toggleAttribute('data-suspended', this.reduced || document.visibilityState === 'hidden' || this.hiddenByUser);
    this.dataset.state = this.state;
    this.element<HTMLElement>('.conversation').hidden = !this.open || this.hiddenByUser;
    this.element<HTMLElement>('.speech').hidden = !this.open || this.hiddenByUser;
    this.element<HTMLElement>('form').hidden = !this.open || this.hiddenByUser;
    this.element<HTMLElement>('.base').hidden = this.hiddenByUser;
    this.element<HTMLButtonElement>('.reopen').hidden = !this.hiddenByUser;
    this.launcher.setAttribute('aria-expanded', String(this.open));
    this.launcher.setAttribute('aria-label', this.open ? 'Tutup chat KARI' : 'Buka chat KARI');
    this.element<HTMLButtonElement>('.send').disabled = this.busy || this.configError;
    this.element<HTMLButtonElement>('.stop').hidden = !this.busy;
    this.element('.hint').textContent = this.busy ? '···' : '';
    this.character?.preferences({ suspended: this.hiddenByUser || document.visibilityState === 'hidden', reduced: this.reduced, calm: this.calm, mobile: this.mobile, pinned: this.pinned, roaming: this.hasAttribute('data-pixel') || !this.mobile || this.roamingOptIn, open: this.open });
    this.character?.conversation(this.state);
    this.layoutConversation();
  }
  private hide() { this.endDrag(true); this.clearDrop(); if (this.wakeTimer) clearTimeout(this.wakeTimer); this.wakeTimer = undefined; this.hiddenByUser = true; this.open = false; this.clearMotion(); this.sync(); this.place(this.anchor); this.element<HTMLButtonElement>('.reopen').focus(); }
  private say(value: string, state: State = 'idle', react = true) { if (state !== this.state) this.glitch(); this.text.textContent = value; this.live.textContent = value; this.state = state; this.sync(); if (react) this.character?.conversation(state, value); }
  private changeState(value: State) { if (this.state !== value) this.glitch(); this.state = value; this.sync(); }
  private stop(announce = true) {
    this.requestSequence++; this.controller?.abort(); this.controller = undefined;
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = undefined; this.busy = false;
    if (announce) this.say('Oke, responsnya dihentikan.'); else { this.state = 'idle'; this.sync(); }
  }
  private async submit() {
    const message = this.input.value.trim();
    if (!message || this.composing) return;
    if (this.busy) { this.live.textContent = 'Tunggu respons selesai atau pilih Stop.'; return; }
    this.touch();
    if (this.localCommand(message)) { this.input.value = ''; return; }
    if (this.configError) { this.say('Konfigurasi KARI belum valid.', 'error'); return; }
    if (new TextEncoder().encode(message).length > 1200) { this.say('Pesannya terlalu panjang. Coba ringkas sedikit, ya.'); return; }
    this.input.value = ''; this.element('.sources').replaceChildren();
    this.busy = true; this.changeState('think'); this.text.textContent = 'Menyiapkan jawaban…'; this.live.textContent = 'KARI sedang menyiapkan jawaban.';
    const sequence = ++this.requestSequence;
    const controller = new AbortController(); this.controller = controller;
    this.requestTimer = setTimeout(() => controller.abort(), 35_000);
    try {
      if (!this.token || Date.now() >= this.expires - 5000) {
        const response = await fetch(`${this.apiBase}/sessions`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteId: this.siteId }), signal: controller.signal });
        if (!response.ok) throw new Error('session');
        const session: unknown = await response.json();
        if (!session || typeof session !== 'object' || !('token' in session) || typeof session.token !== 'string' || session.token.length > 2048) throw new Error('session');
        if (!this.isConnected || sequence !== this.requestSequence) return;
        this.token = session.token;
        const expiry = 'expiresAt' in session ? session.expiresAt : null;
        this.expires = typeof expiry === 'number' ? expiry : typeof expiry === 'string' ? Date.parse(expiry) : Date.now() + 15 * 60_000;
        if (!Number.isFinite(this.expires)) throw new Error('session');
      }
      const requestId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await fetch(`${this.apiBase}/chat`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }, body: JSON.stringify({ siteId: this.siteId, message, requestId }), signal: controller.signal });
      if (!response.ok) { if (response.status === 401) { this.token = undefined; this.expires = 0; } throw new Error(response.status === 429 ? 'busy' : 'chat'); }
      const reply: Reply = await response.json();
      if (!this.isConnected || sequence !== this.requestSequence) return;
      if (!reply || typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > 12000) throw new Error('reply');
      this.say(reply.text, 'talk'); this.character?.conversation('talk', reply.text, { emotion: reply.emotion, intent: reply.intent }); this.renderSources(reply.sources); this.place(this.anchor);
      this.later(() => { if (!this.busy && this.state === 'talk') { this.state = 'idle'; this.sync(); } }, 4000);
    } catch (error) {
      if (!this.isConnected || sequence !== this.requestSequence) return;
      const message = error instanceof Error && error.message === 'busy' ? 'KARI sedang sibuk atau batas penggunaan tercapai. Coba lagi nanti, ya.' : controller.signal.aborted ? 'Waktu tunggu habis. Kamu bisa mencoba lagi secara manual.' : 'KARI belum bisa terhubung. Website tetap bisa kamu gunakan; coba lagi nanti.';
      this.say(message, 'error');
    } finally {
      if (sequence === this.requestSequence) { this.busy = false; this.controller = undefined; if (this.requestTimer) clearTimeout(this.requestTimer); this.requestTimer = undefined; this.sync(); }
    }
  }
  private renderSources(sources: Reply['sources']) {
    const container = this.element('.sources'); container.replaceChildren();
    if (!Array.isArray(sources)) return;
    for (const source of sources.slice(0, 3)) {
      try {
        if (!source || typeof source.url !== 'string' || typeof source.title !== 'string') continue;
        const url = allowedUrl(source.url, document.baseURI);
        const link = document.createElement('a'); link.href = url.href; link.textContent = source.title.slice(0, 70); link.rel = 'noopener noreferrer'; container.append(link);
      } catch { /* Unsafe model-generated links are never rendered. */ }
    }
  }
  private localCommand(raw: string): boolean {
    const command = normalize(raw).replace(/^kari\s*/u, '');
    if (/^(tetap di sini|diam di sini|jangan pindah)$/u.test(command)) { this.pinned = true; this.roamingOptIn = false; this.say('Oke, aku tetap di sini.'); this.sync(); return true; }
    if (/^(pindah tempat|minggir|pindah)$/u.test(command)) {
      let moved = false;
      if (this.isConnected && !this.drag?.active && !this.busy && !this.composing && !this.pointing) {
        if (this.character) moved = this.character.relocateRandom();
        else {
          const anchor = this.otherSafeAnchor();
          if (anchor) moved = this.place(anchor, true);
        }
      }
      this.say(moved ? 'Oke, aku pindah ke tempat aman lain.' : 'Belum ada tempat aman lain. Aku tetap di sini dulu.', 'idle', false);
      return true;
    }
    let target: Anchor | undefined;
    if (/^(?:pindah )?(?:ke )?(?:sebelah )?kiri(?: bawah)?$/u.test(command)) target = 'bottom-left';
    if (/^(?:pindah )?(?:ke )?(?:sebelah )?kanan(?: bawah)?$/u.test(command)) target = 'bottom-right';
    if (/^(?:pindah )?(?:ke )?kiri tengah$/u.test(command)) target = 'middle-left';
    if (/^(?:pindah )?(?:ke )?kanan tengah$/u.test(command)) target = 'middle-right';
    if (target) {
      const moved = this.place(target, true);
      this.say(moved ? `Oke, aku di ${target.includes('left') ? 'kiri' : 'kanan'} sini.` : 'Belum ada tempat aman di situ. Aku tetap di sini dulu.', 'idle', false);
      return true;
    }
    if (/^(halo|hai|hello|hi)$/u.test(command)) { this.say(this.text.textContent === greeting ? 'Hai lagi! Mau ngobrol tentang apa?' : greeting); this.glitch(); return true; }
    if (/^(serius dulu|tenang|jangan banyak gerak)$/u.test(command)) { this.pinned = true; this.calm = true; this.setAttribute('data-quiet', ''); this.clearMotion(); this.say('Oke, aku tenang dulu. Mau dibantu apa?'); this.sync(); return true; }
    return false;
  }
  private beginDrag(event: PointerEvent) {
    if (!this.hiddenByUser) this.dragController?.begin(event);
  }
  private moveDrag(event: PointerEvent) { this.dragController?.move(event); }
  private endDrag(cancelled: boolean) { this.dragController?.end(cancelled); }
  private pinDrop() { this.pinned = true; this.roamingOptIn = false; }
  private clearDrop() { if (this.dropTimer) clearTimeout(this.dropTimer); this.dropTimer = undefined; this.removeAttribute('data-dropped'); }
  private clampPosition(left: number, top: number) {
    const viewport = this.viewport(); const { width, height } = this.bounds(this.anchor);
    return { left: Math.round(Math.max(viewport.left + 12, Math.min(left, viewport.left + viewport.width - width - 12))), top: Math.round(Math.max(viewport.top + 12, Math.min(top, viewport.top + viewport.height - height - 12))), width, height };
  }
  private currentBounds() {
    const rect = this.getBoundingClientRect();
    if (rect.width && rect.height) return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (this.freePosition) { const { width, height } = this.bounds(this.anchor); return this.clampPosition(this.freePosition.right - width, this.freePosition.bottom - height); }
    return this.bounds(this.anchor);
  }
  private setFreePosition(left: number, top: number) {
    const rect = this.clampPosition(left, top);
    this.freePosition = { right: rect.left + rect.width, bottom: rect.top + rect.height };
    this.setAttribute('data-free-position', ''); this.renderPosition(rect);
  }
  private renderPosition(rect: { left: number; top: number }) {
    this.style.transform = `translate3d(${Math.round(rect.left)}px,${Math.round(rect.top)}px,0)`;
    this.style.setProperty('--kari-vh', `${this.viewport().height}px`);
    this.layoutConversation(rect);
  }
  private conversationBounds(rect: { left: number; top: number; width: number; height: number }) {
    const viewport = this.viewport();
    const width = Math.min(this.mobile ? 290 : 316, Math.max(0, viewport.width - 24));
    const left = Math.max(viewport.left + 12, Math.min(rect.left + rect.width - width, viewport.left + viewport.width - width - 12));
    const above = Math.max(0, rect.top - viewport.top - 20);
    const below = Math.max(0, viewport.top + viewport.height - rect.top - rect.height - 20);
    const side = above >= below ? 'above' : 'below';
    const space = Math.max(0, side === 'above' ? above : below);
    const natural = this.element<HTMLElement>('.conversation').getBoundingClientRect().height || 150;
    const height = Math.min(natural, space);
    const top = side === 'above' ? rect.top - height - 8 : rect.top + rect.height + 8;
    return { left, top, width, height, side, space };
  }
  private layoutConversation(position?: { left: number; top: number }) {
    if (!this.open || this.hiddenByUser || !this.isConnected) return;
    const rect = position ? { ...this.bounds(this.anchor), ...position } : this.currentBounds();
    const box = this.conversationBounds(rect);
    const conversation = this.element<HTMLElement>('.conversation');
    conversation.style.width = `${box.width}px`;
    conversation.style.left = `${Math.round(box.left - rect.left)}px`;
    conversation.style.maxHeight = `${box.space}px`;
    conversation.style.setProperty('--kari-chat-space', `${box.space}px`);
    conversation.style.setProperty('--kari-tail', `${Math.round(Math.max(18, Math.min(box.width - 30, rect.left + rect.width - 59 - box.left)))}px`);
    conversation.style.top = box.side === 'below' ? `${rect.height + 8}px` : 'auto';
    conversation.style.bottom = box.side === 'above' ? `${rect.height + 8}px` : 'auto';
    conversation.setAttribute('data-side', box.side);
  }
  private viewport() {
    const viewport = window.visualViewport;
    return { width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight, left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0 };
  }
  private exclusions(): Rect[] {
    return Array.from(document.querySelectorAll('nav,header,[data-kari-avoid],[data-kari-exclude],[aria-modal="true"],a[href],button,input,textarea,select,[contenteditable="true"],main p,main h1,main h2,main h3')).slice(0, 220).flatMap(element => {
      if (element === this || this.contains(element)) return [];
      const rect = element.getBoundingClientRect();
      return rect.width && rect.height ? [{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }] : [];
    });
  }
  private behaviorConfig(): Partial<BehaviorConfig> {
    const raw = this.getAttribute('behavior-config');
    if (!raw || raw.length > 2000) return {};
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      const input = value as Record<string, unknown>, result: Record<string, unknown> = {};
      for (const key of ['decisionMs', 'sleepAfterMs', 'sleepMinMs', 'sleepMaxMs', 'moveMinMs', 'moveMaxMs', 'manualReturnMs', 'rareCooldownMs']) {
        if (typeof input[key] === 'number' && Number.isFinite(input[key])) result[key] = Math.max(key === 'decisionMs' ? 100 : 1000, Math.min(3_600_000, input[key]));
      }
      if (typeof input.lightningChance === 'number' && Number.isFinite(input.lightningChance)) result.lightningChance = Math.max(0, Math.min(1, input.lightningChance));
      if (input.personality && typeof input.personality === 'object') {
        const personality = input.personality as Record<string, unknown>, bounded: Record<string, number> = {};
        for (const key of ['energy', 'curiosity', 'mood']) if (typeof personality[key] === 'number' && Number.isFinite(personality[key])) bounded[key] = Math.max(0, Math.min(1, personality[key]));
        result.personality = bounded;
      }
      return result as Partial<BehaviorConfig>;
    } catch { return {}; }
  }
  private bounds(anchor: Anchor) {
    const viewport = this.viewport(); const measured = this.getBoundingClientRect();
    const width = Math.min(measured.width || (this.mobile ? 104 : 126), viewport.width - 24);
    const height = Math.min(measured.height || (this.hiddenByUser ? 40 : this.mobile && this.hasAttribute('data-pixel') ? 100 : 150), viewport.height - 24);
    const left = anchor.endsWith('right') ? viewport.left + viewport.width - width - 12 : viewport.left + 12;
    const top = anchor.startsWith('bottom') ? viewport.top + viewport.height - height - 12 : viewport.top + (viewport.height - height) / 2;
    return { left: Math.max(viewport.left + 12, left), top: Math.max(viewport.top + 12, top), width, height };
  }
  private roamingEnabled() { return !this.pinned && !this.reduced && (this.hasAttribute('data-pixel') || !this.mobile || this.roamingOptIn); }
  private safe(anchor: Anchor) { return this.safePlacement(this.bounds(anchor)); }
  private safePlacement(candidate: Rect) {
    const boxes = this.open && !this.hiddenByUser ? [candidate, this.conversationBounds(candidate)] : [candidate];
    const controls = Array.from(document.querySelectorAll('nav,[data-kari-avoid],[aria-modal="true"],a[href],button,input,textarea')).slice(0, 200);
    return !controls.some(control => {
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      return boxes.some(box => box.left < rect.right + 6 && box.left + box.width > rect.left - 6 && box.top < rect.bottom + 6 && box.top + box.height > rect.top - 6);
    });
  }
  /** Local movement API for host/demo controls; true means the safe move was accepted. */
  moveTo(anchor: Anchor): boolean {
    if (!anchors.includes(anchor)) return false;
    this.touch(); return this.place(anchor, true);
  }
  private place(anchor: Anchor, explicit = false): boolean {
    if (!this.isConnected || this.drag?.active) return false;
    if (explicit && (this.busy || this.composing || this.pointing)) return false;
    if (explicit && !this.safe(anchor)) return false;
    if (explicit && this.character) {
      const target = this.bounds(anchor);
      return this.character.relocate({ x: target.left, y: target.top }, true, () => {
        this.anchor = anchor; this.freePosition = undefined; this.removeAttribute('data-free-position');
      });
    }
    this.anchor = anchor;
    if (explicit) { this.freePosition = undefined; this.removeAttribute('data-free-position'); }
    const rect = this.bounds(anchor);
    if (this.freePosition) this.setFreePosition(this.freePosition.right - rect.width, this.freePosition.bottom - rect.height);
    else this.renderPosition(rect);
    if (explicit) this.glitch();
    return true;
  }
  private otherSafeAnchor(): Anchor | undefined {
    const candidates = anchors.filter(value => value !== this.anchor && this.safe(value));
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  private interacting() { return this.busy || this.composing || this.pointing || this.hovering || !!this.root.activeElement || Date.now() - this.lastInteraction < 20_000; }
  private later(callback: () => void, delay: number) {
    const timer = setTimeout(() => { this.timers.delete(timer); if (this.isConnected && !this.hiddenByUser && document.visibilityState !== 'hidden') callback(); }, delay); this.timers.add(timer); return timer;
  }
  private clearMotion() { this.timers.forEach(timer => clearTimeout(timer)); this.timers.clear(); this.removeAttribute('data-glitch'); this.removeAttribute('data-blink'); }
  private restartMotion() {
    this.clearMotion();
    if (this.reduced || this.calm || this.hiddenByUser || document.visibilityState === 'hidden') return;
    if (this.character) {
      const flicker = () => { if (!this.busy && !this.composing && !this.drag && !this.pointing && Date.now() - this.lastInputAt > 2500) this.glitch(true); this.later(flicker, 5000 + Math.random() * 7000); };
      this.later(flicker, 5000 + Math.random() * 7000); return;
    }
    const blink = () => { if (Date.now() - this.lastInteraction < 60_000) { this.setAttribute('data-blink', ''); this.later(() => this.removeAttribute('data-blink'), 150); } this.later(blink, 4000 + Math.random() * 5000); };
    const quiet = () => { this.toggleAttribute('data-quiet', Date.now() - this.lastInteraction >= 60_000 && !this.busy && !this.drag?.active); this.later(quiet, 20_000); };
    const roam = () => { if (!this.pinned && (!this.mobile || this.roamingOptIn) && !this.interacting()) { const anchor = this.otherSafeAnchor(); if (anchor) this.place(anchor, true); } this.later(roam, 45_000 + Math.random() * 45_000); };
    const flicker = () => { if (this.state === 'idle' && !this.busy && !this.composing && !this.drag && !this.pointing && Date.now() - this.lastInputAt > 2500 && !this.hasAttribute('data-quiet')) this.glitch(true); this.later(flicker, 5000 + Math.random() * 7000); };
    this.later(blink, 4000 + Math.random() * 5000); this.later(quiet, 20_000); this.later(roam, 45_000 + Math.random() * 45_000); this.later(flicker, 5000 + Math.random() * 7000);
  }
  private glitch(random = false) {
    if (this.reduced || this.calm || this.hiddenByUser || this.drag?.active || this.character?.allowsGlitch === false || Date.now() < this.effectsSuppressedUntil || document.visibilityState === 'hidden' || Date.now() - this.lastGlitch < 2000) return;
    this.lastGlitch = Date.now();
    const duration = random ? Math.round(220 + Math.random() * 200) : 420;
    this.setAttribute('data-glitch', ''); this.later(() => this.removeAttribute('data-glitch'), duration);
  }
}

export function registerKariWidget() {
  if (typeof customElements !== 'undefined' && !customElements.get('kari-widget')) customElements.define('kari-widget', KariWidget);
}
registerKariWidget();
