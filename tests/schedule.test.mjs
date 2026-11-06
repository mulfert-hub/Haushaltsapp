import { test } from "node:test";
import assert from "node:assert/strict";
import "../js/schedule.js";

const S = globalThis.Schedule;
const at = (s) => new Date(s).getTime();

test("Monate am Monatsende werden gekappt", () => {
  assert.equal(S.dayKey(S.addInterval(new Date(2026, 0, 31), 1, "months")), "2026-02-28");
  assert.equal(S.dayKey(S.addInterval(new Date(2024, 1, 29), 1, "years")), "2025-02-28");
});

test("Fälligkeit und Resttage", () => {
  const t = { lastDone: new Date(2026, 10, 1, 18).toISOString(), every: 1, unit: "weeks" };
  assert.equal(S.dayKey(S.dueDate(t)), "2026-11-08");
  assert.equal(S.daysLeft(t, new Date(2026, 10, 6, 10)), 2);
  assert.equal(S.daysLeft(t, new Date(2026, 10, 9, 10)), -1);
});

test("Nie erledigt = sofort fällig", () => {
  const t = { lastDone: null, createdAt: new Date(2026, 10, 6).toISOString(), every: 3, unit: "months" };
  assert.equal(S.daysLeft(t, new Date(2026, 10, 6, 12)), 0);
  assert.equal(S.progress(t), 1);
});

test("Mitteilungen erst ab Uhrzeit und nur einmal je Termin", () => {
  const task = { id: "a", name: "Fenster", lastDone: null, createdAt: new Date(2026, 10, 6).toISOString(), every: 1, unit: "weeks" };
  const state = { settings: { notifyEnabled: true, notifyTime: "09:00" }, tasks: [task] };
  assert.equal(S.tasksToNotify(state, {}, new Date(2026, 10, 6, 8, 59)).length, 0);
  assert.equal(S.tasksToNotify(state, {}, new Date(2026, 10, 6, 9, 0)).length, 1);
  assert.equal(S.tasksToNotify(state, { a: "2026-11-06" }, new Date(2026, 10, 6, 10)).length, 0);
});
