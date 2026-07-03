import { fetchJson } from "../lib/http.js";

// Docs: https://dehashed.com/api (v2 REST API, requires paid credits).
export const dehashed = {
  id: "dehashed",
  name: "DeHashed",
  isConfigured: () => Boolean(process.env.DEHASHED_API_KEY),

  async check(phone) {
    const { ok, status, body } = await fetchJson(
      "https://api.dehashed.com/v2/search",
      {
        method: "POST",
        headers: {
          "Dehashed-Api-Key": process.env.DEHASHED_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          query: `phone_number:"${phone.e164}"`,
          size: 25,
          page: 1,
        }),
      }
    );

    if (status === 401 || status === 403) {
      return { status: "error", error: "Invalid or missing DeHashed API key." };
    }
    if (!ok) {
      return { status: "error", error: `DeHashed returned HTTP ${status}` };
    }

    const entries = (body && body.entries) || [];
    return {
      status: entries.length > 0 ? "breached" : "clean",
      breaches: entries.map((e) => ({
        name: e.database_name || "Unknown source",
        date: e.breach_date,
        details: [e.email, e.username].filter(Boolean).join(", ") || undefined,
      })),
    };
  },
};
