/**
 * Service Worker - SNS Memo PWA
 * 
 * キャッシュ戦略：
 *   - バージョン番号でキャッシュ名を管理 → HTML修整時に自動切替
 *   - install: 新キャッシュ作成 + 旧バージョンキャッシュ削除
 *   - activate: 古いキャッシュを確実に一掃
 *   - skipWaiting() + clients.claim() で待機させず即座に有効化
 *   - controllerchange（メインのindex.htmlで検知）で自動リロード
 * 
 * 使用方法：
 *   index.html の <meta name="app-version"> を変更するだけで
 *   次回訪問時に自動的に古いキャッシュが削除されます。
 */

// ==================== [設定] ====================
// バージョン番号はHTMLから渡されます（URLクエリパラメータ: sw.js?v=VERSION）
const params = new URL(import.meta.url).searchParams;
const APP_VERSION = params.get('v') || 'unknown';
const CACHE_NAME = `sns-memo-v${APP_VERSION}`;

// キャッシュ対象ファイル（静的アセット）
// 注: index.html は常にネットワークから最新版を取得
const CACHE_ASSETS = [
  './',  // サイトルート
  './manifest.json',
  './icon.png',
  // React CDN (フォールバック用)
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
];

// ==================== [install イベント] ====================
// 新バージョンのキャッシュを作成し、旧バージョンを削除
self.addEventListener('install', (event) => {
  console.log(`[SW install] ${CACHE_NAME}`);
  
  event.waitUntil(
    (async () => {
      try {
        // 新キャッシュを開く
        const cache = await caches.open(CACHE_NAME);
        
        // 静的アセットをキャッシュに追加（ネットワークエラーは無視）
        await Promise.all(
          CACHE_ASSETS.map(url => {
            return cache.add(url).catch(err => {
              console.warn(`[SW] キャッシュ追加失敗: ${url}`, err.message);
            });
          })
        );
        
        // 旧キャッシュを削除
        const cacheNames = await caches.keys();
        const oldCaches = cacheNames.filter(name => 
          name.startsWith('sns-memo-v') && name !== CACHE_NAME
        );
        
        if (oldCaches.length > 0) {
          console.log(`[SW] 旧キャッシュを削除: ${oldCaches.join(', ')}`);
          await Promise.all(oldCaches.map(name => caches.delete(name)));
        }
        
        // 待機中のSWを即座にアクティベート
        self.skipWaiting();
      } catch (err) {
        console.error('[SW install] エラー:', err);
      }
    })()
  );
});

// ==================== [activate イベント] ====================
// ページの制御を即座に握る（clients.claim()）
self.addEventListener('activate', (event) => {
  console.log(`[SW activate] ${CACHE_NAME}`);
  
  event.waitUntil(
    (async () => {
      try {
        // 古いキャッシュを確実に削除（念の為 install でも削除済みだが重複削除）
        const cacheNames = await caches.keys();
        const oldCaches = cacheNames.filter(name => 
          name.startsWith('sns-memo-v') && name !== CACHE_NAME
        );
        
        await Promise.all(oldCaches.map(name => caches.delete(name)));
        
        // 既に開かれているページの制御を奪取（待機させない）
        await self.clients.claim();
        console.log('[SW] 全クライアントの制御を取得');
      } catch (err) {
        console.error('[SW activate] エラー:', err);
      }
    })()
  );
});

// ==================== [メッセージハンドラー] ====================
// メインスレッドから SKIP_WAITING を受け取ったら即座にスキップ
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] SKIP_WAITING 受信 → 即座にアクティベート');
    self.skipWaiting();
  }
});

// ==================== [fetch イベント] ====================
// キャッシュ戦略: Stale While Revalidate（ハイブリッド）
//   - index.html: ネットワーク優先（常に最新版）
//   - 静的アセット: キャッシュ優先（フォールバック: ネットワーク）
//   - その他: ネットワーク優先（フォールバック: キャッシュ）
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // 外部リクエスト（http/https以外）は無視
  if (!url.protocol.startsWith('http')) {
    return;
  }
  
  // ==================== index.html: ネットワーク優先 ====================
  if (url.pathname === '/' || url.pathname.endsWith('index.html')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // 200系ステータスのみキャッシュに保存（リダイレクトなどは除外）
          if (response.status === 200) {
            const cache = caches.open(CACHE_NAME);
            cache.then(c => c.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => {
          // ネットワークエラー時はキャッシュから取得
          return caches.match(request).then(response => {
            return response || new Response(
              '<h1>オフライン</h1><p>インターネット接続がありません。</p>',
              { status: 503, headers: { 'Content-Type': 'text/html;charset=utf-8' } }
            );
          });
        })
    );
    return;
  }
  
  // ==================== 静的アセット: キャッシュ優先 ====================
  if (
    url.pathname.endsWith('.js') || 
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.json') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.jpeg') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.svg') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdnjs.cloudflare.com')
  ) {
    event.respondWith(
      caches.match(request)
        .then(response => {
          // キャッシュにあれば返す
          if (response) {
            return response;
          }
          
          // ネットワークから取得してキャッシュに追加
          return fetch(request).then(response => {
            if (response.status === 200) {
              const cache = caches.open(CACHE_NAME);
              cache.then(c => c.put(request, response.clone()));
            }
            return response;
          });
        })
        .catch(() => {
          // 両者失敗時はオフライン応答
          return new Response(
            '<h1>リソース読み込み失敗</h1><p>オフラインのため読み込めません。</p>',
            { status: 503, headers: { 'Content-Type': 'text/html;charset=utf-8' } }
          );
        })
    );
    return;
  }
  
  // ==================== その他: ネットワーク優先 ====================
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.status === 200) {
          const cache = caches.open(CACHE_NAME);
          cache.then(c => c.put(request, response.clone()));
        }
        return response;
      })
      .catch(() => {
        return caches.match(request).catch(() => {
          return new Response(
            '<h1>エラー</h1><p>リソースを取得できません。</p>',
            { status: 503, headers: { 'Content-Type': 'text/html;charset=utf-8' } }
          );
        });
      })
  );
});
