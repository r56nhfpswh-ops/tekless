import { fetchJson } from "../lib/http.js";

// Docs: https://haveibeenpwned.com/API/Key
// The API historically accepted phone numbers as an "account" identifier
// (same endpoint as email), but only a handful of old breaches carry phone
// data, so a "clean" result here means little on its own.
export const hibp = {
  id: "hibp",
  name: "Have I Been Pwned",
  isConfigured: () => Boolean(process.env.HIBP_API_KEY),

  async check(phone) {
    const account = encodeURIComponent(phone.e164);
    const { ok, status, body } = await fetchJson(
      `https://haveibeenpwned.com/api/v3/breachedaccount/${account}?truncateResponse=false`,
      {
        headers: {
          "hibp-api-key": process.env.HIBP_API_KEY,
          "user-agent": "tekless-phone-breach-checker",
        },
      }
    );

    if (status === 404) {
      return { status: "clean", breaches: [] };
    }
    if (status === 401) {
      return { status: "error", error: "Invalid or missing HIBP API key." };
    }
    if (status === 429) {
      return { status: "error", error: "Rate limited by HIBP, try again shortly." };
    }
    if (!ok) {
      return { status: "error", error: `HIBP returned HTTP ${status}` };
    }

    const breaches = Array.isArray(body) ? body : [];
    return {
      status: breaches.length > 0 ? "breached" : "clean",
      breaches: breaches.map((b) => ({
        name: b.Title || b.Name,
        date: b.BreachDate,
        details: b.Description,
      })),
    };
  },
};
