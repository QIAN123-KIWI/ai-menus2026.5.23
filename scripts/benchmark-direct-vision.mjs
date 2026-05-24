import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const imagePath = process.argv[2];
const model = process.argv[3];
const timeoutMs = Number(process.argv[4] || 120000);

if (!imagePath || !model) {
  console.error(
    "Usage: node scripts/benchmark-direct-vision.mjs <imagePath> <model> [timeoutMs]",
  );
  process.exit(1);
}

const apiKey =
  process.env.SILICONFLOW_API_KEY || process.env.VITE_SILICONFLOW_API_KEY || "";

if (!apiKey) {
  console.error("Missing SiliconFlow API key");
  process.exit(1);
}

const imageBuffer = fs.readFileSync(imagePath);
const ext = path.extname(imagePath).toLowerCase();
const mimeType =
  ext === ".png"
    ? "image/png"
    : ext === ".webp"
      ? "image/webp"
      : "image/jpeg";
const imageUrl = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
const startedAt = Date.now();

try {
  const response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      temperature: 0.05,
      messages: [
        {
          role: "system",
          content: [
            "You are a multilingual restaurant menu reader.",
            "Read the image and return JSON only.",
            "Return an array of objects with original, translation, price, currency, category, lang_code, pronunciation, desc.",
            "translation must be natural Simplified Chinese.",
            "Keep original exactly in source language.",
            "Use concise Simplified Chinese categories.",
            "Do not include section headings, notes, warnings, counts-only labels, or pure price labels as dishes.",
            "When a row is a combo, side, topping, or drink, keep it if it is actually orderable.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: imageUrl,
                detail: "high",
              },
            },
            {
              type: "text",
              text: "Extract every real sellable menu item from this image and translate them into Simplified Chinese JSON.",
            },
          ],
        },
      ],
    }),
  });

  const responseText = await response.text();
  const elapsedMs = Date.now() - startedAt;

  let content = responseText;
  try {
    const payload = JSON.parse(responseText);
    const message = payload?.choices?.[0]?.message?.content;
    if (Array.isArray(message)) {
      content = message.map((part) => (typeof part === "string" ? part : part?.text || "")).join("\n");
    } else if (typeof message === "string") {
      content = message;
    }
  } catch {}

  console.log(
    JSON.stringify(
      {
        model,
        status: response.status,
        elapsedMs,
        snippet: content.slice(0, 4000),
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timer);
}
