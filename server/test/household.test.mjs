import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { runSchedule } from "../src/index.js";
import { mergeTasks, normalizeTask, householdKey, normalizeCode } from "../src/household.js";

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
const env = () => ({ HAUSHALT_KV: new FakeKV(), ALLOWED_ORIGINS: ORIGIN });
const call = async (e, method, path, body, headers = {}) => {
  const r = await worker.fetch(new Request("https://w" + path, {
    method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined,
  }), e);
  return { status: r.status, data: await r.json() };
};
const task = (over) => normalizeTask({
  id: "t1", name: "Fenster putzen", room: "Wohnung", every: 3, unit: "months",
  createdAt: "2026-01-01T10:00:00Z", metaAt: 1, schedAt: 1, ...over,
});

test("Code: Schreibweise egal, zu kurz ungültig", async () => {
  assert.equal(normalizeCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(await householdKey("ABCD"), null);
  assert.equal(await householdKey("abcd-efgh-jkmn-pqrs"), await householdKey("ABCDEFGHJKMNPQRS"));
});

test("Zusammenführen: Abhaken und Umbenennen auf zwei Geräten gehen beide nicht verloren", () => {
  const server = [task()];
  const a = task({ name: "Fenster innen+außen", metaAt: 10 });             // Gerät A: umbenannt
  const b = task({ lastDone: "2026-11-06T09:00:00Z", history: ["2026-11-06T09:00:00Z"], schedAt: 12 }); // Gerät B: erledigt
  let { tasks } = mergeTasks(server, [a]);
  ({ tasks } = mergeTasks(tasks, [b]));
  assert.equal(tasks[0].name, "Fenster innen+außen");
  assert.equal(tasks[0].lastDone, "2026-11-06T09:00:00.000Z");
});

test("Zusammenführen: neue Aufgaben kommen dazu, alte Löschungen verschwinden", () => {
  const now = Date.parse("2026-11-06T00:00:00Z");
  const old = task({ id: "x", deleted: true, metaAt: now - 100 * 864e5 });
  const { tasks, changed } = mergeTasks([task(), old], [task({ id: "neu", name: "Neu" })], now);
  assert.equal(changed, true);
  assert.deepEqual(tasks.map((t) => t.id).sort(), ["neu", "t1"]);
});

test("Haushalt anlegen, auf zweitem Gerät abgleichen, falscher Code abgelehnt", async () => {
  const e = env();
  const created = await call(e, "POST", "/api/household", { tasks: [task()] });
  assert.equal(created.status, 200);
  assert.match(created.data.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  const code = created.data.code;

  const sync = await call(e, "POST", "/api/household/sync", { code: code.toLowerCase(), tasks: [task({ id: "t2", name: "Ofen" })] });
  assert.equal(sync.status, 200);
  assert.deepEqual(sync.data.tasks.map((t) => t.name).sort(), ["Fenster putzen", "Ofen"]);

  const bad = await call(e, "POST", "/api/household/sync", { code: "AAAA-BBBB-CCCC-DDDD-EEEE", tasks: [] });
  assert.equal(bad.status, 404);
});

test("Kinderaufgaben und Erledigen über die Schnittstelle", async () => {
  const e = env();
  const { data } = await call(e, "POST", "/api/household", {
    tasks: [task({ id: "k", name: "Spülmaschine ausräumen", unit: "days", every: 1, kids: true, points: 5 }), task()],
  });
  const kids = await call(e, "GET", "/api/household/kids?tz=Europe/Berlin", null, { "X-Household-Code": data.code });
  assert.equal(kids.data.tasks.length, 1);
  assert.equal(kids.data.tasks[0].points, 5);
  assert.equal(kids.data.tasks[0].dueNow, true);

  const done = await call(e, "POST", "/api/household/complete", { code: data.code, taskId: "k", by: "Tochter" });
  assert.equal(done.status, 200);
  const kids2 = await call(e, "GET", "/api/household/kids", null, { "X-Household-Code": data.code });
  assert.equal(kids2.data.tasks[0].dueNow, false);
  assert.equal(kids2.data.tasks[0].lastDoneBy, "Tochter");
});

test("Erinnerung aus der gemeinsamen Liste: Abhaken auf anderem Gerät verhindert Meldung", async () => {
  const e = env();
  const { data } = await call(e, "POST", "/api/household", {
    tasks: [task({ id: "a", name: "Backofen", createdAt: "2026-11-01T10:00:00Z" })], // nie erledigt → fällig
  });
  const sub = { endpoint: "https://push.example.test/1", keys: { p256dh: "p", auth: "a" } };
  const put = await call(e, "PUT", "/api/subscription", {
    subscription: sub, tz: "Europe/Berlin", notifyTime: "09:00", household: data.code, openUrl: ORIGIN + "/Family-Dashboard-/haushalt/",
  });
  assert.equal(put.status, 200);

  // Partner hakt ab, bevor die Erinnerung rausgeht
  await call(e, "POST", "/api/household/sync", {
    code: data.code, tasks: [task({ id: "a", name: "Backofen", lastDone: "2026-11-06T07:00:00Z", schedAt: 99 })],
  });
  const sent = [];
  const send = async (_s, p) => { sent.push(p); return { ok: true, status: 201 }; };
  let r = await runSchedule(e, new Date("2026-11-06T08:30:00Z"), send);
  assert.equal(r.sent, 0);

  // Neue fällige Aufgabe → genau eine Meldung, mit Link zur App
  await call(e, "POST", "/api/household/sync", { code: data.code, tasks: [task({ id: "b", name: "Fenster", createdAt: "2026-11-05T10:00:00Z", metaAt: 5 })] });
  r = await runSchedule(e, new Date("2026-11-06T08:30:00Z"), send);
  assert.equal(r.sent, 1);
  assert.equal(sent[0].title, "Wieder dran: Fenster");
  assert.equal(sent[0].url, ORIGIN + "/Family-Dashboard-/haushalt/");
  r = await runSchedule(e, new Date("2026-11-06T08:45:00Z"), send);
  assert.equal(r.sent, 0, "nicht doppelt");

  const st = await call(e, "POST", "/api/status", { endpoint: sub.endpoint });
  assert.equal(st.data.shared, true);
  assert.equal(st.data.tasks, 2);
});

test("Anmelden mit unbekanntem Haushalt schlägt fehl", async () => {
  const e = env();
  const r = await call(e, "PUT", "/api/subscription", {
    subscription: { endpoint: "https://push.example.test/1", keys: { p256dh: "p", auth: "a" } }, household: "ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ",
  });
  assert.equal(r.status, 404);
});
