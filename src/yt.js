// src/yt.js — использует Cobalt API, cookies не нужны совсем
const fs = require("fs");
const path = require("path");
const os = require("os");

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

// Cobalt — бесплатный публичный API для скачивания аудио
// Docs: https://github.com/imputnet/cobalt
async function downloadAudioAndGetPath(url) {
  // 1. Запрашиваем у Cobalt ссылку на аудио
  const cobaltRes = await fetch("https://api.cobalt.tools/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      url: url,
      downloadMode: "audio",   // только аудио
      audioFormat: "mp3",      // формат MP3
      audioBitrate: "192",     // качество
    }),
  });

  if (!cobaltRes.ok) {
    throw new Error(`Cobalt API HTTP error: ${cobaltRes.status}`);
  }

  const cobalt = await cobaltRes.json();

  // Cobalt возвращает status: "tunnel" или "redirect" со ссылкой
  if (cobalt.status === "error") {
    throw new Error(`Cobalt error: ${cobalt.error?.code || JSON.stringify(cobalt)}`);
  }

  const audioUrl = cobalt.url;
  if (!audioUrl) {
    throw new Error(`Cobalt did not return a download URL: ${JSON.stringify(cobalt)}`);
  }

  // 2. Скачиваем файл по ссылке от Cobalt
  const outDir = ensureTmpDir();
  const fileName = `audio_${Date.now()}.mp3`;
  const filePath = path.join(outDir, fileName);

  const fileRes = await fetch(audioUrl);
  if (!fileRes.ok) {
    throw new Error(`Failed to download audio file: ${fileRes.status}`);
  }

  const buffer = await fileRes.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(buffer));

  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new Error("Downloaded file is empty or missing");
  }

  // Пытаемся достать название из заголовков ответа
  const disposition = fileRes.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=["']?(?:UTF-8'')?([^"';\n]+)/i);
  const title = match
    ? decodeURIComponent(match[1]).replace(/\.mp3$/i, "").trim()
    : safeName(cobalt.filename || "audio");

  return { filePath, title };
}

module.exports = { downloadAudioAndGetPath };
