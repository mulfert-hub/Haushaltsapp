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

Die App muss über **HTTPS** ausgeliefert werden, zum Beispiel kostenlos mit GitHub Pages:

1. Den Branch nach `main` mergen.
2. Im Repository unter **Settings → Pages** bei „Build and deployment“ die Option *Deploy from a branch*,
   den Branch `main` und den Ordner `/ (root)` wählen.
3. Die angezeigte Adresse (`https://<name>.github.io/haushaltsapp/`) auf dem Handy öffnen.

**iPhone/iPad:** In Safari auf *Teilen → Zum Home-Bildschirm* tippen und die App vom Home-Bildschirm
öffnen. Erst dann erlaubt iOS Mitteilungen. Danach auf „Mitteilungen erlauben“ tippen.

**Android:** In Chrome über das Menü *App installieren* wählen und Mitteilungen erlauben.

Lokal testen: `python3 -m http.server` im Projektordner und `http://localhost:8000` öffnen.

## Wichtig: Wann kommen die Mitteilungen?

Ohne eigenen Push-Server kann eine Web-App nicht auf allen Geräten zuverlässig im Hintergrund wecken:

| Gerät | Verhalten |
|---|---|
| Android (Chrome, installiert) | Prüft per *Periodic Background Sync* auch bei geschlossener App, etwa stündlich bis täglich (das Intervall bestimmt Chrome). |
| iPhone/iPad, Desktop | Die Prüfung läuft, solange die App geöffnet ist oder im Hintergrund läuft, und bei jedem Öffnen. |

Für garantierte Erinnerungen auf jedem Gerät gibt es unter **Einstellungen → Kalender-Erinnerungen (.ics)**
eine Kalenderdatei. Sie enthält alle Aufgaben als Serientermine mit Alarm und lässt sich in den
iPhone- oder Google-Kalender importieren. Wer Aufgaben früher oder später erledigt, sollte die Datei
gelegentlich neu exportieren.

Echter Hintergrund-Push wäre mit einem kleinen Server (Web Push/VAPID) möglich. Der Service Worker
reagiert bereits auf `push`-Ereignisse.

## Aufbau

```
index.html            Oberfläche
css/styles.css        Gestaltung (hell/dunkel)
js/app.js             App-Logik, Speicherung, Mitteilungen, Export
js/schedule.js        Termin-Berechnung (gemeinsam für App und Service Worker)
js/defaults.js        Standard-Aufgaben mit Intervallen
sw.js                 Service Worker (offline, Hintergrund-Prüfung, Klick auf Mitteilung)
manifest.webmanifest  PWA-Manifest
icons/                App-Icons
```
