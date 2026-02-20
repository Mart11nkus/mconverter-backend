// src/yt.js — RapidAPI YouTube MP3 с повторными попытками
const fs = require("fs");
const path = require("path");
const os = require("os");

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadAudioAndGetPath(url) {
  if (!RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY не задан в переменных окружения");

  const videoId = extractYouTubeId(url);

  // RapidAPI иногда конвертирует не сразу — опрашиваем до 10 раз
  let mp3Url = null;
  let title = "audio";

  for (let attempt = 1; attempt <= 10; attempt++) {
    console.log(`RapidAPI attempt ${attempt} for ${videoId}`);

    const res = await fetch(
      `https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`,
      {
        method: "GET",
        headers: {
          "X-RapidAPI-Key": RAPIDAPI_KEY,
          "X-RapidAPI-Host": "youtube-mp36.p.rapidapi.com",
        },
      }
    );

    if (!res.ok) {
      throw new Error(`RapidAPI HTTP error: ${res.status}`);
    }

    const data = await res.json();
    console.log(`RapidAPI response:`, JSON.stringify(data).slice(0, 200));

    if (data.status === "ok" && data.link) {
      mp3Url = data.link;
      title = safeName(data.title || "audio");
      break;
    }

    // Если статус processing/progress — ждём и пробуем снова
    if (
      data.status === "processing" ||
      data.status === "progress" ||
      data.msg?.includes("processing") ||
      data.msg?.includes("progress")
    ) {
      await sleep(3000);
      continue;
    }

    // Любая другая ошибка — бросаем
    throw new Error(`RapidAPI error: ${data.msg || JSON.stringify(data)}`);
  }

  if (!mp3Url) {
    throw new Error("RapidAPI: видео конвертируется слишком долго, попробуй ещё раз");
  }

  // Скачиваем MP3
  const outDir = ensureTmpDir();
  const filePath = path.join(outDir, `${title}_${Date.now()}.mp3`);

  const fileRes = await fetch(mp3Url);
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
