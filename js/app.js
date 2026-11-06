import { DEFAULT_TASKS } from "./defaults.js";
import { CONFIG } from "./config.js";

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
  saveLocal();
  schedulePushSync();
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
    showToast(text, false);
  }
}

/** Button während einer Aktion sperren und beschriften. */
async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.classList.add("busy");
  btn.textContent = label;
  try { return await fn(); } finally { btn.classList.remove("busy"); btn.textContent = old; }
}

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
  else $("#dlg-task-title").focus();
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
    await enablePush();
    await registerPeriodicSync();
    checkDue();
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
  if (pushActive()) return; // Der Server übernimmt die Erinnerungen.
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

// ---------- Push über den Server ----------

let pushError = "";
let pushSyncTimer = null;

function pushServer() {
  return String(state.settings.pushServer || CONFIG.pushServerUrl || "").trim().replace(/\/+$/, "");
}
function pushActive() {
  return !!(state.push && state.push.endpoint && state.push.server === pushServer() && pushServer());
}

function b64urlToBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function api(path, options = {}) {
  const res = await fetch(pushServer() + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server antwortet mit ${res.status}`);
  return data;
}

/** Gerät beim Push-Server anmelden (oder Anmeldung auffrischen). */
async function enablePush() {
  pushError = "";
  const server = pushServer();
  if (!server) { if (state.push) { state.push = null; saveLocal(); } return false; }
  if (!swReg || !("PushManager" in window) || !("Notification" in window) || Notification.permission !== "granted") return false;
  try {
    const { publicKey } = await api("/api/vapid-public-key");
    let sub = await swReg.pushManager.getSubscription();
    const currentKey = sub && sub.options && sub.options.applicationServerKey
      ? btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
      : null;
    if (sub && currentKey && currentKey !== publicKey) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
    state.push = { endpoint: sub.endpoint, server };
    saveLocal();
    await syncPush(sub);
    return true;
  } catch (e) {
    pushError = e.message || String(e);
    console.warn("Push-Anmeldung fehlgeschlagen", e);
    return false;
  }
}

function schedulePushSync() {
  if (!pushActive()) return;
  clearTimeout(pushSyncTimer);
  pushSyncTimer = setTimeout(() => syncPush().catch((e) => { pushError = e.message; }), 800);
}

/** Aktuelle Fälligkeitstermine an den Server schicken. */
async function syncPush(sub) {
  if (!pushServer()) return;
  sub = sub || (swReg && (await swReg.pushManager.getSubscription()));
  if (!sub) return;
  await api("/api/subscription", {
    method: "PUT",
    body: JSON.stringify({
      subscription: sub.toJSON(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin",
      notifyTime: state.settings.notifyTime,
      enabled: !!state.settings.notifyEnabled,
      tasks: state.tasks.map((t) => ({ id: t.id, name: t.name, room: t.room || "", due: S.dayKey(S.dueDate(t)) })),
    }),
  });
  pushError = "";
}

async function disablePush() {
  try {
    const sub = swReg && (await swReg.pushManager.getSubscription());
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
  if (!pushServer()) return "Kein Push-Server eingetragen: Erinnerungen kommen nur, solange die App läuft.";
  if (pushActive() && !pushError) return "✓ Push über den Server ist aktiv. Erinnerungen kommen auch bei geschlossener App.";
  if (pushError) return "Push-Server nicht erreichbar: " + pushError;
  if (!("PushManager" in window)) return isIOS() && !isStandalone()
    ? "Für Push auf dem iPhone die App zuerst zum Home-Bildschirm hinzufügen."
    : "Dieser Browser unterstützt keinen Web-Push.";
  return "Push-Server eingetragen. Erlaube Mitteilungen, um das Gerät anzumelden.";
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

  let sub = null;
  try { sub = swReg && "pushManager" in swReg ? await swReg.pushManager.getSubscription() : null; } catch { sub = null; }
  if (!("PushManager" in window)) add("bad", "Push", "nicht verfügbar");
  else if (sub) add("ok", "Push-Abo", new URL(sub.endpoint).host);
  else add("bad", "Push-Abo", pushError ? "fehlgeschlagen: " + pushError : "keins");

  if (!pushServer()) add("bad", "Server", "nicht eingetragen");
  else if (!sub) add("info", "Server", new URL(pushServer()).host);
  else {
    try {
      const st = await api("/api/status", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
      if (!st.registered) add("bad", "Server", "Gerät nicht angemeldet");
      else {
        add("ok", "Server", `angemeldet, ${st.tasks} Aufgaben, Erinnerung um ${st.notifyTime}${st.enabled ? "" : " (aus)"}`);
        const t = describeResult(st.lastTest);
        if (t) add(t.cls, "Letzter Test", t.text);
        const p = describeResult(st.lastPush);
        add(p ? p.cls : "info", "Letzte Erinnerung", p ? p.text : "noch keine gesendet");
      }
    } catch (e) {
      add("bad", "Server", "nicht erreichbar: " + e.message);
    }
  }
  $("#push-diag").innerHTML = items.join("");
}

async function testNotification(delay) {
  if (!("Notification" in window)) { feedback(notifySupportText(), "error"); return; }
  if (Notification.permission === "default") {
    await requestNotify();
  }
  if (Notification.permission !== "granted") {
    feedback("Mitteilungen sind nicht erlaubt. iPhone: Einstellungen → Mitteilungen → Familie Ulfert.", "error");
    renderDiag();
    return;
  }
  feedback("Wird gesendet …", "busy");
  if (pushServer() && !pushActive()) await enablePush();
  if (!pushActive()) {
    await showNotification("Test: Haushaltsplan", { body: "Lokale Mitteilung (ohne Server).", tag: "haushalt-test" });
    feedback("Lokale Test-Mitteilung ausgelöst (ohne Server)" + (pushError ? ". Server-Anmeldung fehlgeschlagen: " + pushError : "."), pushError ? "error" : "ok");
    renderDiag();
    return;
  }
  try {
    const sub = await swReg.pushManager.getSubscription();
    await syncPush(sub);
    const r = await api("/api/test", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint, delay }) });
    if (r.scheduled) {
      feedback(`Test kommt in ${r.scheduled} Sekunden – jetzt App schließen oder iPhone sperren.`);
      setTimeout(renderDiag, (r.scheduled + 4) * 1000);
    } else if (r.ok) {
      feedback(`✓ Vom Push-Dienst angenommen (${r.status}). Die Mitteilung sollte gleich erscheinen. Falls nicht, „Test in 20 Sek.“ tippen und die App schließen.`);
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

function openSettings() {
  const f = $("#form-settings");
  f.notifyTime.value = state.settings.notifyTime;
  f.notifyEnabled.checked = !!state.settings.notifyEnabled;
  f.pushServer.value = pushServer();
  f.pushServer.placeholder = "https://haushalt-push.….workers.dev";
  $("#push-status").textContent = pushStatusText();
  $("#settings-feedback").hidden = true;
  $("#dlg-settings").showModal();
  $("#dlg-settings h2").focus(); // nicht das Uhrzeit-Feld – sonst öffnet iOS sofort die Auswahl
  renderDiag();
}

async function saveSettings() {
  const f = $("#form-settings");
  const timeChanged = f.notifyTime.value !== state.settings.notifyTime;
  state.settings.notifyTime = f.notifyTime.value || "09:00";
  state.settings.notifyEnabled = f.notifyEnabled.checked;
  const newServer = f.pushServer.value.trim().replace(/\/+$/, "");
  const serverChanged = newServer !== pushServer();
  if (serverChanged) {
    await disablePush();
    // Leer = Standard aus config.js verwenden
    state.settings.pushServer = newServer === (CONFIG.pushServerUrl || "").replace(/\/+$/, "") ? "" : newServer;
  }
  save();
  updateNotifyBanner();
  showToast("✓ Einstellungen gespeichert", false);
  if (state.settings.notifyEnabled && "Notification" in window && Notification.permission === "default") await requestNotify();
  else if (serverChanged) await enablePush();
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
      state = { version: 1, tasks: s.tasks, settings: { ...s.settings, pushServer: state.settings.pushServer || "" }, push: state.push };
      save();
      render();
      $("#dlg-settings").close();
      showToast(`✓ ${state.tasks.length} Aufgaben importiert`, false);
    } catch {
      feedback("✗ Die Datei konnte nicht gelesen werden.", "error");
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
  feedback(add.length ? `✓ ${add.length} Standard-Aufgaben ergänzt` : "Alle Standard-Aufgaben sind schon vorhanden");
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
$("#btn-test-notify").addEventListener("click", (e) => busy(e.currentTarget, "Sende …", () => testNotification(0)));
$("#btn-test-later").addEventListener("click", (e) => busy(e.currentTarget, "Sende …", () => testNotification(20)));
$("#btn-diag-refresh").addEventListener("click", (e) => busy(e.currentTarget, "Prüfe …", async () => {
  if ("Notification" in window && Notification.permission === "granted") await enablePush();
  await renderDiag();
}));
$("#btn-ics").addEventListener("click", exportIcs);
$("#btn-export").addEventListener("click", () =>
  shareOrDownload(`haushaltsplan-${S.dayKey(Date.now())}.json`, JSON.stringify(state, null, 2), "application/json"));
$("#import-file").addEventListener("change", (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ""; });
$("#btn-add-defaults").addEventListener("click", addMissingDefaults);
$("#btn-reset").addEventListener("click", () => {
  if (!confirm("Alle Aufgaben und Einstellungen löschen und mit den Standard-Aufgaben neu beginnen?")) return;
  const push = state.push;
  state = freshState();
  state.push = push;
  save();
  writeNotified({});
  render();
  $("#dlg-settings").close();
  showToast("✓ Zurückgesetzt", false);
});

$("#toast-undo").addEventListener("click", undo);

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkDue(); });

// Mitteilung angetippt → Service Worker meldet sich
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data === "refresh") { state = loadState(); render(); } });

// ---------- Start ----------

async function init() {
  if (CONFIG.familieUrl) {
    const a = $("#back-familie");
    a.href = CONFIG.familieUrl;
    a.hidden = false;
  }
  render();
  updateNotifyBanner();
  if ("serviceWorker" in navigator) {
    try {
      swReg = await navigator.serviceWorker.register("./sw.js");
      await navigator.serviceWorker.ready;
      swReg = await navigator.serviceWorker.getRegistration() || swReg;
    } catch { /* z. B. file:// */ }
  }
  saveLocal();
  if ("Notification" in window && Notification.permission === "granted") {
    await enablePush(); // frischt Anmeldung und Termine beim Server auf
    await registerPeriodicSync();
  }
  checkDue();
  // Solange die App offen ist (auch im Hintergrund-Tab), jede Minute prüfen.
  setInterval(checkDue, 60 * 1000);
}

init();
