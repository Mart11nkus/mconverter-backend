// src/yt.js — Invidious API (стабильно, без cookies и токенов)
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Публичные Invidious серверы (fallback по очереди)
const INVIDIOUS_INSTANCES = [
  "https://invidious.privacydev.net",
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yt.drgnz.club",
  "https://invidious.fdn.fr",
];

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

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  throw new Error("Не удалось извлечь ID видео из ссылки");
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("JSON parse error: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    
    function doRequest(reqUrl, redirects = 0) {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      const p = reqUrl.startsWith("https") ? https : http;
      p.get(reqUrl, { timeout: 120000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          return doRequest(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      }).on("error", reject).on("timeout", () => reject(new Error("Download timeout")));
    }
    
    doRequest(url);
  });
}

async function getVideoInfo(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      console.log(`Trying instance: ${instance}`);
      const data = await fetchJson(`${instance}/api/v1/videos/${videoId}?fields=title,adaptiveFormats,formatStreams`);
      return { instance, data };
    } catch (e) {
      console.log(`Instance ${instance} failed: ${e.message}`);
    }
  }
  throw new Error("Все Invidious серверы недоступны. Попробуйте позже.");
}

function findBestAudio(data) {
  // Сначала ищем в adaptiveFormats (только аудио)
  const audioFormats = (data.adaptiveFormats || [])
    .filter(f => f.type && f.type.startsWith("audio/") && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  
  if (audioFormats.length > 0) return audioFormats[0];
  
  // Fallback — берём из обычных форматов (видео+аудио, скачаем всё)
  const formats = (data.formatStreams || []).filter(f => f.url);
  if (formats.length > 0) return formats[0];
  
  throw new Error("Не найдено аудио-форматов для этого видео");
}

async function getInfo(url) {
  const videoId = extractVideoId(url);
  const { data } = await getVideoInfo(videoId);
  return {
    id: videoId,
    title: data.title || videoId,
  };
}

async function downloadAudioAndGetPath(url) {
  const videoId = extractVideoId(url);
  console.log("Video ID:", videoId);

  const { instance, data } = await getVideoInfo(videoId);
  console.log("Got video info from:", instance);

  const audioFormat = findBestAudio(data);
  const title = data.title || videoId;
  console.log("Audio format:", audioFormat.type, "bitrate:", audioFormat.bitrate);

  const outDir = ensureTmpDir();
  const base = safeName(title);
  
  // Определяем расширение
  let ext = "m4a";
  if (audioFormat.type?.includes("webm") || audioFormat.type?.includes("opus")) ext = "webm";
  else if (audioFormat.type?.includes("mp4")) ext = "m4a";
  
  const tmpPath = path.join(outDir, `${base}_${videoId}.${ext}`);
  
  console.log("Downloading to:", tmpPath);
  await downloadFile(audioFormat.url, tmpPath);
  console.log("Downloaded successfully");

  if (!fs.existsSync(tmpPath)) {
    throw new Error("Файл не скачался");
  }

  return { filePath: tmpPath, title };
}

module.exports = { getInfo, downloadAudioAndGetPath };
