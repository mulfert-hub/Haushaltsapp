# Haushaltsplan

Kleine Web-App (PWA) für wiederkehrende Haushaltsaufgaben wie Teppich reinigen,
Ofen säubern oder Fenster putzen – Teil der Familien-App „Familie Ulfert“.

- **Aufgabenliste zum Abhaken:** „Jetzt dran“, „Nächste 7 Tage“, „Später“. Nach dem Abhaken startet der Timer neu.
- **Wochenansicht:** Was an welchem Tag dran ist, Woche für Woche. „Große Aufgaben verteilen“ legt Fenster, Backofen & Co.
  auf die bevorzugten Putztage (Standard: Samstag, höchstens 2 pro Tag), damit nicht alles auf einmal kommt.
- **Gemeinsame Liste:** Alle Geräte der Familie sehen dieselben Aufgaben. Was einer abhakt, ist bei allen erledigt.
  Einladen über *Einstellungen → Gemeinsame Liste → Familie einladen*, auf dem anderen Gerät *Beitreten* und Code eingeben.
- **Erinnerungen per Push**, auch bei geschlossener App (über den Server in `server/`).
- **Arten von Aufgaben:** regelmäßig (alle X Tage/Wochen/Monate/Jahre), **saisonal** (jedes Jahr im Oktober …) und
  **einmalig** (z. B. Garantie-Ende einer Waschmaschine).
- **Geräte & Wartung:** Filter, Kartuschen, Rauchmelder & Co. als eigener Bereich.
- **Kinderaufgaben** mit Punkten – vorbereitet für die App „Aufgaben & Taschengeld“ (siehe Schnittstelle unten).
- **Offline:** Die App läuft ohne Netz weiter und gleicht ab, sobald wieder Verbindung besteht.

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
| Heizkörper entlüften, Gartenmöbel einwintern | jedes Jahr im Oktober |
| Dachrinne von Laub befreien | jedes Jahr im November |
| Rollläden reinigen, Grill reinigen | jedes Jahr im April |
| Wasserfilter-Kartusche wechseln | alle 4 Wochen |
| Staubsauger-Filter | alle 3 Monate |

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

## Server

Der Server (`server/`, Cloudflare Worker) speichert die gemeinsame Liste und verschickt die Erinnerungen.

- **Gemeinsame Liste:** Ein Haushalt wird über einen geheimen Code angesprochen (gespeichert wird nur ein Hash).
  Ändern zwei Geräte gleichzeitig, gewinnt je Aufgabe der neueste Stand – getrennt nach Angaben (Name, Intervall …)
  und Terminen (erledigt, geplant). So geht ein Abhaken nicht verloren, wenn jemand anderes den Namen ändert.
- **Erinnerungen:** Alle 15 Minuten prüft der Server je Gerät, ob zur eingestellten Uhrzeit (in der Zeitzone des Geräts)
  etwas fällig ist, und sendet dann eine Web-Push-Mitteilung. Jeder Termin wird nur einmal gemeldet. Die Termine
  rechnet er mit derselben Logik wie die App (`js/schedule.js`).
- **iPhone:** iOS weckt bei Push nur den Service Worker der installierten App. Liegt Haushalt in der Familien-App,
  meldet sich die App deshalb über deren Service Worker an (`familie-push.js` im Family-Dashboard).
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

### Schnittstelle für „Aufgaben & Taschengeld“

Kinderaufgaben (in der App: *Kinderaufgabe* ankreuzen, Punkte vergeben) kann eine andere App der Familie lesen und abhaken:

```http
GET  /api/household/kids?tz=Europe/Berlin
X-Household-Code: XXXX-XXXX-XXXX-XXXX-XXXX
→ { "tasks": [ { "id", "name", "room", "points", "note", "due": "2026-11-08", "dueNow": false, "lastDone", "lastDoneBy" } ] }

POST /api/household/complete
{ "code": "XXXX-…", "taskId": "…", "by": "Name des Kindes" }
→ { "ok": true, "task": { … } }
```

Das Abhaken landet sofort in der gemeinsamen Liste (mit `lastDoneBy`), der Timer startet neu.

### Diagnose

*Actions → „Push-Server Diagnose“ → Run workflow* zeigt je Gerät Push-Dienst, Erinnerungszeit, letzten Abgleich und
was der Push-Dienst auf Test und Erinnerung geantwortet hat – ohne Adressen, Schlüssel oder Aufgabennamen.

### Entwicklung des Servers

```bash
cd server
npm install
npm test                 # Verschlüsselung, VAPID, Zeitplan, gemeinsame Liste, API
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
