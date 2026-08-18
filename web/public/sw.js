/* eslint-disable no-restricted-globals */

self.addEventListener("push", (event) => {
  if (!event.data) return;

  try {
    const payload = event.data.json();
    const title = payload.title || "AstroidBot Alert";
    const options = {
      body: payload.body || "You have a new update.",
      icon: "/astroid-logo.png", // fallback or project logo
      badge: "/astroid-badge.png",
      data: {
        url: payload.url || "/portfolio",
        timestamp: payload.timestamp,
      },
      tag: payload.tag || "astroidbot-notification",
      renotify: true,
      vibrate: [100, 50, 100],
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error("Error processing push event:", err);
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/portfolio";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
