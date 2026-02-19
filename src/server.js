const express = require("express");
const fs = require("fs");
const path = require("path");

const { ensureCookiesFile } = require("./cookies");
const { ytInfo, ytDownload } = require("./yt");

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

// 1) Проверка: получает инфу о видео
app.post("/api/youtube/info", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: "url is required" });

    const cookiesPath = ensureCookiesFile();
    const info = await ytInfo({ url, cookiesPath });

    res.json({
      ok: true,
      title: info.title,
      id: info.id,
      duration: info.duration,
      uploader: info.uploader,
      webpage_url: info.webpage_url
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// 2) Скачивание (файлы кладёт в /downloads)
app.post("/api/youtube/download", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: "url is required" });

    const cookiesPath = ensureCookiesFile();

    const dir = path.join(process.cwd(), "downloads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const log = await ytDownload({ url, cookiesPath });

    res.json({ ok: true, log: log.slice(-4000) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Backend running on port", port));
