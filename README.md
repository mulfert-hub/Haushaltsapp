# Haushaltsplan

Kleine Web-App (PWA) für wiederkehrende Haushaltsaufgaben wie Teppich reinigen,
Ofen säubern oder Fenster putzen.

- **Aufgabenliste zum Abhaken:** Oben steht „Jetzt dran“, darunter „Nächste 7 Tage“ und „Später“.
- **Timer:** Nach dem Abhaken startet der Countdown bis zur nächsten Wiederholung neu
  (Balken und Restzeit, z. B. „in 3 Wochen“). Ein Versehen lässt sich direkt rückgängig machen.
- **Erinnerungen:** Ist eine Aufgabe wieder dran, kommt zur eingestellten Uhrzeit eine Mitteilung
  (mehrere fällige Aufgaben werden zu einer Mitteilung zusammengefasst).
- **Anpassbar:** Aufgaben anlegen, bearbeiten und löschen, Intervall in Tagen, Wochen, Monaten oder Jahren,
  Datum „zuletzt erledigt“, Notiz, Verlauf, Filter nach Bereich.
- **Offline & privat:** Alle Daten bleiben auf dem Gerät (localStorage). Es gibt keinen Server und kein Konto.
  Über „Sicherung exportieren/importieren“ lassen sich die Daten auf ein anderes Gerät übertragen.

## Standard-Intervalle

Die vorbelegten Intervalle sind Richtwerte aus Haushalts-Ratgebern (u. a. Vorwerk, Migros,
Utopia, EnBW, Hornbach, Beko) und stehen in `js/defaults.js`. Beispiele:

| Aufgabe | Intervall |
|---|---|
| Staubsaugen, Böden wischen, Bad putzen | jede Woche |
| Bettwäsche wechseln | alle 2 Wochen |
| Kühlschrank, Wasserkocher, Waschmaschine reinigen | jeden Monat |
| Dunstabzugshaube (Fettfilter), Duschkopf entkalken | alle 2 Monate |
| Backofen, Fenster, Matratze, Flusensieb | alle 3 Monate |
| Gardinen, Heizkörper, Gefrierfach abtauen | alle 6 Monate |
| Teppich grundreinigen, Rauchmelder testen | jedes Jahr |

## Installation

Die App läuft in der Familien-App **„Familie Ulfert“** unter `…/Family-Dashboard-/haushalt/`
(siehe [Family-Dashboard-](https://github.com/mulfert-hub/Family-Dashboard-)). Dort wird sie bei jedem
Veröffentlichen mit `npm ci && npm run build` aus dem Branch `main` dieses Repositorys gebaut.

Sie läuft aber auch für sich, z. B. über GitHub Pages oder lokal: `python3 -m http.server` im Projektordner,
dann `http://localhost:8000` öffnen.

**iPhone/iPad:** Die App (bzw. die Familien-App) in Safari über *Teilen → Zum Home-Bildschirm* installieren und
vom Home-Bildschirm öffnen. Erst dann erlaubt iOS Mitteilungen.

**Android:** In Chrome über das Menü *App installieren* wählen.

> Jede installierte App hat ihren eigenen Speicher. Wer den Haushaltsplan vorher einzeln benutzt hat:
> dort unter *Einstellungen → Sicherung exportieren* und in der Familien-App wieder importieren.

## Push-Server

Damit Erinnerungen auch bei **geschlossener App** kommen (auch auf dem iPhone), gibt es in `server/` einen kleinen
Server als **Cloudflare Worker** (kostenloser Tarif reicht, keine Wartung):

- Die App meldet das Gerät an und schickt bei jeder Änderung die Fälligkeitstermine (Name, Bereich, Datum).
- Alle 15 Minuten prüft der Server, ob zur eingestellten Uhrzeit (in der Zeitzone des Geräts) etwas fällig ist,
  und sendet dann eine Web-Push-Mitteilung. Jeder Termin wird nur einmal gemeldet.
- Die Schlüssel für Web Push (VAPID) erzeugt der Server beim ersten Start selbst und speichert sie.
- Nur die eigene Seite (`https://mulfert-hub.github.io`) darf den Server benutzen (`ALLOWED_ORIGINS` in `server/wrangler.toml`).
  Maximal 50 Geräte.

### Einrichten (einmalig, etwa 10 Minuten)

1. Kostenloses Konto auf [cloudflare.com](https://dash.cloudflare.com/sign-up) anlegen.
2. **API-Token:** *My Profile → API Tokens → Create Token → Vorlage „Edit Cloudflare Workers“* → erstellen und kopieren.
3. **Account-ID:** im Cloudflare-Dashboard unter *Workers & Pages* (rechte Spalte) kopieren.
4. In diesem GitHub-Repository unter *Settings → Secrets and variables → Actions* zwei Secrets anlegen:
   `CLOUDFLARE_API_TOKEN` und `CLOUDFLARE_ACCOUNT_ID`.
5. *Actions → „Push-Server veröffentlichen“ → Run workflow*. Der Workflow legt den Speicher an und veröffentlicht den Worker.
   Die Adresse steht am Ende des Logs, z. B. `https://haushalt-push.<name>.workers.dev`.
6. Diese Adresse in `js/config.js` bei `pushServerUrl` eintragen (erledigt: `https://haushalt-push.mulfert.workers.dev`).
7. In der App *Einstellungen → Test-Mitteilung* tippen. Kommt „Push-Mitteilungen über den Server funktionieren“, ist alles fertig.

Ohne Push-Server funktioniert die App weiter: Dann erinnert sie, solange sie läuft (Android zusätzlich per
*Periodic Background Sync*), und es gibt den **Kalender-Export (.ics)** als Rückfalllösung.

### Entwicklung des Servers

```bash
cd server
npm install
npm test                 # Verschlüsselung, VAPID, Zeitplan, API
npx wrangler dev --test-scheduled   # lokal; Zeitplan auslösen: curl "localhost:8787/__scheduled"
```

## Aufbau

```
index.html            Oberfläche
js/config.js          Adresse des Push-Servers, Zurück-Knopf zur Familien-App
scripts/build.mjs     npm run build → dist/ (für das Family-Dashboard)
server/               Push-Server (Cloudflare Worker) mit Tests
tests/                Tests der Terminlogik (npm test)
css/styles.css        Gestaltung (hell/dunkel)
js/app.js             App-Logik, Speicherung, Mitteilungen, Export
js/schedule.js        Termin-Berechnung (gemeinsam für App und Service Worker)
js/defaults.js        Standard-Aufgaben mit Intervallen
sw.js                 Service Worker (offline, Hintergrund-Prüfung, Klick auf Mitteilung)
manifest.webmanifest  PWA-Manifest
icons/                App-Icons
```
