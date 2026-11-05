import { styles } from './styles.js';

type Anchor = 'bottom-right' | 'bottom-left' | 'middle-right' | 'middle-left';
type State = 'idle' | 'think' | 'talk' | 'happy' | 'error';
type Reply = { text: string; sources?: Array<{ title: string; url: string }>; mode?: string };
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
  static observedAttributes = ['api-base', 'site-id', 'position', 'avatar-src'];
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
  private requestSequence = 0;
  private apiBase = defaultApi;
  private siteId = 'portfolio';
  private configError = false;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    // This string contains only developer-authored UI. All network/user text uses textContent.
    this.root.innerHTML = `<style>${styles}</style><div class="unit">
      <div class="speech" id="kari-speech" role="region" aria-label="Jawaban KARI" hidden><button class="close" type="button" aria-label="Tutup bubble">×</button><p class="text"></p><div class="sources"></div></div>
      <form class="input-wrap" hidden><label class="sr-only" for="kari-message">Pesan untuk KARI</label><input id="kari-message" name="message" maxlength="1200" autocomplete="off" placeholder="Ngobrol sama KARI..."/><button class="send" type="submit" aria-label="Kirim pesan">➤</button><button class="stop" type="button" hidden>Stop</button></form>
      <div class="settings" hidden><button class="pin" type="button" aria-pressed="false">Tetap di sini</button><button class="roam" type="button" aria-pressed="false">Gerak acak</button><button class="hide" type="button">Sembunyikan</button></div>
      <div class="base"><button class="launcher" type="button" aria-label="Buka chat KARI" aria-controls="kari-speech" aria-expanded="false"><span class="figure"><img class="avatar" alt="" draggable="false"/><span class="fallback" aria-hidden="true"><span class="hair"></span><span class="body"></span><span class="core"></span><span class="face"><span class="eyes"></span><span class="smile"></span></span><i class="fragment f1"></i><i class="fragment f2"></i><i class="fragment f3"></i></span></span><span class="status-dot" aria-hidden="true"></span><span class="hint" aria-hidden="true"></span></button></div>
      <button class="reopen" type="button" hidden>Buka KARI</button><div class="sr-only live" role="status" aria-live="polite" aria-atomic="true"></div>
    </div>`;
    this.text.textContent = greeting;
  }
  private element<T extends Element>(selector: string): T { return this.root.querySelector(selector) as T; }
  private get input() { return this.element<HTMLInputElement>('input'); }
  private get text() { return this.element<HTMLParagraphElement>('.text'); }
  private get launcher() { return this.element<HTMLButtonElement>('.launcher'); }
  private get live() { return this.element<HTMLDivElement>('.live'); }

  connectedCallback() {
    if (this.cleanups.length) return;
    this.lastInteraction = Date.now();
    this.readConfig();
    this.anchor = anchors.includes(this.getAttribute('position') as Anchor) ? this.getAttribute('position') as Anchor : 'bottom-right';
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const mobile = window.matchMedia?.('(max-width: 640px)');
    const preferences = () => { this.reduced = motion?.matches ?? false; this.mobile = mobile?.matches ?? false; this.sync(); this.restartMotion(); };
    this.listen(motion, 'change', preferences); this.listen(mobile, 'change', preferences);
    this.listen(this.launcher, 'click', () => { this.touch(); this.setOpen(!this.open); });
    this.listen(this.element('.close'), 'click', () => this.setOpen(false));
    this.listen(this.element('form'), 'submit', event => { event.preventDefault(); void this.submit(); });
    this.listen(this.element('.stop'), 'click', () => this.stop());
    this.listen(this.element('.pin'), 'click', () => { this.touch(); this.pinned = !this.pinned; if (this.pinned) this.roamingOptIn = false; this.say(this.pinned ? 'Oke, aku tetap di sini.' : 'Oke, aku bisa pindah lagi saat tempatnya aman.'); this.sync(); });
    this.listen(this.element('.roam'), 'click', () => { this.touch(); if (this.reduced) return; this.calm = false; this.roamingOptIn = !(this.roamingOptIn || (!this.mobile && !this.pinned)); this.pinned = !this.roamingOptIn; this.say(this.roamingOptIn ? 'Aku akan pindah sesekali saat kamu tidak sedang mengetik.' : 'Oke, aku tetap di sini.'); this.sync(); this.restartMotion(); });
    this.listen(this.element('.hide'), 'click', () => this.hide());
    this.listen(this.element('.reopen'), 'click', () => { this.hiddenByUser = false; this.sync(); this.restartMotion(); this.place(this.anchor); this.launcher.focus(); });
    this.listen(this.root, 'keydown', event => { const key = event as KeyboardEvent; if (key.key === 'Escape' && this.open && !this.hiddenByUser) { key.preventDefault(); this.setOpen(false); } });
    this.listen(this.root, 'focusin', () => this.touch());
    this.listen(this.input, 'input', () => this.touch());
    this.listen(this.input, 'compositionstart', () => { this.composing = true; this.touch(); });
    this.listen(this.input, 'compositionend', () => { this.composing = false; this.touch(); });
    this.listen(this, 'pointerenter', () => { this.hovering = true; this.touch(); });
    this.listen(this, 'pointerleave', () => { this.hovering = false; });
    this.listen(this, 'pointerdown', () => { this.pointing = true; this.touch(); });
    this.listen(window, 'pointerup', () => { this.pointing = false; });
    this.listen(document, 'visibilitychange', () => { this.sync(); this.restartMotion(); });
    this.listen(window, 'resize', () => this.place(this.anchor));
    this.listen(window.visualViewport, 'resize', () => this.place(this.anchor));
    this.listen(window.visualViewport, 'scroll', () => this.place(this.anchor));
    const image = this.element<HTMLImageElement>('.avatar');
    this.listen(image, 'error', () => this.launcher.classList.add('image-missing'));
    this.listen(image, 'load', () => this.launcher.classList.remove('image-missing'));
    this.setAvatar();
    if (typeof ResizeObserver !== 'undefined') { this.observer = new ResizeObserver(() => this.place(this.anchor)); this.observer.observe(this); }
    preferences(); this.sync(); this.place(this.anchor);
  }
  disconnectedCallback() {
    this.requestSequence++;
    this.controller?.abort(); this.controller = undefined;
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = undefined;
    this.clearMotion(); this.observer?.disconnect(); this.observer = undefined;
    this.cleanups.splice(0).forEach(cleanup => cleanup());
    this.token = undefined; this.expires = 0; this.busy = false; this.composing = false; this.pointing = false; this.hovering = false; this.state = 'idle';
  }
  attributeChangedCallback(name: string, previous: string | null, next: string | null) {
    if (previous === next || !this.isConnected) return;
    if (name === 'avatar-src') { this.setAvatar(); return; }
    if (name === 'position') { if (anchors.includes(next as Anchor)) this.place(next as Anchor); return; }
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
    try { this.element<HTMLImageElement>('.avatar').src = allowedUrl(this.getAttribute('avatar-src') || defaultAvatar, document.baseURI).href; }
    catch { this.launcher.classList.add('image-missing'); }
  }
  private touch() { this.lastInteraction = Date.now(); if (!this.calm) this.removeAttribute('data-quiet'); }
  private setOpen(value: boolean) {
    this.open = value; this.touch(); this.sync(); this.place(this.anchor);
    if (value) { this.glitch(); this.input.focus(); } else this.launcher.focus();
  }
  private sync() {
    this.toggleAttribute('data-open', this.open && !this.hiddenByUser);
    this.toggleAttribute('data-suspended', this.reduced || document.visibilityState === 'hidden' || this.hiddenByUser);
    this.dataset.state = this.state;
    this.element<HTMLElement>('.speech').hidden = !this.open || this.hiddenByUser;
    this.element<HTMLElement>('form').hidden = !this.open || this.hiddenByUser;
    this.element<HTMLElement>('.settings').hidden = !this.open || this.hiddenByUser;
    this.element<HTMLElement>('.base').hidden = this.hiddenByUser;
    this.element<HTMLButtonElement>('.reopen').hidden = !this.hiddenByUser;
    this.launcher.setAttribute('aria-expanded', String(this.open));
    this.launcher.setAttribute('aria-label', this.open ? 'Tutup chat KARI' : 'Buka chat KARI');
    this.element<HTMLButtonElement>('.send').disabled = this.busy || this.configError;
    this.element<HTMLButtonElement>('.stop').hidden = !this.busy;
    this.element<HTMLButtonElement>('.pin').setAttribute('aria-pressed', String(this.pinned));
    const roaming = !this.pinned && !this.reduced && (!this.mobile || this.roamingOptIn);
    this.element<HTMLButtonElement>('.roam').setAttribute('aria-pressed', String(roaming));
    this.element<HTMLButtonElement>('.roam').disabled = this.reduced;
    this.element('.hint').textContent = this.busy ? '···' : '';
  }
  private hide() { this.hiddenByUser = true; this.open = false; this.clearMotion(); this.sync(); this.place(this.anchor); this.element<HTMLButtonElement>('.reopen').focus(); }
  private say(value: string, state: State = 'idle') { this.text.textContent = value; this.live.textContent = value; this.state = state; this.sync(); }
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
      this.say(reply.text, 'talk'); this.renderSources(reply.sources); this.place(this.anchor);
      this.later(() => { if (!this.busy && this.state === 'talk') { this.state = 'idle'; this.sync(); } }, 1500);
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
    let target: Anchor | undefined;
    if (/^(?:pindah )?(?:ke )?(?:sebelah )?kiri(?: bawah)?$/u.test(command)) target = 'bottom-left';
    if (/^(?:pindah )?(?:ke )?(?:sebelah )?kanan(?: bawah)?$/u.test(command)) target = 'bottom-right';
    if (/^(?:pindah )?(?:ke )?kiri tengah$/u.test(command)) target = 'middle-left';
    if (/^(?:pindah )?(?:ke )?kanan tengah$/u.test(command)) target = 'middle-right';
    if (/^(pindah tempat|minggir|pindah)$/u.test(command)) target = this.otherSafeAnchor();
    if (target) {
      const moved = this.place(target, true);
      this.say(moved ? `Oke, aku di ${target.includes('left') ? 'kiri' : 'kanan'} sini.` : 'Belum ada tempat aman di situ. Aku tetap di sini dulu.');
      return true;
    }
    if (/^(pindah tempat|minggir|pindah)$/u.test(command)) { this.say('Belum ada tempat aman lain. Aku tetap di sini dulu.'); return true; }
    if (/^(halo|hai|hello|hi)$/u.test(command)) { this.say(this.text.textContent === greeting ? 'Hai lagi! Mau ngobrol tentang apa?' : greeting); this.glitch(); return true; }
    if (/^(serius dulu|tenang|jangan banyak gerak)$/u.test(command)) { this.pinned = true; this.calm = true; this.setAttribute('data-quiet', ''); this.clearMotion(); this.say('Oke, aku tenang dulu. Mau dibantu apa?'); this.sync(); return true; }
    return false;
  }
  private viewport() {
    const viewport = window.visualViewport;
    return { width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight, left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0 };
  }
  private bounds(anchor: Anchor) {
    const viewport = this.viewport(); const measured = this.getBoundingClientRect();
    const width = Math.min(measured.width || (this.open && !this.hiddenByUser ? 316 : 126), viewport.width - 24);
    const height = Math.min(measured.height || (this.hiddenByUser ? 40 : this.open ? 320 : 150), viewport.height - 24);
    const left = anchor.endsWith('right') ? viewport.left + viewport.width - width - 12 : viewport.left + 12;
    const top = anchor.startsWith('bottom') ? viewport.top + viewport.height - height - 12 : viewport.top + (viewport.height - height) / 2;
    return { left: Math.max(viewport.left + 12, left), top: Math.max(viewport.top + 12, top), width, height };
  }
  private safe(anchor: Anchor) {
    const candidate = this.bounds(anchor);
    const controls = Array.from(document.querySelectorAll('nav,[data-kari-avoid],[aria-modal="true"],a[href],button,input,textarea')).slice(0, 200);
    return !controls.some(control => {
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      return candidate.left < rect.right + 6 && candidate.left + candidate.width > rect.left - 6 && candidate.top < rect.bottom + 6 && candidate.top + candidate.height > rect.top - 6;
    });
  }
  private place(anchor: Anchor, explicit = false): boolean {
    if (!this.isConnected) return false;
    if (explicit && (this.busy || this.composing || this.pointing)) return false;
    if (explicit && !this.safe(anchor)) return false;
    this.anchor = anchor;
    const rect = this.bounds(anchor); this.style.transform = `translate3d(${Math.round(rect.left)}px,${Math.round(rect.top)}px,0)`;
    this.style.setProperty('--kari-vh', `${this.viewport().height}px`);
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
    const blink = () => { if (Date.now() - this.lastInteraction < 20_000) { this.setAttribute('data-blink', ''); this.later(() => this.removeAttribute('data-blink'), 130); } this.later(blink, 4000 + Math.random() * 5000); };
    const quiet = () => { this.toggleAttribute('data-quiet', Date.now() - this.lastInteraction >= 20_000 && !this.busy); this.later(quiet, 20_000); };
    const roam = () => { if (!this.pinned && (!this.mobile || this.roamingOptIn) && !this.interacting()) { const anchor = this.otherSafeAnchor(); if (anchor) this.place(anchor, true); } this.later(roam, 45_000 + Math.random() * 45_000); };
    this.later(blink, 4000 + Math.random() * 5000); this.later(quiet, 20_000); this.later(roam, 45_000 + Math.random() * 45_000);
  }
  private glitch() { if (this.reduced || this.calm || this.hiddenByUser || document.visibilityState === 'hidden' || Date.now() - this.lastGlitch < 2000) return; this.lastGlitch = Date.now(); this.setAttribute('data-glitch', ''); this.later(() => this.removeAttribute('data-glitch'), 280); }
}

export function registerKariWidget() {
  if (typeof customElements !== 'undefined' && !customElements.get('kari-widget')) customElements.define('kari-widget', KariWidget);
}
registerKariWidget();
