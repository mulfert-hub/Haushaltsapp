import { test } from "node:test";
import assert from "node:assert/strict";
import "../js/schedule.js";

const S = globalThis.Schedule;
const iso = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();

test("Monate am Monatsende werden gekappt", () => {
  assert.equal(S.addInterval("2026-01-31", 1, "months"), "2026-02-28");
  assert.equal(S.addInterval("2024-02-29", 1, "years"), "2025-02-28");
  assert.equal(S.addInterval("2026-12-15", 2, "months"), "2027-02-15");
});

test("Fälligkeit und Resttage", () => {
  const t = { lastDone: iso(2026, 11, 1, 18), every: 1, unit: "weeks" };
  assert.equal(S.dueKey(t), "2026-11-08");
  assert.equal(S.daysLeft(t, new Date(2026, 10, 6, 10)), 2);
  assert.equal(S.daysLeft(t, new Date(2026, 10, 9, 10)), -1);
});

test("Nie erledigt = ab Erstellung fällig", () => {
  const t = { lastDone: null, createdAt: iso(2026, 11, 6), every: 3, unit: "months" };
  assert.equal(S.daysLeft(t, new Date(2026, 10, 6, 12)), 0);
  assert.equal(S.progress(t), 1);
});

test("Geplanter Termin hat Vorrang", () => {
  const t = { lastDone: iso(2026, 11, 1), every: 3, unit: "months", planned: "2026-11-14" };
  assert.equal(S.dueKey(t), "2026-11-14");
});

test("Saisonal: im Monat fällig, danach erst wieder im nächsten Jahr", () => {
  const t = { unit: "season", months: [10], createdAt: iso(2026, 1, 1) };
  assert.equal(S.dueKey(t, new Date(2026, 6, 15)), "2026-10-01"); // Juli → 1. Oktober
  assert.equal(S.dueKey(t, new Date(2026, 9, 20)), "2026-10-01"); // im Oktober: seit 1.10. fällig
  assert.equal(S.dueKey({ ...t, lastDone: iso(2026, 10, 12) }, new Date(2026, 9, 13)), "2027-10-01");
  assert.equal(S.dueKey({ ...t, lastDone: iso(2026, 9, 25) }, new Date(2026, 9, 26)), "2027-10-01"); // früh erledigt
});

test("Saisonal mit zwei Monaten", () => {
  const t = { unit: "season", months: [3, 10], createdAt: iso(2026, 1, 1), lastDone: iso(2026, 3, 15) };
  assert.equal(S.dueKey(t), "2026-10-01");
  assert.equal(S.dueKey({ ...t, lastDone: iso(2026, 10, 3) }), "2027-03-01");
});

test("Einmalig: am Datum fällig, danach nie wieder", () => {
  const t = { unit: "once", date: "2027-03-12", createdAt: iso(2026, 11, 6) };
  assert.equal(S.dueKey(t), "2027-03-12");
  assert.equal(S.dueKey({ ...t, lastDone: iso(2027, 3, 12) }), null);
  assert.equal(S.daysLeft({ ...t, lastDone: iso(2027, 3, 12) }), Infinity);
});

test("Zeitzone: Server rechnet in der Zeitzone des Geräts", () => {
  const t = { lastDone: "2026-11-06T23:30:00Z", every: 1, unit: "days" }; // Berlin: 7.11., 00:30
  assert.equal(S.dueKey(t, new Date("2026-11-07T10:00:00Z"), "Europe/Berlin"), "2026-11-08");
  assert.equal(S.dueKey(t, new Date("2026-11-07T10:00:00Z"), "UTC"), "2026-11-07");
});

test("Große Aufgaben", () => {
  assert.equal(S.isBig({ unit: "weeks", every: 1 }), false);
  assert.equal(S.isBig({ unit: "months", every: 3 }), true);
  assert.equal(S.isBig({ unit: "season", months: [4] }), true);
  assert.equal(S.isBig({ unit: "once" }), false);
});

test("Mitteilungen erst ab Uhrzeit, nur einmal je Termin, gelöschte nie", () => {
  const task = { id: "a", name: "Fenster", lastDone: null, createdAt: iso(2026, 11, 6), every: 1, unit: "weeks" };
  const state = { settings: { notifyEnabled: true, notifyTime: "09:00" }, tasks: [task, { ...task, id: "b", deleted: true }] };
  assert.equal(S.tasksToNotify(state, {}, new Date(2026, 10, 6, 8, 59)).length, 0);
  assert.equal(S.tasksToNotify(state, {}, new Date(2026, 10, 6, 9, 0)).length, 1);
  assert.equal(S.tasksToNotify(state, { a: "2026-11-06" }, new Date(2026, 10, 6, 10)).length, 0);
});
