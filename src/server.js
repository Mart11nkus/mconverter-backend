// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");

const { ensureCookiesFile } = require("./cookies");
const { run, getInfo, downloadVideoAndGetPath } = require("./yt");
const { sendMediaToUser } = require("./tg");

const app = express();

/** ===== CORS ===== */
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());

/** ===== Body parsing =====
 * Тут JSON только для {url, chat_id}. Видео через JSON не шлём.
 */
app.use(express.json({ limit: "2mb" }));

/** ===== Helpers ===== */
function httpError(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

// Чтобы в Render логи были понятные:
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** ===== Routes ===== */
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * Диагностика: проверяем что yt-dlp и ffmpeg реально доступны
 */
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

/**
 * /api/youtube/info?url=...
 */
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
    log("INFO ERROR:", e.message);
    return httpError(res, 500, e.message);
  }
});

/**
 * ГЛАВНОЕ:
 * WebApp -> POST /api/youtube/send
 * body: { url, chat_id }
 */
app.post("/api/youtube/send", async (req, res) => {
  let filePath = null;

  try {
    const { url, chat_id } = req.body || {};
    if (!url) return httpError(res, 400, "url is required");
    if (!chat_id) return httpError(res, 400, "chat_id is required");

    log("SEND START:", { url, chat_id });

    const cookiesPath = ensureCookiesFile();

    // 1) Получаем инфу (для названия)
    const info = await getInfo(url, cookiesPath);
    log("INFO OK:", { title: info?.title, id: info?.id, duration: info?.duration });

    // 2) Скачиваем файл (Render-safe: /tmp)
    const dl = await downloadVideoAndGetPath(url, cookiesPath);
    filePath = dl.filePath;

    log("DOWNLOADED:", { filePath, exists: fs.existsSync(filePath) });

    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Downloaded file not found: ${filePath || "(empty)"}`);
    }

    // 3) Отправляем в Telegram
    const tgResult = await sendMediaToUser({
      chat_id,
      filePath,
      title: info?.title || "video",
    });

    log("TG SENT OK:", tgResult);

    // 4) Ответ клиенту
    res.json({ ok: true, telegram: tgResult });
  } catch (e) {
    log("SEND ERROR:", e.message);
    return httpError(res, 500, e.message);
  } finally {
    // 5) Чистим файл (чтобы /tmp не забивался)
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
        log("CLEANUP OK:", filePath);
      } catch (e) {
        log("CLEANUP FAIL:", filePath, e.message);
      }
    }
  }
});

/** ===== Server start ===== */
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => log("Listening on", { HOST, PORT }));
