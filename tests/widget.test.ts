import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3000/demo', pretendToBeVisual: true });
let reduced = false;
let pixelPaints = 0;
let animationId = 0;
const animationFrames = new Map<number, FrameRequestCallback>();
Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { const id = ++animationId; animationFrames.set(id, callback); return id; } });
Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: (id: number) => animationFrames.delete(id) });
function frameAt(now: number) { const pending = [...animationFrames.values()]; animationFrames.clear(); pending.forEach(callback => callback(now)); }
Object.defineProperty(dom.window, 'matchMedia', { value: (query: string) => ({ matches: query.includes('prefers-reduced-motion') && reduced, media: query, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({
  imageSmoothingEnabled: true,
  globalAlpha: 1, fillStyle: '', clearRect() {}, fillRect() {},
  createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
  putImageData: () => { pixelPaints++; },
}) });
for (const key of ['window', 'document', 'HTMLElement', 'customElements', 'Element', 'HTMLInputElement', 'Event', 'KeyboardEvent', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
const { KariWidget, registerKariWidget } = await import('../apps/widget/src/index.js');
const originalFetch = globalThis.fetch;
afterEach(() => { document.body.replaceChildren(); reduced = false; globalThis.fetch = originalFetch; });

function widget(attrs: Record<string, string> = {}) {
  const element = document.createElement('kari-widget') as KariWidget;
  element.setAttribute('api-base', 'http://localhost:3000/kari/api');
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  document.body.append(element); return element;
}
function query<T extends Element>(element: KariWidget, selector: string) { return element.shadowRoot!.querySelector(selector) as T; }
function send(element: KariWidget, message: string) {
  query<HTMLInputElement>(element, 'input').value = message;
  query<HTMLFormElement>(element, 'form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}
async function until(predicate: () => boolean) {
  const limit = Date.now() + 1000;
  while (!predicate()) { if (Date.now() > limit) throw new Error('Widget did not finish in time'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function pointer(target: EventTarget, type: string, x: number, y: number, id = 1, extra: Record<string, unknown> = {}) {
  const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: true }, ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, { value }])) });
  target.dispatchEvent(event); return event;
}
function position(element: KariWidget) { return element.style.transform.match(/translate3d\(([-\d.]+)px,([-\d.]+)px,0\)/u)!.slice(1).map(Number); }

test('registration is idempotent and styling is confined to one shadow tree', () => {
  registerKariWidget(); registerKariWidget();
  assert.equal(customElements.get('kari-widget'), KariWidget);
  const element = widget();
  assert.equal(element.shadowRoot!.querySelectorAll('.launcher').length, 1);
  assert.equal(document.head.querySelectorAll('style').length, 0);
  assert.equal(element.getAttribute('data-state'), 'idle');
});

test('movement and greetings are local, and input remains available', () => {
  let calls = 0; globalThis.fetch = (() => { calls++; throw new Error('No API call expected'); }) as typeof fetch;
  const element = widget();
  send(element, 'Kari, pindah ke kiri');
  assert.match(element.style.transform, /translate3d\(12px,/u);
  assert.match(query(element, '.text').textContent!, /di kiri/u);
  send(element, 'Tetap di sini');
  assert.equal((element as any).pinned, true);
  send(element, 'Kari, halo');
  assert.match(query(element, '.text').textContent!, /Hai/u);
  assert.equal(calls, 0);
});

test('pixel command blinks horizontally with one line while pinned chat and input stay available', context => {
  let clock = 0, calls = 0;
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  context.mock.method(performance, 'now', () => clock);
  globalThis.fetch = (() => { calls++; throw new Error('Blink is local'); }) as typeof fetch;
  const element = widget({ appearance: 'pixel' });
  query<HTMLButtonElement>(element, '.launcher').click();
  send(element, 'Tetap di sini');
  const original = element.style.transform;
  send(element, 'Kari, pindah ke kiri');
  query<HTMLInputElement>(element, 'input').value = 'Draf berikutnya';
  assert.equal(element.style.transform, original, 'Prepare must not move the anchor early');
  assert.equal(element.getAttribute('data-relocation-phase'), 'prepare');
  assert.equal(document.querySelectorAll('[data-kari-lightning]').length, 1);
  clock += 144; context.mock.timers.tick(144); frameAt(clock);
  assert.equal(element.getAttribute('data-relocation-phase'), 'hidden');
  assert.equal(element.style.transform, original, 'The origin disappears before the destination appears');
  clock += 200; context.mock.timers.tick(200); frameAt(clock);
  assert.equal(element.getAttribute('data-relocation-phase'), 'arrive');
  assert.equal(position(element)[0], 12);
  clock += 300; context.mock.timers.tick(300); frameAt(clock);
  assert.equal(element.hasAttribute('data-relocation-phase'), false);
  assert.equal(document.querySelector('[data-kari-lightning]'), null);
  assert.equal(element.hasAttribute('data-open'), true);
  assert.equal((element as any).pinned, true);
  assert.equal(query<HTMLInputElement>(element, 'input').value, 'Draf berikutnya');
  assert.equal(calls, 0);
});

test('idle open chat roams after a draft is cleared, and explicit pin still stops movement', context => {
  let clock = 0;
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  context.mock.method(performance, 'now', () => clock);
  context.mock.method(Math, 'random', () => .5);
  const element = widget({ appearance: 'pixel', 'behavior-config': JSON.stringify({ moveMinMs: 6000, moveMaxMs: 6000, sleepAfterMs: 3_600_000 }) });
  const advance = (duration: number) => { for (let elapsed = 0; elapsed < duration; elapsed += 100) { clock += 100; context.mock.timers.tick(100); frameAt(clock); } };
  query<HTMLButtonElement>(element, '.launcher').click();
  const input = query<HTMLInputElement>(element, 'input');
  input.value = 'Draf yang belum selesai'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const origin = element.style.transform;
  advance(9000); assert.equal(element.style.transform, origin, 'A real draft keeps the input in place');
  assert.equal(input.value, 'Draf yang belum selesai');
  input.value = ''; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  advance(6000); assert.notEqual(element.style.transform, origin, 'Empty idle input and focus do not permanently block roaming');
  assert.equal(element.hasAttribute('data-open'), true);
  send(element, 'Tetap di sini');
  const pinned = element.style.transform; advance(20_000);
  assert.equal(element.style.transform, pinned);
});

test('movement acknowledgement preserves the held expression through blink, while real typing still interrupts', context => {
  let clock = 0, calls = 0;
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  context.mock.method(performance, 'now', () => clock);
  globalThis.fetch = (() => { calls++; throw new Error('Movement acknowledgement must stay local'); }) as typeof fetch;
  const element = widget({ appearance: 'pixel', 'behavior-config': JSON.stringify({ moveMinMs: 60_000, moveMaxMs: 60_000 }) });
  const advance = (duration: number) => {
    for (let elapsed = 0; elapsed < duration; elapsed += 100) { clock += 100; context.mock.timers.tick(100); frameAt(clock); }
  };
  query<HTMLButtonElement>(element, '.launcher').click();
  advance(100);
  // Test setup only: production uses the companion's event-driven public integration.
  const character = (element as any).character;
  character.behavior.force('HAPPY', clock); character.redraw();
  const expression = character.behavior.snapshot;
  const origin = element.style.transform;
  send(element, 'Kari, pindah ke kiri'); // No input event: this isolates acknowledgement from real typing.
  assert.equal(element.getAttribute('data-relocation-phase'), 'prepare');
  assert.equal(element.getAttribute('data-behavior'), 'HAPPY');
  assert.deepEqual(character.behavior.snapshot, expression, 'Local acknowledgement cannot restart or neutralize the expression');
  assert.match(query(element, '.text').textContent!, /di kiri/u);
  advance(900);
  assert.equal(element.hasAttribute('data-relocation-phase'), false);
  assert.notEqual(element.style.transform, origin); assert.equal(position(element)[0], 12);
  assert.deepEqual(character.behavior.snapshot, expression, 'Blink completion preserves state, start time and original deadline');
  advance(4000);
  assert.equal(element.getAttribute('data-behavior'), 'HAPPY');
  const input = query<HTMLInputElement>(element, 'input');
  input.value = 'Sekarang benar-benar mengetik'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(element.getAttribute('data-behavior'), 'LISTEN', 'Real input remains a higher-priority interaction');
  assert.equal(calls, 0);
});

test('generic move commands sample new pixel coordinates instead of choosing only fixed anchors', context => {
  let clock = 0, calls = 0, seed = 703;
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  context.mock.method(performance, 'now', () => clock);
  context.mock.method(Math, 'random', () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; });
  globalThis.fetch = (() => { calls++; throw new Error('Move commands stay local'); }) as typeof fetch;
  const element = widget({ appearance: 'pixel' });
  send(element, 'Tetap di sini');
  const stops: number[][] = [];
  for (const message of ['pindah tempat', 'minggir', 'pindah', 'pindah tempat', 'minggir', 'pindah']) {
    send(element, message);
    assert.equal(element.getAttribute('data-relocation-phase'), 'prepare');
    for (let elapsed = 0; elapsed < 800; elapsed += 100) { clock += 100; context.mock.timers.tick(100); frameAt(clock); }
    assert.equal(element.hasAttribute('data-moving'), false);
    stops.push(position(element));
    assert.match(query(element, '.text').textContent!, /tempat aman lain/u);
  }
  assert.equal(new Set(stops.map(point => point.join(','))).size, 6);
  assert.ok(new Set(stops.map(point => point[0])).size > 3);
  assert.ok(new Set(stops.map(point => point[1])).size > 3);
  assert.equal(calls, 0);
});

test('image-to-pixel switch clears legacy quiet timers and position attributes use the blink path', context => {
  let clock = 0;
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  context.mock.method(performance, 'now', () => clock);
  const element = widget();
  element.setAttribute('data-quiet', '');
  element.setAttribute('appearance', 'pixel');
  assert.equal(element.hasAttribute('data-quiet'), false);
  clock += 21_000; context.mock.timers.tick(21_000); frameAt(clock);
  assert.equal(element.hasAttribute('data-quiet'), false, 'The old image quiet timer cannot mask pixel blink');
  const before = element.style.transform;
  element.setAttribute('position', 'bottom-left');
  assert.equal(element.getAttribute('data-relocation-phase'), 'prepare');
  assert.equal(element.style.transform, before);
  clock += 144; context.mock.timers.tick(144); frameAt(clock);
  assert.equal(element.getAttribute('data-relocation-phase'), 'hidden');
  assert.equal(element.style.transform, before);
  clock += 200; context.mock.timers.tick(200); frameAt(clock);
  assert.equal(position(element)[0], 12);
});

test('public session token stays in memory and untrusted reply is rendered as text', async () => {
  const requests: Array<{ url: string; options: RequestInit }> = [];
  globalThis.fetch = (async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/sessions')) return Response.json({ token: 'opaque-public-token', expiresAt: Date.now() + 60_000 });
    return Response.json({ text: '<img src=x onerror=alert(1)>', sources: [{ title: 'Unsafe', url: 'javascript:alert(1)' }, { title: 'Project', url: 'https://example.com/project' }], mode: 'local' });
  }) as typeof fetch;
  const element = widget({ 'mode': 'owner', 'site-id': 'another-site' });
  send(element, 'Apa proyek yang bisa dilihat?');
  await until(() => requests.length === 2 && element.dataset.state === 'talk');
  assert.equal(query(element, '.text').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(query(element, '.text').querySelectorAll('img').length, 0);
  assert.equal(query(element, '.sources').querySelectorAll('a').length, 1);
  assert.deepEqual(JSON.parse(String(requests[0].options.body)), { siteId: 'another-site' });
  assert.equal(requests[1].options.credentials, 'omit');
  assert.equal((requests[1].options.headers as Record<string, string>).Authorization, 'Bearer opaque-public-token');
  assert.equal('mode' in JSON.parse(String(requests[1].options.body)), false);
  assert.equal(dom.window.localStorage.length, 0);
  assert.equal(document.cookie, '');
  send(element, 'Pertanyaan kedua tentang teknologi');
  await until(() => requests.length === 3 && element.dataset.state === 'talk');
  assert.equal(requests.filter(request => request.url.endsWith('/sessions')).length, 1);
});

test('disconnect aborts request, forgets session and reconnect does not duplicate listeners', async () => {
  let chatSignal: AbortSignal | undefined;
  let calls = 0;
  globalThis.fetch = (async (url, options = {}) => {
    calls++;
    if (String(url).endsWith('/sessions')) return Response.json({ token: 'temporary', expiresAt: Date.now() + 60_000 });
    chatSignal = options.signal!;
    return new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }) as typeof fetch;
  const element = widget();
  send(element, 'Beri penjelasan proyek');
  await until(() => !!chatSignal);
  element.remove();
  assert.equal(chatSignal!.aborted, true);
  document.body.append(element);
  query<HTMLButtonElement>(element, '.launcher').click();
  assert.equal(element.hasAttribute('data-open'), true);
  assert.equal(element.shadowRoot!.querySelectorAll('.launcher').length, 1);
  assert.equal(calls, 2, 'disconnect never replays network requests');
});

test('reduced motion suspends animation and simplified chat omits settings', () => {
  reduced = true;
  const element = widget();
  query<HTMLButtonElement>(element, '.launcher').click();
  assert.equal(element.hasAttribute('data-suspended'), true);
  assert.equal(element.hasAttribute('data-glitch'), false);
  assert.equal(element.shadowRoot!.querySelector('.settings, .pin, .roam, .hide'), null);
});

test('invalid executable API URL never starts a request', () => {
  let calls = 0; globalThis.fetch = (() => { calls++; throw new Error('No API call expected'); }) as typeof fetch;
  const element = widget({ 'api-base': 'javascript:alert(1)' });
  send(element, 'Apa kabar?');
  assert.match(query(element, '.text').textContent!, /Konfigurasi/u);
  assert.equal(calls, 0);
});

test('pixel appearance draws code-native frames without assigning PNG URLs or calling an API', () => {
  let apiCalls = 0; let imageAssignments = 0;
  const imagePrototype = dom.window.HTMLImageElement.prototype;
  const imageSource = Object.getOwnPropertyDescriptor(imagePrototype, 'src')!;
  Object.defineProperty(imagePrototype, 'src', { configurable: true, get: imageSource.get, set(value: string) { imageAssignments++; imageSource.set!.call(this, value); } });
  globalThis.fetch = (() => { apiCalls++; throw new Error('No API call expected'); }) as typeof fetch;
  try {
    const beforePaint = pixelPaints;
    const element = widget({ appearance: 'pixel', 'avatar-src': 'http://localhost:3000/kari/assets/kari.png' });
    assert.equal(element.hasAttribute('data-pixel'), true);
    assert.equal(query<HTMLCanvasElement>(element, '.pixel-avatar').hidden, false);
    assert.equal(query<HTMLCanvasElement>(element, '.pixel-avatar').width, 48);
    assert.equal(query<HTMLCanvasElement>(element, '.pixel-avatar').height, 72);
    assert.equal(query<HTMLImageElement>(element, '.avatar').hasAttribute('src'), false);
    assert.equal(query<HTMLImageElement>(element, '.avatar').hidden, true);
    assert.ok(pixelPaints > beforePaint, 'Code-native canvas was actually painted');
    query<HTMLButtonElement>(element, '.launcher').click();
    send(element, 'Kari, pindah ke kiri');
    element.setAttribute('avatar-src', 'http://localhost:3000/kari/assets/another.png');
    assert.equal(imageAssignments, 0, 'Even avatar-src changes do not load images in pixel mode');
    assert.equal(apiCalls, 0, 'Appearance and movement never create sessions or inference calls');
  } finally { Object.defineProperty(imagePrototype, 'src', imageSource); }
});

test('changing appearance preserves the visitor token, completed reply and pending input', async () => {
  const requests: Array<{ url: string; options: RequestInit }> = [];
  globalThis.fetch = (async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/sessions')) return Response.json({ token: 'same-public-session', expiresAt: Date.now() + 60_000 });
    return Response.json({ text: 'Jawaban dalam sesi yang sama.', sources: [{ title: 'Proyek', url: 'https://example.com/project' }], mode: 'local' });
  }) as typeof fetch;
  const element = widget({ appearance: 'pixel', 'avatar-src': 'http://localhost:3000/kari/assets/kari.png' });
  send(element, 'Jelaskan proyek Genbatik');
  await until(() => requests.length === 2 && element.dataset.state === 'talk');
  query<HTMLInputElement>(element, 'input').value = 'Pertanyaan yang belum dikirim';
  const oldText = query(element, '.text').textContent;
  element.removeAttribute('appearance');
  assert.equal(query(element, '.text').textContent, oldText);
  assert.equal(query<HTMLInputElement>(element, 'input').value, 'Pertanyaan yang belum dikirim');
  assert.equal(query(element, '.sources').querySelectorAll('a').length, 1);
  assert.equal(query<HTMLCanvasElement>(element, '.pixel-avatar').hidden, true);
  assert.equal(query<HTMLImageElement>(element, '.avatar').getAttribute('src'), 'http://localhost:3000/kari/assets/kari.png');
  element.setAttribute('appearance', 'pixel');
  assert.equal(query(element, '.text').textContent, oldText);
  assert.equal(query<HTMLInputElement>(element, 'input').value, 'Pertanyaan yang belum dikirim');
  assert.equal(query<HTMLImageElement>(element, '.avatar').hasAttribute('src'), false);
  assert.equal(requests.length, 2, 'Style changes do not reset or refresh the public session');
  send(element, 'Bagaimana dengan teknologi yang dipakai?');
  await until(() => requests.length === 3 && element.dataset.state === 'talk');
  assert.equal(requests.filter(request => request.url.endsWith('/sessions')).length, 1);
  assert.equal((requests[2].options.headers as Record<string, string>).Authorization, 'Bearer same-public-session');
});

test('pixel animation redraws while connected, stops on disconnect, and reconnects once', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const element = widget({ appearance: 'pixel' });
  await Promise.resolve();
  const connectedPaints = pixelPaints;
  context.mock.timers.tick(300);
  frameAt(performance.now() + 1000);
  await Promise.resolve();
  assert.ok(pixelPaints > connectedPaints, 'Connected pixel animation advances frames');
  element.remove();
  const disconnectedPaints = pixelPaints;
  context.mock.timers.tick(120_000);
  frameAt(performance.now() + 120_000);
  await Promise.resolve();
  assert.equal(pixelPaints, disconnectedPaints, 'Removed widget cannot continue drawing');
  document.body.append(element);
  await Promise.resolve();
  const reconnectedPaints = pixelPaints;
  assert.ok(reconnectedPaints > disconnectedPaints, 'Reconnected widget paints its current state');
  context.mock.timers.tick(300);
  frameAt(performance.now() + 1000);
  await Promise.resolve();
  assert.ok(pixelPaints > reconnectedPaints);
  assert.equal(element.shadowRoot!.querySelectorAll('.pixel-avatar').length, 1);
  element.remove();
  const finalPaints = pixelPaints;
  context.mock.timers.tick(120_000);
  frameAt(performance.now() + 120_000);
  await Promise.resolve();
  assert.equal(pixelPaints, finalPaints);
});

test('drag lifts and drops KARI without clicking chat, calls or losing the draft', () => {
  let calls = 0; globalThis.fetch = (() => { calls++; throw new Error('Drag must stay local'); }) as typeof fetch;
  const element = widget({ appearance: 'pixel' });
  const launcher = query<HTMLButtonElement>(element, '.launcher');
  launcher.click(); const draft = query<HTMLInputElement>(element, 'input'); draft.value = 'Belum dikirim';
  const text = query(element, '.text').textContent;
  const [left, top] = position(element);
  pointer(launcher, 'pointerdown', left + 270, top + 270);
  pointer(window, 'pointermove', left + 70, top + 170);
  assert.equal(element.hasAttribute('data-dragging'), true);
  assert.equal(element.hasAttribute('data-free-position'), true);
  assert.notDeepEqual(position(element), [left, top]);
  pointer(window, 'pointerup', left + 70, top + 170);
  launcher.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  assert.equal(element.hasAttribute('data-dragging'), false);
  assert.equal(element.hasAttribute('data-open'), true, 'A release click cannot toggle the bubble');
  assert.equal((element as any).pinned, false, 'Manual placement stays temporary unless explicitly pinned');
  assert.equal(element.getAttribute('data-behavior'), 'LANDED');
  assert.equal(element.hasAttribute('data-glitch'), false, 'Release never triggers a glitch');
  assert.equal(document.querySelector('[data-kari-lightning]'), null, 'Dragging cannot create autonomous lightning');
  assert.equal(draft.value, 'Belum dikirim'); assert.equal(query(element, '.text').textContent, text);
  const dropped = element.style.transform;
  window.dispatchEvent(new dom.window.Event('resize'));
  assert.equal(element.style.transform, dropped, 'Layout observation preserves a manual drop');
  assert.equal(calls, 0);
});

test('tiny pointer movement is still a click; hold lifts and Escape restores the original position', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const element = widget({ appearance: 'pixel' }); const launcher = query<HTMLButtonElement>(element, '.launcher');
  pointer(launcher, 'pointerdown', 950, 700);
  pointer(window, 'pointermove', 952, 702);
  context.mock.timers.tick(220);
  assert.equal(element.hasAttribute('data-dragging'), false, 'An ordinary unhurried click does not lift');
  pointer(window, 'pointerup', 952, 702);
  launcher.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.equal(element.hasAttribute('data-open'), true);
  assert.equal(element.hasAttribute('data-free-position'), false);
  const origin = element.style.transform;
  pointer(launcher, 'pointerdown', 950, 700);
  context.mock.timers.tick(321);
  assert.equal(element.hasAttribute('data-dragging'), true, 'Holding lifts without needing movement');
  pointer(window, 'pointermove', 500, 400);
  launcher.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(element.hasAttribute('data-dragging'), false);
  assert.equal(element.hasAttribute('data-free-position'), false);
  assert.equal(element.style.transform, origin);
  assert.equal(element.hasAttribute('data-open'), true, 'Escape cancels the drag first');
  assert.equal((element as any).pinned, false);
});

test('drag stays in the viewport, ignores unrelated pointers, and cancels on capture loss or disconnect', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const element = widget({ appearance: 'pixel' }); const launcher = query<HTMLButtonElement>(element, '.launcher');
  pointer(launcher, 'pointerdown', 950, 700, 8);
  pointer(window, 'pointermove', -1000, -1000, 9);
  assert.equal(element.hasAttribute('data-dragging'), false);
  pointer(window, 'pointermove', -1000, -1000, 8);
  assert.deepEqual(position(element), [12, 12]);
  pointer(window, 'pointerup', 0, 0, 9);
  assert.equal(element.hasAttribute('data-dragging'), true);
  pointer(launcher, 'lostpointercapture', 0, 0, 8);
  assert.equal(element.hasAttribute('data-dragging'), false);
  assert.equal(element.hasAttribute('data-free-position'), false);
  pointer(launcher, 'pointerdown', 950, 700, 10);
  element.remove(); context.mock.timers.tick(500);
  assert.equal(element.hasAttribute('data-dragging'), false, 'Disconnected hold cannot lift later');
  document.body.append(element);
  pointer(launcher, 'pointerdown', 950, 700, 11);
  pointer(window, 'pointermove', 20_000, 20_000, 11);
  pointer(window, 'pointerup', 20_000, 20_000, 11);
  const [x, y] = position(element);
  assert.ok(x + 126 <= window.innerWidth - 12); assert.ok(y + 150 <= window.innerHeight - 12);
});

test('keyboard movement and touch dragging work with reduced motion without decorative bursts', () => {
  reduced = true;
  const element = widget({ appearance: 'pixel' }); const launcher = query<HTMLButtonElement>(element, '.launcher');
  const [left, top] = position(element);
  launcher.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual(position(element), [left - 24, top]);
  assert.equal(element.hasAttribute('data-free-position'), true);
  pointer(launcher, 'pointerdown', 800, 650, 2, { pointerType: 'touch' });
  pointer(window, 'pointermove', 500, 400, 2, { pointerType: 'touch' });
  assert.equal(element.hasAttribute('data-dragging'), true);
  pointer(window, 'pointerup', 500, 400, 2, { pointerType: 'touch' });
  assert.equal(element.hasAttribute('data-dropped'), false); assert.equal(element.hasAttribute('data-glitch'), false);
  const manual = element.style.transform;
  send(element, 'Kari, pindah ke kiri');
  assert.notEqual(element.style.transform, manual); assert.equal(position(element)[0], 12);
  assert.equal(element.hasAttribute('data-free-position'), false, 'Explicit anchor commands still work after a drag');
});

test('drop reclamps after a viewport shrinks during an active drag', () => {
  const element = widget({ appearance: 'pixel' }); const launcher = query<HTMLButtonElement>(element, '.launcher');
  const previousWidth = window.innerWidth, previousHeight = window.innerHeight;
  try {
    pointer(launcher, 'pointerdown', 900, 650);
    pointer(window, 'pointermove', 1000, 750);
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });
    window.dispatchEvent(new dom.window.Event('resize'));
    pointer(window, 'pointerup', 1000, 750);
    const [x, y] = position(element);
    assert.ok(x >= 12 && x + 126 <= 388); assert.ok(y >= 12 && y + 150 <= 288);
  } finally {
    Object.defineProperty(window, 'innerWidth', { value: previousWidth, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: previousHeight, configurable: true });
  }
});

test('cancel or blur on bubble controls cannot leave later local moves blocked', () => {
  const element = widget();
  pointer(query(element, '.send'), 'pointerdown', 800, 650);
  pointer(window, 'pointercancel', 800, 650);
  send(element, 'Kari, pindah ke kiri'); assert.equal(position(element)[0], 12);
  send(element, 'Kari, pindah ke kanan');
  pointer(query(element, 'input'), 'pointerdown', 800, 650);
  window.dispatchEvent(new dom.window.Event('blur'));
  send(element, 'Kari, pindah ke kiri'); assert.equal(position(element)[0], 12);
  assert.match(query(element, '.text').textContent!, /di kiri/u);
});

test('bubble toggles and reply growth leave the mascot at the same anchor or manual position', () => {
  for (const anchor of ['bottom-right', 'bottom-left', 'middle-right', 'middle-left']) {
    const element = widget({ appearance: 'pixel', position: anchor });
    const launcher = query<HTMLButtonElement>(element, '.launcher');
    const original = element.style.transform;
    launcher.click(); assert.equal(element.style.transform, original, anchor + ': opening must not move the mascot');
    assert.equal(element.hasAttribute('data-glitch'), false, 'Opening chat does not create a displacement effect');
    send(element, 'Kari, halo');
    window.dispatchEvent(new dom.window.Event('resize'));
    assert.equal(element.style.transform, original, anchor + ': reply changes cannot recenter the mascot');
    launcher.click(); assert.equal(element.style.transform, original, anchor + ': closing must not move the mascot');
    pointer(launcher, 'pointerdown', 900, 650);
    pointer(window, 'pointermove', 600, 400);
    pointer(window, 'pointerup', 600, 400);
    const manual = element.style.transform;
    launcher.click(); assert.equal(element.style.transform, manual);
    launcher.click(); assert.equal(element.style.transform, manual);
    element.remove();
  }
});

test('random glitch uses bounded bursts even with idle input focus, pauses while typing and stops when hidden', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  context.mock.method(Math, 'random', () => 0.5);
  const element = widget({ appearance: 'pixel' }); query<HTMLButtonElement>(element, '.launcher').click();
  assert.equal(element.shadowRoot!.activeElement, query(element, 'input'));
  context.mock.timers.tick(8499); assert.equal(element.hasAttribute('data-glitch'), false);
  context.mock.timers.tick(1); assert.equal(element.hasAttribute('data-glitch'), true);
  context.mock.timers.tick(319); assert.equal(element.hasAttribute('data-glitch'), true);
  context.mock.timers.tick(1); assert.equal(element.hasAttribute('data-glitch'), false);
  context.mock.timers.tick(7680);
  query(element, 'input').dispatchEvent(new dom.window.Event('input'));
  context.mock.timers.tick(500); assert.equal(element.hasAttribute('data-glitch'), false, 'Recent typing suppresses the next burst');
  context.mock.timers.tick(8500); assert.equal(element.hasAttribute('data-glitch'), true, 'Idle focus alone does not disable random glitches');
  element.remove();
  context.mock.timers.tick(40_000); assert.equal(element.hasAttribute('data-glitch'), false);
});

test('sleeping pixel KARI wakes before opening chat, with no inference request', context => {
  let clock = 0, calls = 0;
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  context.mock.method(performance, 'now', () => clock);
  context.mock.method(Math, 'random', () => .5);
  globalThis.fetch = (() => { calls++; throw new Error('Wake stays local'); }) as typeof fetch;
  const element = widget({ appearance: 'pixel', 'behavior-config': JSON.stringify({ sleepAfterMs: 1000, sleepMinMs: 10_000, sleepMaxMs: 10_000, moveMinMs: 60_000, moveMaxMs: 60_000 }) });
  const advance = (ms: number) => { clock += ms; context.mock.timers.tick(ms); frameAt(clock); };
  advance(1300); assert.equal(element.getAttribute('data-behavior'), 'YAWN');
  for (let elapsed = 0; elapsed < 4000 && element.getAttribute('data-behavior') !== 'SLEEP'; elapsed += 200) {
    assert.equal(element.getAttribute('data-behavior'), 'YAWN', 'Bedtime goes straight from yawn into sleep');
    advance(200);
  }
  assert.equal(element.getAttribute('data-behavior'), 'SLEEP');
  query<HTMLButtonElement>(element, '.launcher').click();
  assert.equal(element.getAttribute('data-behavior'), 'WAKE_UP');
  assert.equal(element.hasAttribute('data-open'), false, 'Sleeping click must first wake the character');
  advance(1000); assert.equal(element.hasAttribute('data-open'), false);
  advance(110); assert.equal(element.hasAttribute('data-open'), true);
  assert.equal(calls, 0);
});

test('picking up clears an existing glitch and release has no electrical effect', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const element = widget({ appearance: 'pixel' }), launcher = query<HTMLButtonElement>(element, '.launcher');
  send(element, 'Kari, halo'); assert.equal(element.hasAttribute('data-glitch'), true);
  pointer(launcher, 'pointerdown', 950, 700); pointer(window, 'pointermove', 700, 400);
  assert.equal(element.hasAttribute('data-glitch'), false);
  assert.equal(element.getAttribute('data-behavior'), 'DRAGGED');
  pointer(window, 'pointerup', 700, 400);
  context.mock.timers.tick(1000);
  assert.equal(element.hasAttribute('data-glitch'), false);
  assert.equal(element.hasAttribute('data-lightning'), false);
  assert.equal(document.querySelector('[data-kari-lightning]'), null);
});
