// Service Worker: Offline-Betrieb, Mitteilungen und Hintergrund-Prüfung.
importScripts("js/schedule.js");

const VERSION = "v2";
const APP_CACHE = "haushalt-app-" + VERSION;
const STATE_CACHE = "haushalt-state";
const ASSETS = [
  "./", "index.html", "css/styles.css", "js/app.js", "js/config.js", "js/defaults.js", "js/schedule.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("haushalt-app-") && k !== APP_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Netzwerk zuerst (für Updates), bei Offline aus dem Cache.
// "no-cache": immer beim Server nachfragen, nie eine alte Datei aus dem Browser-Speicher
// nehmen – sonst können alte und neue Dateien gemischt werden.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(new Request(e.request.url, { cache: "no-cache", credentials: "same-origin" }));
      if (res.ok) {
        const c = await caches.open(APP_CACHE);
        c.put(e.request, res.clone());
      }
      return res;
    } catch {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      return hit || caches.match("index.html");
    }
  })());
});

async function readJson(url, fallback) {
  try {
    const c = await caches.open(STATE_CACHE);
    const r = await c.match(new URL(url, self.registration.scope).href);
    if (r) return await r.json();
  } catch { /* ignorieren */ }
  return fallback;
}

async function checkDueInBackground({ force = false } = {}) {
  const state = await readJson("__state.json", null);
  if (!state) return;
  // Mit Push-Server kommen die Erinnerungen von dort – nicht doppelt melden.
  if (!force && state.push && state.push.endpoint) return;
  const notified = await readJson("__notified.json", {});
  const list = self.Schedule.tasksToNotify(state, notified, Date.now());
  if (!list.length) return;
  const { title, body } = self.Schedule.notificationText(list);
  await self.registration.showNotification(title, {
    body, tag: "haushalt-faellig", renotify: true, lang: "de",
    icon: "icons/icon-192.png", badge: "icons/icon-192.png",
  });
  for (const t of list) notified[t.id] = self.Schedule.dayKey(self.Schedule.dueDate(t));
  const c = await caches.open(STATE_CACHE);
  await c.put(new URL("__notified.json", self.registration.scope).href,
    new Response(JSON.stringify(notified), { headers: { "Content-Type": "application/json" } }));
  try {
    const due = state.tasks.filter((t) => self.Schedule.daysLeft(t) <= 0).length;
    if (self.navigator.setAppBadge) self.navigator.setAppBadge(due);
  } catch { /* nicht unterstützt */ }
}

// Android/Chrome (installierte App): regelmäßige Hintergrund-Prüfung.
self.addEventListener("periodicsync", (e) => {
  if (e.tag === "check-due") e.waitUntil(checkDueInBackground());
});

// Web-Push vom Haushalt-Server (server/): Nachricht anzeigen.
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let data = null;
    try { data = e.data ? e.data.json() : null; } catch { data = null; }
    if (!data || !data.title) return checkDueInBackground({ force: true });
    await self.registration.showNotification(data.title, {
      body: data.body || "", tag: data.tag || "haushalt-faellig", renotify: true, lang: "de",
      icon: "icons/icon-192.png", badge: "icons/icon-192.png",
    });
    try {
      if (typeof data.count === "number" && self.navigator.setAppBadge) self.navigator.setAppBadge(data.count);
    } catch { /* nicht unterstützt */ }
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { c.postMessage("refresh"); return c.focus(); }
    }
    return self.clients.openWindow("./");
  })());
});
