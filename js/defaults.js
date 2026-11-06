// Standard-Aufgaben mit empfohlenen Intervallen.
// Die Werte sind Richtwerte aus Haushalts-Ratgebern (Vorwerk, Migros, Utopia,
// EnBW, Hornbach, Beko u. a.) und lassen sich in der App pro Aufgabe anpassen.
// unit: "days" | "weeks" | "months" | "years" | "season" (months = [1..12]) | "once" (date)
// kids: true = Kinderaufgabe (für „Aufgaben & Taschengeld“), points = Punkte dafür

export const DEFAULT_TASKS = [
  // Ganze Wohnung
  { name: "Staubsaugen", room: "Wohnung", every: 1, unit: "weeks" },
  { name: "Böden wischen", room: "Wohnung", every: 1, unit: "weeks" },
  { name: "Staub wischen", room: "Wohnung", every: 1, unit: "weeks" },
  { name: "Türklinken & Lichtschalter abwischen", room: "Wohnung", every: 2, unit: "weeks" },
  { name: "Polstermöbel absaugen", room: "Wohnung", every: 1, unit: "months" },
  { name: "Fenster putzen", room: "Wohnung", every: 3, unit: "months" },
  { name: "Heizkörper reinigen", room: "Wohnung", every: 6, unit: "months" },
  { name: "Gardinen waschen", room: "Wohnung", every: 6, unit: "months" },
  { name: "Teppich grundreinigen", room: "Wohnung", every: 1, unit: "years" },

  // Küche
  { name: "Mikrowelle reinigen", room: "Küche", every: 2, unit: "weeks" },
  { name: "Mülleimer auswaschen", room: "Küche", every: 1, unit: "months" },
  { name: "Kühlschrank reinigen", room: "Küche", every: 1, unit: "months" },
  { name: "Spülmaschine reinigen (Sieb & Dichtung)", room: "Küche", every: 1, unit: "months" },
  { name: "Wasserkocher entkalken", room: "Küche", every: 1, unit: "months" },
  { name: "Kaffeemaschine entkalken", room: "Küche", every: 1, unit: "months" },
  { name: "Dunstabzugshaube: Fettfilter reinigen", room: "Küche", every: 2, unit: "months" },
  { name: "Backofen reinigen", room: "Küche", every: 3, unit: "months" },
  { name: "Küchenschränke auswischen", room: "Küche", every: 3, unit: "months" },
  { name: "Gefrierfach abtauen", room: "Küche", every: 6, unit: "months" },

  // Bad
  { name: "Bad putzen (WC, Waschbecken, Dusche)", room: "Bad", every: 1, unit: "weeks" },
  { name: "Handtücher wechseln", room: "Bad", every: 1, unit: "weeks" },
  { name: "Abflüsse reinigen", room: "Bad", every: 1, unit: "months" },
  { name: "Duschkopf entkalken", room: "Bad", every: 2, unit: "months" },
  { name: "Fugen reinigen", room: "Bad", every: 3, unit: "months" },
  { name: "Waschmaschine reinigen (Trommel, Dichtung, Fach)", room: "Bad", every: 1, unit: "months" },
  { name: "Waschmaschine: Flusensieb reinigen", room: "Bad", every: 3, unit: "months" },

  // Schlafzimmer
  { name: "Bettwäsche wechseln", room: "Schlafzimmer", every: 2, unit: "weeks" },
  { name: "Matratze absaugen & wenden", room: "Schlafzimmer", every: 3, unit: "months" },
  { name: "Kopfkissen & Bettdecke waschen", room: "Schlafzimmer", every: 6, unit: "months" },

  // Geräte & Wartung
  { name: "Rauchmelder testen", room: "Geräte & Wartung", every: 1, unit: "years" },
  { name: "Dunstabzugshaube: Aktivkohlefilter wechseln", room: "Geräte & Wartung", every: 6, unit: "months", note: "Nur bei Umluft-Hauben." },
  { name: "Staubsauger: Filter reinigen oder wechseln", room: "Geräte & Wartung", every: 3, unit: "months" },
  { name: "Wasserfilter-Kartusche wechseln", room: "Geräte & Wartung", every: 4, unit: "weeks", note: "Z. B. Tischwasserfilter oder Kaffeevollautomat." },
  { name: "Spülmaschine: Salz & Klarspüler prüfen", room: "Geräte & Wartung", every: 1, unit: "months" },
  { name: "Kühlschrank: Rückseite & Lüftungsgitter abstauben", room: "Geräte & Wartung", every: 1, unit: "years", note: "Spart Strom." },
  { name: "Lüftungsgitter & Ventilatoren im Bad reinigen", room: "Geräte & Wartung", every: 6, unit: "months" },

  // Saisonal (jedes Jahr im passenden Monat)
  { name: "Balkon/Terrasse: Frühjahrsputz", room: "Draußen", unit: "season", months: [3] },
  { name: "Rollläden & Fensterrahmen reinigen", room: "Wohnung", unit: "season", months: [4] },
  { name: "Grill reinigen", room: "Draußen", unit: "season", months: [4] },
  { name: "Ventilator reinigen", room: "Wohnung", unit: "season", months: [6] },
  { name: "Heizkörper entlüften", room: "Wohnung", unit: "season", months: [10] },
  { name: "Gartenmöbel einwintern", room: "Draußen", unit: "season", months: [10] },
  { name: "Dachrinne & Abflüsse draußen von Laub befreien", room: "Draußen", unit: "season", months: [11] },

  // Für Kinder (erscheinen später auch in „Aufgaben & Taschengeld“)
  { name: "Zimmer aufräumen", room: "Kinderzimmer", every: 1, unit: "weeks", kids: true, points: 5 },
  { name: "Spülmaschine ausräumen", room: "Küche", every: 2, unit: "days", kids: true, points: 2 },
  { name: "Müll rausbringen", room: "Küche", every: 3, unit: "days", kids: true, points: 2 },
];
