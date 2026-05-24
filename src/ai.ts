import type {
  FoodIllustration,
  MenuItem,
  RawRecognizedMenuItem,
  RecognizedMenuItem,
  Settings,
} from "./types";

const API_URL = "https://api.siliconflow.cn/v1/chat/completions";
const IMAGE_API_URL = "https://api.siliconflow.cn/v1/images/generations";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const USE_BACKEND_PROXY = import.meta.env.VITE_USE_BACKEND_PROXY !== "false";
const OCR_CONCURRENCY = 6;
const NORMALIZE_TIMEOUT_MS = 12000;
const SCAN_CACHE_PREFIX = "aimenu-v5-scan-cache";
const SCAN_CACHE_VERSION = "v6";
const DEFAULT_MODEL =
  import.meta.env.VITE_SILICONFLOW_MODEL || "Pro/moonshotai/Kimi-K2.6";
const DEFAULT_VISION_MODEL =
  import.meta.env.VITE_SILICONFLOW_VISION_MODEL ||
  "deepseek-ai/DeepSeek-OCR";
const DEFAULT_IMAGE_MODEL =
  import.meta.env.VITE_SILICONFLOW_IMAGE_MODEL || "Qwen/Qwen-Image";
const DEFAULT_IMAGE_SIZE = "320x320";
const TEXT_MODEL_FALLBACKS = [
  DEFAULT_MODEL,
  "moonshotai/Kimi-K2-Thinking",
  "deepseek-ai/DeepSeek-V3.2",
];
const VISION_MODEL_FALLBACKS = [
  DEFAULT_VISION_MODEL,
  "Qwen/Qwen3-VL-32B-Instruct",
  "deepseek-ai/DeepSeek-OCR",
  "Qwen/Qwen3-VL-30B-A3B-Instruct",
];
const IMAGE_MODEL_FALLBACKS = [DEFAULT_IMAGE_MODEL, "Qwen/Qwen-Image"];
const CATEGORY_LABEL = "菜单识别结果";
const KOREAN_SECTION_LABELS = [
  "볶음류",
  "탕",
  "찌개",
  "탕/찌개",
  "마른안주",
  "사이드",
  "주류",
  "음료",
  "주류/음료",
  "메뉴",
  "추천",
];

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

function getBackendBaseUrl() {
  if (!USE_BACKEND_PROXY) return null;
  if (API_BASE_URL) return API_BASE_URL;
  if (typeof window === "undefined") return null;
  return window.location.hostname.endsWith("github.io") ? null : "";
}

export function isBackendProxyEnabled() {
  return getBackendBaseUrl() !== null;
}

export function requiresClientApiKey() {
  return !isBackendProxyEnabled();
}

function uniqueModels(models: Array<string | undefined>) {
  return [...new Set(models.map((model) => model?.trim()).filter(Boolean))] as string[];
}

function normalizeCategory(input?: string) {
  const cleaned = input?.replace(/\s*\([^)]*\)/g, "").trim();
  return cleaned || "其他";
}

function normalizeLoose(input?: string) {
  return input?.replace(/[\s\u3000\u30fb.,_\-()]+/g, "").toLowerCase() || "";
}

function normalizeCachePart(input?: string) {
  return (input || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
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
  if (!match) return { phonetic: trimmed, transliteration: "" };
  return {
    phonetic: match[1].trim(),
    transliteration: match[2].trim(),
  };
}

function formatCurrencySymbol(input?: string) {
  if (!input) return "¥";
  const normalized = input.toUpperCase().trim();
  if (["YEN", "JPY", "¥", "円", "JAPANESE YEN"].includes(normalized)) return "¥";
  if (["USD", "US$", "$", "DOLLAR"].includes(normalized)) return "$";
  if (["EUR", "€", "EURO"].includes(normalized)) return "€";
  if (["KRW", "₩", "WON"].includes(normalized)) return "₩";
  if (["THB", "฿", "BAHT"].includes(normalized)) return "฿";
  if (["VND", "₫", "DONG"].includes(normalized)) return "₫";
  return input;
}

function parsePrice(input?: string | number) {
  const match = String(input || "").match(/(?:[¥￥円$€₩฿₫]\s*)?([0-9][0-9,.]*)/);
  if (!match) return 0;
  return Number(match[1].replace(/,/g, "")) || 0;
}

function guessCurrency(input?: string) {
  const value = String(input || "");
  if (/[¥￥円]/.test(value)) return "JPY";
  if (/\$|USD/i.test(value)) return "USD";
  if (/[€]|EUR/i.test(value)) return "EUR";
  if (/[₩]|KRW/i.test(value)) return "KRW";
  if (/[฿]|THB/i.test(value)) return "THB";
  if (/[₫]|VND/i.test(value)) return "VND";
  return "JPY";
}

function translateCategoryToChinese(input?: string) {
  const cleaned = normalizeCategory(input);
  const normalized = cleaned.toLowerCase();

  if (/^[\u4e00-\u9fff\s]+$/.test(cleaned)) return cleaned;
  if (/(本日|今日|おすすめ|オススメ|recommend|chef|special)/i.test(cleaned)) {
    return "今日推荐";
  }
  if (/(前菜|一品|appetizer|starter|small plate)/i.test(cleaned)) return "前菜";
  if (/(サラダ|沙拉|salad)/i.test(cleaned)) return "沙拉";
  if (/(スープ|汤|湯|soup)/i.test(cleaned)) return "汤品";
  if (/(主食|麺・飯|ご飯|meal|noodle|rice|pasta)/i.test(cleaned)) return "主食";
  if (/(烧烤|焼き|焼物|grill|bbq)/i.test(cleaned)) return "烧烤";
  if (/(甜品|デザート|dessert|sweet)/i.test(cleaned)) return "甜品";
  if (/(饮品|ドリンク|drink|beverage|beer|wine|cocktail)/i.test(cleaned)) {
    return "饮品";
  }
  if (/(볶음류|볶음)/i.test(cleaned)) return "炒菜类";
  if (/(탕\/찌개|탕|찌개)/i.test(cleaned)) return "汤/炖锅";
  if (/(마른안주)/i.test(cleaned)) return "干货/下酒小食";
  if (/(사이드)/i.test(cleaned)) return "小菜/加点";
  if (/(주류\/음료|주류|음료)/i.test(cleaned)) return "酒水/饮料";
  if (/(메인|메뉴|주메뉴)/i.test(cleaned)) return "主菜";

  return /[a-z]/i.test(normalized) || /[\u3040-\u30ff\uac00-\ud7af]/.test(cleaned)
    ? "其他"
    : cleaned;
}

function pickIllustration(text: string): FoodIllustration {
  const value = text.toLowerCase();
  if (/kimchi|pickle|pickled|泡菜|腌菜|辛白菜/.test(value)) return "kimchi";
  if (/salad|沙拉/.test(value)) return "salad";
  if (/soup|汤|湯/.test(value)) return "soup";
  if (/bibimbap|rice bowl|拌饭|石锅|盖饭/.test(value)) return "bibimbap";
  if (/ramen|noodle|reimen|冷面|拉面|面/.test(value)) return "ramen";
  if (/udon|乌冬/.test(value)) return "udon";
  if (/heart|牛心/.test(value)) return "heart";
  if (/yukke|tartare|生拌/.test(value)) return "yukke";
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

function looksLikeHeader(columns: string[]) {
  const joined = columns.join(" ").toLowerCase();
  return /category|original|menu|dish|item|price|currency|pronunciation/.test(joined);
}

function cleanOcrCell(input: string) {
  return stripHtml(input)
    .replace(/^[-*•・·●▪‣○]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyMenuHeading(input: string) {
  const trimmed = input.trim();
  return (
    /^(本日|今日|おすすめ|オススメ|推荐|菜单|menu)/i.test(trimmed) ||
    KOREAN_SECTION_LABELS.includes(trimmed) ||
    /^백\d+열포차$/i.test(trimmed)
  );
}

function detectDominantLang(items: Array<Pick<RawRecognizedMenuItem, "lang_code" | "original">>) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const lang = item.lang_code || inferLangCode(item.original || "");
    counts.set(lang, (counts.get(lang) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
}

function isMostlyKoreanMenu(items: Array<Pick<RawRecognizedMenuItem, "lang_code" | "original">>) {
  return detectDominantLang(items) === "ko-KR";
}

function buildVisionSystemPrompt() {
  return [
    "You are a multilingual restaurant menu OCR assistant.",
    "Read every real sellable menu item from the image, including dishes, drinks, side items, add-ons, and set items.",
    "Return only a JSON array.",
    "Each object must contain: original, translation, price, currency, pronunciation, category, lang_code, note.",
    "Keep original exactly as printed on the menu in the source language.",
    "translation must be short Simplified Chinese, but accuracy is more important than fluency.",
    "If the menu has multiple section headings, category MUST use the nearest local section heading, never the store name or the top page title.",
    "Do not output pure section headings as dishes.",
    "For Korean menus, category examples include 볶음류, 탕/찌개, 마른안주, 사이드, 주류/음료.",
    "For Japanese menus, preserve Japanese text in original and put kana/romaji only in pronunciation.",
    "Use 0 when there is no clear standalone price.",
    "Do not add markdown or explanations.",
  ].join(" ");
}

function buildNormalizerSystemPrompt(items: RawRecognizedMenuItem[]) {
  const koreanHints = isMostlyKoreanMenu(items)
    ? [
        "Extra rules for Korean menus:",
        "1) Translate each Korean item independently. Never copy one Chinese translation to different Korean originals unless the originals are identical.",
        "2) Preserve the Korean original exactly.",
        "3) Category must follow the nearest Korean section heading. Typical mappings: 볶음류=炒菜类, 탕/찌개=汤/炖锅, 마른안주=干货/下酒小食, 사이드=小菜/加点, 주류/음료=酒水/饮料.",
        "4) Useful term guidance: 계란말이=鸡蛋卷, 김치=泡菜, 날치알=飞鱼籽, 불고기=韩式炒烤肉, 고갈비=烤青花鱼, 오돌뼈=脆骨, 두부김치=豆腐泡菜, 후라이=煎蛋, 스팸=午餐肉, 곱창=肥肠, 순대=韩式血肠, 막창=猪大肠, 닭발=鸡爪, 오뎅탕=鱼饼汤/关东煮汤, 먹태=明太鱼干, 노가리=鳕鱼干, 막걸리=马格利米酒, 하이볼=Highball, 사와=沙瓦.",
        "5) Beverage brands should stay recognizable, for example 산토리하이볼=三得利Highball, 산토리레몬사와=三得利柠檬沙瓦.",
      ].join(" ")
    : "";

  return [
    "You convert multilingual OCR menu items into clean Chinese menu data for a mobile ordering UI.",
    "Return only a JSON array.",
    "Each object must contain: original, translation, pronunciation, price, currency, desc, category, lang_code.",
    "translation must be concise Simplified Chinese and suitable for restaurant menus.",
    "original must stay in the source language exactly as printed.",
    'For Japanese pronunciation, prefer "kana (romaji)". For Korean, Thai, and Vietnamese, provide a readable Latin pronunciation when possible.',
    "desc should be very short Simplified Chinese, ideally under 12 characters.",
    "category should be a short Chinese category translated from the menu's own section heading, not from a fixed preset.",
    "Do not keep every item under one category if the menu has multiple sections.",
    "If an item is a section heading rather than a dish, omit it from the output.",
    "If a price is unclear, use 0.",
    "Never reuse one translation for multiple different originals unless they truly mean the same dish.",
    koreanHints,
  ]
    .filter(Boolean)
    .join(" ");
}

function seedFromText(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function buildDishImagePrompt(item: MenuItem) {
  const names = [item.chineseName, item.sourceText].filter(Boolean).join(" / ");
  const beverageHint =
    /高球|하이볼|사와|맥주|소주|막걸리|ハイボール|サワー|beer|ビール|drink|cocktail|cola|可乐|姜汁|ソーダ|レモン|ウイスキー/i.test(
      `${item.chineseName} ${item.sourceText} ${item.tab}`,
    );
  return [
    beverageHint
      ? `A realistic restaurant menu beverage photo of ${names}.`
      : `A realistic restaurant menu food photo of ${names}.`,
    `Category: ${item.tab}.`,
    beverageHint
      ? "Single drink only, served in one glass or mug, clean studio background, realistic garnish only if appropriate."
      : "Single dish only, plated neatly, appetizing, natural lighting, clean background.",
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
  return rows.flatMap((columns) => {
    const priceColumn = [...columns].reverse().find((column) => parsePrice(column) > 0);
    const originalColumn =
      columns.find((column) => column !== priceColumn && parsePrice(column) === 0) ||
      columns[0];
    const original = cleanOcrCell(originalColumn);

    if (!priceColumn && columns.length === 1) {
      currentCategory = original;
      return [];
    }

    return [
      {
        original,
        price: parsePrice(priceColumn),
        currency: guessCurrency(priceColumn || ""),
        pronunciation: "",
        category: currentCategory || CATEGORY_LABEL,
        lang_code: inferLangCode(original),
        note: "",
      },
    ];
  });
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
        currency: guessCurrency(priceColumn || ""),
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
    .flatMap((line) => {
      const price = parsePrice(line);
      const original = line
        .replace(
          /\s*(?:[¥￥円$€₩฿₫]|JPY|USD|EUR|KRW|THB|VND)?\s*[0-9][0-9,.~～-]*\s*$/i,
          "",
        )
        .trim();

      if (!price) {
        if (original.length <= 18 && !isLikelyMenuHeading(original)) currentCategory = original;
        return [];
      }

      return [
        {
          original,
          price,
          currency: guessCurrency(line),
          pronunciation: "",
          category: currentCategory || CATEGORY_LABEL,
          lang_code: inferLangCode(original),
          note: "",
        },
      ];
    });
}

function compactOcrItems(items: RawRecognizedMenuItem[]) {
  const seen = new Set<string>();
  const compacted: RawRecognizedMenuItem[] = [];

  for (const item of items) {
    const original = cleanOcrCell(item.original || "");
    const price = parsePrice(item.price);
    if (!original || looksLikeHeader([original]) || /^[0-9,.]+$/.test(original)) continue;
    if (isLikelyMenuHeading(original)) continue;

    const key = `${normalizeLoose(original)}:${price || 0}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    compacted.push({
      ...item,
      original,
      price,
      currency: item.currency || guessCurrency(String(item.price || "")),
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
  return Boolean(item.translation && normalizeLoose(item.translation) !== normalizeLoose(item.original));
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

export function mapRecognizedItems(items: RecognizedMenuItem[]): MenuItem[] {
  return items
    .filter((item) => item.original || item.translation)
    .map((item, index) => {
      const originalCategory = normalizeCategory(item.category);
      const category = translateCategoryToChinese(item.category);
      const sourceText = (item.original || item.translation || "未命名菜品").trim();
      const koreanOverride =
        inferLangCode(sourceText) === "ko-KR"
          ? getKoreanMenuOverride(sourceText, item.translation || "")
          : null;
      const chineseName = (koreanOverride?.translation || item.translation || item.original || "未翻译").trim();
      const { phonetic, transliteration } = splitPronunciation(item.pronunciation || "");
      const priceValue =
        typeof item.price === "number"
          ? item.price
          : Number(String(item.price || "0").replace(/[^0-9.]/g, "")) || 0;
      const langCode = item.lang_code || inferLangCode(sourceText);
      const finalCategory = koreanOverride?.category || category;

      return {
        id: `ai-${Date.now()}-${index}-${normalizeLoose(sourceText).slice(0, 16)}`,
        tab: finalCategory,
        sourceText,
        chineseName,
        originalCategory,
        phonetic,
        transliteration,
        price: priceValue,
        currency: formatCurrencySymbol(item.currency || "JPY"),
        desc: item.desc?.trim(),
        img: pickIllustration(`${sourceText} ${chineseName}`),
        color: pickColor(finalCategory, sourceText),
        source: "ai",
        langCode,
      };
    });
}

function getKoreanMenuOverride(sourceText: string, fallbackTranslation = "") {
  const normalized = normalizeLoose(sourceText);
  const exactMap: Array<[RegExp, string, string]> = [
    [/김치.*계란말이|김치볶지게란달이|김치볶지게란말이/, "泡菜飞鱼籽鸡蛋卷", "主菜"],
    [/오삼불고기/, "鱿鱼五花肉炒烤", "主菜"],
    [/고갈비/, "烤青花鱼", "主菜"],
    [/백오돌뼈/, "白味脆骨", "主菜"],
    [/오돌뼈/, "辣炒脆骨", "主菜"],
    [/두부김치/, "豆腐泡菜", "主菜"],
    [/후라이와스팸|후라이와스팬/, "煎蛋＋午餐肉", "主菜"],
    [/매운돼지껍데기|메운돼지껍데기/, "辣猪皮", "主菜"],
    [/곱창야채볶음|곱창아채볶음/, "肥肠蔬菜炒", "炒菜类"],
    [/순대곱창볶음|소대곱창볶음/, "血肠肥肠炒", "炒菜类"],
    [/순대볶음/, "韩式血肠炒", "炒菜类"],
    [/양념막창/, "调味烤猪大肠", "炒菜类"],
    [/매운무뼈닭발/, "辣无骨鸡爪", "炒菜类"],
    [/오징어데침|정어대침/, "白灼鱿鱼", "炒菜类"],
    [/오징어볶음|정어볶음|정어부음/, "辣炒鱿鱼", "炒菜类"],
    [/육볶음/, "辣炒肉", "炒菜类"],
    [/모듬오뎅탕/, "关东煮拼盘汤", "汤/炖锅"],
    [/김치오뎅탕/, "泡菜关东煮汤", "汤/炖锅"],
    [/돼지김치찌개/, "猪肉泡菜锅", "汤/炖锅"],
    [/꽁치김치찌개|공치김치찌개/, "秋刀鱼泡菜锅", "汤/炖锅"],
    [/참치김치찌개/, "金枪鱼泡菜锅", "汤/炖锅"],
    [/먹태/, "烤明太鱼干", "干货/下酒小食"],
    [/반건조오징어/, "半干鱿鱼", "干货/下酒小食"],
    [/왕노가리/, "大号鳕鱼干", "干货/下酒小食"],
    [/우동/, "乌冬面", "小菜/加点"],
    [/국수/, "面条", "小菜/加点"],
    [/라면/, "拉面", "小菜/加点"],
    [/주먹밥/, "饭团", "小菜/加点"],
    [/소면사리추가/, "加细面", "小菜/加点"],
    [/파인애플샤베트|파인애플사베트/, "菠萝冰沙", "小菜/加点"],
    [/산토리하이볼/, "三得利Highball", "酒水/饮料"],
    [/산토리레몬사와/, "三得利柠檬沙瓦", "酒水/饮料"],
    [/포차하이볼|포차이블/, "大排档Highball", "酒水/饮料"],
    [/처음처럼|진로|새로|이슬\/처음|처음진로/, "韩国烧酒", "酒水/饮料"],
    [/청하\/별빛/, "清河米酒 / 星光酒", "酒水/饮料"],
    [/카스\/테라\/켈리|카스\/테라\/헬리/, "Cass / Terra / Kelly 啤酒", "酒水/饮料"],
    [/막걸리/, "马格利米酒", "酒水/饮料"],
    [/생맥주500cc/, "生啤500cc", "酒水/饮料"],
    [/콜라\/사이다/, "可乐 / 雪碧", "酒水/饮料"],
  ];
  const matched = exactMap.find(([pattern]) => pattern.test(normalized));
  return {
    translation: matched?.[1] || fallbackTranslation,
    category: matched?.[2],
  };
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
        reject(new Error("无法初始化图片画布"));
        return;
      }

      canvas.width = width;
      const pushSlice = (start: number, end: number) => {
        const sourceY = image.height * start;
        const sourceHeight = image.height * (end - start);
        const targetHeight = height * (end - start);
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
      };

      if (mode === "single" || image.height <= image.width * 1.8) {
        pushSlice(0, 1);
      } else {
        pushSlice(0, 0.48);
        pushSlice(0.3, 0.78);
        pushSlice(0.58, 1);
      }

      resolve(slices);
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function requestCompletion(settings: Settings, model: string, messages: any[]) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({ model, temperature: 0.1, messages }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `SiliconFlow 请求失败 (${response.status})${
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
  throw lastError instanceof Error ? lastError : new Error("SiliconFlow 请求失败");
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
        content: buildVisionSystemPrompt(),
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl, detail: "auto" } },
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
  const preferredModels = isMostlyKoreanMenu(items)
    ? [settings.model, "deepseek-ai/DeepSeek-V3.2", "moonshotai/Kimi-K2-Thinking", ...TEXT_MODEL_FALLBACKS]
    : [settings.model, ...TEXT_MODEL_FALLBACKS];
  const payload = await requestCompletionWithFallback(
    settings,
    preferredModels,
    [
      {
        role: "system",
        content: buildNormalizerSystemPrompt(items),
      },
      {
        role: "user",
        content: `Normalize these OCR menu items:\n${JSON.stringify(items, null, 2)}`,
      },
    ],
  );

  return extractItems<RecognizedMenuItem>(extractMessageText(payload));
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

  const payload = (await response.json()) as { images?: Array<{ url?: string }> };
  const imageUrl = payload.images?.[0]?.url;
  if (!imageUrl) throw new Error("SiliconFlow 没有返回图片地址");
  return imageUrl;
}

async function requestDishImageUrl(settings: Settings, item: MenuItem) {
  let lastError: unknown;
  for (const model of uniqueModels([settings.imageModel, ...IMAGE_MODEL_FALLBACKS])) {
    try {
      return await requestDishImageUrlWithModel(settings, item, model);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("SiliconFlow 生图失败");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
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

async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onResult?: (result: T) => void,
) {
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index;
      index += 1;
      const result = await tasks[current]();
      onResult?.(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
  );
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
    // Ignore local cache quota errors.
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

function mergeRawItems(items: RawRecognizedMenuItem[]) {
  const seen = new Set<string>();
  return compactOcrItems(items).filter((item) => {
    const key = `${normalizeLoose(item.original)}:${parsePrice(item.price) || 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ensureClientApiKey(settings: Settings) {
  if (!settings.apiKey.trim()) {
    throw new Error("请先填写 SiliconFlow API Key");
  }
}

async function recognizeMenuFilesViaBackend(
  files: File[],
  settings: Settings,
  onProgress?: (count: number) => void,
  onPartialItems?: (items: MenuItem[]) => void,
) {
  const baseUrl = getBackendBaseUrl();
  if (baseUrl === null) throw new Error("服务端代理不可用");

  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  formData.append("model", settings.model);
  formData.append("visionModel", settings.visionModel);

  const response = await fetch(`${baseUrl}/api/recognize`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `服务端识别失败 (${response.status})`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("服务端未返回识别流");

  const decoder = new TextDecoder();
  let buffer = "";
  let finalItems: MenuItem[] | null = null;
  let latestPartialItems: MenuItem[] = [];

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const payload = JSON.parse(line) as
          | { type: "progress"; count: number }
          | { type: "partial"; items: MenuItem[] }
          | { type: "final"; items: MenuItem[] }
          | { type: "ocr_partial"; count: number }
          | { type: "translated_partial"; count: number; items: MenuItem[] }
          | { type: "final_cleaned"; count: number; items: MenuItem[] }
          | { type: "error"; message: string };

        if (payload.type === "progress") onProgress?.(payload.count);
        if (payload.type === "ocr_partial") {
          // Keep the transport compatible, but the UI count should prefer translated items.
        }
        if (payload.type === "partial") {
          latestPartialItems = payload.items;
          onPartialItems?.(payload.items);
        }
        if (payload.type === "translated_partial") {
          latestPartialItems = payload.items;
          onProgress?.(payload.count);
          onPartialItems?.(payload.items);
        }
        if (payload.type === "final") finalItems = payload.items;
        if (payload.type === "final_cleaned") {
          finalItems = payload.items;
          onProgress?.(payload.count);
        }
        if (payload.type === "error") throw new Error(payload.message);
      }
      newlineIndex = buffer.indexOf("\n");
    }

    if (done) break;
  }

  if (!finalItems && latestPartialItems.length > 0) return latestPartialItems;
  if (!finalItems) throw new Error("服务端没有返回最终识别结果");
  return finalItems;
}

async function recognizeMenuFilesDirect(
  files: File[],
  settings: Settings,
  onProgress?: (count: number) => void,
  onPartialItems?: (items: MenuItem[]) => void,
) {
  ensureClientApiKey(settings);

  const mergedItems: RawRecognizedMenuItem[] = [];
  let lastEmittedCount = 0;
  const emitPartial = () => {
    const partialItems = mapRecognizedItems(
      rawItemsToRecognizedItems(mergeRawItems(mergedItems)),
    );
    if (partialItems.length <= lastEmittedCount) return;
    lastEmittedCount = partialItems.length;
    onProgress?.(partialItems.length);
    onPartialItems?.(partialItems);
  };

  const tasks: Array<() => Promise<RawRecognizedMenuItem[]>> = [];

  for (const file of files) {
    const [fastSlices, detailSlices] = await Promise.all([
      splitImage(file, "single"),
      splitImage(file, "slices"),
    ]);
    const seenSlices = new Set<string>();

    for (const slice of [...fastSlices, ...detailSlices]) {
      if (!slice || seenSlices.has(slice)) continue;
      seenSlices.add(slice);
      tasks.push(async () => requestVisionRecognition(slice, settings));
    }
  }

  await runPool(tasks, OCR_CONCURRENCY, (result) => {
    mergedItems.push(...result);
    emitPartial();
  });

  const rawItems = mergeRawItems(mergedItems);
  const normalizedItems = canSkipNormalizer(rawItems)
    ? rawItemsToRecognizedItems(rawItems)
    : await withTimeout(
        requestNormalizer(rawItems, settings),
        NORMALIZE_TIMEOUT_MS,
        "菜单整理超时，请稍后再试",
      );

  onProgress?.(normalizedItems.length);
  return mapRecognizedItems(normalizedItems);
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
  const baseUrl = getBackendBaseUrl();
  if (baseUrl !== null) {
    const response = await fetch(`${baseUrl}/api/generate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item, imageModel: settings.imageModel }),
    });

    if (response.ok) {
      return response.blob();
    }

    if (!settings.apiKey.trim()) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || "服务端生图失败");
    }
  }

  ensureClientApiKey(settings);
  const imageUrl = await requestDishImageUrl(settings, item);
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error("生成后的图片下载失败");
  return imageResponse.blob();
}

export async function generateDishImageUrl(settings: Settings, item: MenuItem) {
  ensureClientApiKey(settings);
  return requestDishImageUrl(settings, item);
}

export function sortTabs(tabs: string[]) {
  return [...new Set(tabs.filter(Boolean))];
}

export async function recognizeMenuFiles(
  files: File[],
  settings: Settings,
  onProgress?: (count: number) => void,
  onPartialItems?: (items: MenuItem[]) => void,
) {
  const cacheKey = await getScanCacheKey(files, settings);
  const cached = readCachedScanResult(cacheKey);
  if (cached && cached.length > 0) {
    onProgress?.(cached.length);
    onPartialItems?.(cached);
    return cached;
  }

  let items: MenuItem[];
  const backendEnabled = isBackendProxyEnabled();

  if (backendEnabled) {
    try {
      items = await recognizeMenuFilesViaBackend(files, settings, onProgress, onPartialItems);
    } catch (error) {
      if (!settings.apiKey.trim()) {
        throw error instanceof Error ? error : new Error("服务端识别失败");
      }
      items = await recognizeMenuFilesDirect(files, settings, onProgress, onPartialItems);
    }
  } else {
    items = await recognizeMenuFilesDirect(files, settings, onProgress, onPartialItems);
  }

  writeCachedScanResult(cacheKey, items);
  return items;
}
