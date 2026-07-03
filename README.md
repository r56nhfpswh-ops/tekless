# Phone Breach Checker

A small local web app: type in a phone number, it checks that number against
data-breach lookup services and shows what it found.

## Reality check

There is no free, keyless way to do this responsibly. Every service below
requires you to sign up and use your own paid API key — this app never talks
to a service you haven't configured.

| Service | Phone support | Notes |
|---|---|---|
| [Have I Been Pwned](https://haveibeenpwned.com/API/Key) | Weak | API accepts phone numbers for legacy reasons, but almost no breaches actually include phone data. Treat a "clean" result here with a grain of salt. |
| [LeakCheck](https://wiki.leakcheck.io/en/api) | Good | Phone-type queries need a paid plan. |
| [DeHashed](https://dehashed.com/api) | Good | Requires paid API credits. |

Leave any key blank in `.env` and that provider is skipped (shown as "not
configured") instead of erroring.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and add whichever API keys you have
npm start
```

Then open http://localhost:3000, enter a phone number (with country code, or
pick a country from the dropdown), and click Check.

## How it works

- `server/lib/phone.js` normalizes whatever you type into E.164 using
  `libphonenumber-js`.
- `server/providers/*.js` each wrap one breach-lookup API. They're
  independent, so adding another service (or removing one you don't use) is
  just adding/removing a file and listing it in `server/providers/index.js`.
- `server/index.js` runs all configured providers in parallel and returns a
  per-provider status: `breached`, `clean`, `error`, or `not_configured`.
- The frontend (`public/`) is a single static page with no build step.

## Security notes

- API keys live only in `.env` (git-ignored) and are used server-side; they
  are never sent to the browser.
- The phone number you check is sent only to providers you've configured —
  check each service's own privacy policy before querying real numbers.
