import type {
  FoodIllustration,
  MenuItem,
  RawRecognizedMenuItem,
  RecognizedMenuItem,
  Settings,
} from "./types";

const API_URL = "https://api.siliconflow.cn/v1/chat/completions";
const IMAGE_API_URL = "https://api.siliconflow.cn/v1/images/generations";
const OCR_CONCURRENCY = 3;
const NORMALIZE_TIMEOUT_MS = 12000;
const OCR_FAST_PASS_MIN_ITEMS = 5;
const SCAN_CACHE_PREFIX = "aimenu-v5-scan-cache";
const SCAN_CACHE_VERSION = "v2";
const DEFAULT_MODEL =
  import.meta.env.VITE_SILICONFLOW_MODEL || "moonshotai/Kimi-K2-Instruct-0905";
const DEFAULT_VISION_MODEL =
  import.meta.env.VITE_SILICONFLOW_VISION_MODEL ||
  "Qwen/Qwen3-VL-32B-Instruct";
const DEFAULT_IMAGE_MODEL =
  import.meta.env.VITE_SILICONFLOW_IMAGE_MODEL ||
  "Qwen/Qwen-Image";
const DEFAULT_IMAGE_SIZE = "512x512";
const TEXT_MODEL_FALLBACKS = [
  DEFAULT_MODEL,
  "moonshotai/Kimi-K2-Thinking",
  "deepseek-ai/DeepSeek-V3.2",
];
const VISION_MODEL_FALLBACKS = [
  DEFAULT_VISION_MODEL,
  "deepseek-ai/DeepSeek-OCR",
  "Qwen/Qwen3-VL-30B-A3B-Instruct",
];
const IMAGE_MODEL_FALLBACKS = [DEFAULT_IMAGE_MODEL, "Qwen/Qwen-Image"];
const CATEGORY_LABEL = "菜单识别结果";

const CATEGORY_COLORS = [
  "#D8C3A5",
  "#E15F41",
  "#B33939",
  "#E55039",
  "#6AB04A",
  "#4A7C59",
  "#D35400",
  "#E58E26",
  "#F6B93B",
];

function formatCurrencySymbol(input?: string) {
  if (!input) return "\u00A5";
  const normalized = input.toUpperCase().trim();

  if (["YEN", "JPY", "\u00A5", "\u5186", "JAPANESE YEN"].includes(normalized)) {
    return "\u00A5";
  }
  if (["USD", "US$", "$", "DOLLAR"].includes(normalized)) {
    return "$";
  }
  if (["EUR", "\u20AC", "EURO"].includes(normalized)) {
    return "\u20AC";
  }
  if (["KRW", "\u20A9", "WON"].includes(normalized)) {
    return "\u20A9";
  }
  if (["THB", "\u0E3F", "BAHT"].includes(normalized)) {
    return "\u0E3F";
  }
  if (["VND", "\u20AB", "DONG"].includes(normalized)) {
    return "\u20AB";
  }

  return input;
}

function normalizeCategory(input?: string) {
  const cleaned = input?.replace(/\s*\([^)]*\)/g, "").trim();
  if (!cleaned) return "\u5176\u4ED6";
  return cleaned;
}

function translateCategoryToChinese(input?: string) {
  const cleaned = normalizeCategory(input);
  const normalized = cleaned.toLowerCase();

  if (/^[\u4e00-\u9fff\s]+$/.test(cleaned)) return cleaned;
  if (/本日|今日|おすすめ|オススメ|recommend|chef|special/.test(cleaned)) {
    return "\u4ECA\u65E5\u63A8\u8350";
  }
  if (/(前菜|一品|appetizer|starter|small plate)/i.test(cleaned)) {
    return "\u524D\u83DC";
  }
  if (/(沙拉|サラダ|salad)/i.test(cleaned)) {
    return "\u6C99\u62C9";
  }
  if (/(汤|スープ|soup)/i.test(cleaned)) {
    return "\u6C64\u54C1";
  }
  if (/(主食|麺|面|饭|ご飯|ライス|noodle|rice|pasta|meal)/i.test(cleaned)) {
    return "\u4E3B\u98DF";
  }
  if (/(烧烤|烤物|焼|grill|bbq)/i.test(cleaned)) {
    return "\u70E7\u70E4";
  }
  if (/(甜品|デザート|dessert|sweet)/i.test(cleaned)) {
    return "\u751C\u54C1";
  }
  if (/(饮品|ドリンク|drink|beverage|beer|wine|cocktail)/i.test(cleaned)) {
    return "\u996E\u54C1";
  }

  return /[a-z]/i.test(normalized) || /[\u3040-\u30ff\uac00-\ud7af]/.test(cleaned)
    ? "\u83DC\u5355\u5206\u7C7B"
    : cleaned;
}

function normalizeLoose(input?: string) {
  return input?.replace(/[\s\u3000\u30fb.,_\-()]+/g, "").toLowerCase() || "";
}

function translateCategoryToChineseSafe(input?: string) {
  const cleaned = normalizeCategory(input);
  const normalized = cleaned.toLowerCase();

  if (/^[\u4e00-\u9fff\s]+$/.test(cleaned)) return cleaned;
  if (/(本日|今日|おすすめ|オススメ|recommend|chef|special)/i.test(cleaned)) {
    return "今日推荐";
  }
  if (/(前菜|一品|appetizer|starter|small plate)/i.test(cleaned)) {
    return "前菜";
  }
  if (/(サラダ|沙拉|salad)/i.test(cleaned)) {
    return "沙拉";
  }
  if (/(スープ|汤|湯|soup)/i.test(cleaned)) {
    return "汤品";
  }
  if (/(主食|麺|面|飯|ご飯|ライス|noodle|rice|pasta|meal)/i.test(cleaned)) {
    return "主食";
  }
  if (/(焼|烧|烤|焼き物|grill|bbq)/i.test(cleaned)) {
    return "烧烤";
  }
  if (/(甜品|デザート|dessert|sweet)/i.test(cleaned)) {
    return "甜品";
  }
  if (/(饮品|飲品|ドリンク|drink|beverage|beer|wine|cocktail)/i.test(cleaned)) {
    return "饮品";
  }

  return /[a-z]/i.test(normalized) || /[\u3040-\u30ff\uac00-\ud7af]/.test(cleaned)
    ? "菜单分类"
    : cleaned;
}

function guessCurrencySafe(input?: string) {
  const value = String(input || "");
  if (/[¥￥円]/.test(value)) return "JPY";
  if (/\$|USD/i.test(value)) return "USD";
  if (/[€]|EUR/i.test(value)) return "EUR";
  if (/[₩]|KRW/i.test(value)) return "KRW";
  if (/[฿]|THB/i.test(value)) return "THB";
  if (/[₫]|VND/i.test(value)) return "VND";
  return "JPY";
}

function isLikelyMenuHeadingSafe(input: string) {
  return /^(本日|今日|おすすめ|オススメ|推荐|菜单|menu)/i.test(input.trim());
}

function normalizeCachePart(input?: string) {
  return (input || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

async function hashBuffer(buffer: BufferSource) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function getFileSignature(file: File) {
  const contentHash = await hashBuffer(await file.arrayBuffer());
  return [
    normalizeCachePart(file.name),
    file.size,
    file.lastModified,
    contentHash.slice(0, 24),
  ].join("__");
}

async function getScanCacheKey(files: File[], settings: Settings) {
  const fileSignatures = await Promise.all(files.map((file) => getFileSignature(file)));
  const signature = [
    SCAN_CACHE_VERSION,
    settings.model,
    settings.visionModel,
    ...fileSignatures.sort(),
  ].join("::");
  return `${SCAN_CACHE_PREFIX}:${await hashBuffer(new TextEncoder().encode(signature))}`;
}

function readCachedScanResult(cacheKey: string): MenuItem[] | null {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MenuItem[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedScanResult(cacheKey: string, items: MenuItem[]) {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(items));
  } catch {
    // Ignore local cache quota errors and continue with live results.
  }
}

export function clearScanResultCache() {
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(SCAN_CACHE_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Ignore cache cleanup failures.
  }
}

function inferLangCode(text: string) {
  if (/[\u3040-\u30ff]/.test(text)) return "ja-JP";
  if (/[\uac00-\ud7af]/.test(text)) return "ko-KR";
  if (/[\u0E00-\u0E7F]/.test(text)) return "th-TH";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh-CN";
  if (/[\u00C0-\u024F]/.test(text)) return "vi-VN";
  return "en-US";
}

function splitPronunciation(input?: string) {
  if (!input) return { phonetic: "", transliteration: "" };
  const trimmed = input.trim();
  const match = trimmed.match(/^(.+?)\s*\((.+?)\)$/);
  if (!match) {
    return { phonetic: trimmed, transliteration: "" };
  }
  return {
    phonetic: match[1].trim(),
    transliteration: match[2].trim(),
  };
}

function pickIllustration(text: string): FoodIllustration {
  const value = text.toLowerCase();

  if (
    /kimchi|pickle|pickled|\u6CE1\u83DC|\u814C\u83DC|\u8F9B\u767D\u83DC/.test(
      value,
    )
  ) {
    return "kimchi";
  }
  if (/salad|\u6C99\u62C9/.test(value)) {
    return "salad";
  }
  if (/soup|\u6C64/.test(value)) {
    return "soup";
  }
  if (/bibimbap|rice bowl|\u62CC\u996D|\u77F3\u9505|\u76D6\u996D/.test(value)) {
    return "bibimbap";
  }
  if (/ramen|noodle|reimen|\u51B7\u9762|\u62C9\u9762|\u9762/.test(value)) {
    return "ramen";
  }
  if (/udon|\u4E4C\u51AC/.test(value)) {
    return "udon";
  }
  if (/heart|\u725B\u5FC3/.test(value)) {
    return "heart";
  }
  if (/yukke|tartare|\u751F\u62CC/.test(value)) {
    return "yukke";
  }
  return "senmai";
}

function pickColor(category: string, label: string) {
  const source = `${category}:${label}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
}

function cleanJsonString(input: string) {
  return input.replace(/```json/gi, "").replace(/```/g, "").trim();
}

function decodeHtml(input: string) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = input;
  return textarea.value;
}

function stripHtml(input: string) {
  return decodeHtml(input)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th|tr|p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function parsePrice(input?: string | number) {
  const match = String(input || "").match(/(?:[¥￥$€₩฿₫]\s*)?([0-9][0-9,.]*)/);
  if (!match) return 0;
  return Number(match[1].replace(/,/g, "")) || 0;
}

function guessCurrency(input?: string) {
  const value = String(input || "");
  if (/[¥￥円]/.test(value)) return "JPY";
  if (/\$|USD/i.test(value)) return "USD";
  if (/€|EUR/i.test(value)) return "EUR";
  if (/₩|KRW|원/i.test(value)) return "KRW";
  if (/฿|THB/i.test(value)) return "THB";
  if (/₫|VND/i.test(value)) return "VND";
  return "JPY";
}

function looksLikeHeader(columns: string[]) {
  const joined = columns.join(" ").toLowerCase();
  return /category|original|menu|dish|item|price|currency|pronunciation/.test(joined);
}

function cleanOcrCell(input: string) {
  return stripHtml(input)
    .replace(/^[-*・\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyMenuHeading(input: string) {
  return /^(本日|今日|おすすめ|オススメ|推荐|菜單|菜单|menu)/i.test(input.trim());
}

function seedFromText(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function uniqueModels(models: Array<string | undefined>) {
  return [...new Set(models.map((model) => model?.trim()).filter(Boolean))] as string[];
}

function buildDishImagePrompt(item: MenuItem) {
  const names = [item.chineseName, item.sourceText].filter(Boolean).join(" / ");
  return [
    `A realistic restaurant menu food photo of ${names}.`,
    `Category: ${item.tab}.`,
    "Single dish only, plated neatly, appetizing, natural lighting, clean background.",
    "Shot from a 45-degree or top-down angle, high detail, commercial food photography.",
    "No people, no hands, no menu text, no price labels, no watermark, no collage, no extra dishes.",
  ].join(" ");
}

function extractMessageText(payload: any) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

function extractItems<T>(content: string): T[] {
  const cleaned = cleanJsonString(content);
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");

  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(objectStart, objectEnd + 1));
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  return [];
}

function parseOcrTable(content: string): RawRecognizedMenuItem[] {
  const rows = [...content.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) =>
      [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((cell) => cleanOcrCell(cell[1]))
        .filter(Boolean),
    )
    .filter((columns) => columns.length > 0 && !looksLikeHeader(columns));

  let currentCategory = "";

  return rows
    .map((columns) => {
      const priceColumn = [...columns].reverse().find((column) => parsePrice(column) > 0);
      const price = parsePrice(priceColumn);
      const originalColumn =
        columns.find((column) => column !== priceColumn && parsePrice(column) === 0) ||
        columns[0];
      const original = cleanOcrCell(originalColumn);

      if (!price && columns.length === 1) {
        currentCategory = original;
        return null;
      }

      return {
        original,
        price,
        currency: guessCurrencySafe(priceColumn),
        pronunciation: "",
        category: currentCategory || CATEGORY_LABEL,
        lang_code: inferLangCode(original),
        note: "",
      };
    })
    .filter((item): item is Exclude<typeof item, null> => Boolean(item?.original));
}

function parseMarkdownTable(content: string): RawRecognizedMenuItem[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("|") && !/^[:\-\s|]+$/.test(line));

  return lines
    .map((line) =>
      line
        .split("|")
        .map(cleanOcrCell)
        .filter(Boolean),
    )
    .filter((columns) => columns.length > 0 && !looksLikeHeader(columns))
    .map((columns) => {
      const priceColumn = [...columns].reverse().find((column) => parsePrice(column) > 0);
      const original =
        columns.find((column) => column !== priceColumn && parsePrice(column) === 0) ||
        columns[0];

      return {
        original,
        price: parsePrice(priceColumn),
        currency: guessCurrencySafe(priceColumn),
        pronunciation: "",
        category: CATEGORY_LABEL,
        lang_code: inferLangCode(original),
        note: "",
      };
    })
    .filter((item) => item.original);
}

function parseOcrLines(content: string): RawRecognizedMenuItem[] {
  let currentCategory = "";
  return stripHtml(content)
    .split(/\r?\n/)
    .map(cleanOcrCell)
    .filter(Boolean)
    .map((line) => {
      const price = parsePrice(line);
      const original = line
        .replace(/(?:[^\p{L}\p{N}\s]?\s*)?[0-9][0-9,.]*\s*[-~]?/gu, "")
        .trim();

      if (!price) {
        if (original.length <= 18) currentCategory = original;
        return null;
      }

      return {
        original,
        price,
        currency: guessCurrencySafe(line),
        pronunciation: "",
        category: currentCategory || CATEGORY_LABEL,
        lang_code: inferLangCode(original),
        note: "",
      };
    })
    .filter((item): item is Exclude<typeof item, null> => Boolean(item?.original));
}

function compactOcrItems(items: RawRecognizedMenuItem[]) {
  const seen = new Set<string>();
  const compacted: RawRecognizedMenuItem[] = [];

  for (const item of items) {
    const original = cleanOcrCell(item.original || "");
    const price = parsePrice(item.price);
    if (!original || looksLikeHeader([original]) || /^[0-9,.]+$/.test(original)) continue;
    if (isLikelyMenuHeadingSafe(original)) continue;

    const key = `${normalizeLoose(original)}:${price || 0}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    compacted.push({
      ...item,
      original,
      price,
      currency: item.currency || guessCurrencySafe(String(item.price || "")),
      category: item.category || CATEGORY_LABEL,
      lang_code: item.lang_code || inferLangCode(original),
    });

    if (compacted.length >= 45) break;
  }

  return compacted;
}

function extractOcrItems(content: string) {
  const jsonItems = extractItems<RawRecognizedMenuItem>(content);
  if (jsonItems.length > 0) return compactOcrItems(jsonItems);

  const tableItems = parseOcrTable(content);
  if (tableItems.length > 0) return compactOcrItems(tableItems);

  const markdownItems = parseMarkdownTable(content);
  if (markdownItems.length > 0) return compactOcrItems(markdownItems);

  return compactOcrItems(parseOcrLines(content));
}

async function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function splitImage(file: File, mode: "single" | "slices" = "slices") {
  const dataUrl = await fileToDataUrl(file);

  return new Promise<string[]>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const slices: string[] = [];
      const maxWidth = 640;
      const scale = image.width > maxWidth ? maxWidth / image.width : 1;
      const width = image.width * scale;
      const height = image.height * scale;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        reject(new Error("\u65E0\u6CD5\u521D\u59CB\u5316\u56FE\u7247\u753B\u5E03"));
        return;
      }

      canvas.width = width;

      if (mode === "single") {
        canvas.height = height;
        context.clearRect(0, 0, width, height);
        context.drawImage(
          image,
          0,
          0,
          image.width,
          image.height,
          0,
          0,
          width,
          height,
        );
        slices.push(canvas.toDataURL("image/jpeg", 0.58));
      } else if (image.height > image.width * 1.8) {
        [
          { start: 0, end: 0.62 },
          { start: 0.45, end: 1 },
        ].forEach((range) => {
          const sourceY = image.height * range.start;
          const sourceHeight = image.height * (range.end - range.start);
          const targetHeight = height * (range.end - range.start);
          canvas.height = targetHeight;
          context.clearRect(0, 0, width, targetHeight);
          context.drawImage(
            image,
            0,
            sourceY,
            image.width,
            sourceHeight,
            0,
            0,
            width,
            targetHeight,
          );
          slices.push(canvas.toDataURL("image/jpeg", 0.58));
        });
      }

      resolve(slices);
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function requestCompletion(
  settings: Settings,
  model: string,
  messages: any[],
) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `SiliconFlow \u8BF7\u6C42\u5931\u8D25 (${response.status})${
        detail ? `: ${detail.slice(0, 180)}` : ""
      }`,
    );
  }

  return response.json();
}

async function requestCompletionWithFallback(
  settings: Settings,
  models: string[],
  messages: any[],
) {
  let lastError: unknown;

  for (const model of uniqueModels(models)) {
    try {
      return await requestCompletion(settings, model, messages);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("SiliconFlow 请求失败");
}

async function requestDishImageUrlWithModel(
  settings: Settings,
  item: MenuItem,
  imageModel: string,
) {
  const response = await fetch(IMAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: imageModel,
      prompt: buildDishImagePrompt(item),
      negative_prompt:
        "text, letters, watermark, logo, people, hands, menu, multiple dishes, blurry, low quality",
      image_size: DEFAULT_IMAGE_SIZE,
      seed: seedFromText(getDishImageCacheKey(item)),
      ...(imageModel.toLowerCase().includes("kolors")
        ? {
            batch_size: 1,
            num_inference_steps: 8,
            guidance_scale: 7.5,
          }
        : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `SiliconFlow 生图失败 (${response.status})${
        detail ? `: ${detail.slice(0, 180)}` : ""
      }`,
    );
  }

  const payload = (await response.json()) as {
    images?: Array<{ url?: string }>;
  };
  const imageUrl = payload.images?.[0]?.url;

  if (!imageUrl) {
    throw new Error("SiliconFlow 没有返回图片地址");
  }

  return imageUrl;
}

async function requestDishImageUrl(settings: Settings, item: MenuItem) {
  let lastError: unknown;

  for (const model of uniqueModels([
    settings.imageModel,
    ...IMAGE_MODEL_FALLBACKS,
  ])) {
    try {
      return await requestDishImageUrlWithModel(settings, item, model);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("SiliconFlow 生图失败");
}

async function requestVisionRecognition(
  imageDataUrl: string,
  settings: Settings,
): Promise<RawRecognizedMenuItem[]> {
  const payload = await requestCompletionWithFallback(
    settings,
    [settings.visionModel, ...VISION_MODEL_FALLBACKS],
    [
      {
        role: "system",
        content:
          "You are a multilingual restaurant menu OCR and translation assistant. Read every real menu item from the image, including dishes, set meals, drinks, options, and add-ons. Return only a JSON array. Each object must contain: original, translation, price, currency, pronunciation, category, lang_code, note. translation must be concise Simplified Chinese. Keep original exactly in the source language as printed on the menu. For Japanese menus, never romanize original; preserve the visible Japanese text in original and put kana/romaji only in pronunciation. Use the nearest section heading or page title as category, translated into short Simplified Chinese when possible. If the whole board has one title such as 本日のオススメ, category can be 今日推荐. Use 0 when there is no clear price. Do not output headings as dishes. Do not add explanations or markdown.",
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: imageDataUrl,
              detail: "auto",
            },
          },
          {
            type: "text",
            text: "Extract every real menu item and price, translate each item into Simplified Chinese, and output JSON only.",
          },
        ],
      },
    ],
  );

  return extractOcrItems(extractMessageText(payload));
}

async function requestNormalizer(
  items: RawRecognizedMenuItem[],
  settings: Settings,
): Promise<RecognizedMenuItem[]> {
  const payload = await requestCompletionWithFallback(settings, [
    settings.model,
    ...TEXT_MODEL_FALLBACKS,
  ], [
    {
      role: "system",
      content:
        "You convert multilingual OCR menu items into clean Chinese menu data for a mobile ordering UI. Return only a JSON array. Each object must contain: original, translation, pronunciation, price, currency, desc, category, lang_code. Rules: 1) translation must be concise Simplified Chinese dish naming. 2) original must stay in the source language exactly as printed. For Japanese, keep the Japanese text in original and never replace it with romaji. 3) pronunciation should help reading the source line. For Japanese prefer \"kana (romaji)\". For Korean, Thai, Vietnamese, provide a readable Latin pronunciation when possible. 4) desc must be short Simplified Chinese, ideally under 12 characters. 5) category should be a short Chinese category translated from the menu's own section heading or page title. Do not force everything into fixed categories. If the board title is 本日のオススメ, category can be 本日推荐. 6) note items, spice levels, and add-ons without a clear standalone price should use price 0. 7) keep or correct lang_code as a valid BCP-47 code.",
    },
    {
      role: "user",
      content: `Normalize these OCR menu items:\n${JSON.stringify(items, null, 2)}`,
    },
  ]);

  return extractItems<RecognizedMenuItem>(extractMessageText(payload));
}

export function getDefaultSettings(): Settings {
  return {
    apiKey: import.meta.env.VITE_SILICONFLOW_API_KEY || "",
    model: DEFAULT_MODEL,
    visionModel: DEFAULT_VISION_MODEL,
    imageModel: DEFAULT_IMAGE_MODEL,
    enableImageGeneration: false,
  };
}

export function getDishImageCacheKey(
  item: Pick<MenuItem, "tab" | "chineseName" | "sourceText" | "langCode">,
) {
  return [
    normalizeCachePart(item.langCode),
    normalizeCachePart(item.tab),
    normalizeCachePart(item.chineseName),
    normalizeCachePart(item.sourceText),
  ]
    .filter(Boolean)
    .join("__");
}

export async function generateDishImageBlob(settings: Settings, item: MenuItem) {
  if (!settings.apiKey.trim()) {
    throw new Error("\u8BF7\u5148\u586B\u5199 SiliconFlow API Key");
  }

  const imageUrl = await requestDishImageUrl(settings, item);
  const imageResponse = await fetch(imageUrl);

  if (!imageResponse.ok) {
    throw new Error("生成后的图片下载失败");
  }

  return imageResponse.blob();
}

export async function generateDishImageUrl(settings: Settings, item: MenuItem) {
  if (!settings.apiKey.trim()) {
    throw new Error("\u8BF7\u5148\u586B\u5199 SiliconFlow API Key");
  }

  return requestDishImageUrl(settings, item);
}

export function sortTabs(tabs: string[]) {
  return [...new Set(tabs.filter(Boolean))];
}

export function mapRecognizedItems(items: RecognizedMenuItem[]): MenuItem[] {
  return items
    .filter((item) => item.original || item.translation)
    .map((item, index) => {
      const originalCategory = normalizeCategory(item.category);
      const category = translateCategoryToChineseSafe(item.category);
      const sourceText = (
        item.original ||
        item.translation ||
        "\u672A\u547D\u540D\u83DC\u54C1"
      ).trim();
      const chineseName = (
        item.translation ||
        item.original ||
        "\u672A\u7FFB\u8BD1"
      ).trim();
      const { phonetic, transliteration } = splitPronunciation(item.pronunciation);
      const priceValue =
        typeof item.price === "number"
          ? item.price
          : Number(String(item.price || "0").replace(/[^0-9.]/g, "")) || 0;
      const langCode = item.lang_code || inferLangCode(sourceText);

      return {
        id: `ai-${Date.now()}-${index}-${normalizeLoose(sourceText).slice(0, 16)}`,
        tab: category,
        sourceText,
        chineseName,
        originalCategory,
        phonetic,
        transliteration,
        price: priceValue,
        currency: formatCurrencySymbol(item.currency),
        desc: item.desc?.trim(),
        img: pickIllustration(`${sourceText} ${chineseName}`),
        color: pickColor(category, sourceText),
        source: "ai",
        langCode,
      };
    });
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onResult?: (result: T) => void,
) {
  const results: T[] = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const task = tasks[index];
      index += 1;
      const result = await task();
      results.push(result);
      onResult?.(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
  );

  return results;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function rawItemsToRecognizedItems(items: RawRecognizedMenuItem[]): RecognizedMenuItem[] {
  return items.map((item) => ({
    original: item.original,
    translation: item.translation || item.original,
    pronunciation: item.pronunciation || "",
    price: item.price,
    currency: item.currency,
    desc: item.desc || item.note || "",
    category: item.category || CATEGORY_LABEL,
    lang_code: item.lang_code || inferLangCode(item.original),
  }));
}

function hasModelReadyTranslation(item: RawRecognizedMenuItem) {
  return Boolean(
    item.translation &&
      normalizeLoose(item.translation) !== normalizeLoose(item.original),
  );
}

function hasUsefulCategory(item: RawRecognizedMenuItem) {
  const category = normalizeLoose(item.category);
  return Boolean(category && category !== normalizeLoose(CATEGORY_LABEL));
}

function canSkipNormalizer(items: RawRecognizedMenuItem[]) {
  if (items.length === 0) return true;

  const translatedCount = items.filter(hasModelReadyTranslation).length;
  const categorizedCount = items.filter(hasUsefulCategory).length;

  return (
    translatedCount >= Math.max(1, Math.ceil(items.length * 0.4)) &&
    categorizedCount >= Math.max(1, Math.ceil(items.length * 0.25))
  );
}

export async function recognizeMenuFiles(
  files: File[],
  settings: Settings,
  onProgress?: (count: number) => void,
) {
  if (!settings.apiKey.trim()) {
    throw new Error("\u8BF7\u5148\u586B\u5199 SiliconFlow API Key");
  }

  const cacheKey = await getScanCacheKey(files, settings);
  const cachedResult = readCachedScanResult(cacheKey);
  if (cachedResult) {
    onProgress?.(cachedResult.length);
    return cachedResult;
  }

  const seen = new Set<string>();
  const rawCollected: RawRecognizedMenuItem[] = [];

  function collectItems(items: RawRecognizedMenuItem[]) {
    for (const item of items) {
        const priceValue =
          typeof item.price === "number"
            ? item.price
            : Number(String(item.price || "0").replace(/[^0-9.]/g, "")) || 0;
        const dedupeKey = `${normalizeLoose(item.original)}:${priceValue}`;
        if (!dedupeKey || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        rawCollected.push(item);
        onProgress?.(rawCollected.length);
    }
  }

  const fastPassParts = (await Promise.all(
    files.map((file) => splitImage(file, "single")),
  )).flat();

  await runPool(
    fastPassParts.map((part) => () => requestVisionRecognition(part, settings)),
    OCR_CONCURRENCY,
    collectItems,
  );

  if (rawCollected.length < Math.max(OCR_FAST_PASS_MIN_ITEMS, files.length * 4)) {
    const fallbackParts = (await Promise.all(
      files.map((file) => splitImage(file, "slices")),
    )).flat();

    if (fallbackParts.length > 0) {
      await runPool(
        fallbackParts.map((part) => () => requestVisionRecognition(part, settings)),
        OCR_CONCURRENCY,
        collectItems,
      );
    }
  }

  if (rawCollected.length === 0) {
    return [];
  }

  if (canSkipNormalizer(rawCollected)) {
    const directItems = mapRecognizedItems(rawItemsToRecognizedItems(rawCollected));
    writeCachedScanResult(cacheKey, directItems);
    return directItems;
  }

  try {
    const normalizedChunks = await withTimeout(
      Promise.all(
        chunkArray(rawCollected, 15).map((chunk) => requestNormalizer(chunk, settings)),
      ),
      NORMALIZE_TIMEOUT_MS,
      "菜单整理超时，已先显示 OCR 识别结果",
    );

    const normalizedItems = mapRecognizedItems(normalizedChunks.flat());
    writeCachedScanResult(cacheKey, normalizedItems);
    return normalizedItems;
  } catch {
    const fallbackItems = mapRecognizedItems(rawItemsToRecognizedItems(rawCollected));
    writeCachedScanResult(cacheKey, fallbackItems);
    return fallbackItems;
  }
}
