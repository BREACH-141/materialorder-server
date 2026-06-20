# MaterialOrder server

This is the real backend for the MaterialOrder app. It sends genuine stock-check
emails to suppliers via Resend, and gives each supplier a one-tap link (no
account, no login) to confirm whether items are in stock — no email parsing,
no guessing.

## What this does, honestly

- Sends a real email to each supplier with the exact items/quantities you need.
- The email contains a unique link. The supplier clicks it, taps one of three
  buttons (in stock / partial / unavailable), optionally adds a note, and
  that's recorded.
- The MaterialOrder app polls this server and shows you replies as they come in.

## What this does NOT do

- It does not check live stock automatically. No UK builders' merchant
  publishes a public stock API, so there is no way to query stock without
  asking a human at the merchant — this is the most honest, reliable version
  of "automated" that's actually possible right now.
- It does not parse email replies. If a supplier just hits reply on the email
  instead of clicking the link, that reply goes to whatever inbox FROM_EMAIL
  points at, not back into the app. The link is the mechanism that works.

## Setup

1. **Install dependencies**
   ```
   npm install
   ```

2. **Get a free Resend API key**
   Sign up at https://resend.com (free tier is enough to start). Go to
   API Keys → Create API Key, and copy it.

3. **Configure environment variables**
   ```
   cp .env.example .env
   ```
   Open `.env` and set `RESEND_API_KEY` to the key you just copied.

4. **Important: verify your own domain before emailing real suppliers**
   Resend's shared test address (`onboarding@resend.dev`) can only deliver to
   the email you signed up to Resend with. It cannot email real, arbitrary
   supplier addresses. To actually send to suppliers:
   - In the Resend dashboard, go to Domains → Add Domain
   - Add the DNS records they give you to your domain's DNS settings
   - Once verified, set `FROM_EMAIL` in `.env` to an address on that domain,
     e.g. `orders@yourdomain.com`
   This step needs you to own a domain. If you don't have one yet, you can
   still fully test the flow using your own Resend-registered email address
   as the "supplier" email when testing.

5. **Run it**
   ```
   npm start
   ```
   The server starts on port 3001 by default (`http://localhost:3001`).

6. **Deploy it somewhere reachable from the internet**
   Suppliers need to be able to click the reply link in their email, which
   means this server can't just run on your laptop — `localhost` only works
   on the machine it's running on. Deploy it to something like Render,
   Railway, Fly.io, or a small VPS, then:
   - Set `PUBLIC_BASE_URL` in `.env` to your real deployed URL
   - Update `API_BASE_URL` at the top of the frontend app file
     (`materialorder-app.html`) to match

## Endpoints

- `GET  /api/health` — confirms the server is running and email is configured
- `POST /api/stock-check` — sends stock-check emails for an order
- `GET  /api/orders/:orderNumber` — current status of an order's supplier replies
- `GET  /reply/:token` — the page a supplier sees when they click the email link
- `POST /api/reply/:token` — records a supplier's reply

## Storage

Order and reply data is stored in `data/orders.json`, a plain file on disk.
This is fine for personal use or a small prototype. If this ever needs to
handle multiple concurrent users reliably, swap this for a real database
(Postgres, SQLite, etc.) before relying on it.
