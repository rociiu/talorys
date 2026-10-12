// Talorys service worker. It only shows Web Push notifications: nothing is cached, so the
// app always loads fresh from the network. Payloads arrive encrypted end to end (RFC 8291).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Only same-origin paths can be opened from a notification. */
function safePath(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : "/";
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Talorys";
  // Every push must show a notification; browsers revoke permission from silent pushes.
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: typeof data.id === "string" ? data.id : undefined,
      data: { url: safePath(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data?.url), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) return open.focus();
      return self.clients.openWindow(target);
    })(),
  );
});

// The browser replaced the subscription (keys rotated or it expired): register the new one.
self.addEventListener("pushsubscriptionchange", (event) => {
  const options = event.oldSubscription?.options;
  if (!options?.applicationServerKey) return;
  event.waitUntil(
    (async () => {
      const sub = event.newSubscription ?? (await self.registration.pushManager.subscribe(options));
      await fetch("/api/push/subscriptions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-talorys-request": "1" },
        body: JSON.stringify(sub.toJSON()),
      });
    })(),
  );
});
