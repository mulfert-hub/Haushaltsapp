// Gemeinsame Termin-Logik für App, Service Worker und Push-Server.
// Klassisches Skript (setzt globalThis.Schedule), damit es per <script>, importScripts()
// und als Import im Cloudflare Worker funktioniert.
//
// Alle Termine werden als Tageskennung "JJJJ-MM-TT" in einer Zeitzone gerechnet.
// Ohne Zeitzone gilt die Zeitzone des Geräts.
//
// Arten von Aufgaben (task.unit):
//   days | weeks | months | years  – wiederkehrend, task.every gibt die Anzahl an
//   season                          – jedes Jahr in bestimmten Monaten (task.months = [1..12])
//   once                            – einmalig am Datum task.date (z. B. Garantie-Ende)
// task.planned = "JJJJ-MM-TT" verschiebt den nächsten Termin (z. B. durch „Plan verteilen“).
(function (root) {
  const DAY = 24 * 60 * 60 * 1000;
  const fmtCache = {};

  function pad(n) { return String(n).padStart(2, "0"); }

  /** Tageskennung eines Zeitpunkts in einer Zeitzone (Standard: Gerät). */
  function dayKey(d, tz) {
    const x = d instanceof Date ? d : new Date(d);
    if (!tz) return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }));
    return f.format(x);
  }

  function parseKey(k) {
    const [y, m, d] = String(k).split("-").map(Number);
    return { y, m, d };
  }
  function keyFromUTC(t) {
    const x = new Date(t);
    return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
  }
  function utcOf(k) { const { y, m, d } = parseKey(k); return Date.UTC(y, m - 1, d); }

  function addDays(k, n) { return keyFromUTC(utcOf(k) + n * DAY); }
  function diffDays(a, b) { return Math.round((utcOf(a) - utcOf(b)) / DAY); }
  function addMonths(k, n) {
    const { y, m, d } = parseKey(k);
    const total = (y * 12 + (m - 1)) + n;
    const ny = Math.floor(total / 12), nm = total % 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
  }

  function addInterval(k, every, unit) {
    const n = Math.max(1, Number(every) || 1);
    switch (unit) {
      case "weeks": return addDays(k, 7 * n);
      case "months": return addMonths(k, n);
      case "years": return addMonths(k, 12 * n);
      default: return addDays(k, n);
    }
  }

  function seasonMonths(task) {
    return [...new Set((task.months || []).map(Number).filter((m) => m >= 1 && m <= 12))].sort((a, b) => a - b);
  }

  /** Erster Tag des nächsten aufgeführten Monats, der am oder nach Tag k beginnt. */
  function nextSeasonStart(months, k) {
    const { y, m, d } = parseKey(k);
    for (let i = 0; i < 25; i++) {
      const total = y * 12 + (m - 1) + i;
      const yy = Math.floor(total / 12), mm = (total % 12) + 1;
      if (months.includes(mm)) {
        const start = `${yy}-${pad(mm)}-01`;
        if (i > 0 || d === 1) return start;
      }
    }
    return null;
  }

  /** Nächster Fälligkeitstag als "JJJJ-MM-TT" – oder null (einmalige Aufgabe erledigt). */
  function dueKey(task, now, tz) {
    if (task.planned) return task.planned;
    const today = dayKey(now || Date.now(), tz);
    const created = task.createdAt ? dayKey(task.createdAt, tz) : today;
    const last = task.lastDone ? dayKey(task.lastDone, tz) : null;

    if (task.unit === "once") {
      if (last) return null;
      return task.date || created;
    }
    if (task.unit === "season") {
      const months = seasonMonths(task);
      if (!months.length) return last ? addInterval(last, 1, "years") : created;
      if (last) return nextSeasonStart(months, addDays(last, 45));
      const { m } = parseKey(today);
      if (months.includes(m)) {
        const monthStart = today.slice(0, 8) + "01";
        return created > monthStart ? created : monthStart;
      }
      return nextSeasonStart(months, today);
    }
    return last ? addInterval(last, task.every, task.unit) : created;
  }

  /** Ganze Tage bis zur Fälligkeit (negativ = überfällig, Infinity = nie wieder). */
  function daysLeft(task, now, tz) {
    const due = dueKey(task, now, tz);
    if (!due) return Infinity;
    return diffDays(due, dayKey(now || Date.now(), tz));
  }

  /** Fälligkeitstag als lokales Datum (00:00 Uhr) – oder null. */
  function dueDate(task, now) {
    const k = dueKey(task, now);
    if (!k) return null;
    const { y, m, d } = parseKey(k);
    return new Date(y, m - 1, d);
  }

  /** Anteil der abgelaufenen Zeit seit dem letzten Erledigen (0…1). */
  function progress(task, now) {
    if (!task.lastDone) return 1;
    const due = dueKey(task, now);
    if (!due) return 0;
    const start = dayKey(task.lastDone);
    const total = diffDays(due, start);
    if (total <= 0) return 1;
    const t = new Date(now || Date.now());
    const elapsed = diffDays(dayKey(t), start) + (t.getHours() * 60 + t.getMinutes()) / 1440;
    return Math.min(1, Math.max(0, elapsed / total));
  }

  /** „Große“ Aufgabe (mindestens etwa monatlich) – wird beim Verteilen berücksichtigt. */
  function isBig(task) {
    switch (task.unit) {
      case "season": return true;
      case "once": return false;
      case "years": return true;
      case "months": return true;
      case "weeks": return Number(task.every) >= 4;
      default: return Number(task.every) >= 28;
    }
  }

  function reminderTimeReached(notifyTime, now, tz) {
    const [h, m] = String(notifyTime || "09:00").split(":").map(Number);
    const n = new Date(now || Date.now());
    let hh = n.getHours(), mm = n.getMinutes();
    if (tz) {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(n);
      hh = Number(parts.find((p) => p.type === "hour").value);
      mm = Number(parts.find((p) => p.type === "minute").value);
    }
    return hh > h || (hh === h && mm >= m);
  }

  function activeTasks(tasks) {
    return (tasks || []).filter((t) => t && !t.deleted);
  }

  /** Aufgaben, für die jetzt eine Mitteilung fällig ist und die für diesen Termin noch nicht gemeldet wurden. */
  function tasksToNotify(state, notified, now, tz) {
    if (!state || !state.settings || !state.settings.notifyEnabled) return [];
    if (!reminderTimeReached(state.settings.notifyTime, now, tz)) return [];
    const today = dayKey(now || Date.now(), tz);
    return activeTasks(state.tasks).filter((t) => {
      const due = dueKey(t, now, tz);
      return due && due <= today && notified[t.id] !== due;
    });
  }

  function notificationText(tasks) {
    const names = tasks.map((t) => t.name);
    const title = tasks.length === 1 ? "Wieder dran: " + names[0] : tasks.length + " Haushaltsaufgaben sind dran";
    const body = tasks.length === 1
      ? (tasks[0].room ? tasks[0].room + " · " : "") + "Tippe, um sie abzuhaken."
      : names.slice(0, 5).join(", ") + (names.length > 5 ? " …" : "");
    return { title, body };
  }

  root.Schedule = {
    DAY, dayKey, addDays, diffDays, addMonths, addInterval, seasonMonths, dueKey, daysLeft, dueDate, progress,
    isBig, reminderTimeReached, activeTasks, tasksToNotify, notificationText,
  };
})(typeof self !== "undefined" ? self : globalThis);
