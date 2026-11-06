// Standard-Aufgaben mit empfohlenen Intervallen.
// Die Werte sind Richtwerte aus Haushalts-Ratgebern (Vorwerk, Migros, Utopia,
// EnBW, Hornbach, Beko u. a.) und lassen sich in der App pro Aufgabe anpassen.
// unit: "days" | "weeks" | "months" | "years"

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
  { name: "Rauchmelder testen", room: "Wohnung", every: 1, unit: "years" },

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
];
