// Diagnose: Was weiß der Push-Server über die angemeldeten Geräte?
// Gibt nur unkritische Angaben aus (keine Push-Adressen, keine Schlüssel, keine Aufgabennamen),
// weil Workflow-Logs öffentlicher Repositories für alle lesbar sind.
// Aufruf (im Ordner server/, mit CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID): node scripts/diagnose.mjs <KV-ID>
import { execFileSync } from "node:child_process";

const ns = process.argv[2];
if (!ns) { console.error("KV-ID fehlt"); process.exit(1); }
const wr = (...args) => execFileSync("npx", ["wrangler", ...args, "--namespace-id", ns, "--remote"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const json = (s) => JSON.parse(s.slice(s.search(/[[{]/)));

const keys = json(wr("kv", "key", "list")).map((k) => k.name);
console.log(`Schlüssel im Speicher: ${keys.length} (VAPID vorhanden: ${keys.includes("vapid") ? "ja" : "nein"})`);
const subs = keys.filter((k) => k.startsWith("sub:"));
console.log(`Angemeldete Geräte: ${subs.length}`);
for (const [i, k] of subs.entries()) {
  const r = json(wr("kv", "key", "get", k));
  const host = (() => { try { return new URL(r.subscription.endpoint).host; } catch { return "?"; } })();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: r.tz }).format(new Date());
  const due = (r.tasks || []).filter((t) => t.due <= today).length;
  const fmt = (x) => (x ? `${x.ok ? "OK" : "FEHLER"} ${x.status} ${x.reason ? "– " + x.reason : ""} (${x.at})` : "–");
  console.log(`\nGerät ${i + 1}: Push-Dienst ${host}`);
  console.log(`  Zeitzone ${r.tz}, Erinnerung ${r.notifyTime}, aktiv: ${r.enabled}, Aufgaben: ${(r.tasks || []).length}, heute fällig: ${due}`);
  console.log(`  Zuletzt abgeglichen: ${r.updatedAt || "–"}, bereits gemeldet: ${Object.keys(r.notified || {}).length}`);
  console.log(`  Letzter Test: ${fmt(r.lastTest)}`);
  console.log(`  Letzte Erinnerung: ${fmt(r.lastPush)}`);
}
