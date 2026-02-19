const fs = require("fs");
const path = require("path");

function ensureCookiesFile() {
  const raw = process.env.YT_COOKIES;

  if (!raw || raw.trim().length < 50) {
    throw new Error(
      "YT_COOKIES is missing. Add it in Render/Railway environment variables (paste full cookies.txt)."
    );
  }

  const cookiesPath = path.join(process.cwd(), "cookies.txt");
  fs.writeFileSync(cookiesPath, raw, { encoding: "utf8" });
  return cookiesPath;
}

module.exports = { ensureCookiesFile };
