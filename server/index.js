import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePhone } from "./lib/phone.js";
import { providers } from "./providers/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/providers", (_req, res) => {
  res.json(
    providers.map((p) => ({ id: p.id, name: p.name, configured: p.isConfigured() }))
  );
});

app.post("/api/check", async (req, res) => {
  const { phone: rawPhone, country } = req.body || {};

  if (!rawPhone || typeof rawPhone !== "string") {
    return res.status(400).json({ error: "Provide a phone number." });
  }

  const phone = normalizePhone(rawPhone, country);
  if (!phone.valid) {
    return res.status(400).json({
      error: "That doesn't look like a valid phone number. Include a country code (e.g. +1 415 555 2671) or pick a country.",
    });
  }

  const results = await Promise.all(
    providers.map(async (provider) => {
      if (!provider.isConfigured()) {
        return { id: provider.id, name: provider.name, status: "not_configured" };
      }
      try {
        const result = await provider.check(phone);
        return { id: provider.id, name: provider.name, ...result };
      } catch (err) {
        return {
          id: provider.id,
          name: provider.name,
          status: "error",
          error: err.message || "Request failed.",
        };
      }
    })
  );

  res.json({ phone: phone.e164, results });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Phone breach checker running at http://localhost:${port}`);
});
