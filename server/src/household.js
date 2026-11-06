// Gemeinsame Haushaltsliste: mehrere Geräte teilen dieselben Aufgaben.
//
// Ein Haushalt wird über einen geheimen Einladungscode angesprochen. Gespeichert wird nur
// ein Hash des Codes. Wer den Code kennt, kann die Liste lesen und ändern.
//
// Zusammenführen (mehrere Geräte ändern gleichzeitig):
//   - "meta"  = Name, Bereich, Intervall, Notiz, Kinder-Infos, gelöscht  → neuester Stand gewinnt (metaAt)
//   - "sched" = zuletzt erledigt, Verlauf, geplanter Termin              → neuester Stand gewinnt (schedAt)
// So geht ein Abhaken auf dem einen Gerät nicht verloren, wenn auf dem anderen der Name geändert wird.

export const HH_PREFIX = "hh:";
export const MAX_TASKS = 400;
const TOMBSTONE_DAYS = 90;
const UNITS = new Set(["days", "weeks", "months", "years", "season", "once"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne 0/O, 1/I

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s.match(/.{4}/g).join("-");
}

export function normalizeCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function householdKey(code) {
  const norm = normalizeCode(code);
  if (norm.length < 16) return null;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("haushalt:" + norm)));
  return HH_PREFIX + [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const str = (s, max) => String(s ?? "").slice(0, max);
const isoOrNull = (s) => (typeof s === "string" && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);
const num = (n, min, max, dflt) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
};

/** Bereinigt eine Aufgabe aus einer Anfrage (nichts Unbekanntes, Längen begrenzt). */
export function normalizeTask(t) {
  if (!t || typeof t.id !== "string" || !t.id) return null;
  const unit = UNITS.has(t.unit) ? t.unit : "weeks";
  return {
    id: str(t.id, 64),
    name: str(t.name, 80),
    room: str(t.room, 40),
    every: num(t.every, 1, 999, 1),
    unit,
    months: Array.isArray(t.months) ? [...new Set(t.months.map(Number).filter((m) => m >= 1 && m <= 12))].sort((a, b) => a - b) : [],
    date: DAY_RE.test(t.date) ? t.date : null,
    note: str(t.note, 300),
    kids: !!t.kids,
    points: num(t.points, 0, 1000, 0),
    deleted: !!t.deleted,
    planned: DAY_RE.test(t.planned) ? t.planned : null,
    lastDone: isoOrNull(t.lastDone),
    lastDoneBy: str(t.lastDoneBy, 40),
    createdAt: isoOrNull(t.createdAt) || new Date().toISOString(),
    history: (Array.isArray(t.history) ? t.history : []).map(isoOrNull).filter(Boolean).slice(0, 30),
    metaAt: num(t.metaAt, 0, 9e15, 0),
    schedAt: num(t.schedAt, 0, 9e15, 0),
  };
}

const META = ["name", "room", "every", "unit", "months", "date", "note", "kids", "points", "deleted", "createdAt"];
const SCHED = ["planned", "lastDone", "lastDoneBy", "history"];

function pick(obj, keys) {
  const o = {};
  for (const k of keys) o[k] = obj[k];
  return o;
}

/** Führt zwei Aufgabenlisten zusammen. Rückgabe: { tasks, changed } */
export function mergeTasks(serverTasks, clientTasks, now = Date.now()) {
  const byId = new Map();
  for (const t of serverTasks || []) byId.set(t.id, t);
  let changed = false;
  for (const c of clientTasks || []) {
    const s = byId.get(c.id);
    if (!s) { byId.set(c.id, c); changed = true; continue; }
    const m = c.metaAt > s.metaAt ? c : s;
    const d = c.schedAt > s.schedAt ? c : s;
    if (m !== s || d !== s) changed = true;
    byId.set(c.id, {
      id: s.id, ...pick(m, META), metaAt: m.metaAt, ...pick(d, SCHED), schedAt: d.schedAt,
    });
  }
  // Gelöschte Einträge nach einiger Zeit endgültig entfernen
  const cutoff = now - TOMBSTONE_DAYS * 864e5;
  const tasks = [...byId.values()].filter((t) => !(t.deleted && t.metaAt < cutoff));
  if (tasks.length !== byId.size) changed = true;
  return { tasks: tasks.slice(0, MAX_TASKS), changed };
}
