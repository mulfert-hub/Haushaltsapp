// Einstellungen für die Auslieferung. Beim Bauen (npm run build) werden die Werte
// aus Umgebungsvariablen übernommen, falls gesetzt (siehe scripts/build.mjs).
export const CONFIG = {
  // Adresse des Push-Servers (Cloudflare Worker), z. B. "https://haushalt-push.<name>.workers.dev"
  pushServerUrl: "",
  // Adresse der Familien-App für den Zurück-Knopf (wird vom Family-Dashboard gesetzt)
  familieUrl: "",
};
