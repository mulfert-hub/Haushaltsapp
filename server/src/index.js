// Haushalt-Push: kleiner Server (Cloudflare Worker) für Erinnerungen der Haushalts-App.
//
// Die App schickt pro Gerät ihr Push-Abonnement und die Fälligkeitstermine der Aufgaben.
// Ein Zeitplan (alle 15 Minuten) prüft, ob zur eingestellten Uhrzeit Aufgaben fällig sind,
// und sendet dann eine Web-Push-Mitteilung, auch wenn die App geschlossen ist.
//
// Endpunkte:
//   GET    /api/vapid-public-key       → { publicKey }
//   PUT    /api/subscription           → Abonnement + Termine speichern/aktualisieren
//   DELETE /api/subscription           → Abonnement entfernen ({ endpoint })
//   POST   /api/test                   → Test-Mitteilung an dieses Gerät ({ endpoint, delay? Sekunden })
//   POST   /api/status                 → Was der Server über dieses Gerät weiß ({ endpoint })
//   GET    /api/health                 → { ok: true }

import { generateVapidKeys, sendPush } from "./webpush.js";

const MAX_SUBSCRIPTIONS = 50;
const MAX_TASKS = 300;
const MAX_BODY = 64 * 1024;
const SUB_PREFIX = "sub:";

// ---------- Hilfen ----------

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes("*") || allowed.includes(origin);
  return ok
    ? {
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      }
    : null;
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(cors || {}) },
  });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Zu groß");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "Ungültiges JSON"); }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function subKey(endpoint) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return SUB_PREFIX + [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getVapid(env) {
  const stored = await env.HAUSHALT_KV.get("vapid", "json");
  if (stored && stored.publicKey && stored.privateJwk) return stored;
  // Beim ersten Start einmalig erzeugen und dauerhaft speichern.
  const keys = await generateVapidKeys();
  await env.HAUSHALT_KV.put("vapid", JSON.stringify(keys));
  return keys;
}

function subjectOf(env) {
  return env.VAPID_SUBJECT || "https://mulfert-hub.github.io/Family-Dashboard-/";
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat("de-DE", { timeZone: tz }); return true; } catch { return false; }
}

function cleanString(s, max) {
  return String(s ?? "").slice(0, max);
}

export function validateRecord(body, { allowHttp = false } = {}) {
  const sub = body && body.subscription;
  const scheme = allowHttp ? /^https?:\/\// : /^https:\/\//;
  if (!sub || typeof sub.endpoint !== "string" || !scheme.test(sub.endpoint) ||
      !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") {
    throw new HttpError(400, "Abonnement fehlt oder ist ungültig");
  }
  const tz = validTimeZone(body.tz) ? body.tz : "Europe/Berlin";
  const notifyTime = TIME_RE.test(body.notifyTime) ? body.notifyTime : "09:00";
  const tasks = (Array.isArray(body.tasks) ? body.tasks : []).slice(0, MAX_TASKS)
    .filter((t) => t && t.id && t.name && DAY_RE.test(t.due))
    .map((t) => ({ id: cleanString(t.id, 64), name: cleanString(t.name, 80), room: cleanString(t.room, 40), due: t.due }));
  return {
    subscription: { endpoint: sub.endpoint.slice(0, 1024), keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) } },
    tz, notifyTime, enabled: body.enabled !== false, tasks,
  };
}

// ---------- Zeitlogik ----------

/** Lokales Datum (YYYY-MM-DD) und Uhrzeit (HH:MM) in einer Zeitzone. */
export function localNow(tz, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Welche Aufgaben sollen jetzt gemeldet werden? */
export function dueForNotification(record, now = new Date()) {
  if (!record.enabled) return [];
  const { day, time } = localNow(record.tz, now);
  if (time < record.notifyTime) return [];
  const notified = record.notified || {};
  return record.tasks.filter((t) => t.due <= day && notified[t.id] !== t.due);
}

export function buildMessage(tasks, totalDue) {
  const names = tasks.map((t) => t.name);
  const title = tasks.length === 1 ? `Wieder dran: ${names[0]}` : `${tasks.length} Haushaltsaufgaben sind dran`;
  const body = tasks.length === 1
    ? `${tasks[0].room ? tasks[0].room + " · " : ""}Tippe, um sie abzuhaken.`
    : names.slice(0, 5).join(", ") + (names.length > 5 ? " …" : "");
  return { title, body, count: totalDue, tag: "haushalt-faellig" };
}

// ---------- Anfragen ----------

function pushResult(res) {
  return { at: new Date().toISOString(), ok: !!res.ok, status: res.status || 0, reason: res.reason || "" };
}

async function sendTest(env, key, rec) {
  let res;
  try {
    res = await sendPush(rec.subscription,
      { title: "Test: Haushaltsplan", body: "Push-Mitteilungen über den Server funktionieren.", tag: "haushalt-test" },
      { vapid: await getVapid(env), subject: subjectOf(env), urgency: "high" });
  } catch (e) {
    res = { ok: false, status: 0, reason: String((e && e.message) || e) };
  }
  if (res.gone) {
    await env.HAUSHALT_KV.delete(key);
  } else {
    const fresh = (await env.HAUSHALT_KV.get(key, "json")) || rec;
    fresh.lastTest = pushResult(res);
    await env.HAUSHALT_KV.put(key, JSON.stringify(fresh));
  }
  return res;
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
  }
  if (url.pathname === "/api/health") return json({ ok: true }, 200, cors);
  // Schreibende Zugriffe nur von der eigenen App aus.
  if (!cors) return json({ error: "Herkunft nicht erlaubt" }, 403);

  if (url.pathname === "/api/vapid-public-key" && request.method === "GET") {
    const { publicKey } = await getVapid(env);
    return json({ publicKey }, 200, cors);
  }

  if (url.pathname === "/api/subscription" && request.method === "PUT") {
    const rec = validateRecord(await readBody(request), { allowHttp: env.DEV_ALLOW_HTTP_ENDPOINT === "1" });
    const key = await subKey(rec.subscription.endpoint);
    const existing = await env.HAUSHALT_KV.get(key, "json");
    if (!existing) {
      const list = await env.HAUSHALT_KV.list({ prefix: SUB_PREFIX, limit: MAX_SUBSCRIPTIONS + 1 });
      if (list.keys.length >= MAX_SUBSCRIPTIONS) throw new HttpError(429, "Zu viele Geräte angemeldet");
    }
    // Bereits gemeldete Termine behalten, damit nach einem Abgleich nicht doppelt erinnert wird.
    const oldNotified = (existing && existing.notified) || {};
    const notified = {};
    for (const t of rec.tasks) if (oldNotified[t.id] === t.due) notified[t.id] = t.due;
    await env.HAUSHALT_KV.put(key, JSON.stringify({
      ...rec, notified, updatedAt: new Date().toISOString(),
      lastPush: existing ? existing.lastPush || null : null,
      lastTest: existing ? existing.lastTest || null : null,
    }));
    return json({ ok: true }, 200, cors);
  }

  if (url.pathname === "/api/subscription" && request.method === "DELETE") {
    const body = await readBody(request);
    if (typeof body.endpoint !== "string") throw new HttpError(400, "endpoint fehlt");
    await env.HAUSHALT_KV.delete(await subKey(body.endpoint));
    return json({ ok: true }, 200, cors);
  }

  if (url.pathname === "/api/test" && request.method === "POST") {
    const body = await readBody(request);
    const key = typeof body.endpoint === "string" ? await subKey(body.endpoint) : null;
    const rec = key && (await env.HAUSHALT_KV.get(key, "json"));
    if (!rec) throw new HttpError(404, "Gerät ist beim Server nicht angemeldet");
    const delay = Math.max(0, Math.min(25, Number(body.delay) || 0));
    if (delay > 0 && ctx) {
      // Später senden, damit man die App vorher schließen kann.
      ctx.waitUntil(new Promise((r) => setTimeout(r, delay * 1000)).then(() => sendTest(env, key, rec)));
      return json({ ok: true, scheduled: delay }, 200, cors);
    }
    const res = await sendTest(env, key, rec);
    return json({ ok: res.ok, status: res.status, reason: res.reason || "" }, 200, cors);
  }

  if (url.pathname === "/api/status" && request.method === "POST") {
    const body = await readBody(request);
    const rec = typeof body.endpoint === "string" && (await env.HAUSHALT_KV.get(await subKey(body.endpoint), "json"));
    if (!rec) return json({ registered: false }, 200, cors);
    return json({
      registered: true,
      pushService: new URL(rec.subscription.endpoint).host,
      tasks: rec.tasks.length,
      tz: rec.tz, notifyTime: rec.notifyTime, enabled: rec.enabled,
      updatedAt: rec.updatedAt || null,
      lastPush: rec.lastPush || null,
      lastTest: rec.lastTest || null,
    }, 200, cors);
  }

  return json({ error: "Nicht gefunden" }, 404, cors);
}

// ---------- Zeitplan ----------

export async function runSchedule(env, now = new Date(), send = sendPush) {
  const vapid = await getVapid(env);
  let cursor;
  const result = { checked: 0, sent: 0, removed: 0, failed: 0 };
  do {
    const page = await env.HAUSHALT_KV.list({ prefix: SUB_PREFIX, cursor });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const { name } of page.keys) {
      const rec = await env.HAUSHALT_KV.get(name, "json");
      if (!rec) continue;
      result.checked++;
      const tasks = dueForNotification(rec, now);
      if (!tasks.length) continue;
      const { day } = localNow(rec.tz, now);
      const totalDue = rec.tasks.filter((t) => t.due <= day).length;
      try {
        const res = await send(rec.subscription, buildMessage(tasks, totalDue), { vapid, subject: subjectOf(env) });
        if (res.gone) {
          await env.HAUSHALT_KV.delete(name);
          result.removed++;
        } else if (res.ok) {
          rec.lastPush = pushResult(res);
          rec.notified = rec.notified || {};
          for (const t of tasks) rec.notified[t.id] = t.due;
          await env.HAUSHALT_KV.put(name, JSON.stringify(rec));
          result.sent++;
        } else {
          result.failed++;
          rec.lastPush = pushResult(res);
          await env.HAUSHALT_KV.put(name, JSON.stringify(rec));
          console.log("Push fehlgeschlagen", res.status, res.reason);
        }
      } catch (e) {
        result.failed++;
        console.log("Push-Fehler", e && e.message);
      }
    }
  } while (cursor);
  return result;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.log("Fehler", e && e.stack);
      return json({ error: e.message || "Fehler" }, status, corsHeaders(request, env));
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runSchedule(env).then((r) => console.log("Zeitplan", JSON.stringify(r))));
  },
};
