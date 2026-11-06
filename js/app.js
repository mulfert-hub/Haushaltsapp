import { DEFAULT_TASKS } from "./defaults.js";
import { CONFIG } from "./config.js";

const S = window.Schedule;
const STORAGE_KEY = "haushaltsplan.v1";
const STATE_CACHE = "haushalt-state";
const STATE_URL = "./__state.json";
const NOTIFIED_URL = "./__notified.json";
const LAST_PUSH_CACHE = "familie-push";
const LAST_PUSH_URL = location.origin + "/__familie-last-push.json";

const UNIT_LABEL = {
  days: ["Tag", "Tage"], weeks: ["Woche", "Wochen"],
  months: ["Monat", "Monate"], years: ["Jahr", "Jahre"],
};
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const MONTHS_LONG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const KIDS_FILTER = "⭐ Kinder";

const $ = (sel) => document.querySelector(sel);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const todayKey = () => S.dayKey(Date.now());

// ---------- Zustand ----------

function newTask(data) {
  const now = Date.now();
  return {
    id: uid(), name: "", room: "", every: 1, unit: "weeks", months: [], date: null, note: "",
    kids: false, points: 0, deleted: false, planned: null, lastDone: null, history: [],
    createdAt: new Date(now).toISOString(), metaAt: now, schedAt: now, ...data,
  };
}

function defaultSettings() {
  return { notifyTime: "09:00", notifyEnabled: true, view: "list", planDays: [6], planMax: 2 };
}

function freshState() {
  return { version: 2, tasks: DEFAULT_TASKS.map((t) => newTask({ ...t })), settings: defaultSettings(), initialPlan: true };
}

/** Ältere Daten auf den aktuellen Stand bringen. */
function upgrade(s) {
  s.settings = { ...defaultSettings(), ...(s.settings || {}) };
  s.tasks = (s.tasks || []).filter((t) => t && t.name).map((t) => ({
    months: [], date: null, note: "", kids: false, points: 0, deleted: false, planned: null, history: [],
    metaAt: 0, schedAt: 0, ...t,
  }));
  s.version = 2;
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.tasks)) return upgrade(s);
    }
  } catch { /* ignorieren */ }
  return freshState();
}

let state = loadState();
let filter = "Alle";
let weekOffset = 0;
let undoAction = null;
let toastTimer = null;

const active = () => S.activeTasks(state.tasks);
const touchMeta = (t) => { t.metaAt = Date.now(); };
const touchSched = (t) => { t.schedAt = Date.now(); };

function save() {
  saveLocal();
  scheduleSync();
}

function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* voll/privat */ }
  mirrorToCache();
}

// Spiegel für den Service Worker (kein localStorage-Zugriff dort).
async function mirrorToCache() {
  if (!("caches" in window)) return;
  try {
    const c = await caches.open(STATE_CACHE);
    await c.put(STATE_URL, new Response(JSON.stringify(state), { headers: { "Content-Type": "application/json" } }));
  } catch { /* ignorieren */ }
}

async function readCacheJson(cacheName, url, fallback) {
  try {
    if ("caches" in window) {
      const c = await caches.open(cacheName);
      const r = await c.match(url);
      if (r) return await r.json();
    }
  } catch { /* ignorieren */ }
  return fallback;
}

const readNotified = () => readCacheJson(STATE_CACHE, NOTIFIED_URL, {});

async function writeNotified(map) {
  try {
    if ("caches" in window) {
      const c = await caches.open(STATE_CACHE);
      await c.put(NOTIFIED_URL, new Response(JSON.stringify(map), { headers: { "Content-Type": "application/json" } }));
    }
  } catch { /* ignorieren */ }
}

// ---------- Formatierung ----------

function monthList(months) {
  const names = months.map((m) => MONTHS_LONG[m - 1]);
  return names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " und " + names[names.length - 1];
}

function intervalText(t) {
  if (t.unit === "once") return t.date ? "einmalig am " + longDate(t.date) : "einmalig";
  if (t.unit === "season") {
    const m = S.seasonMonths(t);
    return m.length ? "jedes Jahr im " + monthList(m) : "jedes Jahr";
  }
  const [, many] = UNIT_LABEL[t.unit] || UNIT_LABEL.days;
  const single = { days: "jeden Tag", weeks: "jede Woche", months: "jeden Monat", years: "jedes Jahr" };
  return Number(t.every) === 1 ? single[t.unit] || single.days : `alle ${t.every} ${many}`;
}

function timerText(days) {
  if (days === Infinity) return "erledigt";
  if (days < -1) return `${-days} Tage überfällig`;
  if (days === -1) return "seit gestern fällig";
  if (days === 0) return "heute fällig";
  if (days === 1) return "morgen";
  if (days < 14) return `in ${days} Tagen`;
  if (days < 60) return `in ${Math.round(days / 7)} Wochen`;
  if (days < 700) return `in ${Math.round(days / 30.4)} Monaten`;
  return `in ${Math.round(days / 365)} Jahren`;
}

const dateFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short" });
const dayHeadFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long" });
const keyToDate = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const longDate = (k) => new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric" }).format(keyToDate(k));
const weekday = (k) => keyToDate(k).getDay();

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Rendern ----------

function rooms() {
  return [...new Set(active().map((t) => t.room).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
}

function renderFilters() {
  const list = ["Alle", ...rooms()];
  if (active().some((t) => t.kids)) list.push(KIDS_FILTER);
  if (!list.includes(filter)) filter = "Alle";
  $("#filters").innerHTML = list.map((r) =>
    `<button class="chip" data-room="${escapeHtml(r)}" aria-pressed="${r === filter}">${escapeHtml(r)}</button>`).join("");
  $("#rooms").innerHTML = rooms().map((r) => `<option value="${escapeHtml(r)}">`).join("");
}

function filtered() {
  return active().filter((t) => filter === "Alle" || (filter === KIDS_FILTER ? t.kids : t.room === filter));
}

function taskHtml(t, now, { compact = false } = {}) {
  const days = S.daysLeft(t, now);
  const cls = days < 0 ? "overdue" : days === 0 ? "due" : "";
  const pct = Math.round(S.progress(t, now) * 100);
  const due = S.dueKey(t, now);
  const last = t.lastDone ? `zuletzt ${shortFmt.format(new Date(t.lastDone))}` : "noch nie erledigt";
  const meta = [
    t.room && !compact ? escapeHtml(t.room) : "",
    escapeHtml(intervalText(t)),
    t.unit === "once" ? "" : last,
    t.planned ? "📅 eingeplant" : "",
    t.kids ? `⭐ ${t.points || 0} Punkte` : "",
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('<span class="dot"></span>');
  return `
    <li class="task ${cls}" data-id="${t.id}">
      <button class="check-btn" data-action="done" aria-label="${escapeHtml(t.name)} erledigt">
        <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
      </button>
      <div class="task-body" data-action="edit">
        <div class="task-name">${escapeHtml(t.name)}</div>
        <div class="task-meta">${meta}</div>
        ${compact ? "" : `<div class="timer" title="${due ? "Fällig am " + dateFmt.format(keyToDate(due)) : ""}">
          <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
          <span class="timer-label">${timerText(days)}</span>
        </div>`}
      </div>
      <button class="icon-btn more-btn" data-action="edit" aria-label="${escapeHtml(t.name)} bearbeiten">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/></svg>
      </button>
    </li>`;
}

function sortByDue(list, now) {
  return list.sort((a, b) => (S.dueKey(a, now) || "9999").localeCompare(S.dueKey(b, now) || "9999") || a.name.localeCompare(b.name, "de"));
}

function renderList(now) {
  const all = filtered();
  const open = sortByDue(all.filter((t) => S.dueKey(t, now)), now);
  const archived = all.filter((t) => !S.dueKey(t, now));
  const groups = [
    { title: "Jetzt dran", items: open.filter((t) => S.daysLeft(t, now) <= 0) },
    { title: "Nächste 7 Tage", items: open.filter((t) => { const d = S.daysLeft(t, now); return d > 0 && d <= 7; }) },
    { title: "Später", items: open.filter((t) => S.daysLeft(t, now) > 7) },
  ];
  let html = "";
  for (const g of groups) {
    if (g.title === "Jetzt dran" && g.items.length === 0) {
      html += `<div class="section-title"><span>Jetzt dran</span></div>
        <div class="empty"><strong>Alles erledigt 🎉</strong>Gerade ist nichts fällig. Du bekommst eine Mitteilung, sobald wieder etwas dran ist.</div>`;
      continue;
    }
    if (g.items.length === 0) continue;
    html += `<div class="section-title"><span>${g.title}</span><span>${g.items.length}</span></div>
      <ul class="card-list">${g.items.map((t) => taskHtml(t, now)).join("")}</ul>`;
  }
  if (archived.length) {
    html += `<details class="archive"><summary>Erledigte einmalige Termine (${archived.length})</summary>
      <ul class="card-list">${archived.map((t) => taskHtml(t, now)).join("")}</ul></details>`;
  }
  if (all.length === 0) {
    html = `<div class="empty" style="margin-top:20px"><strong>Keine Aufgaben</strong>Tippe auf +, um eine Aufgabe anzulegen.</div>`;
  }
  return html;
}

function renderWeek(now) {
  const today = S.dayKey(now);
  const start = S.addDays(today, weekOffset * 7);
  const end = S.addDays(start, 6);
  const all = filtered();
  const label = weekOffset === 0 ? "Diese Woche" : weekOffset === 1 ? "Nächste Woche"
    : `${shortFmt.format(keyToDate(start))} – ${shortFmt.format(keyToDate(end))}`;
  let html = `<div class="week-nav">
      <button class="icon-btn" data-week="-1" aria-label="Vorige Woche" ${weekOffset <= 0 ? "disabled" : ""}>‹</button>
      <strong>${label}</strong>
      <button class="icon-btn" data-week="1" aria-label="Nächste Woche">›</button>
    </div>
    <div class="week-tools"><button class="btn" id="btn-distribute">Große Aufgaben verteilen</button></div>`;
  for (let i = 0; i < 7; i++) {
    const day = S.addDays(start, i);
    const items = sortByDue(all.filter((t) => {
      const due = S.dueKey(t, now);
      return due && (due === day || (day === today && due < today));
    }), now);
    const head = day === today ? "Heute" : day === S.addDays(today, 1) ? "Morgen" : dayHeadFmt.format(keyToDate(day));
    const planDay = (state.settings.planDays || []).includes(weekday(day));
    html += `<div class="section-title day-title ${planDay ? "plan-day" : ""}"><span>${head}${day === today || day === S.addDays(today, 1) ? " · " + shortFmt.format(keyToDate(day)) : ""}</span><span>${items.length || ""}</span></div>`;
    html += items.length
      ? `<ul class="card-list">${items.map((t) => taskHtml(t, now, { compact: true })).join("")}</ul>`
      : `<div class="day-empty">frei</div>`;
  }
  return html;
}

function render() {
  const now = Date.now();
  renderFilters();
  const view = state.settings.view === "week" ? "week" : "list";
  $("#view-list").setAttribute("aria-selected", String(view === "list"));
  $("#view-week").setAttribute("aria-selected", String(view === "week"));
  $("#list").innerHTML = view === "week" ? renderWeek(now) : renderList(now);

  const open = active().filter((t) => S.dueKey(t, now));
  const dueCount = open.filter((t) => S.daysLeft(t, now) <= 0).length;
  const next = sortByDue(open.filter((t) => S.daysLeft(t, now) > 0), now)[0];
  $("#summary").textContent = dueCount
    ? `${dueCount} ${dueCount === 1 ? "Aufgabe ist" : "Aufgaben sind"} dran`
    : next ? `Nächste: ${next.name} (${timerText(S.daysLeft(next, now))})` : "";
  updateBadge(dueCount);
}

function updateBadge(n) {
  try {
    if (n > 0 && navigator.setAppBadge) navigator.setAppBadge(n);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch { /* nicht unterstützt */ }
}

// ---------- Aktionen ----------

function snapshot(ids) {
  return ids.map((id) => ({ ...state.tasks.find((t) => t.id === id) }));
}
function restore(snap) {
  for (const old of snap) {
    const i = state.tasks.findIndex((t) => t.id === old.id);
    if (i >= 0) state.tasks[i] = { ...old, schedAt: Date.now(), metaAt: Date.now() };
  }
  save();
  render();
}

function completeTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const snap = snapshot([id]);
  const now = new Date().toISOString();
  t.lastDone = now;
  t.history = [now, ...(t.history || [])].slice(0, 30);
  t.planned = null;
  touchSched(t);
  save();

  const li = document.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
  if (li) {
    li.querySelector(".check-btn").classList.add("checked");
    li.classList.add("done-anim");
  }
  setTimeout(render, 450);
  const again = S.daysLeft(t);
  showToast(`„${t.name}“ erledigt${again === Infinity ? "" : " · wieder " + timerText(again)}`, () => restore(snap));
}

function showToast(text, onUndo = null) {
  undoAction = onUndo;
  $("#toast-text").textContent = text;
  $("#toast-undo").hidden = !onUndo;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, onUndo ? 6000 : 4000);
}
function hideToast() { $("#toast").hidden = true; undoAction = null; }

/** Rückmeldung: im offenen Einstellungen-Dialog direkt dort, sonst als Hinweis unten. */
let feedbackTimer = null;
function feedback(text, kind = "ok") {
  const dlg = $("#dlg-settings");
  if (dlg.open) {
    const el = $("#settings-feedback");
    el.textContent = text;
    el.className = "feedback" + (kind === "error" ? " error" : kind === "busy" ? " busy" : "");
    el.hidden = false;
    clearTimeout(feedbackTimer);
    if (kind !== "busy") feedbackTimer = setTimeout(() => { el.hidden = true; }, 12000);
  } else {
    showToast(text);
  }
}

/** Button während einer Aktion sperren und beschriften. */
async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.classList.add("busy");
  btn.textContent = label;
  try { return await fn(); } finally { btn.classList.remove("busy"); btn.textContent = old; }
}

// ---------- Plan verteilen ----------

/** Verteilt große Aufgaben der nächsten 4 Wochen auf die bevorzugten Tage. */
function distribute({ quiet = false } = {}) {
  const now = Date.now();
  const today = todayKey();
  const planDays = (state.settings.planDays || []).length ? state.settings.planDays : [6];
  const cap = Math.max(1, Number(state.settings.planMax) || 2);
  const horizon = S.addDays(today, 28);
  const cands = active().filter((t) => S.isBig(t)).map((t) => {
    const natural = S.dueKey({ ...t, planned: null }, now);
    return { t, natural };
  }).filter((c) => c.natural && c.natural <= horizon)
    .sort((a, b) => a.natural.localeCompare(b.natural));
  if (!cands.length) { if (!quiet) showToast("Keine großen Aufgaben in den nächsten 4 Wochen"); return; }

  const slots = [];
  for (let i = 0; i < 120; i++) {
    const k = S.addDays(today, i);
    if (planDays.includes(weekday(k))) slots.push({ k, n: 0 });
  }
  const snap = snapshot(cands.map((c) => c.t.id));
  let moved = 0;
  for (const { t, natural } of cands) {
    const target = natural < today ? today : natural;
    let best = null;
    for (const s of slots) {
      if (s.n >= cap) continue;
      const dist = Math.abs(S.diffDays(s.k, target)) + (s.k < target ? 0.5 : 0); // lieber etwas später als früher
      if (!best || dist < best.dist) best = { s, dist };
    }
    if (!best) break;
    best.s.n++;
    const planned = best.s.k === natural ? null : best.s.k;
    if (planned !== t.planned) { t.planned = planned; touchSched(t); moved++; }
  }
  save();
  render();
  if (!quiet) showToast(moved ? `✓ ${cands.length} große Aufgaben verteilt` : "Plan war schon gut verteilt", moved ? () => restore(snap) : null);
}

// ---------- Dialog: Aufgabe ----------

let editingId = null;

function kindOf(t) {
  return t.unit === "season" ? "season" : t.unit === "once" ? "once" : "repeat";
}

function updateTaskDialogKind() {
  const f = $("#form-task");
  const kind = f.kind.value;
  document.querySelectorAll("#form-task [data-kind]").forEach((el) => {
    el.hidden = !el.dataset.kind.split(" ").includes(kind);
  });
  $("#form-task [data-kids]").hidden = !f.kids.checked;
}

function renderMonthChips(selected) {
  $("#month-chips").innerHTML = MONTHS.map((m, i) =>
    `<button type="button" class="chip small" data-month="${i + 1}" aria-pressed="${selected.includes(i + 1)}">${m}</button>`).join("");
}

function openTaskDialog(id) {
  editingId = id;
  const t = id ? state.tasks.find((x) => x.id === id) : null;
  const f = $("#form-task");
  $("#dlg-task-title").textContent = t ? "Aufgabe bearbeiten" : "Neue Aufgabe";
  f.name.value = t?.name ?? "";
  f.room.value = t?.room ?? (filter !== "Alle" && filter !== KIDS_FILTER ? filter : "");
  f.kind.value = t ? kindOf(t) : "repeat";
  f.every.value = t && t.unit !== "season" && t.unit !== "once" ? t.every : 1;
  f.unit.value = t && UNIT_LABEL[t.unit] ? t.unit : "weeks";
  renderMonthChips(t?.unit === "season" ? S.seasonMonths(t) : [new Date().getMonth() + 1]);
  f.date.value = t?.date || "";
  f.lastDone.value = t?.lastDone ? S.dayKey(t.lastDone) : "";
  f.lastDone.max = todayKey();
  f.planned.value = t?.planned || "";
  const auto = t ? S.dueKey({ ...t, planned: null }) : null;
  $("#planned-hint").textContent = auto ? `Leer lassen = automatisch (${longDate(auto)}).` : "Leer lassen = automatisch.";
  f.kids.checked = !!t?.kids;
  f.points.value = t?.points ?? 5;
  f.note.value = t?.note ?? "";
  $("#btn-delete").hidden = !t;
  const hist = (t?.history || []).slice(0, 6);
  $("#history").innerHTML = hist.length
    ? `<div class="field"><span>Verlauf</span><ul>${hist.map((h) => `<li>${dateFmt.format(new Date(h))}</li>`).join("")}</ul></div>`
    : "";
  updateTaskDialogKind();
  $("#dlg-task").showModal();
  if (!t) f.name.focus();
  else $("#dlg-task-title").focus();
}

function dateInputToIso(v) {
  if (!v) return null;
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y, m - 1, d, 12).toISOString();
}

function saveTaskDialog() {
  const f = $("#form-task");
  const kind = f.kind.value;
  const months = [...document.querySelectorAll("#month-chips [aria-pressed=true]")].map((b) => Number(b.dataset.month));
  const data = {
    name: f.name.value.trim(),
    room: f.room.value.trim(),
    every: kind === "repeat" ? Math.max(1, Math.min(999, parseInt(f.every.value, 10) || 1)) : 1,
    unit: kind === "repeat" ? f.unit.value : kind,
    months: kind === "season" ? months : [],
    date: kind === "once" ? (f.date.value || todayKey()) : null,
    note: f.note.value.trim(),
    kids: f.kids.checked,
    points: f.kids.checked ? Math.max(0, Math.min(1000, parseInt(f.points.value, 10) || 0)) : 0,
  };
  if (!data.name) return;
  if (kind === "season" && !months.length) data.months = [new Date().getMonth() + 1];
  const lastDone = kind === "once" ? undefined : dateInputToIso(f.lastDone.value);
  const planned = kind === "once" ? null : (f.planned.value || null);

  if (editingId) {
    const t = state.tasks.find((x) => x.id === editingId);
    const metaChanged = Object.keys(data).some((k) => JSON.stringify(t[k]) !== JSON.stringify(data[k]));
    if (metaChanged) { Object.assign(t, data); touchMeta(t); }
    const prevDay = t.lastDone ? S.dayKey(t.lastDone) : "";
    let schedChanged = false;
    if (lastDone !== undefined && (f.lastDone.value || "") !== prevDay) {
      t.lastDone = lastDone;
      if (lastDone) t.history = [lastDone, ...(t.history || [])].slice(0, 30);
      schedChanged = true;
    }
    if ((planned || null) !== (t.planned || null)) { t.planned = planned; schedChanged = true; }
    if (schedChanged) touchSched(t);
  } else {
    state.tasks.push(newTask({ ...data, lastDone: lastDone || null, planned, history: lastDone ? [lastDone] : [] }));
  }
  save();
  render();
}

// ---------- Gemeinsame Liste (Server) ----------

let syncTimer = null;
let syncError = "";
let syncing = null;

function serverUrl() {
  return String(state.settings.pushServer || CONFIG.pushServerUrl || "").trim().replace(/\/+$/, "");
}

async function api(path, options = {}) {
  const res = await fetch(serverUrl() + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Server antwortet mit ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Wie auf dem Server: neuester Stand je Teil (Angaben / Termine) gewinnt. */
const META = ["name", "room", "every", "unit", "months", "date", "note", "kids", "points", "deleted", "createdAt"];
const SCHED = ["planned", "lastDone", "lastDoneBy", "history"];
function mergeTasks(a, b) {
  const byId = new Map(a.map((t) => [t.id, t]));
  for (const c of b) {
    const s = byId.get(c.id);
    if (!s) { byId.set(c.id, c); continue; }
    const m = (c.metaAt || 0) > (s.metaAt || 0) ? c : s;
    const d = (c.schedAt || 0) > (s.schedAt || 0) ? c : s;
    const t = { ...s };
    for (const k of META) t[k] = m[k];
    for (const k of SCHED) t[k] = d[k];
    t.metaAt = m.metaAt || 0;
    t.schedAt = d.schedAt || 0;
    byId.set(c.id, t);
  }
  return [...byId.values()];
}

/** Gelöschte Einträge nach 90 Tagen endgültig entfernen (wie auf dem Server). */
function purge(tasks) {
  const cutoff = Date.now() - 90 * 864e5;
  return tasks.filter((t) => !(t.deleted && (t.metaAt || 0) < cutoff));
}

function scheduleSync() {
  if (!serverUrl() || !state.household) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), 1000);
}

/** Mit der gemeinsamen Liste abgleichen. Legt beim ersten Mal einen Haushalt an. */
async function syncNow() {
  if (!serverUrl()) return false;
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      if (!state.household) {
        const r = await api("/api/household", { method: "POST", body: JSON.stringify({ tasks: state.tasks }) });
        state.household = { code: r.code };
        state.tasks = purge(mergeTasks(r.tasks, state.tasks));
        saveLocal();
        await registerDevice().catch(() => {}); // Erinnerungen ab jetzt aus der gemeinsamen Liste
      } else {
        const r = await api("/api/household/sync", { method: "POST", body: JSON.stringify({ code: state.household.code, tasks: state.tasks }) });
        state.tasks = purge(mergeTasks(r.tasks, state.tasks));
        saveLocal();
      }
      state.household.lastSync = new Date().toISOString();
      syncError = "";
      render();
      return true;
    } catch (e) {
      syncError = e.message || String(e);
      return false;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

async function joinHousehold(code) {
  code = String(code || "").trim().toUpperCase();
  if (code.replace(/[^A-Z0-9]/g, "").length < 16) { feedback("Der Code ist zu kurz.", "error"); return; }
  feedback("Verbinde …", "busy");
  try {
    const r = await api("/api/household/sync", { method: "POST", body: JSON.stringify({ code, tasks: [] }) });
    if (!confirm(`Gemeinsame Liste mit ${S.activeTasks(r.tasks).length} Aufgaben gefunden.\n\nDie Aufgaben auf diesem Gerät werden durch die gemeinsame Liste ersetzt. Fortfahren?`)) {
      feedback("Abgebrochen.");
      return;
    }
    state.household = { code, lastSync: new Date().toISOString() };
    state.tasks = r.tasks;
    saveLocal();
    await writeNotified({});
    await registerDevice().catch(() => {});
    render();
    renderShareBox();
    feedback(`✓ Verbunden – ${S.activeTasks(r.tasks).length} Aufgaben übernommen.`);
  } catch (e) {
    feedback("✗ " + (e.status === 404 ? "Kein Haushalt mit diesem Code gefunden." : e.message), "error");
  }
}

function inviteText() {
  return `Unser Haushaltsplan 🏠\n\nÖffne die Familien-App → Haushalt → Einstellungen → „Gemeinsame Liste“ → „Beitreten“ und gib diesen Code ein:\n\n${state.household.code}`;
}

async function invite() {
  if (!state.household) { await syncNow(); }
  if (!state.household) { feedback("✗ Server nicht erreichbar: " + syncError, "error"); return; }
  const text = inviteText();
  try {
    if (navigator.share) { await navigator.share({ title: "Haushaltsplan", text }); feedback("✓ Einladung geteilt"); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(state.household.code); feedback("✓ Code kopiert: " + state.household.code); }
  catch { feedback("Code: " + state.household.code); }
}

function renderShareBox() {
  const box = $("#share-box");
  if (!serverUrl()) {
    box.innerHTML = `<p class="muted small">Ohne Server bleibt die Liste nur auf diesem Gerät.</p>`;
    return;
  }
  const hh = state.household;
  const status = !hh ? "Noch nicht verbunden."
    : syncError ? `✗ Abgleich fehlgeschlagen: ${escapeHtml(syncError)}`
    : `✓ Gemeinsame Liste aktiv${hh.lastSync ? " · abgeglichen " + timeFmt.format(new Date(hh.lastSync)) : ""}`;
  box.innerHTML = `
    <p class="small ${syncError ? "error-text" : ""}">${status}</p>
    <p class="muted small">Alle, die beitreten, sehen dieselben Aufgaben. Was einer abhakt, ist bei allen erledigt.</p>
    <div class="row wrap">
      <button type="button" class="btn" id="btn-invite">Familie einladen</button>
      <button type="button" class="btn" id="btn-join">Beitreten</button>
      <button type="button" class="btn" id="btn-sync">Jetzt abgleichen</button>
    </div>
    <div class="join-row" id="join-row" hidden>
      <input id="join-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX">
      <button type="button" class="btn btn-primary" id="btn-join-go">Verbinden</button>
    </div>
    ${hh ? `<p class="muted small code-line">Code: <code>${escapeHtml(hh.code)}</code></p>` : ""}`;
  $("#btn-invite").onclick = (e) => busy(e.currentTarget, "…", invite);
  $("#btn-join").onclick = () => { $("#join-row").hidden = false; $("#join-code").focus(); };
  $("#btn-join-go").onclick = (e) => busy(e.currentTarget, "…", () => joinHousehold($("#join-code").value));
  $("#btn-sync").onclick = (e) => busy(e.currentTarget, "Gleiche ab …", async () => {
    const ok = await syncNow();
    renderShareBox();
    feedback(ok ? "✓ Abgeglichen" : "✗ Abgleich fehlgeschlagen: " + syncError, ok ? "ok" : "error");
  });
}

// ---------- Mitteilungen ----------

let swReg = null;   // eigener Service Worker (offline)
let pushReg = null; // Service Worker, über den Push läuft (am liebsten der der Familien-App)
let pushError = "";

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function notifySupportText() {
  if (!("Notification" in window)) {
    if (isIOS() && !isStandalone()) return "Auf dem iPhone/iPad: Tippe in Safari auf „Teilen“ → „Zum Home-Bildschirm“ und öffne die App von dort. Dann kannst du Mitteilungen erlauben.";
    return "Dieser Browser unterstützt keine Mitteilungen. Nutze die Kalender-Erinnerungen in den Einstellungen.";
  }
  if (Notification.permission === "denied") return "Mitteilungen sind blockiert. Erlaube sie in den Browser- bzw. Systemeinstellungen.";
  if (Notification.permission === "default") return "Mitteilungen sind noch nicht erlaubt.";
  return "Mitteilungen sind erlaubt.";
}

function updateNotifyBanner() {
  const banner = $("#notify-banner");
  const supported = "Notification" in window;
  banner.hidden = !(state.settings.notifyEnabled && (!supported || Notification.permission === "default"));
  $("#notify-banner-text").textContent = supported
    ? "Erlaube Mitteilungen, damit du erinnert wirst, wenn eine Aufgabe wieder dran ist."
    : notifySupportText();
  $("#btn-enable-notify").hidden = !supported;
}

async function requestNotify() {
  if (!("Notification" in window)) return;
  const p = await Notification.requestPermission();
  updateNotifyBanner();
  if (p === "granted") {
    await enablePush();
    await registerPeriodicSync();
    checkDue();
  }
}

async function showNotification(title, options) {
  const opts = { icon: "icons/icon-192.png", badge: "icons/icon-192.png", lang: "de", ...options };
  const reg = pushReg || swReg;
  if (reg && reg.showNotification) return reg.showNotification(title, opts);
  return new Notification(title, opts);
}

function pushActive() {
  return !!(state.push && state.push.endpoint && state.push.server === serverUrl() && serverUrl());
}

async function checkDue() {
  render();
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (pushActive()) return; // Der Server übernimmt die Erinnerungen.
  const notified = await readNotified();
  const list = S.tasksToNotify(state, notified, Date.now());
  if (!list.length) return;
  if (document.visibilityState !== "visible") {
    const { title, body } = S.notificationText(list);
    await showNotification(title, { body, tag: "haushalt-faellig" });
  }
  for (const t of list) notified[t.id] = S.dueKey(t);
  await writeNotified(notified);
}

async function registerPeriodicSync() {
  try {
    if (!swReg || !("periodicSync" in swReg)) return;
    const status = await navigator.permissions.query({ name: "periodic-background-sync" });
    if (status.state === "granted") await swReg.periodicSync.register("check-due", { minInterval: 60 * 60 * 1000 });
  } catch { /* nicht unterstützt */ }
}

/** Antwortet ein Service Worker auf „Kannst du Mitteilungen für die Familie zeigen?“ */
function pingFamiliePush(reg) {
  return new Promise((resolve) => {
    const worker = reg && reg.active;
    if (!worker) return resolve(false);
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 1500);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(!!(e.data && e.data.type === "familie-push-pong")); };
    try { worker.postMessage({ type: "familie-push-ping" }, [ch.port2]); } catch { clearTimeout(timer); resolve(false); }
  });
}

/**
 * Auf dem iPhone weckt iOS bei einer Push-Nachricht den Service Worker der installierten App.
 * Liegt Haushalt in der Familien-App, ist das deren Service Worker – darüber läuft Push dann.
 */
async function findPushRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const regs = (await navigator.serviceWorker.getRegistrations())
      .filter((r) => location.href.startsWith(r.scope))
      .sort((a, b) => a.scope.length - b.scope.length);
    for (const r of regs) {
      if (r === swReg || r.scope === (swReg && swReg.scope)) continue;
      if (await pingFamiliePush(r)) return r;
    }
  } catch { /* weiter mit eigenem */ }
  return swReg;
}

function b64urlToBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function bytesToB64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Gerät beim Server für Erinnerungen anmelden (oder Anmeldung auffrischen). */
async function enablePush() {
  pushError = "";
  const server = serverUrl();
  if (!server) { if (state.push) { state.push = null; saveLocal(); } return false; }
  if (!("PushManager" in window) || !("Notification" in window) || Notification.permission !== "granted") return false;
  try {
    pushReg = await findPushRegistration();
    if (!pushReg) throw new Error("Kein Service Worker");
    const { publicKey } = await api("/api/vapid-public-key");
    let sub = await pushReg.pushManager.getSubscription();
    const currentKey = sub && sub.options && sub.options.applicationServerKey ? bytesToB64url(sub.options.applicationServerKey) : null;
    if (sub && currentKey && currentKey !== publicKey) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await pushReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });

    // Altes Abo am eigenen Service Worker aufräumen, wenn Push jetzt über die Familien-App läuft
    if (swReg && pushReg !== swReg) {
      const old = await swReg.pushManager.getSubscription().catch(() => null);
      if (old && old.endpoint !== sub.endpoint) {
        api("/api/subscription", { method: "DELETE", body: JSON.stringify({ endpoint: old.endpoint }) }).catch(() => {});
        old.unsubscribe().catch(() => {});
      }
    }
    state.push = { endpoint: sub.endpoint, server, via: pushReg === swReg ? "haushalt" : "familie" };
    saveLocal();
    if (!state.household) await syncNow(); // legt den Haushalt an und meldet das Gerät an
    else await registerDevice(sub);
    return true;
  } catch (e) {
    pushError = e.message || String(e);
    console.warn("Push-Anmeldung fehlgeschlagen", e);
    return false;
  }
}

async function registerDevice(sub) {
  if (!serverUrl()) return;
  const reg = pushReg || swReg;
  sub = sub || (reg && (await reg.pushManager.getSubscription().catch(() => null)));
  if (!sub) return;
  await api("/api/subscription", {
    method: "PUT",
    body: JSON.stringify({
      subscription: sub.toJSON(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin",
      notifyTime: state.settings.notifyTime,
      enabled: !!state.settings.notifyEnabled,
      household: state.household ? state.household.code : null,
      openUrl: location.href.split("#")[0],
    }),
  });
  pushError = "";
}

async function disablePush() {
  try {
    const reg = pushReg || swReg;
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub && state.push && state.push.server) {
      await fetch(state.push.server + "/api/subscription", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
    }
    if (sub) await sub.unsubscribe();
  } catch { /* ignorieren */ }
  state.push = null;
  saveLocal();
}

function pushStatusText() {
  if (!serverUrl()) return "Kein Server eingetragen: Erinnerungen kommen nur, solange die App läuft.";
  if (pushActive() && !pushError) return "✓ Push über den Server ist aktiv.";
  if (pushError) return "Server nicht erreichbar: " + pushError;
  return "Server eingetragen. Erlaube Mitteilungen, um das Gerät anzumelden.";
}

// ---------- Push-Status (Diagnose) ----------

const timeFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function describeResult(r) {
  if (!r) return null;
  const when = r.at ? timeFmt.format(new Date(r.at)) : "";
  if (r.ok) return { cls: "ok", text: `vom Push-Dienst angenommen (${r.status}), ${when}` };
  return { cls: "bad", text: `abgelehnt (${r.status || "Fehler"}${r.reason ? ": " + r.reason : ""}), ${when}` };
}

async function renderDiag() {
  const items = [];
  const add = (cls, label, text) => items.push(`<li class="${cls}"><div><b>${escapeHtml(label)}:</b> <span>${escapeHtml(text)}</span></div></li>`);

  if (!("Notification" in window)) {
    add("bad", "Mitteilungen", isIOS() && !isStandalone() ? "nur in der App vom Home-Bildschirm möglich" : "von diesem Browser nicht unterstützt");
  } else if (Notification.permission === "granted") add("ok", "Mitteilungen", "erlaubt");
  else if (Notification.permission === "denied") add("bad", "Mitteilungen", "blockiert – in den iPhone-Einstellungen unter Mitteilungen erlauben");
  else add("bad", "Mitteilungen", "noch nicht erlaubt – „Test-Mitteilung“ tippen");

  add(isStandalone() ? "ok" : "info", "Geöffnet als", isStandalone() ? "App vom Home-Bildschirm" : "Browser-Seite");

  const reg = pushReg || swReg;
  let sub = null;
  try { sub = reg && "pushManager" in reg ? await reg.pushManager.getSubscription() : null; } catch { sub = null; }
  if (!("PushManager" in window)) add("bad", "Push", "nicht verfügbar");
  else if (sub) add("ok", "Push-Abo", `${new URL(sub.endpoint).host} · über ${reg === swReg ? "Haushalt" : "Familien-App"}`);
  else add("bad", "Push-Abo", pushError ? "fehlgeschlagen: " + pushError : "keins");

  if (!serverUrl()) add("bad", "Server", "nicht eingetragen");
  else if (!sub) add("info", "Server", new URL(serverUrl()).host);
  else {
    try {
      const st = await api("/api/status", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
      if (!st.registered) add("bad", "Server", "Gerät nicht angemeldet");
      else {
        add("ok", "Server", `angemeldet${st.shared ? " (gemeinsame Liste)" : ""}, ${st.tasks} Aufgaben, Erinnerung um ${st.notifyTime}${st.enabled ? "" : " (aus)"}`);
        const t = describeResult(st.lastTest);
        if (t) add(t.cls, "Letzter Test", t.text);
        const p = describeResult(st.lastPush);
        add(p ? p.cls : "info", "Letzte Erinnerung", p ? p.text : "noch keine gesendet");
      }
    } catch (e) {
      add("bad", "Server", "nicht erreichbar: " + e.message);
    }
  }
  const received = await readCacheJson(LAST_PUSH_CACHE, LAST_PUSH_URL, null);
  add(received ? "ok" : "info", "Auf diesem Gerät empfangen",
    received ? `${timeFmt.format(new Date(received.at))} („${received.title || ""}“, ${received.by === "familie" ? "Familien-App" : "Haushalt"})` : "noch nichts");
  $("#push-diag").innerHTML = items.join("");
}

async function testNotification(delay) {
  if (!("Notification" in window)) { feedback(notifySupportText(), "error"); return; }
  if (Notification.permission === "default") await requestNotify();
  if (Notification.permission !== "granted") {
    feedback("Mitteilungen sind nicht erlaubt. iPhone: Einstellungen → Mitteilungen → Familie Ulfert.", "error");
    renderDiag();
    return;
  }
  feedback("Wird gesendet …", "busy");
  if (serverUrl()) await enablePush();
  if (!pushActive()) {
    await showNotification("Test: Haushaltsplan", { body: "Lokale Mitteilung (ohne Server).", tag: "haushalt-test" });
    feedback("Lokale Test-Mitteilung ausgelöst (ohne Server)" + (pushError ? ". Server-Anmeldung fehlgeschlagen: " + pushError : "."), pushError ? "error" : "ok");
    renderDiag();
    return;
  }
  try {
    const sub = await (pushReg || swReg).pushManager.getSubscription();
    const r = await api("/api/test", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint, delay }) });
    if (r.scheduled) {
      feedback(`Test kommt in ${r.scheduled} Sekunden – jetzt App schließen oder iPhone sperren.`);
      setTimeout(renderDiag, (r.scheduled + 4) * 1000);
    } else if (r.ok) {
      feedback(`✓ Vom Push-Dienst angenommen (${r.status}). Die Mitteilung sollte gleich erscheinen. Falls nicht, „Test in 20 Sek.“ tippen und die App schließen.`);
      setTimeout(renderDiag, 4000);
    } else {
      feedback(`✗ Push-Dienst lehnt ab (${r.status}${r.reason ? ": " + r.reason : ""}).`, "error");
    }
  } catch (e) {
    pushError = e.message;
    feedback("✗ Server-Fehler: " + e.message, "error");
  }
  renderDiag();
}

// ---------- Kalender (.ics) ----------

function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
const p2 = (n) => String(n).padStart(2, "0");
function icsDate(d) {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}00`;
}
const RRULE_FREQ = { days: "DAILY", weeks: "WEEKLY", months: "MONTHLY", years: "YEARLY" };

function exportIcs() {
  const [h, m] = state.settings.notifyTime.split(":").map(Number);
  const today = todayKey();
  const stamp = icsDate(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Haushaltsplan//DE", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Haushaltsplan"];
  for (const t of active()) {
    const due = S.dueKey(t);
    if (!due) continue;
    const start = keyToDate(due < today ? today : due);
    start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    const rrule = t.unit === "once" ? null
      : t.unit === "season" ? `RRULE:FREQ=YEARLY;BYMONTH=${S.seasonMonths(t).join(",") || start.getMonth() + 1};BYMONTHDAY=1`
      : `RRULE:FREQ=${RRULE_FREQ[t.unit] || "DAILY"};INTERVAL=${t.every}`;
    lines.push(
      "BEGIN:VEVENT", `UID:${t.id}@haushaltsplan`, `DTSTAMP:${stamp}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
      ...(rrule ? [rrule] : []),
      `SUMMARY:${icsEscape("🧹 " + t.name)}`,
      `DESCRIPTION:${icsEscape((t.room ? t.room + " – " : "") + intervalText(t) + (t.note ? "\n" + t.note : ""))}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(t.name)}`, "TRIGGER:PT0M", "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  shareOrDownload("haushaltsplan.ics", lines.join("\r\n"), "text/calendar");
}

/** Auf dem Handy über das Teilen-Menü (speichern, AirDrop, Kalender …), sonst als Download. */
function shareOrDownload(name, content, type) {
  try {
    const file = new File([content], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name })
        .then(() => feedback("✓ Geteilt: " + name))
        .catch((e) => { if (e && e.name !== "AbortError") feedback("Teilen fehlgeschlagen: " + e.message, "error"); });
      return;
    }
  } catch { /* weiter mit Download */ }
  download(name, content, type);
  feedback("✓ Datei „" + name + "“ wird heruntergeladen");
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- Einstellungen ----------

function renderPlanDays(selected) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  $("#plan-days").innerHTML = order.map((d) =>
    `<button type="button" class="chip small" data-weekday="${d}" aria-pressed="${selected.includes(d)}">${WEEKDAYS[d]}</button>`).join("");
}

function openSettings() {
  const f = $("#form-settings");
  f.notifyTime.value = state.settings.notifyTime;
  f.notifyEnabled.checked = !!state.settings.notifyEnabled;
  f.pushServer.value = serverUrl();
  f.pushServer.placeholder = "https://haushalt-push.….workers.dev";
  f.planMax.value = state.settings.planMax || 2;
  renderPlanDays(state.settings.planDays || [6]);
  $("#push-status").textContent = pushStatusText();
  $("#settings-feedback").hidden = true;
  renderShareBox();
  $("#dlg-settings").showModal();
  $("#dlg-settings h2").focus(); // nicht das Uhrzeit-Feld – sonst öffnet iOS sofort die Auswahl
  renderDiag();
}

async function saveSettings() {
  const f = $("#form-settings");
  const timeChanged = f.notifyTime.value !== state.settings.notifyTime;
  const enabledChanged = f.notifyEnabled.checked !== !!state.settings.notifyEnabled;
  state.settings.notifyTime = f.notifyTime.value || "09:00";
  state.settings.notifyEnabled = f.notifyEnabled.checked;
  state.settings.planMax = Math.max(1, Math.min(10, parseInt(f.planMax.value, 10) || 2));
  const days = [...document.querySelectorAll("#plan-days [aria-pressed=true]")].map((b) => Number(b.dataset.weekday));
  state.settings.planDays = days.length ? days : [6];
  const newServer = f.pushServer.value.trim().replace(/\/+$/, "");
  const serverChanged = newServer !== serverUrl();
  if (serverChanged) {
    await disablePush();
    state.household = null;
    state.settings.pushServer = newServer === (CONFIG.pushServerUrl || "").replace(/\/+$/, "") ? "" : newServer;
  }
  saveLocal();
  render();
  updateNotifyBanner();
  showToast("✓ Einstellungen gespeichert");
  if (state.settings.notifyEnabled && "Notification" in window && Notification.permission === "default") await requestNotify();
  else if (serverChanged) await enablePush();
  else if ((timeChanged || enabledChanged) && pushActive()) registerDevice().catch(() => {});
  if (timeChanged) checkDue();
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const s = JSON.parse(reader.result);
      if (!s || !Array.isArray(s.tasks)) throw new Error("Ungültig");
      const imported = upgrade({ tasks: s.tasks, settings: s.settings }).tasks.map((t) => ({
        ...t, id: t.id || uid(), metaAt: Date.now(), schedAt: Date.now(),
      }));
      // Bisherige Aufgaben als gelöscht markieren (damit es auch in der gemeinsamen Liste ankommt)
      const now = Date.now();
      const ids = new Set(imported.map((t) => t.id));
      const removed = state.tasks.filter((t) => !ids.has(t.id)).map((t) => ({ ...t, deleted: true, metaAt: now }));
      state.tasks = [...imported, ...removed];
      save();
      render();
      $("#dlg-settings").close();
      showToast(`✓ ${imported.length} Aufgaben importiert`);
    } catch {
      feedback("✗ Die Datei konnte nicht gelesen werden.", "error");
    }
  };
  reader.readAsText(file);
}

function addMissingDefaults() {
  const have = new Set(active().map((t) => t.name.toLowerCase()));
  const add = DEFAULT_TASKS.filter((d) => !have.has(d.name.toLowerCase()));
  for (const d of add) state.tasks.push(newTask({ ...d }));
  save();
  render();
  feedback(add.length ? `✓ ${add.length} Standard-Aufgaben ergänzt – Tipp: in der Wochenansicht „Verteilen“` : "Alle Standard-Aufgaben sind schon vorhanden");
}

// ---------- Ereignisse ----------

$("#list").addEventListener("click", (e) => {
  const wk = e.target.closest("[data-week]");
  if (wk) { weekOffset = Math.max(0, weekOffset + Number(wk.dataset.week)); render(); return; }
  if (e.target.closest("#btn-distribute")) { distribute(); return; }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const id = el.closest(".task")?.dataset.id;
  if (!id) return;
  if (el.dataset.action === "done") completeTask(id);
  else openTaskDialog(id);
});

$("#filters").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  filter = chip.dataset.room;
  render();
});

for (const v of ["list", "week"]) {
  $("#view-" + v).addEventListener("click", () => {
    state.settings.view = v;
    if (v === "week") weekOffset = 0;
    saveLocal();
    render();
  });
}

// Monats- und Wochentag-Chips umschalten
document.addEventListener("click", (e) => {
  const chip = e.target.closest("#month-chips .chip, #plan-days .chip");
  if (!chip) return;
  chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
});

$("#form-task").kind.addEventListener("change", updateTaskDialogKind);
$("#form-task").kids.addEventListener("change", updateTaskDialogKind);
$("#btn-add").addEventListener("click", () => openTaskDialog(null));
$("#btn-cancel").addEventListener("click", () => $("#dlg-task").close());
$("#form-task").addEventListener("submit", saveTaskDialog);
$("#btn-delete").addEventListener("click", () => {
  const t = state.tasks.find((x) => x.id === editingId);
  if (!t || !confirm(`„${t.name}“ wirklich löschen?`)) return;
  const snap = snapshot([t.id]);
  t.deleted = true;
  touchMeta(t);
  save();
  render();
  $("#dlg-task").close();
  showToast(`„${t.name}“ gelöscht`, () => restore(snap));
});

$("#btn-settings").addEventListener("click", openSettings);
$("#btn-settings-close").addEventListener("click", () => $("#dlg-settings").close());
$("#form-settings").addEventListener("submit", saveSettings);
$("#btn-enable-notify").addEventListener("click", requestNotify);
$("#btn-test-notify").addEventListener("click", (e) => busy(e.currentTarget, "Sende …", () => testNotification(0)));
$("#btn-test-later").addEventListener("click", (e) => busy(e.currentTarget, "Sende …", () => testNotification(20)));
$("#btn-diag-refresh").addEventListener("click", (e) => busy(e.currentTarget, "Prüfe …", async () => {
  if ("Notification" in window && Notification.permission === "granted") await enablePush();
  await renderDiag();
}));
$("#btn-ics").addEventListener("click", exportIcs);
$("#btn-export").addEventListener("click", () =>
  shareOrDownload(`haushaltsplan-${todayKey()}.json`, JSON.stringify({ version: state.version, tasks: active(), settings: state.settings }, null, 2), "application/json"));
$("#import-file").addEventListener("change", (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ""; });
$("#btn-add-defaults").addEventListener("click", addMissingDefaults);
$("#btn-reset").addEventListener("click", () => {
  const shared = !!state.household;
  if (!confirm(shared
    ? "Alle Aufgaben löschen und mit den Standard-Aufgaben neu beginnen?\n\nAchtung: Das gilt auch für alle, mit denen ihr die Liste teilt."
    : "Alle Aufgaben und Einstellungen löschen und mit den Standard-Aufgaben neu beginnen?")) return;
  const now = Date.now();
  const removed = state.tasks.map((t) => ({ ...t, deleted: true, metaAt: now }));
  const fresh = freshState();
  state.tasks = [...fresh.tasks, ...removed];
  distribute({ quiet: true });
  save();
  writeNotified({});
  render();
  $("#dlg-settings").close();
  showToast("✓ Zurückgesetzt");
});

$("#toast-undo").addEventListener("click", () => { const fn = undoAction; hideToast(); if (fn) fn(); });

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { syncNow(); checkDue(); }
});

// Mitteilung angetippt → Service Worker meldet sich
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data === "refresh") { state = loadState(); render(); syncNow(); }
});

// Unerwartete Fehler sichtbar machen statt still zu scheitern
function showError(msg) {
  try { showToast("Fehler: " + msg + " – bitte App schließen und neu öffnen."); } catch { /* ignorieren */ }
}
window.addEventListener("error", (e) => showError(e.message || "unbekannt"));
window.addEventListener("unhandledrejection", (e) => showError((e.reason && e.reason.message) || String(e.reason)));

// ---------- Start ----------

async function init() {
  if (CONFIG.familieUrl) {
    const a = $("#back-familie");
    a.href = CONFIG.familieUrl;
    a.hidden = false;
  }
  // Beim allerersten Start: große Aufgaben auf die nächsten Samstage verteilen statt alles auf heute
  if (state.initialPlan) { delete state.initialPlan; distribute({ quiet: true }); }
  render();
  updateNotifyBanner();
  if ("serviceWorker" in navigator) {
    try {
      swReg = await navigator.serviceWorker.register("./sw.js");
      await navigator.serviceWorker.ready;
      swReg = (await navigator.serviceWorker.getRegistration()) || swReg;
    } catch { /* z. B. file:// */ }
  }
  saveLocal();
  if ("Notification" in window && Notification.permission === "granted") {
    await enablePush(); // frischt Anmeldung beim Server auf (legt ggf. den Haushalt an)
    await registerPeriodicSync();
  }
  await syncNow();
  checkDue();
  // Solange die App offen ist: jede Minute prüfen, alle 2 Minuten abgleichen.
  setInterval(checkDue, 60 * 1000);
  setInterval(() => { if (document.visibilityState === "visible") syncNow(); }, 2 * 60 * 1000);
}

init();
