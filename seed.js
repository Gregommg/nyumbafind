// Optional: npm run seed  -> adds a demo landlord and sample houses (no photos).
require("dotenv").config();
const bcrypt = require("bcryptjs"), { pool, init } = require("./db");
const A = { Kilimani: [-1.2921, 36.7872], Westlands: [-1.2676, 36.8108], Langata: [-1.3533, 36.7472], Kasarani: [-1.223, 36.8977], "South B": [-1.31, 36.835], Syokimau: [-1.36, 36.933] };
const L = [["Sunny 2BR in Kilimani", "Kilimani", "2 Bedroom", 65000, ["Parking", "Security", "Balcony", "Water 24/7"], "Bright apartment near Yaya Centre, with a lift and backup generator."],
  ["Cozy Studio, Westlands", "Westlands", "Studio", 32000, ["WiFi", "Security", "Furnished"], "Furnished studio within walking distance of Sarit Centre."],
  ["Family Maisonette Langata", "Langata", "Maisonette", 120000, ["Parking", "Pets allowed", "Security", "Water 24/7"], "Four en-suite rooms and a garden in a gated community."],
  ["Affordable Bedsitter Kasarani", "Kasarani", "Bedsitter", 9000, ["Water 24/7", "Security"], "Clean self-contained bedsitter close to Thika Road."],
  ["Modern 1BR South B", "South B", "1 Bedroom", 28000, ["Balcony", "Gym", "Security"], "New block with a gym and rooftop terrace."],
  ["Bungalow in Syokimau", "Syokimau", "Bungalow", 85000, ["Parking", "Pets allowed", "Water 24/7"], "Three bedroom bungalow with a big compound near the SGR station."]];
(async () => {
  await init();
  const u = await pool.query("INSERT INTO users(name,email,phone,password_hash,role) VALUES('Demo Landlord','landlord@example.com','+254700000001',$1,'landlord') ON CONFLICT (email) DO UPDATE SET name=users.name RETURNING id", [await bcrypt.hash("landlord123", 10)]);
  for (const [t, a, ty, p, f, d] of L)
    await pool.query("INSERT INTO listings(owner_id,title,area,type,price,phone,description,features,lat,lng) VALUES($1,$2,$3,$4,$5,'+254700000001',$6,$7,$8,$9)",
      [u.rows[0].id, t, a, ty, p, d, f, A[a][0] + (Math.random() - .5) * .01, A[a][1] + (Math.random() - .5) * .01]);
  console.log("Seeded. Demo landlord: landlord@example.com / landlord123");
  process.exit();
})();
