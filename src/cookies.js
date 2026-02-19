const fs = require("fs");
const path = require("path");

function ensureCookiesFile() {
  const secretPath = "/etc/secrets/cookies.txt";
  const localPath = path.join(process.cwd(), "cookies.txt");

  if (fs.existsSync(secretPath)) {
    // копируем из read-only secret в обычный файл (writable)
    fs.copyFileSync(secretPath, localPath);
    return localPath;
  }

  const raw = process.env.YT_COOKIES;
  if (!raw || raw.trim().length < 50) {
    throw new Error("Cookies missing: add Render Secret File cookies.txt OR set YT_COOKIES env var.");
  }

  fs.writeFileSync(localPath, raw, { encoding: "utf8" });
  return localPath;
}

module.exports = { ensureCookiesFile };
