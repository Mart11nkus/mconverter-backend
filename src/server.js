// src/server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { downloadAudioAndGetPath } = require("./yt");
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

// Главный эндпоинт — скачать аудио через Cobalt и отправить MP3 в Telegram
app.post("/api/youtube/send", async (req, res) => {
  let filePath = null;
  try {
    const { url, chat_id } = req.body || {};
    if (!url) return httpError(res, 400, "url is required");
    if (!chat_id) return httpError(res, 400, "chat_id is required");

    log("SEND START:", { url, chat_id });

    const dl = await downloadAudioAndGetPath(url);
    filePath = dl.filePath;
    const title = dl.title;

    log("DOWNLOADED:", { filePath, title });

    const tgResult = await sendMediaToUser({ chat_id, filePath, title });
    log("TG SENT OK");

    return res.json({ ok: true });
  } catch (e) {
    log("SEND ERROR:", e?.message || String(e));
    return httpError(res, 500, e?.message || "send failed");
  } finally {
    if (filePath) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => log("Listening on", { PORT }));
