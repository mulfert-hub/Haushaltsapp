// Baut die App nach dist/ – so kann das Family-Dashboard sie einbinden (npm ci && npm run build).
// Die App nutzt nur relative Adressen und läuft daher unter jedem Pfad (BASE_PATH).
//
// Umgebungsvariablen (alle optional):
//   HAUSHALT_PUSH_URL  Adresse des Push-Servers (überschreibt js/config.js)
//   VITE_FAMILIE_URL   Adresse der Familien-App für den Zurück-Knopf (setzt das Family-Dashboard)
//   BASE_PATH          wird nur angezeigt; die App braucht ihn dank relativer Adressen nicht
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const dist = join(root, "dist");
const { CONFIG } = await import(pathToFileURL(join(root, "js/config.js")).href);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const p of ["index.html", "sw.js", "manifest.webmanifest", "css", "js", "icons"]) {
  cpSync(join(root, p), join(dist, p), { recursive: true });
}

const config = {
  pushServerUrl: process.env.HAUSHALT_PUSH_URL ?? CONFIG.pushServerUrl,
  familieUrl: process.env.VITE_FAMILIE_URL ?? CONFIG.familieUrl,
};
writeFileSync(join(dist, "js/config.js"),
  `// Beim Bauen erzeugt (scripts/build.mjs)\nexport const CONFIG = ${JSON.stringify(config, null, 2)};\n`);

// Neue Version des Service Workers bei jedem Build, damit Geräte das Update sicher bekommen.
const version = (process.env.GITHUB_SHA || String(Date.now())).slice(0, 8);
const swPath = join(dist, "sw.js");
writeFileSync(swPath, readFileSync(swPath, "utf8").replace(/const VERSION = "[^"]*";/, `const VERSION = "${version}";`));

// Versionsnummer an alle Dateien hängen: So lädt ein Gerät nie alte und neue Dateien gemischt.
const edit = (file, fn) => { const p = join(dist, file); writeFileSync(p, fn(readFileSync(p, "utf8"))); };
const v = `?v=${version}`;
edit("index.html", (s) => s
  .replace(/(href|src)="(css\/styles\.css|js\/schedule\.js|js\/app\.js|manifest\.webmanifest)"/g, `$1="$2${v}"`));
edit("js/app.js", (s) => s.replace(/from "\.\/(defaults|config)\.js"/g, `from "./$1.js${v}"`));

console.log(`✓ Haushaltsplan gebaut nach dist/ (Pfad: ${process.env.BASE_PATH ?? "/"}, Push: ${config.pushServerUrl || "–"}, Familie: ${config.familieUrl || "–"})`);
