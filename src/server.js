// src/server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const crypto = require("crypto");
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

// Хранилище джобов в памяти
const jobs = new Map();

function createJob() {
  const id = crypto.randomUUID();
  jobs.set(id, { status: "queued", error: null });
  return id;
}

function setJob(id, data) {
  jobs.set(id, { ...jobs.get(id), ...data });
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => res.send("ok"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ✅ Статус джоба — Mini App постоянно его опрашивает
app.get("/job-status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: "error", error: "Job not found" });
  res.json(job);
});

// ✅ Главный эндпоинт — Mini App шлёт сюда ссылку
app.post("/download-by-url", async (req, res) => {
  // Mini App шлёт FormData
  let url, initData;

  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("multipart/form-data")) {
    // Парсим FormData
    const multer = require("multer");
    const upload = multer().none();
    await new Promise((resolve, reject) => {
      upload(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    url = req.body?.url;
    initData = req.body?.init_data;
  } else {
    url = req.body?.url;
    initData = req.body?.init_data;
  }

  if (!url) return res.status(400).json({ ok: false, detail: "url is required" });
  if (!initData) return res.status(400).json({ ok: false, detail: "Открой из Telegram" });

  // Достаём chat_id из initData
  let chat_id;
  try {
    const params = new URLSearchParams(initData);
    const userStr = params.get("user");
    if (!userStr) throw new Error("no user");
    const user = JSON.parse(userStr);
    chat_id = user.id;
  } catch (e) {
    return res.status(400).json({ ok: false, detail: "Не удалось получить user из Telegram" });
  }

  // Создаём джоб и сразу отвечаем Mini App
  const jobId = createJob();
  res.json({ ok: true, job_id: jobId });

  // Дальше работаем в фоне
  (async () => {
    let filePath = null;
    try {
      setJob(jobId, { status: "downloading" });
      log("DOWNLOAD START:", { url, chat_id });

      const dl = await downloadAudioAndGetPath(url);
      filePath = dl.filePath;
      const title = dl.title;

      setJob(jobId, { status: "sending" });
      log("SENDING:", { filePath, title, chat_id });

      await sendMediaToUser({ chat_id, filePath, title });

      setJob(jobId, { status: "done" });
      log("DONE:", { jobId });
    } catch (e) {
      log("ERROR:", e?.message);
      setJob(jobId, { status: "error", error: e?.message || "unknown error" });
    } finally {
      if (filePath) {
        try { fs.unlinkSync(filePath); } catch (_) {}
      }
      // Удаляем джоб из памяти через 10 минут
      setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
    }
  })();
});

// Заглушка для upload-mp4 (если нажмут кнопку файла)
app.post("/upload-mp4", (req, res) => {
  res.status(400).json({ ok: false, detail: "Загрузка файлов пока не поддерживается" });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => log("Listening on", { PORT }));
