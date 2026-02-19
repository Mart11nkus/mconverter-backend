const { spawn } = require("child_process");

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

async function getInfo(url, cookiesPath) {
  const args = [
    "--cookies", cookiesPath,
    "--add-header", "User-Agent: Mozilla/5.0",
    "--dump-json",
    "--no-warnings",
    url
  ];

  const { out } = await run("yt-dlp", args);
  return JSON.parse(out);
}

// Скачиваем и возвращаем ПОЛНЫЙ путь к файлу через --print after_move:filepath
async function downloadVideoAndGetPath(url, cookiesPath) {
  const args = [
    "--cookies", cookiesPath,
    "--add-header", "User-Agent: Mozilla/5.0",

    // делаем выход более стабильным для Telegram
    "-f", "bv*+ba/best",
    "--merge-output-format", "mp4",

    "-o", "downloads/%(title).200B [%(id)s].%(ext)s",

    "--print", "after_move:filepath",
    "--no-warnings",
    url
  ];

  const { out } = await run("yt-dlp", args);

  // yt-dlp может печатать несколько строк, берём последнюю непустую
  const lines = out.split("\n").map(s => s.trim()).filter(Boolean);
  const filePath = lines[lines.length - 1];

  if (!filePath) throw new Error("Cannot determine downloaded file path");
  return { filePath, log: out };
}

module.exports = { run, getInfo, downloadVideoAndGetPath };
