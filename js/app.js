import { DEFAULT_TASKS } from "./defaults.js";

const S = window.Schedule;
const STORAGE_KEY = "haushaltsplan.v1";
const STATE_CACHE = "haushalt-state";
const STATE_URL = "./__state.json";
const NOTIFIED_URL = "./__notified.json";

const UNIT_LABEL = {
  days: ["Tag", "Tage"], weeks: ["Woche", "Wochen"],
  months: ["Monat", "Monate"], years: ["Jahr", "Jahre"],
};

const $ = (sel) => document.querySelector(sel);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------- Zustand ----------

function freshState() {
  const now = new Date().toISOString();
  return {
    version: 1,
    tasks: DEFAULT_TASKS.map((t) => ({ id: uid(), ...t, lastDone: null, createdAt: now, history: [], note: "" })),
    settings: { notifyTime: "09:00", notifyEnabled: true },
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.tasks)) return s;
    }
  } catch { /* ignorieren */ }
  return freshState();
}

let state = loadState();
let filter = "Alle";
let undoSnapshot = null;
let toastTimer = null;

function save() {
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

async function readNotified() {
  try {
    if ("caches" in window) {
      const c = await caches.open(STATE_CACHE);
      const r = await c.match(NOTIFIED_URL);
      if (r) return await r.json();
    }
  } catch { /* ignorieren */ }
  return {};
}

async function writeNotified(map) {
  try {
    if ("caches" in window) {
      const c = await caches.open(STATE_CACHE);
      await c.put(NOTIFIED_URL, new Response(JSON.stringify(map), { headers: { "Content-Type": "application/json" } }));
    }
  } catch { /* ignorieren */ }
}

// ---------- Formatierung ----------

function intervalText(t) {
  const [, many] = UNIT_LABEL[t.unit] || UNIT_LABEL.days;
  const single = { days: "jeden Tag", weeks: "jede Woche", months: "jeden Monat", years: "jedes Jahr" };
  return Number(t.every) === 1 ? single[t.unit] || single.days : `alle ${t.every} ${many}`;
}

function timerText(days) {
  if (days < -1) return `${-days} Tage überfällig`;
  if (days === -1) return "seit gestern fällig";
  if (days === 0) return "heute fällig";
  if (days === 1) return "morgen";
  if (days < 14) return `in ${days} Tagen`;
  if (days < 60) return `in ${Math.round(days / 7)} Wochen`;
  return `in ${Math.round(days / 30.4)} Monaten`;
}

const dateFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short" });

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Rendern ----------

function rooms() {
  return [...new Set(state.tasks.map((t) => t.room).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
}

function renderFilters() {
  const list = ["Alle", ...rooms()];
  if (!list.includes(filter)) filter = "Alle";
  $("#filters").innerHTML = list.map((r) =>
    `<button class="chip" data-room="${escapeHtml(r)}" aria-pressed="${r === filter}">${escapeHtml(r)}</button>`).join("");
  $("#rooms").innerHTML = rooms().map((r) => `<option value="${escapeHtml(r)}">`).join("");
}

function taskHtml(t, now) {
  const days = S.daysLeft(t, now);
  const cls = days < 0 ? "overdue" : days === 0 ? "due" : "";
  const pct = Math.round(S.progress(t, now) * 100);
  const due = S.dueDate(t);
  const last = t.lastDone ? `zuletzt ${shortFmt.format(new Date(t.lastDone))}` : "noch nie erledigt";
  return `
    <li class="task ${cls}" data-id="${t.id}">
      <button class="check-btn" data-action="done" aria-label="${escapeHtml(t.name)} erledigt">
        <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
      </button>
      <div class="task-body" data-action="edit">
        <div class="task-name">${escapeHtml(t.name)}</div>
        <div class="task-meta">
          ${t.room ? `<span>${escapeHtml(t.room)}</span><span class="dot"></span>` : ""}
          <span>${intervalText(t)}</span><span class="dot"></span><span>${last}</span>
        </div>
        <div class="timer" title="Fällig am ${dateFmt.format(due)}">
          <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
          <span class="timer-label">${timerText(days)}</span>
        </div>
      </div>
      <button class="icon-btn more-btn" data-action="edit" aria-label="${escapeHtml(t.name)} bearbeiten">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/></svg>
      </button>
    </li>`;
}

function render() {
  const now = Date.now();
  renderFilters();
  const tasks = state.tasks
    .filter((t) => filter === "Alle" || t.room === filter)
    .sort((a, b) => S.dueDate(a) - S.dueDate(b) || a.name.localeCompare(b.name, "de"));

  const groups = [
    { title: "Jetzt dran", items: tasks.filter((t) => S.daysLeft(t, now) <= 0) },
    { title: "Nächste 7 Tage", items: tasks.filter((t) => { const d = S.daysLeft(t, now); return d > 0 && d <= 7; }) },
    { title: "Später", items: tasks.filter((t) => S.daysLeft(t, now) > 7) },
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
  if (tasks.length === 0) {
    html = `<div class="empty" style="margin-top:20px"><strong>Keine Aufgaben</strong>Tippe auf +, um eine Aufgabe anzulegen.</div>`;
  }
  $("#list").innerHTML = html;

  const dueCount = state.tasks.filter((t) => S.daysLeft(t, now) <= 0).length;
  const next = state.tasks.filter((t) => S.daysLeft(t, now) > 0).sort((a, b) => S.dueDate(a) - S.dueDate(b))[0];
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

function completeTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  undoSnapshot = { id, lastDone: t.lastDone, history: [...(t.history || [])] };
  const now = new Date().toISOString();
  t.lastDone = now;
  t.history = [now, ...(t.history || [])].slice(0, 30);
  save();

  const li = document.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
  if (li) {
    li.querySelector(".check-btn").classList.add("checked");
    li.classList.add("done-anim");
  }
  setTimeout(render, 450);
  showToast(`„${t.name}“ erledigt · wieder ${timerText(S.daysLeft(t))}`);
}

function undo() {
  if (!undoSnapshot) return;
  const t = state.tasks.find((x) => x.id === undoSnapshot.id);
  if (t) {
    t.lastDone = undoSnapshot.lastDone;
    t.history = undoSnapshot.history;
    save();
    render();
  }
  undoSnapshot = null;
  hideToast();
}

function showToast(text, withUndo = true) {
  $("#toast-text").textContent = text;
  $("#toast-undo").hidden = !withUndo;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
function hideToast() { $("#toast").hidden = true; }

// ---------- Dialog: Aufgabe ----------

let editingId = null;

function toDateInput(iso) {
  return iso ? S.dayKey(iso) : "";
}

function openTaskDialog(id) {
  editingId = id;
  const t = id ? state.tasks.find((x) => x.id === id) : null;
  const f = $("#form-task");
  $("#dlg-task-title").textContent = t ? "Aufgabe bearbeiten" : "Neue Aufgabe";
  f.name.value = t?.name ?? "";
  f.room.value = t?.room ?? (filter !== "Alle" ? filter : "");
  f.every.value = t?.every ?? 1;
  f.unit.value = t?.unit ?? "weeks";
  f.lastDone.value = toDateInput(t?.lastDone);
  f.lastDone.max = S.dayKey(Date.now());
  f.note.value = t?.note ?? "";
  $("#btn-delete").hidden = !t;
  const hist = (t?.history || []).slice(0, 6);
  $("#history").innerHTML = hist.length
    ? `<div class="field"><span>Verlauf</span><ul>${hist.map((h) => `<li>${dateFmt.format(new Date(h))}</li>`).join("")}</ul></div>`
    : "";
  $("#dlg-task").showModal();
  if (!t) f.name.focus();
}

function saveTaskDialog() {
  const f = $("#form-task");
  const data = {
    name: f.name.value.trim(),
    room: f.room.value.trim(),
    every: Math.max(1, Math.min(999, parseInt(f.every.value, 10) || 1)),
    unit: f.unit.value,
    note: f.note.value.trim(),
  };
  if (!data.name) return;
  let lastDone = null;
  if (f.lastDone.value) {
    const [y, m, d] = f.lastDone.value.split("-").map(Number);
    lastDone = new Date(y, m - 1, d, 12).toISOString();
  }
  if (editingId) {
    const t = state.tasks.find((x) => x.id === editingId);
    const prevDay = t.lastDone ? S.dayKey(t.lastDone) : "";
    Object.assign(t, data);
    if ((f.lastDone.value || "") !== prevDay) {
      t.lastDone = lastDone;
      if (lastDone) t.history = [lastDone, ...(t.history || [])].slice(0, 30);
    }
  } else {
    state.tasks.push({ id: uid(), ...data, lastDone, createdAt: new Date().toISOString(), history: lastDone ? [lastDone] : [] });
  }
  save();
  render();
}

// ---------- Mitteilungen ----------

let swReg = null;

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
  const btn = $("#btn-enable-notify");
  const supported = "Notification" in window;
  const show = state.settings.notifyEnabled && (!supported || Notification.permission === "default");
  banner.hidden = !show;
  $("#notify-banner-text").textContent = supported
    ? "Erlaube Mitteilungen, damit du erinnert wirst, wenn eine Aufgabe wieder dran ist."
    : notifySupportText();
  btn.hidden = !supported;
}

async function requestNotify() {
  if (!("Notification" in window)) return;
  const p = await Notification.requestPermission();
  updateNotifyBanner();
  if (p === "granted") {
    await registerPeriodicSync();
    checkDue(true);
  }
}

async function showNotification(title, options) {
  const opts = { icon: "icons/icon-192.png", badge: "icons/icon-192.png", lang: "de", ...options };
  if (swReg && swReg.showNotification) return swReg.showNotification(title, opts);
  return new Notification(title, opts);
}

async function checkDue() {
  render();
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const notified = await readNotified();
  const list = S.tasksToNotify(state, notified, Date.now());
  if (!list.length) return;
  // Nur melden, wenn die App nicht gerade im Vordergrund ist – sonst sieht man es ja.
  if (document.visibilityState !== "visible") {
    const { title, body } = S.notificationText(list);
    await showNotification(title, { body, tag: "haushalt-faellig", renotify: true });
  }
  for (const t of list) notified[t.id] = S.dayKey(S.dueDate(t));
  await writeNotified(notified);
}

async function registerPeriodicSync() {
  try {
    if (!swReg || !("periodicSync" in swReg)) return;
    const status = await navigator.permissions.query({ name: "periodic-background-sync" });
    if (status.state === "granted") {
      await swReg.periodicSync.register("check-due", { minInterval: 60 * 60 * 1000 });
    }
  } catch { /* nicht unterstützt */ }
}

// ---------- Kalender (.ics) ----------

function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
function icsDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
}
const RRULE_FREQ = { days: "DAILY", weeks: "WEEKLY", months: "MONTHLY", years: "YEARLY" };

function exportIcs() {
  const [h, m] = state.settings.notifyTime.split(":").map(Number);
  const today = S.startOfDay(Date.now());
  const stamp = icsDate(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Haushaltsplan//DE", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Haushaltsplan"];
  for (const t of state.tasks) {
    const due = S.dueDate(t);
    const start = due < today ? new Date(today) : new Date(due);
    start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${t.id}@haushaltsplan`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      `RRULE:FREQ=${RRULE_FREQ[t.unit] || "DAILY"};INTERVAL=${t.every}`,
      `SUMMARY:${icsEscape("🧹 " + t.name)}`,
      `DESCRIPTION:${icsEscape((t.room ? t.room + " – " : "") + intervalText(t) + (t.note ? "\n" + t.note : ""))}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(t.name)}`, "TRIGGER:PT0M", "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  download("haushaltsplan.ics", lines.join("\r\n"), "text/calendar");
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

function openSettings() {
  const f = $("#form-settings");
  f.notifyTime.value = state.settings.notifyTime;
  f.notifyEnabled.checked = !!state.settings.notifyEnabled;
  $("#notify-status").textContent = notifySupportText();
  $("#dlg-settings").showModal();
}

async function saveSettings() {
  const f = $("#form-settings");
  const timeChanged = f.notifyTime.value !== state.settings.notifyTime;
  state.settings.notifyTime = f.notifyTime.value || "09:00";
  state.settings.notifyEnabled = f.notifyEnabled.checked;
  save();
  updateNotifyBanner();
  if (state.settings.notifyEnabled && "Notification" in window && Notification.permission === "default") await requestNotify();
  if (timeChanged) checkDue();
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const s = JSON.parse(reader.result);
      if (!s || !Array.isArray(s.tasks)) throw new Error("Ungültig");
      s.tasks = s.tasks.filter((t) => t && t.name).map((t) => ({
        id: t.id || uid(), name: String(t.name), room: String(t.room || ""),
        every: Math.max(1, parseInt(t.every, 10) || 1),
        unit: UNIT_LABEL[t.unit] ? t.unit : "days",
        lastDone: t.lastDone || null, createdAt: t.createdAt || new Date().toISOString(),
        history: Array.isArray(t.history) ? t.history.slice(0, 30) : [], note: String(t.note || ""),
      }));
      s.settings = { notifyTime: "09:00", notifyEnabled: true, ...(s.settings || {}) };
      state = { version: 1, tasks: s.tasks, settings: s.settings };
      save();
      render();
      $("#dlg-settings").close();
      showToast(`${state.tasks.length} Aufgaben importiert`, false);
    } catch {
      alert("Die Datei konnte nicht gelesen werden.");
    }
  };
  reader.readAsText(file);
}

function addMissingDefaults() {
  const have = new Set(state.tasks.map((t) => t.name.toLowerCase()));
  const now = new Date().toISOString();
  const add = DEFAULT_TASKS.filter((d) => !have.has(d.name.toLowerCase()));
  for (const d of add) state.tasks.push({ id: uid(), ...d, lastDone: null, createdAt: now, history: [], note: "" });
  save();
  render();
  showToast(add.length ? `${add.length} Standard-Aufgaben ergänzt` : "Alle Standard-Aufgaben sind schon vorhanden", false);
}

// ---------- Ereignisse ----------

$("#list").addEventListener("click", (e) => {
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

$("#btn-add").addEventListener("click", () => openTaskDialog(null));
$("#btn-cancel").addEventListener("click", () => $("#dlg-task").close());
$("#form-task").addEventListener("submit", saveTaskDialog);
$("#btn-delete").addEventListener("click", () => {
  const t = state.tasks.find((x) => x.id === editingId);
  if (!t || !confirm(`„${t.name}“ wirklich löschen?`)) return;
  state.tasks = state.tasks.filter((x) => x.id !== editingId);
  save();
  render();
  $("#dlg-task").close();
});

$("#btn-settings").addEventListener("click", openSettings);
$("#btn-settings-close").addEventListener("click", () => $("#dlg-settings").close());
$("#form-settings").addEventListener("submit", saveSettings);
$("#btn-enable-notify").addEventListener("click", requestNotify);
$("#btn-test-notify").addEventListener("click", async () => {
  if (!("Notification" in window)) { alert(notifySupportText()); return; }
  if (Notification.permission !== "granted") await requestNotify();
  if (Notification.permission === "granted") {
    await showNotification("Test: Haushaltsplan", { body: "So sehen deine Erinnerungen aus.", tag: "haushalt-test" });
  }
  $("#notify-status").textContent = notifySupportText();
});
$("#btn-ics").addEventListener("click", exportIcs);
$("#btn-export").addEventListener("click", () =>
  download(`haushaltsplan-${S.dayKey(Date.now())}.json`, JSON.stringify(state, null, 2), "application/json"));
$("#import-file").addEventListener("change", (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ""; });
$("#btn-add-defaults").addEventListener("click", addMissingDefaults);
$("#btn-reset").addEventListener("click", () => {
  if (!confirm("Alle Aufgaben und Einstellungen löschen und mit den Standard-Aufgaben neu beginnen?")) return;
  state = freshState();
  save();
  writeNotified({});
  render();
  $("#dlg-settings").close();
});

$("#toast-undo").addEventListener("click", undo);

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkDue(); });

// Mitteilung angetippt → Service Worker meldet sich
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data === "refresh") { state = loadState(); render(); } });

// ---------- Start ----------

async function init() {
  render();
  updateNotifyBanner();
  if ("serviceWorker" in navigator) {
    try {
      swReg = await navigator.serviceWorker.register("./sw.js");
      await navigator.serviceWorker.ready;
      swReg = await navigator.serviceWorker.getRegistration() || swReg;
    } catch { /* z. B. file:// */ }
  }
  save();
  if ("Notification" in window && Notification.permission === "granted") await registerPeriodicSync();
  checkDue();
  // Solange die App offen ist (auch im Hintergrund-Tab), jede Minute prüfen.
  setInterval(checkDue, 60 * 1000);
}

init();
