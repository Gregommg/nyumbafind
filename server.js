require("dotenv").config();
const express = require("express"), path = require("path"), helmet = require("helmet"), rateLimit = require("express-rate-limit");
const { init, pool } = require("./db");
const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use("/api", (req, res, next) => {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const duration = Number(process.hrtime.bigint() - started) / 1e6;
    const route = req.path.replace(/\/\d+(?=\/|$)/g, "/:id");
    pool.query(
      "INSERT INTO api_request_metrics(method,path,status,duration_ms) VALUES($1,$2,$3,$4)",
      [req.method, route, res.statusCode, duration]
    ).catch(error => console.error("API metrics write failed:", error.message));
  });
  next();
});
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }));
app.use("/api", require("./routes"));
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => {
  if (err.name === "MulterError") return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong" });
});
const PORT = process.env.PORT || 3000;
init().then(() => app.listen(PORT, () => console.log("NyumbaFind running on port " + PORT)))
  .catch(e => { console.error("Database setup failed:", e.message); process.exit(1); });
