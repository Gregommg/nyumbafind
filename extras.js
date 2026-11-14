// Payments (Pesapal), paid access, boosts, subscriptions and Airbnb-style bookings.
const pesapal = require("./pesapal");
module.exports = (r, { auth, role, h, bad, db, optUser, getSettings, saveSettings }) => {
  const FLAGS = { pin: "pinned_until", badge: "badge_until", home: "home_until", popular: "popular_until" };
  const FEAT = { view_pack: "views", suggest_sub: "suggest", boost: "boost" };
  const appUrl = q => (process.env.APP_URL || q.protocol + "://" + q.get("host")).replace(/\/$/, "");
  const prodOut = x => ({ id: x.id, kind: x.kind, role: x.role, name: x.name, price: x.price, qty: x.qty, pin: x.pin, badge: x.badge, home: x.home, popular: x.popular, active: x.active });
  // Kenyan mobile numbers: 0712345678, 712345678 or +254712345678 -> 254712345678
  const normPhone = x => { const d = String(x || "").replace(/\D/g, ""); if (/^0[17]\d{8}$/.test(d)) return "254" + d.slice(1); if (/^[17]\d{8}$/.test(d)) return "254" + d; if (/^254[17]\d{8}$/.test(d)) return d; return null; };
  const D = x => /^\d{4}-\d{2}-\d{2}$/.test(String(x || "")) && !isNaN(Date.parse(x));

  async function applyProduct(c, uid, p, listingId) {
    if (p.kind === "view_pack") await c.query("UPDATE users SET view_credits=view_credits+$2 WHERE id=$1", [uid, p.qty]);
    else if (p.kind === "suggest_sub") await c.query("UPDATE users SET suggest_until=GREATEST(COALESCE(suggest_until,now()),now())+($2::int*interval '1 day') WHERE id=$1", [uid, p.qty]);
    else if (p.kind === "boost") {
      const sets = Object.entries(FLAGS).filter(([k]) => p[k]).map(([, col]) => `${col}=GREATEST(COALESCE(${col},now()),now())+($2::int*interval '1 day')`);
      if (sets.length) await c.query(`UPDATE listings SET ${sets.join(",")} WHERE id=$1`, [listingId, p.qty]);
    }
  }
  async function settle(ref, trackingId) {
    const p = (await db.query("SELECT * FROM payments WHERE ref=$1", [ref])).rows[0];
    if (!p || p.status === "paid") return p;
    const tid = trackingId || p.tracking_id; if (!tid) return p;
    const st = await pesapal.status(tid), d = String(st.payment_status_description || "").toLowerCase();
    await db.query("UPDATE payments SET note=$2, checked_at=now(), tracking_id=COALESCE(tracking_id,$3) WHERE ref=$1", [ref, String(st.payment_status_description || st.message || "").slice(0, 80) || null, tid]);
    const completed = d === "completed" || Number(st.status_code) === 1;
    const refOk = !st.merchant_reference || String(st.merchant_reference).toLowerCase() === ref.toLowerCase();
    if (st.amount != null && Number(st.amount) < p.amount) console.warn("Pesapal amount differs for", ref, st.amount, "expected", p.amount);
    if (completed && refOk) {
      const c = await db.connect();
      try {
        await c.query("BEGIN");
        const u = await c.query("UPDATE payments SET status='paid',paid_at=now(),tracking_id=$2 WHERE ref=$1 AND status<>'paid' RETURNING *", [ref, tid]);
        if (u.rowCount) await applyProduct(c, p.user_id, p.product, p.listing_id);
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    } else if (["failed", "invalid", "reversed"].includes(d)) await db.query("UPDATE payments SET status='failed' WHERE ref=$1 AND status='pending'", [ref]);
    return (await db.query("SELECT * FROM payments WHERE ref=$1", [ref])).rows[0];
  }
  // Re-asks Pesapal about payments we have not heard back on (missed notifications, closed browser, sleeping server).
  async function reconcile({ limit = 30, uid = null, hours = 24, force = false } = {}) {
    const rows = (await db.query(`SELECT ref,tracking_id FROM payments WHERE tracking_id IS NOT NULL AND ($2::int IS NULL OR user_id=$2)
      AND (status='pending' OR (status='failed' AND created_at>now()-interval '2 hours')) AND created_at>now()-($3::int*interval '1 hour')
      AND ($4::boolean OR checked_at IS NULL OR checked_at<now()-interval '45 seconds') ORDER BY created_at DESC LIMIT $1`, [limit, uid, hours, force])).rows;
    let paid = 0;
    for (const x of rows) { try { const p = await settle(x.ref, x.tracking_id); if (p && p.status === "paid") paid++; } catch (e) { console.error("Pesapal recheck:", x.ref, e.message); } }
    return { checked: rows.length, paid };
  }
  setTimeout(() => reconcile().catch(() => {}), 20000).unref();
  setInterval(() => reconcile().catch(() => {}), 2 * 60 * 1000).unref();

  // ---------- public config ----------
  r.get("/config", h(async (q, s) => {
    const u = optUser(q), st = await getSettings();
    if (u) await reconcile({ limit: 3, uid: u.id }).catch(() => {});
    const products = (await db.query("SELECT * FROM products WHERE active ORDER BY price,id")).rows.map(prodOut);
    let me = null;
    if (u) { const x = (await db.query("SELECT view_credits,suggest_until FROM users WHERE id=$1", [u.id])).rows[0]; me = x && { viewCredits: x.view_credits, suggestUntil: x.suggest_until }; }
    s.json({ payments: st, products, pesapal: pesapal.configured(), me });
  }));

  // ---------- paying ----------
  r.post("/pay", auth, h(async (q, s) => {
    const { productId, listingId } = q.body || {};
    const p = (await db.query("SELECT * FROM products WHERE id=$1 AND active", [parseInt(productId) || 0])).rows[0];
    if (!p) return bad(s, "That plan is not available");
    const me = (await db.query("SELECT * FROM users WHERE id=$1", [q.user.id])).rows[0], admin = me.role === "admin";
    if (!admin && p.role !== me.role) return bad(s, "That plan is for " + p.role + "s", 403);
    if (!admin) { const rs = (await getSettings())[me.role]; if (!rs.enabled || !rs[FEAT[p.kind]]) return bad(s, "Payments for this are switched off"); }
    let lid = null;
    if (p.kind === "boost") {
      lid = parseInt(listingId);
      const l = (await db.query("SELECT owner_id FROM listings WHERE id=$1", [lid])).rows[0];
      if (!l) return bad(s, "Choose a listing to boost");
      if (!admin && l.owner_id !== me.id) return bad(s, "That is not your listing", 403);
      if (admin) { await applyProduct(db, me.id, p, lid); return s.json({ granted: true }); }
    } else if (admin) return bad(s, "Admins can only grant boosts");
    if (!pesapal.configured()) return bad(s, "Payments are not set up yet. Please try again later.", 503);
    const site = appUrl(q);
    if (process.env.PESAPAL_ALLOW_LOCAL !== "1" && /^https?:\/\/(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.)/i.test(site))
      return bad(s, "Pesapal cannot reach a local address. Set APP_URL to your public https site address (use an ngrok link when testing on your computer) and restart.", 503);
    const phone = q.body.phone ? normPhone(q.body.phone) : null;
    if (q.body.phone && !phone) return bad(s, "Enter a valid M-Pesa number, for example 0712345678");
    const ref = "NF" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await db.query("INSERT INTO payments(ref,user_id,product,listing_id,amount) VALUES($1,$2,$3,$4,$5)", [ref, me.id, JSON.stringify(prodOut(p)), lid, p.price]);
    const o = await pesapal.submit({ ref, amount: p.price, description: p.name, user: me, appUrl: site, phone });
    await db.query("UPDATE payments SET tracking_id=$2 WHERE ref=$1", [ref, o.order_tracking_id]);
    s.json({ redirectUrl: o.redirect_url, ref });
  }));
  r.get("/pay/ipn", h(async (q, s) => {
    const { OrderTrackingId: t, OrderMerchantReference: ref, OrderNotificationType: n } = q.query;
    try { if (ref) await settle(ref, t); } catch (e) { console.error("Pesapal IPN:", e.message); }
    s.json({ orderNotificationType: n || "IPNCHANGE", orderTrackingId: t, orderMerchantReference: ref, status: 200 });
  }));
  r.get("/pay/return", h(async (q, s) => {
    const { OrderTrackingId: t, OrderMerchantReference: ref } = q.query; let st = "pending";
    try { const p = ref && await settle(ref, t); if (p) st = p.status; } catch (e) { console.error("Pesapal return:", e.message); }
    s.redirect("/?paid=" + encodeURIComponent(ref || "") + "&status=" + st);
  }));
  r.get("/pay/:ref", auth, h(async (q, s) => {
    let p = (await db.query("SELECT * FROM payments WHERE ref=$1 AND user_id=$2", [q.params.ref, q.user.id])).rows[0];
    if (!p) return bad(s, "Payment not found", 404);
    if (p.status === "pending") try { p = await settle(p.ref); } catch {}
    s.json({ status: p.status, product: p.product, listingId: p.listing_id });
  }));

  // ---------- unlock a house (contact + directions) ----------
  r.post("/listings/:id/unlock", auth, h(async (q, s) => {
    const l = (await db.query("SELECT phone,lat,lng,owner_id FROM listings WHERE id=$1", [parseInt(q.params.id) || 0])).rows[0];
    if (!l) return bad(s, "Listing not found", 404);
    const d = { phone: l.phone, lat: l.lat, lng: l.lng }, st = await getSettings();
    if (q.user.role !== "tenant" || !(st.tenant.enabled && st.tenant.views)) return s.json(d);
    const id = parseInt(q.params.id);
    if ((await db.query("SELECT 1 FROM unlocks WHERE user_id=$1 AND listing_id=$2", [q.user.id, id])).rowCount) return s.json(d);
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      const u = await c.query("UPDATE users SET view_credits=view_credits-1 WHERE id=$1 AND view_credits>0 RETURNING view_credits", [q.user.id]);
      if (!u.rowCount) { await c.query("ROLLBACK"); return s.status(402).json({ error: "You have no house views left. Choose a plan to continue.", need: "view_pack" }); }
      await c.query("INSERT INTO unlocks(user_id,listing_id) VALUES($1,$2)", [q.user.id, id]);
      await c.query("COMMIT");
      s.json({ ...d, viewCredits: u.rows[0].view_credits });
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }));

  // ---------- admin: payment switches, plans, payments ----------
  const adm = [auth, role("admin")];
  r.get("/admin/payment-settings", ...adm, h(async (q, s) => s.json({ settings: await getSettings(), pesapal: pesapal.configured(), env: process.env.PESAPAL_ENV === "live" ? "live" : "sandbox", ipn: appUrl(q) + "/api/pay/ipn" })));
  r.put("/admin/payment-settings", ...adm, h(async (q, s) => {
    const t = (q.body || {}).tenant || {}, l = (q.body || {}).landlord || {}, B = x => x === true;
    await saveSettings({ tenant: { enabled: B(t.enabled), views: B(t.views), suggest: B(t.suggest) }, landlord: { enabled: B(l.enabled), suggest: B(l.suggest), boost: B(l.boost) } });
    s.json({ ok: true });
  }));
  const prodBody = (b, s) => {
    const kind = b.kind, rl = b.role, price = parseInt(b.price), qty = parseInt(b.qty), f = k => b[k] === true;
    if (!FEAT[kind] || !["tenant", "landlord"].includes(rl) || !String(b.name || "").trim() || !(price > 0) || !(qty > 0)) { bad(s, "Enter a name, role, price and quantity"); return null; }
    if (kind === "view_pack" && rl !== "tenant") { bad(s, "House view plans are for tenants"); return null; }
    if (kind === "boost" && rl !== "landlord") { bad(s, "Boosts are for landlords"); return null; }
    if (kind === "boost" && !(f("pin") || f("badge") || f("home") || f("popular"))) { bad(s, "Choose at least one boost option"); return null; }
    const bo = kind === "boost";
    return [kind, rl, String(b.name).trim().slice(0, 80), price, qty, bo && f("pin"), bo && f("badge"), bo && f("home"), bo && f("popular"), b.active !== false];
  };
  r.get("/admin/products", ...adm, h(async (q, s) => s.json({ products: (await db.query("SELECT * FROM products ORDER BY kind,role,price,id")).rows.map(prodOut) })));
  r.post("/admin/products", ...adm, h(async (q, s) => {
    const v = prodBody(q.body || {}, s); if (!v) return;
    s.status(201).json({ id: (await db.query("INSERT INTO products(kind,role,name,price,qty,pin,badge,home,popular,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id", v)).rows[0].id });
  }));
  r.put("/admin/products/:id", ...adm, h(async (q, s) => {
    const v = prodBody(q.body || {}, s); if (!v) return;
    await db.query("UPDATE products SET kind=$1,role=$2,name=$3,price=$4,qty=$5,pin=$6,badge=$7,home=$8,popular=$9,active=$10 WHERE id=$11", [...v, parseInt(q.params.id) || 0]);
    s.json({ ok: true });
  }));
  r.delete("/admin/products/:id", ...adm, h(async (q, s) => { await db.query("DELETE FROM products WHERE id=$1", [parseInt(q.params.id) || 0]); s.json({ ok: true }); }));
  r.get("/admin/payments", ...adm, h(async (q, s) => {
    await reconcile({ limit: 20, hours: 24 * 14 }).catch(() => {});
    const x = await db.query("SELECT p.ref,p.amount,p.status,p.note,p.created_at,p.product->>'name' AS plan,u.name,u.email FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 50");
    const t = (await db.query("SELECT COALESCE(SUM(amount) FILTER (WHERE status='paid'),0)::int AS total, COUNT(*) FILTER (WHERE status='paid')::int AS paid, COUNT(*) FILTER (WHERE status='pending')::int AS pending, COUNT(*)::int AS all FROM payments")).rows[0];
    s.json({ payments: x.rows, totals: t });
  }));
  r.post("/admin/payments/recheck", ...adm, h(async (q, s) => s.json(await reconcile({ limit: 100, hours: 24 * 30, force: true }))));

  // ---------- Airbnb-style stays: search, book, manage ----------
  r.get("/stays/available", h(async (q, s) => {
    const { checkIn, checkOut, guests } = q.query;
    if (!D(checkIn) || !D(checkOut) || checkOut <= checkIn) return bad(s, "Choose valid check-in and check-out dates");
    const x = await db.query(`SELECT l.id FROM listings l WHERE l.mode='stay' AND l.vacant AND ($3::int IS NULL OR l.max_guests>=$3)
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.listing_id=l.id AND b.status='confirmed' AND b.check_in<$2::date AND b.check_out>$1::date)`, [checkIn, checkOut, parseInt(guests) || null]);
    s.json({ ids: x.rows.map(z => z.id) });
  }));
  r.get("/listings/:id/booked", h(async (q, s) => {
    const x = await db.query("SELECT check_in::text AS a, check_out::text AS b FROM bookings WHERE listing_id=$1 AND status='confirmed' AND check_out>=current_date ORDER BY check_in", [parseInt(q.params.id) || 0]);
    s.json({ ranges: x.rows });
  }));
  r.post("/bookings", auth, role("tenant"), h(async (q, s) => {
    const b = q.body || {}, id = parseInt(b.listingId) || 0, g = parseInt(b.guests) || 1;
    if (!D(b.checkIn) || !D(b.checkOut) || b.checkOut <= b.checkIn) return bad(s, "Choose valid dates");
    if (b.checkIn < new Date().toISOString().slice(0, 10)) return bad(s, "Check-in cannot be in the past");
    const nights = Math.round((Date.parse(b.checkOut) - Date.parse(b.checkIn)) / 864e5);
    if (nights > 90) return bad(s, "Stays are limited to 90 nights");
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      const l = (await c.query("SELECT * FROM listings WHERE id=$1 FOR UPDATE", [id])).rows[0];
      const fail = async (m, code) => { await c.query("ROLLBACK"); return bad(s, m, code); };
      if (!l || l.mode !== "stay" || !l.vacant) return fail("This place is not available for booking");
      if (g < 1 || g > (l.max_guests || 1)) return fail("This place sleeps up to " + (l.max_guests || 1) + " guests");
      if ((await c.query("SELECT 1 FROM bookings WHERE listing_id=$1 AND status='confirmed' AND check_in<$3::date AND check_out>$2::date", [id, b.checkIn, b.checkOut])).rowCount) return fail("Those dates are already booked", 409);
      const x = await c.query("INSERT INTO bookings(listing_id,guest_id,check_in,check_out,guests,nights,total,note,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,status,nights,total",
        [id, q.user.id, b.checkIn, b.checkOut, g, nights, nights * l.price, String(b.note || "").slice(0, 500), l.instant_book ? "confirmed" : "pending"]);
      await c.query("COMMIT");
      s.status(201).json(x.rows[0]);
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }));
  r.get("/my/bookings", auth, h(async (q, s) => {
    const base = `SELECT b.id,b.status,b.guests,b.nights,b.total,b.note,b.check_in::text AS check_in,b.check_out::text AS check_out,b.guest_id,l.id AS listing_id,l.title,l.area,l.owner_id,
      l.phone AS host_phone,g.name AS guest_name,g.phone AS guest_phone,u.name AS host_name FROM bookings b JOIN listings l ON l.id=b.listing_id JOIN users g ON g.id=b.guest_id JOIN users u ON u.id=l.owner_id`;
    const rows = q.user.role === "admin" ? (await db.query(base + " ORDER BY b.check_in DESC LIMIT 200")).rows
      : q.user.role === "landlord" ? (await db.query(base + " WHERE l.owner_id=$1 ORDER BY b.check_in DESC", [q.user.id])).rows
      : (await db.query(base + " WHERE b.guest_id=$1 ORDER BY b.check_in DESC", [q.user.id])).rows;
    s.json({ bookings: rows.map(x => { const host = q.user.role === "admin" || x.owner_id === q.user.id;
      return { id: x.id, status: x.status, guests: x.guests, nights: x.nights, total: x.total, note: x.note, checkIn: x.check_in, checkOut: x.check_out, listingId: x.listing_id, title: x.title, area: x.area,
        hostName: host || x.status === "confirmed" ? x.host_name : null, hostPhone: host || x.status === "confirmed" ? x.host_phone : null,
        guestName: host ? x.guest_name : null, guestPhone: host ? x.guest_phone : null, asHost: host }; }) });
  }));
  r.patch("/bookings/:id", auth, h(async (q, s) => {
    const act = (q.body || {}).action, id = parseInt(q.params.id) || 0;
    const b = (await db.query("SELECT b.*,l.owner_id FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE b.id=$1", [id])).rows[0];
    if (!b) return bad(s, "Booking not found", 404);
    const host = q.user.role === "admin" || b.owner_id === q.user.id, guest = b.guest_id === q.user.id;
    if (act === "cancel") {
      if (!(host || guest)) return bad(s, "Not allowed", 403);
      if (!["pending", "confirmed"].includes(b.status)) return bad(s, "This booking can no longer be cancelled");
      await db.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [id]); return s.json({ ok: true });
    }
    if (!host) return bad(s, "Not allowed", 403);
    if (b.status !== "pending") return bad(s, "This request was already handled");
    if (act === "decline") { await db.query("UPDATE bookings SET status='declined' WHERE id=$1", [id]); return s.json({ ok: true }); }
    if (act !== "confirm") return bad(s, "Unknown action");
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT id FROM listings WHERE id=$1 FOR UPDATE", [b.listing_id]);
      const clash = await c.query("SELECT 1 FROM bookings WHERE listing_id=$1 AND status='confirmed' AND id<>$4 AND check_in<$3::date AND check_out>$2::date", [b.listing_id, b.check_in, b.check_out, id]);
      if (clash.rowCount) { await c.query("ROLLBACK"); return bad(s, "Those dates are already booked by another guest", 409); }
      await c.query("UPDATE bookings SET status='confirmed' WHERE id=$1", [id]);
      await c.query("COMMIT"); s.json({ ok: true });
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }));
};
