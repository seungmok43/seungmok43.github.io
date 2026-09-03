/* 사랑방 4W 키트 — 서비스워커
 *
 * ★설계 요지 (본부 발주 2026-08-07)
 *  ① 앱 코드 = stale-while-revalidate
 *     캐시본을 즉시 내주고(오프라인에서도 바로 뜬다) 뒤에서 새 버전을 받아 캐시를 갱신한다.
 *     목자는 아무 조치도 하지 않는다 — 다음에 열면 새 버전이다.
 *  ② 자료(content.json) = network-first + 캐시 폴백
 *     오너가 고친 자료가 가능한 한 즉시 반영되게 하고, 오프라인이면 마지막으로 받은 자료를 쓴다.
 *  ③ ★이 워커 자신은 어떤 데이터도 업로드하지 않는다(다운로드 전용).
 *     VIP 명단 등 앱이 스스로 만드는 개인정보는 localStorage에만 있고 네트워크에 올라가지 않는다.
 *     ⚠단 2026-08-30 투입된 「긍휼 사역 매칭」 설문(matching.html)은 예외다 —
 *       이용자가 직접 적은 이름·소속·연락처를 외부 시트로 보낸다. 워커를 거치지 않는 별도 전송이다.
 *       「이 앱은 아무것도 업로드하지 않는다」고 더는 말할 수 없다.
 *
 * ⚠ APP_VERSION 을 올리면 옛 캐시가 정리된다. 앱 코드를 고칠 때마다 올릴 것.
 */

const APP_VERSION  = '2026-09-03.1';   // 2026-08-31 빈 UI 16개 채움(결단·스탬프·파송기도문)
const SHELL_CACHE   = `sarangbang-4w-shell-${APP_VERSION}`;
const CONTENT_CACHE = 'sarangbang-4w-content';   // 버전 고정 — 자료는 코드 버전과 무관

// 앱 셸 (코드·아이콘). content.json 은 여기 넣지 않는다(전략이 다르다).
const SHELL_ASSETS = [
  './',
  './index.html',
  './matching.html',
  './manifest.json',
  './img/touch-banner.jpg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon-180.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 개별 실패가 설치 전체를 깨뜨리지 않게 한 건씩 담는다
    await Promise.all(SHELL_ASSETS.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (e) { console.warn('[sw] 캐시 실패(무시):', url, e); }
    }));
    // 자료도 설치 시 한 번 받아 둔다(첫 오프라인 대비)
    try {
      const c2 = await caches.open(CONTENT_CACHE);
      await c2.add(new Request('./content.json', { cache: 'reload' }));
    } catch (e) { console.warn('[sw] content.json 초기 캐시 실패(무시)', e); }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      // 이번 버전 셸과 자료 캐시만 남기고 옛 셸 캐시는 지운다
      if (k !== SHELL_CACHE && k !== CONTENT_CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // ★GET 이외(POST 등)는 절대 다루지 않는다 — 이 앱은 업로드를 하지 않는다.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 외부 도메인(구글 폰트 등)은 건드리지 않는다 — 실패해도 앱은 시스템 폰트로 뜬다.
  if (url.origin !== self.location.origin) return;

  // ── ② 자료: network-first ──
  if (url.pathname.endsWith('/content.json')) {
    event.respondWith((async () => {
      const cache = await caches.open(CONTENT_CACHE);
      try {
        const fresh = await fetch(new Request(req, { cache: 'no-store' }));
        if (fresh && fresh.ok) { cache.put('./content.json', fresh.clone()); return fresh; }
        throw new Error('bad response');
      } catch (e) {
        const cached = await cache.match('./content.json');
        if (cached) return cached;
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // ── ① 앱 코드: stale-while-revalidate ──
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });

    const network = fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);

    if (cached) {
      event.waitUntil(network);   // 캐시를 즉시 주고 갱신은 뒤에서
      return cached;
    }
    const res = await network;
    if (res) return res;

    // 오프라인 + 캐시 없음 → 내비게이션이면 앱 진입점으로
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('오프라인입니다. 네트워크에 한 번 연결하면 이후에는 오프라인에서도 열립니다.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
