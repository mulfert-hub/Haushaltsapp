import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import ece from "http_ece";
import worker, { runSchedule, dueForNotification, localNow, validateRecord } from "../src/index.js";
import { encryptPayload, sendPush, generateVapidKeys, b64urlDecode, b64urlEncode } from "../src/webpush.js";

// ---- Test-Hilfen ----

function makeBrowserSubscription() {
  const ecdh = nodeCrypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return {
    ecdh, auth,
    subscription: {
      endpoint: "https://push.example.test/send/abc123",
      keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) },
    },
  };
}

function decrypt(body, browser) {
  return ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: browser.ecdh, authSecret: browser.auth }).toString("utf8");
}

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k, type) { const v = this.map.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

const ORIGIN = "https://mulfert-hub.github.io";
const env = () => ({ HAUSHALT_KV: new FakeKV(), ALLOWED_ORIGINS: ORIGIN, VAPID_SUBJECT: "https://example.test/" });

function req(method, path, body, origin = ORIGIN) {
  return new Request("https://haushalt-push.example.workers.dev" + path, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ---- Verschlüsselung & VAPID ----

test("Nachricht lässt sich mit http_ece (Referenz-Implementierung) entschlüsseln", async () => {
  const browser = makeBrowserSubscription();
  const body = await encryptPayload(browser.subscription, '{"title":"Hallo – äöü"}');
  assert.equal(decrypt(body, browser), '{"title":"Hallo – äöü"}');
});

test("sendPush setzt VAPID-Header mit gültiger ES256-Signatur", async () => {
  const browser = makeBrowserSubscription();
  const vapid = await generateVapidKeys();
  let captured;
  const res = await sendPush(browser.subscription, { title: "x" }, {
    vapid, subject: "https://example.test/",
    fetchImpl: async (url, init) => { captured = { url, init }; return new Response(null, { status: 201 }); },
  });
  assert.equal(res.ok, true);
  const h = captured.init.headers;
  assert.equal(h["Content-Encoding"], "aes128gcm");
  assert.equal(h.TTL, "86400");
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.Authorization);
  assert.ok(m, "Authorization-Format");
  assert.equal(m[2], vapid.publicKey);
  const [hd, pl, sig] = m[1].split(".");
  const claims = JSON.parse(Buffer.from(b64urlDecode(pl)).toString());
  assert.equal(claims.aud, "https://push.example.test");
  assert.equal(claims.sub, "https://example.test/");
  assert.ok(claims.exp > Date.now() / 1000);
  const pub = nodeCrypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: vapid.privateJwk.x, y: vapid.privateJwk.y }, format: "jwk" });
  const ok = nodeCrypto.verify("sha256", Buffer.from(`${hd}.${pl}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(b64urlDecode(sig)));
  assert.ok(ok, "Signatur gültig");
  assert.deepEqual(JSON.parse(decrypt(new Uint8Array(captured.init.body), browser)), { title: "x" });
});

test("410 vom Push-Dienst wird als abgelaufen erkannt", async () => {
  const browser = makeBrowserSubscription();
  const res = await sendPush(browser.subscription, { a: 1 }, {
    vapid: await generateVapidKeys(), subject: "x", fetchImpl: async () => new Response(null, { status: 410 }),
  });
  assert.equal(res.gone, true);
});

// ---- Zeitlogik ----

test("localNow rechnet in der Zeitzone des Geräts", () => {
  const t = new Date("2026-11-06T23:30:00Z"); // in Berlin bereits 7.11., 00:30
  assert.deepEqual(localNow("Europe/Berlin", t), { day: "2026-11-07", time: "00:30" });
});

test("Erinnerung erst ab Uhrzeit, nur fällige und nicht doppelt", () => {
  const rec = {
    enabled: true, tz: "Europe/Berlin", notifyTime: "09:00",
    tasks: [
      { id: "a", name: "Fenster", due: "2026-11-06" },
      { id: "b", name: "Ofen", due: "2026-11-01" },
      { id: "c", name: "Teppich", due: "2026-11-20" },
    ],
    notified: { b: "2026-11-01" },
  };
  assert.deepEqual(dueForNotification(rec, new Date("2026-11-06T07:59:00Z")), []); // 08:59 Berlin
  assert.deepEqual(dueForNotification(rec, new Date("2026-11-06T08:00:00Z")).map((t) => t.id), ["a"]);
  assert.deepEqual(dueForNotification({ ...rec, enabled: false }, new Date("2026-11-06T10:00:00Z")), []);
});

test("validateRecord verwirft Unsinn", () => {
  assert.throws(() => validateRecord({ subscription: { endpoint: "http://x" } }));
  const r = validateRecord({
    subscription: { endpoint: "https://x/y", keys: { p256dh: "p", auth: "a" } },
    tz: "Mars/Olympus", notifyTime: "25:00",
    tasks: [{ id: "1", name: "Ok", due: "2026-01-01" }, { id: "2", name: "Kaputt", due: "morgen" }],
  });
  assert.equal(r.tz, "Europe/Berlin");
  assert.equal(r.notifyTime, "09:00");
  assert.equal(r.tasks.length, 1);
});

// ---- API & Zeitplan ----

test("API: Schlüssel, Anmelden, Zeitplan sendet einmal, Abmelden", async () => {
  const e = env();
  const browser = makeBrowserSubscription();

  const r1 = await worker.fetch(req("GET", "/api/vapid-public-key"), e);
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const { publicKey } = await r1.json();
  assert.equal(b64urlDecode(publicKey).length, 65);
  // Schlüssel bleibt gleich
  assert.equal((await (await worker.fetch(req("GET", "/api/vapid-public-key"), e)).json()).publicKey, publicKey);

  const tasks = [
    { id: "a", name: "Fenster putzen", room: "Wohnung", due: "2026-11-06" },
    { id: "b", name: "Backofen reinigen", room: "Küche", due: "2026-11-02" },
    { id: "c", name: "Teppich", room: "Wohnung", due: "2026-12-24" },
  ];
  const put = await worker.fetch(req("PUT", "/api/subscription",
    { subscription: browser.subscription, tz: "Europe/Berlin", notifyTime: "09:00", enabled: true, tasks }), e);
  assert.equal(put.status, 200);

  const sent = [];
  const send = async (sub, payload) => { sent.push(payload); return { ok: true, status: 201 }; };

  let r = await runSchedule(e, new Date("2026-11-06T06:00:00Z"), send); // 07:00 Berlin
  assert.equal(r.sent, 0);
  r = await runSchedule(e, new Date("2026-11-06T08:15:00Z"), send);
  assert.equal(r.sent, 1);
  assert.equal(sent[0].title, "2 Haushaltsaufgaben sind dran");
  assert.equal(sent[0].count, 2);
  r = await runSchedule(e, new Date("2026-11-06T08:30:00Z"), send);
  assert.equal(r.sent, 0, "nicht doppelt");

  // Erneuter Abgleich mit gleichen Terminen: keine erneute Meldung
  await worker.fetch(req("PUT", "/api/subscription",
    { subscription: browser.subscription, tz: "Europe/Berlin", notifyTime: "09:00", enabled: true, tasks }), e);
  r = await runSchedule(e, new Date("2026-11-06T08:45:00Z"), send);
  assert.equal(r.sent, 0);

  // Fenster erledigt → neuer Termin; Ofen bleibt gemeldet
  const tasks2 = [{ ...tasks[0], due: "2027-02-06" }, tasks[1], tasks[2]];
  await worker.fetch(req("PUT", "/api/subscription",
    { subscription: browser.subscription, tz: "Europe/Berlin", notifyTime: "09:00", enabled: true, tasks: tasks2 }), e);
  r = await runSchedule(e, new Date("2026-11-07T08:15:00Z"), send);
  assert.equal(r.sent, 0);

  // Abgelaufenes Abo wird entfernt
  await worker.fetch(req("PUT", "/api/subscription",
    { subscription: browser.subscription, tz: "Europe/Berlin", notifyTime: "09:00", enabled: true,
      tasks: [{ id: "z", name: "Neu", due: "2026-11-07" }] }), e);
  r = await runSchedule(e, new Date("2026-11-07T08:15:00Z"), async () => ({ ok: false, status: 410, gone: true }));
  assert.equal(r.removed, 1);
  assert.equal([...e.HAUSHALT_KV.map.keys()].filter((k) => k.startsWith("sub:")).length, 0);
});

test("API: fremde Herkunft wird abgelehnt, CORS-Vorabfrage klappt", async () => {
  const e = env();
  const bad = await worker.fetch(req("GET", "/api/vapid-public-key", null, "https://evil.example"), e);
  assert.equal(bad.status, 403);
  const pre = await worker.fetch(new Request("https://w/api/subscription", { method: "OPTIONS", headers: { Origin: ORIGIN } }), e);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Methods"), /PUT/);
  const del = await worker.fetch(req("DELETE", "/api/subscription", { endpoint: "https://x/y" }), e);
  assert.equal(del.status, 200);
});
