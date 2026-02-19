// src/cookies.js
const fs = require("fs");
const path = require("path");
const os = require("os");

function ensureCookiesFile() {
  // ⚠️ Поменяй имя, если твой secret file называется иначе
  const secretPath = "/etc/secrets/cookies.txt";

  if (!fs.existsSync(secretPath)) {
    throw new Error("Secret cookies file not found at " + secretPath);
  }

  // ✅ writable путь на Render
  const tmpPath = path.join(os.tmpdir(), "mconverter-cookies.txt");

  // копируем secret -> /tmp
  const data = fs.readFileSync(secretPath, "utf8");
  fs.writeFileSync(tmpPath, data, "utf8");

  return tmpPath;
}

module.exports = { ensureCookiesFile };
