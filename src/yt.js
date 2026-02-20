// src/yt.js — Piped API + Invidious fallback
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.coldmirror.de",
  "https://pipedapi.in.projectsegfau.lt",
  "https://pipedapi.drgns.space",
  "https://piped-api.garudalinux.org",
  "https://api.piped.projectsegfau.lt",
];

const INVIDIOUS_INSTANCES = [
  "https://invidious.privacydev.net",
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
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

function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, {
      timeout: timeoutMs,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      }
    }, (res) => {
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
    const file = fs.createWriteStream(destPath);

    function doRequest(reqUrl, redirects = 0) {
      if (redirects > 10) return reject(new Error("Too many redirects"));
      const proto = reqUrl.startsWith("https") ? https : http;
      proto.get(reqUrl, {
        timeout: 180000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://www.youtube.com/",
        }
      }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          return doRequest(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error(`Download HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", (e) => { file.close(); reject(e); });
      }).on("error", (e) => { file.close(); reject(e); })
        .on("timeout", () => { file.close(); reject(new Error("Download timeout")); });
    }

    doRequest(url);
  });
}

async function getPipedStreams(videoId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      console.log(`Piped: trying ${instance}`);
      const data = await fetchJson(`${instance}/streams/${videoId}`, 12000);
      if (data.audioStreams && data.audioStreams.length > 0) {
        return { title: data.title, streams: data.audioStreams };
      }
    } catch (e) {
      console.log(`Piped ${instance} failed: ${e.message}`);
    }
  }
  return null;
}

async function getInvidiousStreams(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      console.log(`Invidious: trying ${instance}`);
      const data = await fetchJson(`${instance}/api/v1/videos/${videoId}?fields=title,adaptiveFormats,formatStreams`, 12000);
      const audioFormats = (data.adaptiveFormats || [])
        .filter(f => f.type && f.type.startsWith("audio/") && f.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (audioFormats.length > 0) {
        return { title: data.title, streams: audioFormats.map(f => ({ url: f.url, mimeType: f.type, bitrate: f.bitrate })) };
      }
    } catch (e) {
      console.log(`Invidious ${instance} failed: ${e.message}`);
    }
  }
  return null;
}

async function downloadAudioAndGetPath(url) {
  const videoId = extractVideoId(url);
  console.log("Video ID:", videoId);

  let result = await getPipedStreams(videoId);

  if (!result) {
    console.log("Piped failed, trying Invidious...");
    result = await getInvidiousStreams(videoId);
  }

  if (!result) {
    throw new Error("Не удалось получить ссылку на аудио. YouTube временно недоступен через прокси.");
  }

  const { title, streams } = result;
  const sorted = [...streams].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const m4a = sorted.find(s => s.mimeType?.includes("m4a") || s.mimeType?.includes("mp4"));
  const best = m4a || sorted[0];

  console.log("Best stream:", best.mimeType, "bitrate:", best.bitrate);

  const outDir = ensureTmpDir();
  const base = safeName(title || videoId);
  let ext = "m4a";
  if (best.mimeType?.includes("webm") || best.mimeType?.includes("opus")) ext = "webm";

  const tmpPath = path.join(outDir, `${base}_${videoId}.${ext}`);
  console.log("Downloading to:", tmpPath);

  await downloadFile(best.url, tmpPath);

  if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 1000) {
    throw new Error("Файл скачался пустым или повреждён");
  }

  console.log("Downloaded:", fs.statSync(tmpPath).size, "bytes");
  return { filePath: tmpPath, title: title || base };
}

async function getInfo(url) {
  const videoId = extractVideoId(url);
  const result = await getPipedStreams(videoId) || await getInvidiousStreams(videoId);
  return { id: videoId, title: result?.title || videoId };
}

module.exports = { getInfo, downloadAudioAndGetPath };
