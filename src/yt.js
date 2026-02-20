// src/yt.js — использует RapidAPI YouTube MP3
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

async function downloadAudioAndGetPath(url) {
  if (!RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY не задан в переменных окружения");

  // 1. Запрашиваем ссылку на MP3
  const searchRes = await fetch(
    `https://youtube-mp36.p.rapidapi.com/dl?id=${extractYouTubeId(url)}`,
    {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": "youtube-mp36.p.rapidapi.com",
      },
    }
  );

  if (!searchRes.ok) {
    throw new Error(`RapidAPI HTTP error: ${searchRes.status}`);
  }

  const data = await searchRes.json();

  if (data.status !== "ok" || !data.link) {
    throw new Error(`RapidAPI error: ${data.msg || JSON.stringify(data)}`);
  }

  const mp3Url = data.link;
  const title = safeName(data.title || "audio");

  // 2. Скачиваем MP3 файл
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

function extractYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  if (!match) throw new Error("Не удалось извлечь ID видео из ссылки");
  return match[1];
}

module.exports = { downloadAudioAndGetPath };
