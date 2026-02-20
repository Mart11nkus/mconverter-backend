// src/yt.js — YouTube MP3 Audio Video Downloader (Spicy-Laika) с polling
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getMp3Url(videoId) {
  // Первый запрос — API начинает готовить файл
  // Потом повторяем каждые 15 сек пока не получим ссылку (макс 5 минут)
  const maxAttempts = 20;
  const delayMs = 15000; // 15 секунд между попытками

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      console.log(`Попытка ${i + 1}/${maxAttempts}, ждём...`);
      await sleep(delayMs);
    }

    const apiRes = await fetch(
      `https://${RAPIDAPI_HOST}/get_mp3_download_link/${videoId}?quality=low&wait_until_the_file_is_ready=false`,
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
    console.log(`Ответ API (попытка ${i + 1}):`, JSON.stringify(data).slice(0, 200));

    // Если есть ссылка — возвращаем
    const mp3Url = data.url || data.link || data.download_url || data.mp3_url;
    if (mp3Url && !data.comment) {
      return { mp3Url, title: safeName(data.title || data.name || "audio") };
    }

    // Если API говорит "скоро будет готово" — ждём и повторяем
    if (data.comment && data.comment.includes("will soon be ready")) {
      continue;
    }

    throw new Error(`Неожиданный ответ API: ${JSON.stringify(data).slice(0, 300)}`);
  }

  throw new Error("Таймаут: API слишком долго готовит файл (>5 минут)");
}

async function downloadAudioAndGetPath(url) {
  if (!RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY не задан в переменных окружения");

  const videoId = extractYouTubeId(url);
  console.log("Запрашиваем MP3 для videoId:", videoId);

  const { mp3Url, title } = await getMp3Url(videoId);
  console.log("Получили ссылку, скачиваем...");

  // Скачиваем MP3
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

  console.log("Файл скачан:", filePath);
  return { filePath, title };
}

module.exports = { downloadAudioAndGetPath };
