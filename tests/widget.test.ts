import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3000/demo', pretendToBeVisual: true });
let reduced = false;
Object.defineProperty(dom.window, 'matchMedia', { value: (query: string) => ({ matches: query.includes('prefers-reduced-motion') && reduced, media: query, addEventListener() {}, removeEventListener() {} }) });
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
  assert.equal(query(element, '.pin').getAttribute('aria-pressed'), 'true');
  send(element, 'Kari, halo');
  assert.match(query(element, '.text').textContent!, /Hai/u);
  assert.equal(calls, 0);
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

test('reduced motion suspends decorative animation and hide retains accessible reopen', () => {
  reduced = true;
  const element = widget();
  query<HTMLButtonElement>(element, '.launcher').click();
  assert.equal(element.hasAttribute('data-suspended'), true);
  assert.equal(element.hasAttribute('data-glitch'), false);
  assert.equal(query<HTMLButtonElement>(element, '.roam').disabled, true);
  query<HTMLButtonElement>(element, '.hide').click();
  const reopen = query<HTMLButtonElement>(element, '.reopen');
  assert.equal(reopen.hidden, false);
  assert.equal(element.shadowRoot!.activeElement, reopen);
  reopen.click();
  assert.equal(element.shadowRoot!.activeElement, query(element, '.launcher'));
});

test('invalid executable API URL never starts a request', () => {
  let calls = 0; globalThis.fetch = (() => { calls++; throw new Error('No API call expected'); }) as typeof fetch;
  const element = widget({ 'api-base': 'javascript:alert(1)' });
  send(element, 'Apa kabar?');
  assert.match(query(element, '.text').textContent!, /Konfigurasi/u);
  assert.equal(calls, 0);
});
