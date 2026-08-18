import "dotenv/config";
import express from "express";
import cors from "cors";
import { Telegraf } from "telegraf";
import pg from "pg";

const {
  TELEGRAM_BOT_TOKEN,
  ANTHROPIC_API_KEY,
  DATABASE_URL,
  PUBLIC_URL,
  WEBHOOK_SECRET,
  API_TOKEN,
  DEFAULT_CURRENCY = "MMK",
  PORT = 8080,
} = process.env;

for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, DATABASE_URL, PUBLIC_URL, WEBHOOK_SECRET, API_TOKEN })) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}

const CATEGORIES = [
  "Food & Groceries", "Dining Out", "Transport", "Utilities",
  "Household", "Health", "Education", "Shopping",
  "Entertainment", "Travel", "Other",
];

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(cors());

// Simple shared-secret check for the REST API used by the dashboard artifact.
// Note: this token lives in the artifact's client-side code, so it deters
// casual access but isn't real security — don't put sensitive data behind it
// beyond what you're comfortable being visible to anyone with the artifact link.
function requireApiToken(req, res, next) {
  if (req.header("x-api-token") !== API_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

// ---------- Claude API helpers ----------
async function callClaude({ system, content }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      system,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text in Claude response");
  return JSON.parse(textBlock.text.replace(/```json|```/g, "").trim());
}

async function extractFromReceipt(base64, mediaType, caption) {
  const system = `You read a photo of a purchase receipt from a family expense-tracking Telegram bot. Output ONLY a JSON object, no prose:
{"merchant": string|null, "date": "YYYY-MM-DD"|null, "amount": number|null, "currency": "MMK"|"USD"|"SGD"|"THB"|null, "category": one of ${JSON.stringify(CATEGORIES)}, "note": string|null}
amount is the final total paid, numeric only. If a caption is provided alongside the photo, use it as extra context (e.g. who it's for). If unreadable, use null for that field.`;
  const content = [
    { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
    { type: "text", text: caption ? `Caption: "${caption}". Extract the receipt as the specified JSON object.` : "Extract the receipt as the specified JSON object." },
  ];
  return callClaude({ system, content });
}

async function extractFromText(message) {
  const system = `You read one message from a family expense-tracking Telegram group chat. Decide if it describes a specific expense worth logging (e.g. "12000 kyats grab to airport", "paid 5$ for lunch"). Casual chat, questions, greetings, or replies with no amount are NOT expenses. Output ONLY JSON:
{"is_expense": boolean, "merchant": string|null, "date": "YYYY-MM-DD"|null, "amount": number|null, "currency": "MMK"|"USD"|"SGD"|"THB"|null, "category": one of ${JSON.stringify(CATEGORIES)}, "note": string|null}
If is_expense is false, all other fields should be null. Numbers with "k" or "kyats" are MMK; "$" or "usd" is USD.`;
  return callClaude({ system, content: [{ type: "text", text: message }] });
}

// ---------- DB ----------
async function insertExpense(e) {
  const q = `insert into expenses (date, amount, currency, category, merchant, note, entered_by, source, telegram_user_id, telegram_chat_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`;
  const vals = [
    e.date || new Date().toISOString().slice(0, 10),
    e.amount,
    e.currency || DEFAULT_CURRENCY,
    CATEGORIES.includes(e.category) ? e.category : "Other",
    e.merchant || null,
    e.note || null,
    e.enteredBy || null,
    e.source,
    e.telegramUserId || null,
    e.telegramChatId || null,
  ];
  const r = await pool.query(q, vals);
  return r.rows[0];
}

async function getSettings() {
  const r = await pool.query("select currency, members from settings where id = 1");
  return r.rows[0] || { currency: DEFAULT_CURRENCY, members: [] };
}

async function updateSettings({ currency, members }) {
  const r = await pool.query(
    `update settings set currency = coalesce($1, currency), members = coalesce($2, members) where id = 1 returning currency, members`,
    [currency || null, members || null]
  );
  return r.rows[0];
}

async function addMemberIfNew(name) {
  if (!name) return;
  await pool.query(
    `update settings set members = array(select distinct unnest(members || $1::text[])) where id = 1`,
    [[name]]
  );
}

async function monthSummary(currency) {
  const r = await pool.query(
    `select category, sum(amount) as total from expenses
     where currency = $1 and date_trunc('month', date) = date_trunc('month', current_date)
     group by category order by total desc`,
    [currency]
  );
  const total = r.rows.reduce((a, row) => a + Number(row.total), 0);
  return { total, byCategory: r.rows };
}

const fmt = (n, c) => `${c === "MMK" ? "Ks" : c === "USD" ? "$" : c === "SGD" ? "S$" : c === "THB" ? "฿" : c} ${Number(n).toLocaleString("en-US", { maximumFractionDigits: c === "MMK" ? 0 : 2 })}`;

// ---------- Bot handlers ----------
bot.start((ctx) => ctx.reply(
  "👋 I'm your family's expense ledger.\n\n" +
  "• Send a photo of a receipt and I'll log it.\n" +
  "• Or just type it, e.g. \"12000 kyats grab to airport\".\n" +
  "• /summary — this month's totals\n" +
  "• /help — this message"
));
bot.help((ctx) => ctx.reply("Send a receipt photo, or type an expense like \"5$ coffee\". Use /summary for this month's totals."));

bot.command("summary", async (ctx) => {
  try {
    const { total, byCategory } = await monthSummary(DEFAULT_CURRENCY);
    if (byCategory.length === 0) return ctx.reply("Nothing logged this month yet.");
    const lines = byCategory.slice(0, 6).map((r) => `• ${r.category}: ${fmt(r.total, DEFAULT_CURRENCY)}`).join("\n");
    ctx.reply(`📒 This month so far: ${fmt(total, DEFAULT_CURRENCY)}\n\n${lines}`);
  } catch (e) {
    console.error(e);
    ctx.reply("Couldn't pull the summary just now — try again in a bit.");
  }
});

bot.on("photo", async (ctx) => {
  try {
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id; // largest size
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const imgRes = await fetch(fileLink.href);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const base64 = buf.toString("base64");
    const mediaType = imgRes.headers.get("content-type") || "image/jpeg";

    const extracted = await extractFromReceipt(base64, mediaType, ctx.message.caption);
    if (extracted.amount == null) {
      return ctx.reply("Got the photo, but couldn't read an amount off it. Mind typing it instead? e.g. \"5000 kyats — City Mart\"");
    }
    const enteredBy = ctx.from.first_name || ctx.from.username || "Someone";
    await insertExpense({
      ...extracted,
      enteredBy,
      source: "telegram_photo",
      telegramUserId: ctx.from.id,
      telegramChatId: ctx.chat.id,
    });
    await addMemberIfNew(enteredBy);
    ctx.reply(`✅ Logged: ${fmt(extracted.amount, extracted.currency || DEFAULT_CURRENCY)} · ${extracted.category}${extracted.merchant ? " · " + extracted.merchant : ""} (via ${enteredBy})`);
  } catch (e) {
    console.error(e);
    ctx.reply("Something went wrong reading that receipt. Try again, or type the expense instead.");
  }
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text || "";
  if (text.startsWith("/")) return; // let command handlers deal with it
  try {
    const extracted = await extractFromText(text);
    if (!extracted.is_expense || extracted.amount == null) return; // stay quiet on ordinary chat
    const enteredBy = ctx.from.first_name || ctx.from.username || "Someone";
    await insertExpense({
      ...extracted,
      enteredBy,
      source: "telegram_text",
      telegramUserId: ctx.from.id,
      telegramChatId: ctx.chat.id,
    });
    await addMemberIfNew(enteredBy);
    ctx.reply(`✅ Logged: ${fmt(extracted.amount, extracted.currency || DEFAULT_CURRENCY)} · ${extracted.category}${extracted.merchant ? " · " + extracted.merchant : ""} (via ${enteredBy})`);
  } catch (e) {
    console.error(e);
    // Stay silent on parse failures for plain text so the bot doesn't spam the group.
  }
});

// ---------- REST API (used by the dashboard artifact) ----------
app.get("/expenses", requireApiToken, async (req, res) => {
  try {
    const r = await pool.query("select * from expenses order by date desc, created_at desc");
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed to load expenses" });
  }
});

app.post("/expenses", requireApiToken, async (req, res) => {
  try {
    const row = await insertExpense({ ...req.body, source: req.body.source || "artifact" });
    await addMemberIfNew(req.body.enteredBy);
    res.status(201).json(row);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: "failed to create expense" });
  }
});

app.put("/expenses/:id", requireApiToken, async (req, res) => {
  try {
    const e = req.body;
    const q = `update expenses set date=$1, amount=$2, currency=$3, category=$4, merchant=$5, note=$6, entered_by=$7
               where id=$8 returning *`;
    const vals = [e.date, e.amount, e.currency, CATEGORIES.includes(e.category) ? e.category : "Other", e.merchant || null, e.note || null, e.enteredBy || null, req.params.id];
    const r = await pool.query(q, vals);
    if (r.rows.length === 0) return res.status(404).json({ error: "not found" });
    await addMemberIfNew(e.enteredBy);
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: "failed to update expense" });
  }
});

app.delete("/expenses/:id", requireApiToken, async (req, res) => {
  try {
    await pool.query("delete from expenses where id = $1", [req.params.id]);
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: "failed to delete expense" });
  }
});

app.get("/settings", requireApiToken, async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed to load settings" });
  }
});

app.put("/settings", requireApiToken, async (req, res) => {
  try {
    res.json(await updateSettings(req.body));
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: "failed to update settings" });
  }
});

// ---------- Webhook wiring ----------
const webhookPath = `/telegram/${WEBHOOK_SECRET}`;
app.use(bot.webhookCallback(webhookPath));
app.get("/", (req, res) => res.send("Family ledger bot is running."));

app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);
  await bot.telegram.setWebhook(`${PUBLIC_URL}${webhookPath}`);
  console.log(`Webhook set to ${PUBLIC_URL}${webhookPath}`);
});
