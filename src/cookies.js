// src/cookies.js
const fs = require("fs");
const path = require("path");
const os = require("os");

function ensureCookiesFile() {
  const cookiesText = process.env.YTDLP_COOKIES;

  if (!cookiesText || !cookiesText.trim()) {
    throw new Error(
      "YTDLP_COOKIES env is missing. Add it in Render Environment (paste full cookies.txt content)."
    );
  }

  // Render-safe path
  const p = path.join(os.tmpdir(), "mconverter-cookies.txt");

  // перезаписываем каждый раз (кукисы могли обновиться)
  fs.writeFileSync(p, cookiesText, "utf8");

  // маленькая проверка, что файл реально есть
  if (!fs.existsSync(p)) {
    throw new Error("Failed to create cookies file in /tmp");
  }

  return p;
}

module.exports = { ensureCookiesFile };
