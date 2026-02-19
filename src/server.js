const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const { ensureCookiesFile } = require("./cookies");
const { getInfo, downloadVideo } = require("./yt");

const app = express();

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/youtube/info", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });

    const cookiesPath = ensureCookiesFile();
    const info = await getInfo(url, cookiesPath);

    res.json({
      ok: true,
      title: info.title,
      duration: info.duration,
      uploader: info.uploader
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/youtube/download", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });

    const cookiesPath = ensureCookiesFile();

    const dir = path.join(process.cwd(), "downloads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);

    const log = await downloadVideo(url, cookiesPath);

    res.json({ ok: true, log: log.slice(-3000) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
