// src/server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { ensureCookiesFile } = require("./cookies");
const { run, getInfo, downloadAudioAndGetPath } = require("./yt");
const { sendMediaToUser } = require("./tg");

process.on("unhandledRejection", (err) => {
  console.error(new Date().toISOString(), "UNHANDLED_REJECTION:", err);
});
process.on("uncaughtException", (err) => {
  console.error(new Date().toISOString(), "UNCAUGHT_EXCEPTION:", err);
  process.exit(1);
});

const app = express();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function httpError(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => res.send("ok"));
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/diag", async (req, res) => {
  try {
    const yt = await run("yt-dlp", ["--version"]);
    const ff = await run("ffmpeg", ["-version"]);
    res.json({
      ok: true,
      yt_dlp: (yt.out || "").trim(),
      ffmpeg: (ff.out || "").split("\n")[0],
    });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

app.get("/api/youtube/info", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return httpError(res, 400, "url query param is required");
    const cookiesPath = ensureCookiesFile();
    const info = await getInfo(url, cookiesPath);
    res.json({
      ok: true,
      title: info.title,
      duration: info.duration,
      uploader: info.uploader,
      id: info.id,
    });
  } catch (e) {
    log("INFO ERROR:", e?.message || String(e));
    return httpError(res, 500, e?.message || "info failed");
  }
});

// ✅ Главный эндпоинт — скачать аудио и отправить MP3 в Telegram
app.post("/api/youtube/send", async (req, res) => {
  let filePath = null;
  try {
    const { url, chat_id } = req.body || {};
    if (!url) return httpError(res, 400, "url is required");
    if (!chat_id) return httpError(res, 400, "chat_id is required");

    log("SEND START:", { url, chat_id });

    const cookiesPath = ensureCookiesFile();

    // Скачиваем аудио как MP3
    const dl = await downloadAudioAndGetPath(url, cookiesPath);
    filePath = dl.filePath;
    const title = dl.title;

    log("DOWNLOADED:", { filePath, exists: fs.existsSync(filePath) });

    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Downloaded file not found: ${filePath || "(empty)"}`);
    }

    // Отправляем MP3 в Telegram
    const tgResult = await sendMediaToUser({ chat_id, filePath, title });
    log("TG SENT OK:", tgResult);

    return res.json({ ok: true, telegram: tgResult });
  } catch (e) {
    log("SEND ERROR:", e?.message || String(e));
    return httpError(res, 500, e?.message || "send failed");
  } finally {
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
        log("CLEANUP OK:", filePath);
      } catch (e) {
        log("CLEANUP FAIL:", filePath, e?.message || String(e));
      }
    }
  }
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => log("Listening on", { PORT }));
