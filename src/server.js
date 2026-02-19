const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const { ensureCookiesFile } = require("./cookies");
const { run, getInfo, downloadVideo } = require("./yt");

const app = express();

app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options("*", cors());

app.use(express.json({ limit: "2mb" }));

// ✅ health check
app.get("/health", (req, res) => res.json({ ok: true }));

// ✅ diag: проверка что yt-dlp и ffmpeg реально стоят
app.get("/diag", async (req, res) => {
  try {
    const yt = await run("yt-dlp", ["--version"]);
    const ff = await run("ffmpeg", ["-version"]);
    res.json({
      ok: true,
      yt_dlp: (yt.out || "").trim(),
      ffmpeg: (ff.out || "").split("\n")[0]
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

//
// ✅ GET-версии для проверки прямо в браузере:
// /api/youtube/info?url=...
// /api/youtube/download?url=...
//

app.get("/api/youtube/info", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ ok: false, error: "url query param is required" });

    const cookiesPath = ensureCookiesFile();
    const info = await getInfo(url, cookiesPath);

    res.json({
      ok: true,
      title: info.title,
      duration: info.duration,
      uploader: info.uploader,
      id: info.id
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/youtube/download", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ ok: false, error: "url query param is required" });

    const cookiesPath = ensureCookiesFile();

    const dir = path.join(process.cwd(), "downloads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const log = await downloadVideo(url, cookiesPath);
    res.json({ ok: true, log: (log || "").slice(-4000) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

//
// ✅ POST-версии для фронта (как и было)
//

app.post("/api/youtube/info", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "url is required" });

    const cookiesPath = ensureCookiesFile();
    const info = await getInfo(url, cookiesPath);

    res.json({
      ok: true,
      title: info.title,
      duration: info.duration,
      uploader: info.uploader,
      id: info.id
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/youtube/download", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "url is required" });

    const cookiesPath = ensureCookiesFile();

    const dir = path.join(process.cwd(), "downloads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const log = await downloadVideo(url, cookiesPath);
    res.json({ ok: true, log: (log || "").slice(-4000) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log("Listening on", { HOST, PORT });
});
