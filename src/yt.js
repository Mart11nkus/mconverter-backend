// src/yt.js — YouTube MP3 Audio Video Downloader (Spicy-Laika)
const fs = require("fs");
const path = require("path");
const os = require("os");

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "youtube-mp3-audio-video-downloader.p.rapidapi.com";

function ensureTmpDir() {
  const dir = path.join(os.tmpdir(), "mconverter");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(s) {
  return String(s || "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function extractYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  if (!match) throw new Error("Не удалось извлечь ID видео из ссылки");
  return match[1];
}

async function downloadAudioAndGetPath(url) {
  if (!RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY не задан в переменных окружения");

  const videoId = extractYouTubeId(url);

  // 1. Получаем прямую ссылку на MP3
  // wait_until_the_file_is_ready=true — API сам ждёт пока файл готов
  const apiRes = await fetch(
    `https://${RAPIDAPI_HOST}/get_mp3_download_link/${videoId}?quality=low&wait_until_the_file_is_ready=true`,
    {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST,
      },
    }
  );

  if (!apiRes.ok) {
    throw new Error(`RapidAPI HTTP error: ${apiRes.status}`);
  }

  const data = await apiRes.json();
  console.log("API response:", JSON.stringify(data).slice(0, 300));

  // Достаём ссылку — может быть в разных полях
  const mp3Url = data.url || data.link || data.download_url || data.mp3_url;
  const title = safeName(data.title || data.name || "audio");

  if (!mp3Url) {
    throw new Error(`API не вернул ссылку на MP3: ${JSON.stringify(data).slice(0, 300)}`);
  }

  // 2. Скачиваем MP3
  const outDir = ensureTmpDir();
  const filePath = path.join(outDir, `${title}_${Date.now()}.mp3`);

  const fileRes = await fetch(mp3Url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; bot)",
    },
  });

  if (!fileRes.ok) {
    throw new Error(`Ошибка скачивания MP3: ${fileRes.status}`);
  }

  const buffer = await fileRes.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(buffer));

  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new Error("Файл пустой или не скачался");
  }

  return { filePath, title };
}

module.exports = { downloadAudioAndGetPath };
