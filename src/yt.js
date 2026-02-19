c// yt.js
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Универсальный запуск команд с захватом stdout/stderr
function run(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";

    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("error", (e) => reject(new Error(`${command} spawn error: ${e.message}`)));

    p.on("close", (code) => {
      if (code === 0) return resolve({ out, err });
      reject(new Error((err || out || `exit code ${code}`).slice(-6000)));
    });
  });
}

// /tmp — единственное место, куда безопасно писать на Render
function ensureTmpDir() {
  const dir = path.join(os.tmpdir(), "mconverter");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// чуть чистим имя файла от запрещённых символов
function safeName(s) {
  return String(s || "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function getInfo(url, cookiesPath) {
  const args = [
    "--cookies", cookiesPath,
    "--add-header", "User-Agent: Mozilla/5.0",
    "--sleep-interval", "1",
    "--max-sleep-interval", "3",
    "--extractor-args", "youtube:player_client=web",
    "--geo-bypass",
    "--dump-json",
    "--no-warnings",
    url
  ];

  const { out } = await run("yt-dlp", args);
  return JSON.parse(out);
}

// ✅ скачиваем видео, кладём в /tmp/mconverter, возвращаем реальный путь
async function downloadVideoAndGetPath(url, cookiesPath) {
  const outDir = ensureTmpDir();

  // сначала возьмём info, чтобы сделать предсказуемое имя
  let info = null;
  try {
    info = await getInfo(url, cookiesPath);
  } catch (_) {
    // не критично, имя сделаем по времени
  }

  const base = safeName(info?.title || "video");
  const id = safeName(info?.id || String(Date.now()));
  const outTemplate = path.join(outDir, `${base} [${id}].%(ext)s`);

  const args = [
    "--cookies", cookiesPath,
    "--add-header", "User-Agent: Mozilla/5.0",
    "--sleep-interval", "1",
    "--max-sleep-interval", "3",
    "--extractor-args", "youtube:player_client=web",
    "--geo-bypass",

    "-f", "bv*+ba/best",
    "--merge-output-format", "mp4",

    "-o", outTemplate,

    // печатаем путь реально созданного файла
    "--print", "after_move:filepath",
    "--no-warnings",
    url
  ];

  const { out, err } = await run("yt-dlp", args);

  // yt-dlp может печатать много строк, берём последнюю непустую
  const lines = out.split("\n").map(s => s.trim()).filter(Boolean);
  const filePath = lines[lines.length - 1];

  if (!filePath) {
    throw new Error(`Cannot determine downloaded file path.\n${(err || out).slice(-4000)}`);
  }

  // ✅ главное: проверяем что файл реально существует
  if (!fs.existsSync(filePath)) {
    // иногда yt-dlp печатает относительный путь — попробуем резолвить относительно outDir
    const alt = path.isAbsolute(filePath) ? filePath : path.join(outDir, filePath);
    if (!fs.existsSync(alt)) {
      throw new Error(
        `Downloaded file does not exist.\n` +
        `filePath="${filePath}"\n` +
        `alt="${alt}"\n` +
        `${(err || out).slice(-4000)}`
      );
    }
    return { filePath: alt, log: out };
  }

  return { filePath, log: out };
}

module.exports = { run, getInfo, downloadVideoAndGetPath };
