const { Pool } = require("pg"), fs = require("fs"), path = require("path"), bcrypt = require("bcryptjs");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});
async function init() {
  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  await seedDefaults();
  const e = process.env.ADMIN_EMAIL, p = process.env.ADMIN_PASSWORD;
  if (e && p) {
    const r = await pool.query("SELECT 1 FROM users WHERE email=$1", [e.toLowerCase()]);
    if (!r.rowCount)
      await pool.query("INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'admin')",
        ["Site Admin", e.toLowerCase(), await bcrypt.hash(p, 10)]);
  }
}
async function seedDefaults() {
  // Payments start switched OFF so the site works as before until the admin turns them on.
  await pool.query("INSERT INTO settings(key,value) VALUES('payments',$1) ON CONFLICT DO NOTHING", [JSON.stringify({
    tenant: { enabled: false, views: true, suggest: true }, landlord: { enabled: false, suggest: true, boost: true } })]);
  if ((await pool.query("SELECT 1 FROM products LIMIT 1")).rowCount) return;
  const P = [["view_pack","tenant","5 houses",200,5],["view_pack","tenant","15 houses",500,15],
    ["suggest_sub","tenant","Suggestions - 30 days",100,30],["suggest_sub","landlord","See suggestions - 30 days",300,30]];
  for (const [k, r, n, p, q] of P) await pool.query("INSERT INTO products(kind,role,name,price,qty) VALUES($1,$2,$3,$4,$5)", [k, r, n, p, q]);
  await pool.query("INSERT INTO products(kind,role,name,price,qty,pin) VALUES('boost','landlord','Pin to top - 7 days',300,7,true)");
  await pool.query("INSERT INTO products(kind,role,name,price,qty,badge) VALUES('boost','landlord','Featured badge - 7 days',200,7,true)");
  await pool.query("INSERT INTO products(kind,role,name,price,qty,pin,badge,home,popular) VALUES('boost','landlord','Full boost - 14 days',1000,14,true,true,true,true)");
}
module.exports = { pool, init };
