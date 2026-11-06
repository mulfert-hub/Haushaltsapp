// Gemeinsame Termin-Logik für App und Service Worker (klassisches Skript,
// damit es auch per importScripts() im Service Worker nutzbar ist).
(function (root) {
  const DAY = 24 * 60 * 60 * 1000;

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function addInterval(date, every, unit) {
    const d = new Date(date);
    const n = Math.max(1, Number(every) || 1);
    switch (unit) {
      case "days": d.setDate(d.getDate() + n); break;
      case "weeks": d.setDate(d.getDate() + 7 * n); break;
      case "months":
      case "years": {
        const months = unit === "years" ? 12 * n : n;
        const day = d.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + months);
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(day, last));
        break;
      }
      default: d.setDate(d.getDate() + n);
    }
    return d;
  }

  /** Fälligkeitstag (00:00 Uhr lokale Zeit). Nie erledigt = ab Erstellung fällig. */
  function dueDate(task) {
    if (!task.lastDone) return startOfDay(task.createdAt || Date.now());
    return addInterval(startOfDay(task.lastDone), task.every, task.unit);
  }

  /** Ganze Tage bis zur Fälligkeit (negativ = überfällig). */
  function daysLeft(task, now) {
    const today = startOfDay(now || Date.now());
    return Math.round((dueDate(task) - today) / DAY);
  }

  /** Anteil der abgelaufenen Zeit seit dem letzten Erledigen (0…1). */
  function progress(task, now) {
    if (!task.lastDone) return 1;
    const start = startOfDay(task.lastDone).getTime();
    const end = dueDate(task).getTime();
    const t = (now || Date.now());
    if (end <= start) return 1;
    return Math.min(1, Math.max(0, (t - start) / (end - start)));
  }

  function dayKey(d) {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  }

  /** Ist die Erinnerungs-Uhrzeit heute schon erreicht? */
  function reminderTimeReached(notifyTime, now) {
    const [h, m] = String(notifyTime || "09:00").split(":").map(Number);
    const n = new Date(now || Date.now());
    return n.getHours() > h || (n.getHours() === h && n.getMinutes() >= m);
  }

  /**
   * Liefert die Aufgaben, für die jetzt eine Mitteilung fällig ist,
   * und noch nicht für diesen Fälligkeitstermin gemeldet wurden.
   */
  function tasksToNotify(state, notified, now) {
    if (!state || !state.settings || !state.settings.notifyEnabled) return [];
    if (!reminderTimeReached(state.settings.notifyTime, now)) return [];
    return (state.tasks || []).filter((t) =>
      daysLeft(t, now) <= 0 && notified[t.id] !== dayKey(dueDate(t)));
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
    DAY, startOfDay, addInterval, dueDate, daysLeft, progress, dayKey,
    reminderTimeReached, tasksToNotify, notificationText,
  };
})(typeof self !== "undefined" ? self : globalThis);
