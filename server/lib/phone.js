import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Normalizes user input into the handful of formats different breach
 * databases expect (E.164 with/without the leading "+", digits only).
 */
export function normalizePhone(raw, defaultCountry) {
  const phoneNumber = parsePhoneNumberFromString(raw, defaultCountry || "US");

  if (!phoneNumber || !phoneNumber.isValid()) {
    return { valid: false };
  }

  const e164 = phoneNumber.number; // e.g. "+14155552671"

  return {
    valid: true,
    e164,
    noPlus: e164.replace("+", ""),
    digitsOnly: e164.replace(/\D/g, ""),
    country: phoneNumber.country,
  };
}
