// src/server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const multer = require("multer");
const { downloadAudioAndGetPath } = require("./yt");
const { sendMediaToUser } = require("./tg");

process.on("unhandledRejection", (err) => console.error(new Date().toISOString(), "UNHANDLED:", err));
process.on("uncaughtException", (err) => { console.error(new Date().toISOString(), "UNCAUGHT:", err); process.exit(1); });

const app = express();
const jobs = new Map();

function log(...args) { console.log(new Date().toISOString(), ...args); }
function createJob() { const id = crypto.randomUUID(); jobs.set(id, { status: "queued", error: null }); return id; }
function setJob(id, data) { jobs.set(id, { ...jobs.get(id), ...data }); }

function ensureTmpDir() {
  const dir = path.join(os.tmpdir(), "mconverter");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(s) {
  return String(s || "").replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}

function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-i", inputPath, "-vn", "-ar", "44100", "-ac", "2", "-b:a", "192k", "-y", outputPath]);
    let err = "";
    p.stderr.on("data", d => err += d);
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve() : reject(new Error("ffmpeg error: " + err.slice(-500))));
  });
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => res.send("ok"));
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/job-status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: "error", error: "Job not found" });
  res.json(job);
});

app.post("/download-by-url", async (req, res) => {
  let url, initData;
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    const upload = multer().none();
    await new Promise((resolve, reject) => upload(req, res, err => err ? reject(err) : resolve()));
  }
  url = req.body?.url;
  initData = req.body?.init_data;

  if (!url) return res.status(400).json({ ok: false, detail: "url is required" });
  if (!initData) return res.status(400).json({ ok: false, detail: "Открой из Telegram" });

  let chat_id;
  try {
    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get("user"));
    chat_id = user.id;
  } catch (e) {
    return res.status(400).json({ ok: false, detail: "Не удалось получить user из Telegram" });
  }

  const jobId = createJob();
  res.json({ ok: true, job_id: jobId });

  (async () => {
    let filePath = null;
    try {
      setJob(jobId, { status: "downloading" });
      log("DOWNLOAD START:", { url, chat_id });
      const dl = await downloadAudioAndGetPath(url);
      filePath = dl.filePath;
      setJob(jobId, { status: "sending" });
      await sendMediaToUser({ chat_id, filePath, title: dl.title, thumbPath: dl.thumbPath });
      setJob(jobId, { status: "done" });
    } catch (e) {
      log("ERROR:", e?.message);
      setJob(jobId, { status: "error", error: e?.message || "unknown error" });
    } finally {
      if (filePath) try { fs.unlinkSync(filePath); } catch (_) {}
      setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
    }
  })();
});

// MP4 → MP3 конвертация
const upload = multer({ dest: ensureTmpDir(), limits: { fileSize: 200 * 1024 * 1024 } });

app.post("/upload-mp4", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, detail: "Файл не получен" });

  const initData = req.body?.init_data;
  if (!initData) return res.status(400).json({ ok: false, detail: "Открой из Telegram" });

  let chat_id;
  try {
    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get("user"));
    chat_id = user.id;
  } catch (e) {
    return res.status(400).json({ ok: false, detail: "Не удалось получить user из Telegram" });
  }

  const jobId = createJob();
  res.json({ ok: true, job_id: jobId });

  (async () => {
    const inputPath = req.file.path;
    const title = safeName(path.basename(req.file.originalname, path.extname(req.file.originalname)));
    const outputPath = inputPath + ".mp3";

    try {
      setJob(jobId, { status: "converting" });
      log("CONVERTING:", { inputPath, title, chat_id });
      await convertToMp3(inputPath, outputPath);
      setJob(jobId, { status: "sending" });
      await sendMediaToUser({ chat_id, filePath: outputPath, title, thumbPath: null });
      setJob(jobId, { status: "done" });
    } catch (e) {
      log("ERROR:", e?.message);
      setJob(jobId, { status: "error", error: e?.message || "unknown error" });
    } finally {
      try { fs.unlinkSync(inputPath); } catch (_) {}
      try { fs.unlinkSync(outputPath); } catch (_) {}
      setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
    }
  })();
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => log("Listening on", { PORT }));
