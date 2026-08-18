import "dotenv/config";
import fs from "fs";
import pg from "pg";

const sql = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  await client.connect();
  await client.query(sql);
  console.log("Schema applied.");
  await client.end();
})().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
