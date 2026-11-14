// Pesapal API 3.0 client (sandbox or live). Set PESAPAL_CONSUMER_KEY / PESAPAL_CONSUMER_SECRET; PESAPAL_ENV=live for real money.
const { pool: db } = require("./db");
const BASE = (process.env.PESAPAL_ENV === "live" ? "https://pay.pesapal.com/v3" : "https://cybqa.pesapal.com/pesapalv3") + "/api";
const configured = () => !!(process.env.PESAPAL_CONSUMER_KEY && process.env.PESAPAL_CONSUMER_SECRET);
let tok = null;
async function call(path, { method = "GET", body, token } = {}) {
  const r = await fetch(BASE + path, { method, headers: { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw Object.assign(new Error((d.error && (d.error.message || d.error.code)) || "Pesapal request failed"), { status: 502 });
  return d;
}
async function token() {
  if (tok && tok.exp > Date.now() + 30000) return tok.v;
  const d = await call("/Auth/RequestToken", { method: "POST", body: { consumer_key: process.env.PESAPAL_CONSUMER_KEY, consumer_secret: process.env.PESAPAL_CONSUMER_SECRET } });
  if (!d.token) throw Object.assign(new Error("Pesapal login failed. Check the consumer key and secret."), { status: 502 });
  tok = { v: d.token, exp: d.expiryDate ? Date.parse(d.expiryDate) : Date.now() + 4 * 60000 };
  return tok.v;
}
async function ipnId(appUrl) {
  const url = appUrl + "/api/pay/ipn", saved = (await db.query("SELECT value FROM settings WHERE key='pesapal_ipn'")).rows[0]?.value;
  if (saved && saved.url === url && saved.env === BASE) return saved.id;
  const d = await call("/URLSetup/RegisterIPN", { method: "POST", token: await token(), body: { url, ipn_notification_type: "GET" } });
  await db.query("INSERT INTO settings(key,value) VALUES('pesapal_ipn',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [JSON.stringify({ url, id: d.ipn_id, env: BASE })]);
  return d.ipn_id;
}
async function submit({ ref, amount, description, user, appUrl, phone }) {
  const [first, ...rest] = String(user.name || "Customer").split(" ");
  return call("/Transactions/SubmitOrderRequest", { method: "POST", token: await token(), body: {
    id: ref, currency: "KES", amount, description: description.slice(0, 100), callback_url: appUrl + "/api/pay/return",
    notification_id: await ipnId(appUrl), billing_address: { email_address: user.email, phone_number: phone || user.phone || "", country_code: "KE", first_name: first, last_name: rest.join(" ") || first } } });
}
async function status(trackingId) { return call("/Transactions/GetTransactionStatus?orderTrackingId=" + encodeURIComponent(trackingId), { token: await token() }); }
module.exports = { configured, submit, status, ping: token, registerIpn: ipnId, base: BASE };
