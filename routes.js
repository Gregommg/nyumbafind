const r = require("express").Router(), jwt = require("jsonwebtoken"), bcrypt = require("bcryptjs");
const multer = require("multer"), cloudinary = require("cloudinary").v2;
const { pool: db } = require("./db");
const { COUNTY_AREAS } = require("./public/js/locations");
const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
if (process.env.CLOUDINARY_CLOUD_NAME)
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
else cloudinary.config({ secure: true }); // also reads CLOUDINARY_URL if set

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (q, f, cb) => cb(null, /^image\//.test(f.mimetype)) });
const h = f => (q, s, n) => f(q, s, n).catch(n);
const bad = (s, m, c = 400) => s.status(c).json({ error: m });
const sign = u => jwt.sign({ id: u.id, role: u.role, name: u.name }, SECRET, { expiresIn: "7d" });
const pub = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const auth = (q, s, n) => { try { q.user = jwt.verify((q.headers.authorization || "").replace("Bearer ", ""), SECRET); n(); } catch { bad(s, "Please log in", 401); } };
const role = (...rs) => (q, s, n) => rs.includes(q.user.role) ? n() : bad(s, "You are not allowed to do that", 403);
const countyForArea = area => Object.keys(COUNTY_AREAS).find(county => COUNTY_AREAS[county].includes(area));

function toCloud(file, folder) {
  return new Promise((ok, no) => {
    const fail = () => no(Object.assign(new Error("Image upload failed. Check your Cloudinary settings."), { status: 502 }));
    try {
      cloudinary.uploader.upload_stream(
        { folder: "nyumbafind/" + folder, resource_type: "image", transformation: [{ width: 1600, crop: "limit", quality: "auto", fetch_format: "auto" }] },
        (e, res) => e ? fail() : ok(res)).end(file.buffer);
    } catch { fail(); }
  });
}
const drop = ids => Promise.all(ids.map(id => cloudinary.uploader.destroy(id).catch(() => {})));

// ---------- auth ----------
r.post("/auth/register", h(async (q, s) => {
  const { name, email, password, role: ro, phone } = q.body;
  if (!name || !/^\S+@\S+\.\S+$/.test(email || "") || (password || "").length < 6)
    return bad(s, "Enter your name, a valid email and a password of at least 6 characters");
  try {
    const x = await db.query("INSERT INTO users(name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [name.trim(), email.toLowerCase(), phone || null, await bcrypt.hash(password, 10), ro === "landlord" ? "landlord" : "tenant"]);
    s.json({ token: sign(x.rows[0]), user: pub(x.rows[0]) });
  } catch (e) { if (e.code === "23505") return bad(s, "That email is already registered", 409); throw e; }
}));
r.post("/auth/login", h(async (q, s) => {
  const x = await db.query("SELECT * FROM users WHERE email=$1", [String(q.body.email || "").toLowerCase()]);
  const u = x.rows[0];
  if (!u || !(await bcrypt.compare(q.body.password || "", u.password_hash))) return bad(s, "Wrong email or password", 401);
  s.json({ token: sign(u), user: pub(u) });
}));
r.get("/auth/me", auth, h(async (q, s) => {
  const x = await db.query("SELECT * FROM users WHERE id=$1", [q.user.id]);
  x.rows[0] ? s.json({ user: pub(x.rows[0]) }) : bad(s, "Please log in", 401);
}));

const optUser = q => { try { return jwt.verify((q.headers.authorization || "").replace("Bearer ", ""), SECRET); } catch { return null; } };
let stCache = null;
const DEF = { tenant: { enabled: false, views: true, suggest: true }, landlord: { enabled: false, suggest: true, boost: true } };
const getSettings = async () => {
  if (stCache && stCache.t > Date.now() - 5000) return stCache.v;
  const x = (await db.query("SELECT value FROM settings WHERE key='payments'")).rows[0];
  const v = x ? { tenant: { ...DEF.tenant, ...x.value.tenant }, landlord: { ...DEF.landlord, ...x.value.landlord } } : DEF;
  stCache = { t: Date.now(), v }; return v;
};
const saveSettings = async v => { await db.query("INSERT INTO settings(key,value) VALUES('payments',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [JSON.stringify(v)]); stCache = null; };
const hasSub = async uid => !!(await db.query("SELECT 1 FROM users WHERE id=$1 AND suggest_until>now()", [uid])).rowCount;
// Gating: when the admin turns on tenant "views" payments, visitors and tenants only see approximate location and no contact until they unlock a house.
async function viewer(q) {
  const user = optUser(q), st = await getSettings(); let unlocked = new Set();
  if (user) unlocked = new Set((await db.query("SELECT listing_id FROM unlocks WHERE user_id=$1 UNION SELECT listing_id FROM bookings WHERE guest_id=$1 AND status='confirmed'", [user.id])).rows.map(x => x.listing_id));
  return { gate: st.tenant.enabled && st.tenant.views && !(user && user.role !== "tenant"), unlocked, user };
}
const live = d => !!d && new Date(d) > new Date();

// ---------- listings ----------
const LQ = `SELECT l.*, u.name AS owner_name, COALESCE((SELECT json_agg(i.url ORDER BY i.position, i.id) FROM listing_images i WHERE i.listing_id=l.id),'[]'::json) AS imgs
            FROM listings l JOIN users u ON u.id=l.owner_id`;
const fmt = (l, v) => {
  const locked = v && v.gate && !v.unlocked.has(l.id) && !(v.user && v.user.id === l.owner_id);
  return { id: l.id, title: l.title, area: l.area, county: countyForArea(l.area), type: l.type, price: l.price, mode: l.mode, maxGuests: l.max_guests, instant: l.instant_book,
    desc: l.description, feats: l.features, phone: locked ? null : l.phone, lat: locked ? +l.lat.toFixed(2) : l.lat, lng: locked ? +l.lng.toFixed(2) : l.lng, locked: !!locked,
    vacant: l.vacant, owner: l.owner_id, ownerName: locked ? null : l.owner_name, imgs: l.imgs, at: new Date(l.created_at).getTime(),
    boost: { pin: live(l.pinned_until), badge: live(l.badge_until), home: live(l.home_until), popular: live(l.popular_until) } };
};
r.get("/listings", h(async (q, s) => { const v = await viewer(q); s.json({ listings: (await db.query(LQ + " WHERE l.vacant ORDER BY l.created_at DESC LIMIT 500")).rows.map(l => fmt(l, v)) }); }));
r.get("/my/listings", auth, role("landlord", "admin"), h(async (q, s) => {
  const x = q.user.role === "admin" ? await db.query(LQ + " ORDER BY l.created_at DESC")
    : await db.query(LQ + " WHERE l.owner_id=$1 ORDER BY l.created_at DESC", [q.user.id]);
  s.json({ listings: x.rows.map(l => fmt(l)) });
}));
r.post("/listings", auth, role("landlord", "admin"), upload.array("images", 8), h(async (q, s) => {
  const b = q.body, price = parseInt(b.price), lat = parseFloat(b.lat), lng = parseFloat(b.lng);
  if (!b.title || !b.area || !b.type || !b.phone || !(price > 0) || isNaN(lat) || isNaN(lng)) return bad(s, "Please complete the title, area, type, rent, phone and location");
  const mode = b.mode === "stay" ? "stay" : "rent", maxGuests = parseInt(b.max_guests) || null;
  if (mode === "stay" && !(maxGuests > 0)) return bad(s, "Enter how many guests the place sleeps");
  if (b.county && (!COUNTY_AREAS[b.county] || !COUNTY_AREAS[b.county].includes(b.area))) return bad(s, "Choose a location in the selected county");
  let feats = []; try { feats = JSON.parse(b.features || "[]").map(String); } catch {}
  const ups = await Promise.all((q.files || []).map(f => toCloud(f, "listings")));
  const x = await db.query("INSERT INTO listings(owner_id,title,area,type,price,phone,description,features,lat,lng,mode,max_guests,instant_book) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",
    [q.user.id, b.title.trim(), b.area, b.type, price, b.phone.trim(), (b.description || "").trim(), feats, lat, lng, mode, mode === "stay" ? maxGuests : null, mode === "stay" && (b.instant_book === "true" || b.instant_book === true)]);
  for (let i = 0; i < ups.length; i++)
    await db.query("INSERT INTO listing_images(listing_id,url,public_id,position) VALUES($1,$2,$3,$4)", [x.rows[0].id, ups[i].secure_url, ups[i].public_id, i]);
  s.status(201).json({ id: x.rows[0].id });
}));
async function mine(q, s) {
  const x = await db.query("SELECT owner_id FROM listings WHERE id=$1", [q.params.id]);
  if (!x.rowCount) { bad(s, "Listing not found", 404); return false; }
  if (q.user.role !== "admin" && x.rows[0].owner_id !== q.user.id) { bad(s, "This is not your listing", 403); return false; }
  return true;
}
r.patch("/listings/:id/vacant", auth, role("landlord", "admin"), h(async (q, s) => {
  if (!(await mine(q, s))) return;
  const x = await db.query("UPDATE listings SET vacant=NOT vacant WHERE id=$1 RETURNING vacant", [q.params.id]);
  s.json({ vacant: x.rows[0].vacant });
}));
r.delete("/listings/:id", auth, role("landlord", "admin"), h(async (q, s) => {
  if (!(await mine(q, s))) return;
  const im = await db.query("SELECT public_id FROM listing_images WHERE listing_id=$1", [q.params.id]);
  await drop(im.rows.map(i => i.public_id));
  await db.query("DELETE FROM listings WHERE id=$1", [q.params.id]);
  s.json({ ok: true });
}));

// ---------- favorites ----------
const favIds = async uid => (await db.query("SELECT listing_id FROM favorites WHERE user_id=$1", [uid])).rows.map(x => x.listing_id);
r.get("/favorites", auth, h(async (q, s) => s.json({ ids: await favIds(q.user.id) })));
r.post("/favorites/:id", auth, h(async (q, s) => {
  const d = await db.query("DELETE FROM favorites WHERE user_id=$1 AND listing_id=$2", [q.user.id, q.params.id]);
  if (!d.rowCount) await db.query("INSERT INTO favorites(user_id,listing_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [q.user.id, q.params.id]);
  s.json({ ids: await favIds(q.user.id) });
}));

// ---------- tenant requests and contact messages ----------
r.post("/requests", h(async (q, s) => {
  const b = q.body; if (!b.phone) return bad(s, "Phone number is required");
  const county = b.county || (b.area && countyForArea(b.area));
  if ((county && !COUNTY_AREAS[county]) || (b.area && (!county || !COUNTY_AREAS[county].includes(b.area)))) return bad(s, "Choose a location in the selected county");
  const u = optUser(q), st = await getSettings();
  if (st.tenant.enabled && st.tenant.suggest && !(u && u.role === "admin")) {
    if (!u) return s.status(401).json({ error: "Log in as a tenant to send suggestions", needLogin: true });
    if (u.role !== "tenant") return bad(s, "Only tenants can send suggestions", 403);
    if (!(await hasSub(u.id))) return s.status(402).json({ error: "A subscription is needed to send suggestions", need: "suggest_sub", role: "tenant" });
  }
  await db.query("INSERT INTO requests(phone,area,type,budget,county,user_id) VALUES($1,$2,$3,$4,$5,$6)", [String(b.phone).slice(0, 40), b.area || null, b.type || null, parseInt(b.budget) || null, county || null, u ? u.id : null]);
  s.status(201).json({ ok: true });
}));
r.get("/requests", auth, role("landlord", "admin"), h(async (q, s) => {
  const st = await getSettings();
  if (q.user.role === "landlord" && st.landlord.enabled && st.landlord.suggest && !(await hasSub(q.user.id)))
    return s.status(402).json({ error: "Subscribe to see tenant suggestions", need: "suggest_sub", role: "landlord" });
  s.json({ requests: (await db.query("SELECT * FROM requests ORDER BY created_at DESC LIMIT 50")).rows });
}));
r.post("/messages", h(async (q, s) => {
  const { name, email, message } = q.body; if (!name || !email || !message) return bad(s, "Please fill in all fields");
  await db.query("INSERT INTO messages(name,email,message) VALUES($1,$2,$3)", [String(name).slice(0, 120), String(email).slice(0, 160), String(message).slice(0, 3000)]);
  s.status(201).json({ ok: true });
}));
r.get("/messages", auth, role("admin"), h(async (q, s) => s.json({ messages: (await db.query("SELECT * FROM messages ORDER BY created_at DESC LIMIT 100")).rows })));

// ---------- county search, featured areas, and admin analytics ----------
r.post("/search-events", h(async (q, s) => {
  const { county, area, type } = q.body || {};
  if (!COUNTY_AREAS[county] || (area && !COUNTY_AREAS[county].includes(area))) return bad(s, "Choose a valid county and location");
  await db.query("INSERT INTO search_events(county,area,type) VALUES($1,$2,$3)", [county, area || null, type || null]);
  s.status(201).json({ ok: true });
}));
r.get("/popular-areas", h(async (q, s) => {
  const { county } = q.query;
  if (!COUNTY_AREAS[county]) return bad(s, "Choose a valid county");
  const featured = (await db.query("SELECT areas FROM featured_areas WHERE county=$1", [county])).rows[0]?.areas || [];
  const ranked = (await db.query(
    "SELECT area,COUNT(*)::int AS searches FROM search_events WHERE county=$1 AND area IS NOT NULL GROUP BY area ORDER BY searches DESC,area LIMIT 10",
    [county]
  )).rows;
  const byArea = new Map(ranked.map(x => [x.area, x.searches]));
  const areas = featured.length ? featured.map(area => ({ area, searches: byArea.get(area) || 0 })) : ranked;
  s.json({ areas, featured, availableAreas: COUNTY_AREAS[county] });
}));
r.put("/popular-areas", auth, role("admin"), h(async (q, s) => {
  const { county, areas } = q.body || {};
  if (!COUNTY_AREAS[county] || !Array.isArray(areas) || areas.length > 10 ||
      areas.some((area, i) => !COUNTY_AREAS[county].includes(area) || areas.indexOf(area) !== i))
    return bad(s, "Choose up to 10 unique locations from a valid county");
  await db.query(
    "INSERT INTO featured_areas(county,areas) VALUES($1,$2) ON CONFLICT(county) DO UPDATE SET areas=EXCLUDED.areas,updated_at=now()",
    [county, areas]
  );
  s.json({ ok: true });
}));
r.get("/admin/analytics", auth, role("admin"), h(async (q, s) => {
  const days = Math.min(365, Math.max(1, parseInt(q.query.days, 10) || 30));
  const params = [days];
  const [performance, activity, daily, searches, database] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS requests,
      COUNT(*) FILTER(WHERE status>=400)::int AS errors,
      ROUND(COALESCE(AVG(duration_ms),0)::numeric,1) AS avg_ms,
      ROUND(COALESCE(percentile_cont(0.95) WITHIN GROUP(ORDER BY duration_ms),0)::numeric,1) AS p95_ms
      FROM api_request_metrics WHERE created_at>=now()-($1::int*interval '1 day')`, params),
    db.query(`SELECT (SELECT COUNT(*)::int FROM users WHERE created_at>=now()-($1::int*interval '1 day')) AS users,
      (SELECT COUNT(*)::int FROM listings WHERE created_at>=now()-($1::int*interval '1 day')) AS listings,
      (SELECT COUNT(*)::int FROM requests WHERE created_at>=now()-($1::int*interval '1 day')) AS requests,
      (SELECT COUNT(*)::int FROM search_events WHERE created_at>=now()-($1::int*interval '1 day')) AS searches`, params),
    db.query(`SELECT date_trunc('day',created_at)::date AS day,COUNT(*)::int AS searches
      FROM search_events WHERE created_at>=now()-($1::int*interval '1 day')
      GROUP BY 1 ORDER BY 1`, params),
    db.query(`SELECT county,area,COUNT(*)::int AS searches FROM search_events
      WHERE created_at>=now()-($1::int*interval '1 day') AND area IS NOT NULL
      GROUP BY county,area ORDER BY searches DESC,county,area LIMIT 20`, params),
    db.query("SELECT 1 AS ok")
  ]);
  const rev = (await db.query("SELECT COALESCE(SUM(amount),0)::int AS total, COUNT(*)::int AS count FROM payments WHERE status='paid' AND paid_at>=now()-($1::int*interval '1 day')", params)).rows[0];
  const byKind = (await db.query("SELECT product->>'kind' AS kind, COALESCE(SUM(amount),0)::int AS total, COUNT(*)::int AS count FROM payments WHERE status='paid' AND paid_at>=now()-($1::int*interval '1 day') GROUP BY 1 ORDER BY 2 DESC", params)).rows;
  s.json({ days, performance: performance.rows[0], activity: activity.rows[0],
    daily: daily.rows, searches: searches.rows, database: { ok: database.rowCount === 1 },
    revenue: { status: "ok", ...rev, byKind } });
}));

// ---------- home page banner photos (admin only) ----------
r.get("/banner", h(async (q, s) => s.json({ photos: (await db.query("SELECT id, url AS src, kind AS k FROM banner_photos ORDER BY id DESC")).rows })));
r.post("/banner", auth, role("admin"), upload.array("images", 10), h(async (q, s) => {
  if (!q.files || !q.files.length) return bad(s, "Choose at least one image");
  const kind = q.body.kind === "interior" ? "interior" : "exterior";
  const ups = await Promise.all(q.files.map(f => toCloud(f, "banner")));
  for (const u of ups) await db.query("INSERT INTO banner_photos(url,public_id,kind) VALUES($1,$2,$3)", [u.secure_url, u.public_id, kind]);
  s.status(201).json({ added: ups.length });
}));
r.delete("/banner/:id", auth, role("admin"), h(async (q, s) => {
  const x = await db.query("DELETE FROM banner_photos WHERE id=$1 RETURNING public_id", [q.params.id]);
  if (x.rowCount) await drop([x.rows[0].public_id]);
  s.json({ ok: true });
}));

// ---------- misc ----------
r.get("/stats", h(async (q, s) => {
  const x = await db.query("SELECT COUNT(*) FILTER (WHERE role='landlord') AS landlords, COUNT(*) FILTER (WHERE role='tenant') AS tenants FROM users");
  s.json({ landlords: +x.rows[0].landlords, tenants: +x.rows[0].tenants });
}));
r.get("/health", (q, s) => s.json({ ok: true }));
require("./extras")(r, { auth, role, h, bad, db, optUser, getSettings, saveSettings });
module.exports = r;
