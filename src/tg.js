// src/tg.js
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NAME = "@Martinkusconverter_bot";

async function tgRequest(method, formData) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    body: formData,
    headers: formData.getHeaders(),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data.result;
}

async function sendMediaToUser({ chat_id, filePath, title }) {
  const caption = `🎵 ${title}\n\n${BOT_NAME}`.trim();

  const form = new FormData();
  form.append("chat_id", String(chat_id));
  form.append("caption", caption);
  form.append("title", title);
  form.append("performer", BOT_NAME);
  // Отправляем как аудио — появится как музыкальный трек в чате
  form.append("audio", fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: "audio/mpeg",
  });

  return tgRequest("sendAudio", form);
}

module.exports = { sendMediaToUser };
