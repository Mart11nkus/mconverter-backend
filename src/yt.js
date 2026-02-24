// src/yt.js — cobalt.tools API
const https = require("https");
const http = require("http");
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

function postJson(url, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj = new URL(url);
    const proto = url.startsWith("https") ? https : http;
    const req = proto.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error("JSON parse error: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(payload);
    req.end();
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    function doRequest(reqUrl, redirects = 0) {
      if (redirects > 10) return reject(new Error("Too many redirects"));
      const proto = reqUrl.startsWith("https") ? https : http;
      proto.get(reqUrl, { timeout: 180000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          return doRequest(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error(`Download HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", e => { file.close(); reject(e); });
      }).on("error", e => { file.close(); reject(e); })
        .on("timeout", () => { file.close(); reject(new Error("Download timeout")); });
    }
    doRequest(url);
  });
}

async function downloadAudioAndGetPath(url) {
  console.log("cobalt: requesting", url);

  const { status, body } = await postJson("https://api.cobalt.tools/", {
    url: url,
    downloadMode: "audio",
    audioFormat: "mp3",
    audioBitrate: "128",
  });

  console.log("cobalt response:", status, JSON.stringify(body).slice(0, 200));

  if (status !== 200) {
    throw new Error(`cobalt HTTP ${status}: ${JSON.stringify(body)}`);
  }

  // cobalt возвращает: { status: "tunnel"|"redirect"|"picker", url, filename }
  if (body.status === "error") {
    throw new Error(`cobalt error: ${body.error?.code || JSON.stringify(body)}`);
  }

  const downloadUrl = body.url;
  if (!downloadUrl) {
    throw new Error("cobalt не вернул URL: " + JSON.stringify(body));
  }

  const title = safeName(body.filename?.replace(/\.mp3$/, "") || "audio");
  const outDir = ensureTmpDir();
  const tmpPath = path.join(outDir, `${title}_${Date.now()}.mp3`);

  console.log("Downloading from cobalt to:", tmpPath);
  await downloadFile(downloadUrl, tmpPath);

  const size = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
  if (size < 1000) throw new Error("Файл скачался пустым");

  console.log("Downloaded:", size, "bytes");
  return { filePath: tmpPath, title };
}

async function getInfo(url) {
  return { id: url, title: "audio" };
}

module.exports = { getInfo, downloadAudioAndGetPath };
