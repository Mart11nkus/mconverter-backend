const fs = require("fs");
const path = require("path");

function ensureCookiesFile() {
  const raw = process.env.YT_COOKIES;

  if (!raw || raw.trim().length < 50) {
    throw new Error("YT_COOKIES is missing or too short");
  }

  // Диагностика: длина (без содержимого)
  console.log("YT_COOKIES length:", raw.length);

  const cookiesPath = path.join(process.cwd(), "cookies.txt");
  fs.writeFileSync(cookiesPath, raw, { encoding: "utf8" });

  return cookiesPath;
}

module.exports = { ensureCookiesFile };
