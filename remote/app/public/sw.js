// Claake Code Remote service worker: offline app shell and notifications.
const CACHE = "claake-remote-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so a deploy shows up on the next launch; the cache only serves offline launches.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname === "/ws" || url.pathname === "/healthz" || url.pathname === "/vapid-public-key") return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request.mode === "navigate" ? "/" : request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request.mode === "navigate" ? "/" : request).then((cached) => cached || Response.error())),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  // iOS requires a visible notification for every push.
  event.waitUntil(
    self.registration.showNotification(data.title || "Claake Code", {
      body: data.body || "L'agent a terminé.",
      tag: data.conversationId || "claake",
      icon: "/icons/icon-192.png",
      data: { conversationId: data.conversationId || null, workspaceId: data.workspaceId || null },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { conversationId, workspaceId } = event.notification.data || {};
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const client = windows[0];
      if (client) {
        client.postMessage({ type: "open-conversation", conversationId, workspaceId });
        return client.focus();
      }
      const params = new URLSearchParams();
      if (conversationId) params.set("conversation", conversationId);
      if (workspaceId) params.set("workspace", workspaceId);
      const query = params.toString();
      return self.clients.openWindow(query ? `/?${query}` : "/");
    }),
  );
});
