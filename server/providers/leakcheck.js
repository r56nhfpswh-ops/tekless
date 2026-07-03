import { fetchJson } from "../lib/http.js";

// Docs: https://wiki.leakcheck.io/en/api/api-v2-pro
// Phone-type lookups require a paid plan; the free public API only supports
// email/hash queries.
export const leakcheck = {
  id: "leakcheck",
  name: "LeakCheck",
  isConfigured: () => Boolean(process.env.LEAKCHECK_API_KEY),

  async check(phone) {
    const value = encodeURIComponent(phone.digitsOnly);
    const { ok, status, body } = await fetchJson(
      `https://leakcheck.io/api/v2/query/${value}?type=phone`,
      {
        headers: {
          "X-API-Key": process.env.LEAKCHECK_API_KEY,
        },
      }
    );

    if (status === 404) {
      return { status: "clean", breaches: [] };
    }
    if (status === 401 || status === 403) {
      return { status: "error", error: "Invalid or missing LeakCheck API key." };
    }
    if (!ok) {
      return { status: "error", error: `LeakCheck returned HTTP ${status}` };
    }
    if (body && body.success === false) {
      return { status: "error", error: body.error || "LeakCheck query failed." };
    }

    const results = (body && body.result) || [];
    return {
      status: results.length > 0 ? "breached" : "clean",
      breaches: results.map((r) => ({
        name: r.source?.name || r.source || "Unknown source",
        date: r.source?.breach_date || r.date,
        details: [r.email, r.username, r.name].filter(Boolean).join(", ") || undefined,
      })),
    };
  },
};
