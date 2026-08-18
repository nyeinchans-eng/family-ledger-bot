# Family Ledger Bot

A Telegram bot for the family group chat: send a receipt photo or type an
expense in plain language, and it gets parsed and logged to Postgres.
Runs alongside the dashboard artifact if you point both at the same database.

## 1. Create the Telegram bot
1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow the
   prompts → copy the token it gives you.
2. Add the bot to your family group and give it permission to read messages
   (BotFather → your bot → Group Privacy → turn **off**, so it sees every
   message, not just commands).

## 2. Get an Anthropic API key
Go to console.anthropic.com → API Keys → create one. This is billed
separately, pay-as-you-go, from your claude.ai subscription — a few cents
per receipt scanned.

## 3. Set up DigitalOcean
1. **Database**: Create a Managed Database → PostgreSQL (the cheapest tier
   is plenty for this). Copy the connection string from
   *Connection Details* (use the one with `sslmode=require`).
2. **App**: Push this folder to a GitHub repo, then in DigitalOcean go to
   **App Platform → Create App → GitHub** and select the repo. It will
   detect Node.js automatically.
3. In the App's **Settings → Environment Variables**, add everything from
   `.env.example`:
   - `TELEGRAM_BOT_TOKEN`
   - `ANTHROPIC_API_KEY`
   - `DATABASE_URL` (from step 1)
   - `WEBHOOK_SECRET` (make one up, e.g. `openssl rand -hex 20`)
   - `PUBLIC_URL` — leave blank on first deploy, DigitalOcean will show you
     the app's URL (like `https://family-ledger-bot-xxxxx.ondigitalocean.app`)
     once it's live — then add it here and redeploy.
   - `DEFAULT_CURRENCY` (e.g. `MMK`)
4. Deploy. On first boot the app registers itself as the Telegram webhook
   automatically — no manual curl commands needed.

## 4. Apply the database schema
Run once, from your own machine, pointed at the DigitalOcean database:
```bash
npm install
DATABASE_URL="<your connection string>" npm run migrate
```

## 5. Try it
In the family group, send a receipt photo, or type something like
`12000 kyats grab to airport`. The bot replies with what it logged.
`/summary` gives this month's running total.

## Connecting the dashboard artifact
This server now exposes a REST API the dashboard uses directly:
`GET/POST /expenses`, `PUT/DELETE /expenses/:id`, `GET/PUT /settings`.
All of it requires the `x-api-token` header to match `API_TOKEN`.

To connect the artifact:
1. Deploy this server (steps above) and note its public URL.
2. Open the dashboard artifact's code, find these two lines near the top:
   ```js
   const API_BASE_URL = "";
   const API_TOKEN = "";
   ```
3. Fill in `API_BASE_URL` with the app's URL (no trailing slash) and
   `API_TOKEN` with the same value you set in the server's env vars.
4. Re-share the artifact.

From then on, entries logged by the bot in Telegram and entries added from
the dashboard both read and write the same `expenses` table.

## Notes
- Every message in the group is sent to Claude for a quick check ("is this
  an expense?"). Ordinary chit-chat is silently ignored — the bot only
  replies when it actually logs something.
- The bot never edits or deletes entries from Telegram by design; do
  corrections from the dashboard once it's connected to the same database.
