const express = require("express");
const cors = require("cors");

const { ensureCookiesFile } = require("./cookies");
const { run, getInfo, downloadVideoAndGetPath } = require("./yt");
const { sendMediaToUser } = require("./tg");

const app = express();

app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options("*", cors());

app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

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

// ✅ Проверка в браузере:
// /api/youtube/info?url=...
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

// ✅ ГЛАВНОЕ: скачать и отправить пользователю в Telegram
// POST /api/youtube/send
// body: { "url": "...", "chat_id": 123456789 }
app.post("/api/youtube/send", async (req, res) => {
  try {
    const { url, chat_id } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "url is required" });
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id is required" });

    const cookiesPath = ensureCookiesFile();

    // 1) получаем мету (название для подписи)
    const info = await getInfo(url, cookiesPath);

    // 2) скачиваем и узнаём путь к файлу
    const { filePath } = await downloadVideoAndGetPath(url, cookiesPath);

    // 3) отправляем пользователю
    const tgResult = await sendMediaToUser({
      chat_id,
      filePath,
      title: info.title
    });

    res.json({ ok: true, telegram: tgResult });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => console.log("Listening on", { HOST, PORT }));
