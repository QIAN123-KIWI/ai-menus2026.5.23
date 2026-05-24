import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env.local") });
dotenv.config({ path: path.join(rootDir, ".env") });

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const distDir = path.join(rootDir, "dist");
const cacheDir = path.join(rootDir, ".cache", "recognize");
const API_URL = "https://api.siliconflow.cn/v1/chat/completions";
const IMAGE_API_URL = "https://api.siliconflow.cn/v1/images/generations";
const PORT = Number(process.env.PORT || 8787);
const API_KEY =
  process.env.SILICONFLOW_API_KEY || process.env.VITE_SILICONFLOW_API_KEY || "";

const DEFAULT_MODEL =
  process.env.SILICONFLOW_MODEL ||
  process.env.VITE_SILICONFLOW_MODEL ||
  "Pro/moonshotai/Kimi-K2.6";
const DEFAULT_VISION_MODEL =
  process.env.SILICONFLOW_VISION_MODEL ||
  process.env.VITE_SILICONFLOW_VISION_MODEL ||
  "deepseek-ai/DeepSeek-OCR";
const DEFAULT_IMAGE_MODEL =
  process.env.SILICONFLOW_IMAGE_MODEL ||
  process.env.VITE_SILICONFLOW_IMAGE_MODEL ||
  "Qwen/Qwen-Image";

const SCAN_CACHE_VERSION = "server-v15";
const OCR_SLICE_CONCURRENCY = 18;
const NORMALIZER_CONCURRENCY = 12;
const NORMALIZER_CHUNK_SIZE = 3;
const STREAM_TRANSLATION_CONCURRENCY = 5;
const ENABLE_STRUCTURED_RESCUE = false;
const NORMALIZE_TIMEOUT_MS = 18000;
const OCR_FAST_TIMEOUT_MS = 7000;
const OCR_SLOW_TIMEOUT_MS = 9000;
const OCR_MIN_ACCEPTABLE_ITEMS = 12;
const OCR_RESCUE_MIN_ITEMS = 28;
const OCR_RESCUE_TIMEOUT_MS = 32000;
const OCR_PANEL_STRUCTURED_TIMEOUT_MS = 14000;
const IMAGE_SIZE = "320x320";
const CATEGORY_FALLBACK = "其他";

const TEXT_MODEL_FALLBACKS = [
  "deepseek-ai/DeepSeek-V3.2",
  DEFAULT_MODEL,
  "moonshotai/Kimi-K2-Thinking",
];
const OCR_FAST_MODELS = [
  "deepseek-ai/DeepSeek-OCR",
  "Qwen/Qwen3-VL-8B-Instruct",
  DEFAULT_MODEL,
  DEFAULT_VISION_MODEL,
];
const OCR_SLOW_MODELS = [
  "Qwen/Qwen3-VL-32B-Instruct",
  "Qwen/Qwen3-VL-30B-A3B-Instruct",
  DEFAULT_MODEL,
];
const IMAGE_MODEL_FALLBACKS = [DEFAULT_IMAGE_MODEL, "Qwen/Qwen-Image"];

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

app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

function ensureApiKey() {
  if (!API_KEY.trim()) {
    throw new Error("服务端未配置 SiliconFlow API Key");
  }
}

function sendEvent(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
  res.flush?.();
}

function uniqueModels(models) {
  return [...new Set(models.map((model) => model?.trim()).filter(Boolean))];
}

function normalizeCategory(input = "") {
  const cleaned = String(input).replace(/\s*\([^)]*\)/g, "").trim();
  return cleaned || CATEGORY_FALLBACK;
}

function normalizeLoose(input = "") {
  return String(input)
    .normalize("NFKC")
    .replace(/[\s\u3000\u30fb.,_\-()（）[\]{}:：/\\]+/g, "")
    .toLowerCase();
}

function normalizeCachePart(input = "") {
  return String(input)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function inferLangCode(text = "") {
  if (/[\u3040-\u30ff]/.test(text)) return "ja-JP";
  if (/[\uac00-\ud7af]/.test(text)) return "ko-KR";
  if (/[\u0E00-\u0E7F]/.test(text)) return "th-TH";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh-CN";
  if (/[\u00C0-\u024F]/.test(text)) return "vi-VN";
  return "en-US";
}

function normalizeLangCode(input, fallbackText = "") {
  const value = String(input || "").trim().toLowerCase();
  if (["ko", "kor", "kr", "ko-kr", "ko_kr", "korean"].includes(value)) return "ko-KR";
  if (["ja", "jp", "jpn", "ja-jp", "ja_jp", "japanese"].includes(value)) return "ja-JP";
  if (["zh", "cn", "zh-cn", "zh_cn", "chinese"].includes(value)) return "zh-CN";
  if (["th", "tha", "th-th", "thai"].includes(value)) return "th-TH";
  if (["vi", "vie", "vi-vn", "vietnamese"].includes(value)) return "vi-VN";
  if (value) return input;
  return inferLangCode(fallbackText);
}

function splitPronunciation(input = "") {
  const trimmed = String(input || "").trim();
  const match = trimmed.match(/^(.+?)\s*\((.+?)\)$/);
  if (!match) return { phonetic: trimmed, transliteration: "" };
  return { phonetic: match[1].trim(), transliteration: match[2].trim() };
}

function formatCurrencySymbol(input = "JPY") {
  const normalized = String(input || "").toUpperCase().trim();
  if (["YEN", "JPY", "￥", "¥", "円", "JAPANESE YEN"].includes(normalized)) return "円";
  if (["KRW", "₩", "WON", "원"].includes(normalized)) return "원";
  if (["CNY", "RMB", "元"].includes(normalized)) return "元";
  if (["USD", "US$", "$", "DOLLAR"].includes(normalized)) return "$";
  if (["EUR", "€", "EURO"].includes(normalized)) return "€";
  if (["THB", "฿", "BAHT", "บาท"].includes(normalized)) return "บาท";
  if (["VND", "₫", "DONG", "Đ", "đ"].includes(normalized)) return "đ";
  return input || "円";
}

function parsePrice(input) {
  const match = String(input || "").match(/(?:[¥￥₩$€฿₫]\s*)?([0-9][0-9,.]*)/);
  if (!match) return 0;
  return Number(match[1].replace(/,/g, "")) || 0;
}

function formatCleanCurrencySymbol(input = "JPY") {
  const value = String(input || "").trim();
  const normalized = value.toUpperCase();
  if (!value || /^(JPY|YEN|JAPANESE YEN)$/i.test(value) || /[\u00A5\u5186]/.test(value)) return "\u5186";
  if (/^(KRW|WON)$/i.test(value) || /[\u20A9\uC6D0]/.test(value)) return "\uC6D0";
  if (/^(CNY|RMB)$/i.test(value) || /[\uFFE5\u5143]/.test(value)) return "\u5143";
  if (/^(THB|BAHT)$/i.test(value) || /[\u0E3F]/.test(value) || value.includes("\u0E1A\u0E32\u0E17")) return "\u0E1A\u0E32\u0E17";
  if (/^(VND|DONG)$/i.test(value) || /[\u20AB\u0111\u0110]/.test(value)) return "\u0111";
  if (/^(USD|US\$|DOLLAR)$/i.test(value) || value === "$") return "$";
  if (/^(EUR|EURO)$/i.test(value) || value === "\u20AC") return "\u20AC";
  if (normalized.includes("KRW") || normalized.includes("WON")) return "\uC6D0";
  if (normalized.includes("JPY") || normalized.includes("YEN")) return "\u5186";
  if (normalized.includes("CNY") || normalized.includes("RMB")) return "\u5143";
  return value;
}

function guessCleanCurrency(input = "") {
  const value = String(input || "");
  if (/[\u00A5\u5186]|JPY|YEN/i.test(value)) return "JPY";
  if (/[\u20A9\uC6D0]|KRW|WON/i.test(value)) return "KRW";
  if (/[\uFFE5\u5143]|CNY|RMB/i.test(value)) return "CNY";
  if (/\u0E3F|\u0E1A\u0E32\u0E17|THB|BAHT/i.test(value)) return "THB";
  if (/[\u20AB\u0111\u0110]|VND|DONG/i.test(value)) return "VND";
  if (/\$|USD/i.test(value)) return "USD";
  if (/\u20AC|EUR/i.test(value)) return "EUR";
  return "";
}

function guessCurrency(input = "") {
  const value = String(input || "");
  if (/[₩원]|KRW|WON/i.test(value)) return "KRW";
  if (/[¥￥円]|JPY|YEN/i.test(value)) return "JPY";
  if (/[元]|CNY|RMB/i.test(value)) return "CNY";
  if (/\$|USD/i.test(value)) return "USD";
  if (/[€]|EUR/i.test(value)) return "EUR";
  if (/[฿บาท]|THB/i.test(value)) return "THB";
  if (/[₫đĐ]|VND/i.test(value)) return "VND";
  return "JPY";
}

function translateCategoryToChinese(input) {
  const cleaned = normalizeCategory(input);
  if (!cleaned || cleaned === CATEGORY_FALLBACK) return CATEGORY_FALLBACK;
  if (/神田屋|黒醤油使用/.test(cleaned)) return "主菜";
  if (/^煮$/.test(cleaned)) return "炖煮/锅物";
  if (/^肉刺$/.test(cleaned)) return "刺身/冷盘";
  if (/^薄皮餃子$/.test(cleaned)) return "薄皮饺子";
  if (/^水餃子$/.test(cleaned)) return "水饺";
  if (/^油淋餃子$/.test(cleaned)) return "油淋饺子";
  if (/^(一品)$/.test(cleaned)) return "前菜";
  if (/^(菜品|品)$/.test(cleaned)) return "主菜";
  if (/^(汤品|汤类)$/.test(cleaned)) return "汤/炖锅";
  if (/^(丼|丼饭|盖饭)$/.test(cleaned)) return "主食";
  if (/^(铁板烧蔬菜|铁板烧|铁板)$/.test(cleaned)) return "铁板";
  if (/^(味噌烧\/葱烧|葱烧)$/.test(cleaned)) return "烧烤";
  if (/^[\u4e00-\u9fff\s/]+$/.test(cleaned)) return cleaned;
  if (/(今日|本日|추천|おすすめ|オススメ|recommend|chef|special)/i.test(cleaned)) return "今日推荐";
  if (/(前菜|一品|appetizer|starter|small plate|小菜)/i.test(cleaned)) return "前菜";
  if (/(サラダ|沙拉|salad)/i.test(cleaned)) return "沙拉";
  if (/(スープ|汤|湯|soup|탕|찌개)/i.test(cleaned)) return "汤/炖锅";
  if (/(主食|麺・飯|麺飯|麺|飯|밥|면|meal|noodle|rice|pasta|丼|うどん|クッパ)/i.test(cleaned)) return "主食";
  if (/(炒|볶음|볶음류|stir|fried)/i.test(cleaned)) return "炒菜类";
  if (/(鉄板|铁板)/i.test(cleaned)) return "铁板";
  if (/(烧烤|焼き|焼物|구이|grill|bbq)/i.test(cleaned)) return "烧烤";
  if (/(干货|마른안주|안주|snack)/i.test(cleaned)) return "干货/下酒小食";
  if (/(小菜|加点|사이드|side|addon|add-on)/i.test(cleaned)) return "小菜/加点";
  if (/(酒|饮品|飲み物|ドリンク|주류|음료|drink|beverage|beer|wine|cocktail)/i.test(cleaned)) {
    return "酒水/饮料";
  }
  if (/饮料|飲料/.test(cleaned)) return "酒水/饮料";
  if (/(dish|dishes|food|menu item|요리)/i.test(cleaned)) return "主菜";
  if (/(甜品|甘味|デザート|dessert|sweet|샤베트)/i.test(cleaned)) return "甜品";
  if (/(메인|메뉴|메인요리|main)/i.test(cleaned)) return "主菜";
  return CATEGORY_FALLBACK;
}

function getKoreanMenuOverride(sourceText, fallbackTranslation = "", fallbackCategory) {
  const normalized = normalizeLoose(sourceText);
  const exactMap = [
    [/김치.*날치알.*계란말이|김치.*날치알.*게란말이|김치.*날치알.*게란달이|김치.*계란말이|김치볶지게란말이/, "泡菜飞鱼籽鸡蛋卷", "主菜"],
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
    [/똥집|통집/, "鸡胗（盐/咖喱/调味）", "炒菜类"],
    [/양념막창/, "调味烤猪大肠", "炒菜类"],
    [/[매개]운무뼈닭발/, "辣无骨鸡爪", "炒菜类"],
    [/오징어데침|정어대침/, "白灼鱿鱼", "炒菜类"],
    [/징어데침|징어대침/, "白灼鱿鱼", "炒菜类"],
    [/오징어볶음|정어볶음|정어부음/, "辣炒鱿鱼", "炒菜类"],
    [/징어볶음/, "辣炒鱿鱼", "炒菜类"],
    [/육볶음/, "辣炒肉", "炒菜类"],
    [/모듬오뎅탕/, "关东煮拼盘汤", "汤/炖锅"],
    [/김치오뎅탕/, "泡菜关东煮汤", "汤/炖锅"],
    [/돼지김치찌개/, "猪肉泡菜锅", "汤/炖锅"],
    [/꽁치김치찌개|공치김치찌개|콩치김치찌개/, "秋刀鱼泡菜锅", "汤/炖锅"],
    [/참치김치찌개/, "金枪鱼泡菜锅", "汤/炖锅"],
    [/먹태/, "烤明太鱼干", "干货/下酒小食"],
    [/반건조오징어/, "半干鱿鱼", "干货/下酒小食"],
    [/왕노가리/, "大号鳕鱼干", "干货/下酒小食"],
    [/우동/, "乌冬面", "小菜/加点"],
    [/소면사리추가/, "加细面", "小菜/加点"],
    [/^국수$|^소면$/, "面条", "小菜/加点"],
    [/라면/, "拉面", "小菜/加点"],
    [/주먹밥|먹밥/, "饭团", "小菜/加点"],
    [/파인애플샤베트|파인애플사베트|파인애플\s*샐러드|파인애플\s*샤베트/, "菠萝冰沙", "甜品"],
    [/산토리하이볼/, "三得利Highball", "酒水/饮料"],
    [/산토리레몬사와/, "三得利柠檬沙瓦", "酒水/饮料"],
    [/포차하이볼|포차이블/, "大排档Highball", "酒水/饮料"],
    [/처음처럼|진로|새로|이슬\/처음|처음진로/, "韩国烧酒", "酒水/饮料"],
    [/청하\/별빛|청하별빛/, "清河米酒 / 星光酒", "酒水/饮料"],
    [/카스\/테라\/켈리|카스\/테라\/헬리|카스테라켈리|카스테라헬리/, "Cass / Terra / Kelly 啤酒", "酒水/饮料"],
    [/막걸리/, "马格利米酒", "酒水/饮料"],
    [/생맥주500cc/, "生啤500cc", "酒水/饮料"],
    [/콜라\/사이다|콜라사이다/, "可乐 / 雪碧", "酒水/饮料"],
  ];
  const secondaryMap = [
    [/きゅうりキムチ/, "黄瓜泡菜", "前菜"],
    [/キムチ2種盛/, "双拼泡菜", "前菜"],
    [/チシャ菜/, "生菜叶", "沙拉"],
    [/塩ダレきゅうり/, "盐汁黄瓜", "沙拉"],
    [/ぶつ切キャベツ/, "手撕卷心菜", "沙拉"],
    [/塩ダレキャベツ/, "盐汁卷心菜", "沙拉"],
    [/もやしナムル/, "凉拌豆芽", "前菜"],
    [/なすびナムル/, "凉拌茄子", "前菜"],
    [/ほうれん草ナムル/, "凉拌菠菜", "前菜"],
    [/ナムル3種盛/, "三种拌菜拼盘", "前菜"],
    [/大根のなます/, "凉拌萝卜丝", "前菜"],
    [/韓国のり/, "韩式海苔", "前菜"],
    [/牛すじ土手煮/, "味噌炖牛筋", "前菜"],
    [/たまごスープ/, "鸡蛋汤", "汤/炖锅"],
    [/わか玉スープ/, "海带蛋花汤", "汤/炖锅"],
    [/ビビンバ/, "韩式拌饭", "主食"],
    [/石焼ビビ/, "石锅拌饭", "主食"],
    [/牛骨だし天津飯/, "牛骨高汤天津饭", "主食"],
    [/鶏クッパ/, "鸡肉汤饭", "主食"],
    [/ビビンめん/, "韩式拌面", "主食"],
    [/牛すじ煮うどん/, "牛筋炖乌冬", "主食"],
    [/牛モツうどん/, "牛杂乌冬", "主食"],
    [/白ごはん/, "白米饭", "主食"],
    [/雪見だいふくミニ/, "雪见大福迷你版", "甜品"],
    [/ビスケットサンド/, "饼干冰淇淋三明治", "甜品"],
    [/ガツンとみかん/, "蜜柑冰棒", "甜品"],
    [/コーラハイボール/, "可乐Highball", "酒水/饮料"],
    [/ジンジャーハイボール/, "姜汁Highball", "酒水/饮料"],
    [/ザクギリレモンハイボール/, "柠檬块Highball", "酒水/饮料"],
    [/ハイボール/, "Highball", "酒水/饮料"],
    [/酎ハイ/, "烧酒嗨棒", "酒水/饮料"],
    [/アサヒスーパードライ樽生/, "朝日超爽生啤", "酒水/饮料"],
    [/アサヒスーパードライ中瓶/, "朝日超爽中瓶", "酒水/饮料"],
    [/アサヒマルエフ中瓶/, "朝日丸F中瓶", "酒水/饮料"],
    [/アサヒドライゼロ小瓶/, "朝日零度无酒精小瓶", "酒水/饮料"],
    [/焼酎/, "烧酒", "酒水/饮料"],
    [/梅酒/, "梅酒", "酒水/饮料"],
    [/日本酒/, "日本清酒", "酒水/饮料"],
    [/白鶴/, "白鹤清酒", "酒水/饮料"],
    [/ワイン/, "葡萄酒", "酒水/饮料"],
    [/グラスワイン/, "杯装葡萄酒", "酒水/饮料"],
    [/ソフトドリンク/, "软饮", "酒水/饮料"],
    [/カルピスソーダ/, "可尔必思苏打", "酒水/饮料"],
    [/ゆずティー/, "柚子茶", "酒水/饮料"],
    [/黒ウーロン茶/, "黑乌龙茶", "酒水/饮料"],
    [/チキンシーザ.?サラダ|ケチャ.?ジ.?サラダ|ススメ.?サラダ/, "鸡肉凯撒沙拉", "沙拉"],
    [/とりするめ|上りすきめ/, "鸡肉小菜", "前菜"],
    [/蒸し鶏.*(ねぎ|ソース|ポター?ジュ)/, "葱酱蒸鸡", "主菜"],
    [/むね肉の山かけ|セロリの山かけ/, "山药鸡胸肉", "主菜"],
    [/(せせり.*黒.*揚げ|サリダイン.*揚げ|黒こめ揚げ)/, "黑胡椒鸡颈脆骨", "主菜"],
    [/(じゃがいも.*ナムル|のナムル|じゃがいもとまぐろのうどん)/, "土豆豆芽拌菜", "配菜"],
    [/(ブロッコリー.*チリマヨ|ブドウフルーツのチリ)/, "西兰花辣味蛋黄酱", "配菜"],
    [/(お芋さん塩バター|お茶塩バター)/, "盐黄油土豆", "配菜"],
    [/チリの天ぷら/, "舞茸天妇罗", "配菜"],
    [/いちごミルク(アイス|プレス)/, "草莓牛奶冰淇淋", "甜品"],
    [/骨.*鶏.*ベーコン/, "带骨鸡肉培根", "主菜"],
    [/チキンカレーライス/, "鸡肉咖喱饭", "主食"],
    [/チキンカレー/, "鸡肉咖喱", "主菜"],
    [/ケチャー?ジャー|ケチャ.?ジ.?ャー|ケチャ.?ジ.?サラダ/, "鸡肉凯撒沙拉", "沙拉"],
    [/上りすき[のめ]/, "鸡肉小菜", "前菜"],
    [/蒸し鶏のポタ.?ズ|蒸し鶏のポター?ジュ/, "葱酱蒸鸡", "主菜"],
    [/せせりあんこ黒[いし].*揚げ/, "黑胡椒鸡颈脆骨", "主菜"],
    [/じゃがいもとまぐろの(カレー|うどん)/, "土豆豆芽拌菜", "配菜"],
    [/ブドウソースのチリ/, "西兰花辣味蛋黄酱", "配菜"],
    [/お茶と塩バター/, "盐黄油土豆", "配菜"],
    [/ザクギリレモン/, "柠檬块Highball", "酒水/饮料"],
    [/ブレーン.*各/, "酎High 可选口味", "酒水/饮料"],
    [/ゆずジャム.*各/, "酎High 特调口味", "酒水/饮料"],
  ];
  const matched = [...secondaryMap, ...exactMap].find(([pattern]) => pattern.test(normalized));
  return {
    translation: matched?.[1] || fallbackTranslation,
    category: matched?.[2] || fallbackCategory,
  };
}

function getJapaneseMenuOverride(sourceText, fallbackTranslation = "", fallbackCategory) {
  const normalized = normalizeLoose(sourceText);
  const exactMap = [
    [/生せんまい刺し|なませんまいさし|namasenmaisashi/, "生拌牛百叶刺身", "前菜"],
    [/あぶりユッケ|あぶりゆっけ|aburiyukke/, "炙烤生拌牛肉", "前菜"],
    [/こころ刺し|こころさし|kokorosashi/, "牛心刺身", "前菜"],
    [/白菜キムチ|はくさいきむち|hakusaikimuchi/, "白菜泡菜", "前菜"],
    [/チョレギサラダ|ちょれぎさらだ|choregisarada/, "韩式生菜沙拉", "沙拉"],
    [/わかめスープ|わかめすーぷ|wakamesuupu/, "海带芽汤", "汤/炖锅"],
    [/石焼ビビンバ|いしやきびびんば|ishiyakibibinba/, "石锅拌饭", "主食"],
    [/盛岡れいめん|もりおかれいめん|moriokareimen/, "盛冈冷面", "主食"],
    [/わかめうどん|wakameudon/, "海带芽乌冬", "主食"],
    [/チキンシーザーサラダ|chikinshiizaasarada/, "鸡肉凯撒沙拉", "沙拉"],
    [/とりするめ|torisurume/, "鸡肉小菜", "前菜"],
    [/蒸し鶏のねぎソース|むしどりのねぎそーす|mushidorinonegisoosu/, "葱酱蒸鸡", "主菜"],
    [/むね肉の山かけ|munenikunoyamakake/, "山药鸡胸肉", "主菜"],
    [/せせりなんこつ黒こしょう|seserinankotsukurokoshou/, "黑胡椒鸡颈脆骨", "主菜"],
    [/じゃがいもともやしのナムル|jagaimotomoyashinonamuru/, "土豆豆芽拌菜", "配菜"],
    [/ブロッコリーのチリマヨ|burokkoriinochirimayo/, "西兰花辣味蛋黄酱", "配菜"],
    [/お芋de塩バター|oimodeshiobataa/, "盐黄油土豆", "配菜"],
    [/まいたけの天ぷら|maitakenotempura/, "舞茸天妇罗", "配菜"],
    [/いちごミルクアイス|ichigomirukuaisu/, "草莓牛奶冰淇淋", "甜品"],
    [/りんごの天ぷら|ringonotempura/, "苹果天妇罗", "甜品"],
    [/骨つき鶏ベーコン|honezukitoribeekon/, "带骨鸡肉培根", "主菜"],
    [/チキンカレーライス|chikinkareeraisu/, "鸡肉咖喱饭", "主食"],
    [/ハイボール|haibooru/, "高球", "酒水/饮料"],
    [/コーラハイボール|koorahaibooru/, "可乐高球", "酒水/饮料"],
    [/ジンジャーハイボール|jinjaahaibooru/, "姜汁高球", "酒水/饮料"],
    [/サワー|sawaa/, "沙瓦", "酒水/饮料"],
  ];
  const matched = exactMap.find(([pattern]) => pattern.test(normalized));
  return {
    translation: matched?.[1] || fallbackTranslation,
    category: matched?.[2] || fallbackCategory,
  };
}

function getHeuristicMenuTranslation(sourceText, sourceLang, fallbackTranslation = "", fallbackCategory = CATEGORY_FALLBACK) {
  const normalizedFallback = normalizeLoose(fallbackTranslation);
  const normalizedSource = normalizeLoose(sourceText);
  if (sourceLang !== "ja-JP") {
    return {
      translation: fallbackTranslation || sourceText,
      category: fallbackCategory || CATEGORY_FALLBACK,
    };
  }

  const exactMap = [
    [/^もつ煮込み$/, "炖牛杂", "炖煮/锅物"],
    [/^牛すき焼き鍋$/, "牛肉寿喜烧锅", "炖煮/锅物"],
    [/^砂肝刺し$/, "砂肝刺身", "刺身/冷盘"],
    [/^鶏レバー刺し$/, "鸡肝刺身", "刺身/冷盘"],
    [/^アボカド$/, "牛油果", "小菜/加点"],
    [/^よだれ鶏$/, "口水鸡", "前菜"],
    [/^肉じゃが$/, "土豆炖肉", "炖煮/锅物"],
    [/^おつまみチ[ョヨ]リ[ソツ]ー$/, "下酒辣香肠", "前菜"],
    [/^ねぎだくホルモンポン酢$/, "葱花内脏柚子醋", "前菜"],
    [/^活どじょう唐揚げ$/, "炸活泥鳅", "炸物"],
    [/^水鶏の薬味おろしポン酢$/, "鸡肉萝卜泥柚子醋", "前菜"],
    [/^赤えびユッ[ケク]$/, "赤虾生拌", "前菜"],
    [/^レッドホット鶏ハーブ$/, "辣味香草鸡", "主菜"],
    [/^たのチキンガーリック$/, "蒜香鸡肉", "主菜"],
    [/^胡麻カンパチ$/, "芝麻酱红甘鱼", "刺身/冷盘"],
    [/^唐揚げ$/, "日式炸鸡", "炸物"],
    [/^シチュー$/, "奶油炖菜", "主菜"],
    [/^揚げ$/, "炸物", "炸物"],
    [/^わさび$/, "山葵", "小菜/加点"],
    [/^6個$/, "6个装", "小菜/加点"],
    [/^温麺・冷麺$/, "温面/冷面", "面类"],
    [/^トースト・カレー$/, "吐司咖喱", "主食"],
    [/^気まぐれサラダ$/, "主厨随性沙拉", "沙拉"],
    [/^Mixネギ$/i, "综合葱烧", "烧烤"],
    [/^神郎系！ニンニク増し増し冷製ねぎ和えそば$/, "蒜香加量冷拌葱荞麦面", "主食"],
    [/^昔ながらのナポリタン$/, "怀旧拿坡里意面", "主食"],
    [/^神田屋\s*黒[猫醤]油使用まっ黒チャーハン$/, "神田屋黑酱油黑炒饭", "主食"],
    [/^黒胡椒レモン焼きそば$/, "黑胡椒柠檬炒面", "主食"],
    [/^昭和の中華そば$/, "昭和风中华拉面", "主食"],
    [/^絶品！かき味噌$/, "绝品牡蛎味噌", "珍味"],
    [/^梅水晶$/, "梅水晶（鲨鱼软骨梅肉）", "珍味"],
    [/^極わたくいかの塩から$/, "极上鱿鱼盐辛", "珍味"],
    [/^濃厚！豆腐の味噌漬け$/, "浓厚味噌腌豆腐", "珍味"],
    [/^まぐろの酒盗$/, "金枪鱼酒盗", "珍味"],
    [/^ハクベテ$/, "烤牛排", "主菜"],
    [/^シーフード$/, "海鲜料理", "主菜"],
    [/^酒\s*￥\d+\s*赤丸のう$/, "赤丸下酒菜", "前菜"],
    [/^酒\s*￥\d+\s*鶏もも$/, "鸡腿肉下酒菜", "前菜"],
    [/^フライドエッグ$/, "煎蛋", "小菜/加点"],
    [/^えんがわ$/, "比目鱼裙边", "刺身/冷盘"],
    [/^バナアイえ$/, "香蕉冰淇淋", "甜品"],
    [/^二層の漬けまど井$/, "双层腌金枪鱼盖饭", "主食"],
    [/^まかないトロたく井$/, "金枪鱼腩腌萝卜盖饭", "主食"],
    [/^タマネギ$/, "洋葱", "配菜"],
    [/^鶏スープ$/, "鸡汤", "汤/炖锅"],
    [/^悪魔のドーナッツアイス$/, "恶魔甜甜圈冰淇淋", "甜品"],
    [/^追加青唐辛子$/, "追加青辣椒", "小菜/加点"],
    [/^焼きたけんこ$/, "薄皮煎饺", "薄皮饺子"],
    [/^シソ巻き焼きたけんこ$/, "紫苏卷薄皮煎饺", "薄皮饺子"],
    [/^油淋焼きたけんこ$/, "油淋薄皮煎饺", "薄皮饺子"],
    [/^秘伝スープの水餃子$/, "秘制高汤水饺", "水饺"],
    [/^焼き餃子$/, "煎饺", "薄皮饺子"],
    [/^いか肝ルイベ$/, "冰镇鱿鱼肝", "珍味"],
    [/^げそわさ$/, "山葵鱿鱼须", "珍味"],
    [/^赤丸の[う力]$/, "赤丸风味小菜", "前菜"],
    [/^胡麻カツ$/, "芝麻炸猪排", "主菜"],
    [/^鶏肉カツ$/, "炸鸡排", "主菜"],
    [/^シ[ソシ]巻き焼き餃子$/, "紫苏卷煎饺", "薄皮饺子"],
    [/^神田屋\s*黒醤油使用まう黒チャーハン$/, "神田屋黑酱油黑炒饭", "主食"],
    [/^とろたくタワー$/, "金枪鱼腩腌萝卜塔", "前菜"],
    [/^いか刺し$/, "鱿鱼刺身", "刺身/冷盘"],
    [/^[みメ]さばの刺身$/, "青花鱼刺身", "刺身/冷盘"],
    [/^チャーシュー$/, "叉烧", "主菜"],
    [/^おつまみ\s*チョリツー$/, "下酒辣香肠", "前菜"],
    [/^まかないトロたっく井$/, "金枪鱼腩腌萝卜盖饭", "主食"],
    [/^ロコット$/, "可乐饼", "炸物"],
    [/^レッドポー！オズエ！鶏ハム$/, "辣味鸡肉火腿", "主菜"],
    [/^水焼の薬味おろしポン酢\s*赤えびエッグ$/, "萝卜泥柚子醋水章鱼配赤虾蛋", "前菜"],
    [/^たのチキンガリック\s*¥\d+\s*胡麻カンパチ$/, "蒜香鸡肉配芝麻红甘鱼", "前菜"],
    [/^豚の角煮\s*¥\d+\s*あおさたっぷり湯葉押し$/, "猪肉角煮配海苔腐皮", "前菜"],
    [/^かわらび餅$/, "蕨饼", "甜品"],
    [/^タマゴ$/, "鸡蛋", "小菜/加点"],
    [/^二鶏の漬けまぐろ丼$/, "双层腌金枪鱼盖饭", "主食"],
    [/^月家の角煮$/, "猪肉角煮", "主菜"],
    [/^和牛スイート$/, "和牛甜味烧", "主菜"],
    [/^き野菜$/, "烤蔬菜", "配菜"],
    [/^鉄板ナポリタ$/, "铁板拿坡里意面", "主食"],
    [/^イカビネギ$/, "鱿鱼虾葱烧", "烧烤"],
    [/^から牛$/, "炸鸡牛肉双拼盖饭", "主食"],
    [/^サラダセット$/, "沙拉套餐", "小菜/加点"],
    [/^ポテトサラダ$/, "土豆沙拉", "沙拉"],
    [/^ポテトサラダセット$/, "土豆沙拉套餐", "小菜/加点"],
    [/^お新香セット$/, "日式酱菜套餐", "小菜/加点"],
    [/^キムチセット$/, "泡菜套餐", "小菜/加点"],
    [/^から揚げセット$/, "炸鸡套餐", "小菜/加点"],
    [/^お好みアレンジ$/, "自选搭配", "小菜/加点"],
    [/^3個入$/, "3个装", "小菜/加点"],
    [/^6個入$/, "6个装", "小菜/加点"],
    [/^9個入$/, "9个装", "小菜/加点"],
    [/^みそ汁$/, "味噌汤", "汤/炖锅"],
    [/^しじみ汁$/, "蚬汤", "汤/炖锅"],
    [/^とん汁$/, "豚汁", "汤/炖锅"],
    [/^アタマの大盛$/, "肉量加大", "份量选项"],
    [/^ご飯増量$/, "加饭", "份量选项"],
    [/^バニラアイス$/, "香草冰淇淋", "甜品"],
    [/^もなか付わらび餅$/, "最中饼配蕨饼", "甜品"],
    [/^ほっこり鯛茶漬け$/, "鲷鱼茶泡饭", "主食"],
    [/^まかないトロたく丼$/, "金枪鱼腩腌萝卜盖饭", "主食"],
    [/^カツ丼$/, "炸猪排盖饭", "主食"],
    [/^自家製からあげ丼$/, "自制炸鸡盖饭", "主食"],
    [/^二層の漬けまぐろ丼$/, "双层腌金枪鱼盖饭", "主食"],
    [/^牛丼並$/, "牛肉盖饭（普通份）", "牛肉盖饭"],
    [/^チーズ牛丼並$/, "芝士牛肉盖饭（普通份）", "牛肉盖饭"],
    [/^ねぎ玉牛丼並$/, "葱温泉蛋牛肉盖饭（普通份）", "牛肉盖饭"],
    [/^キムチ牛丼並$/, "泡菜牛肉盖饭（普通份）", "牛肉盖饭"],
    [/^ねぎラー油牛丼並$/, "葱辣油牛肉盖饭（普通份）", "牛肉盖饭"],
    [/^ねぎ塩豚丼並$/, "葱盐猪肉盖饭（普通份）", "猪肉盖饭"],
    [/^豚丼並$/, "猪肉盖饭（普通份）", "猪肉盖饭"],
    [/^スタミナ超特盛丼$/, "元气超大份盖饭", "主食"],
    [/^特盛$/, "特大份", "份量选项"],
    [/^大盛$/, "大份", "份量选项"],
    [/^中盛$/, "中份", "份量选项"],
    [/^小盛$/, "小份", "份量选项"],
    [/^並$/, "普通份", "份量选项"],
    [/^サラダ$/, "沙拉", "沙拉"],
    [/^トマト$/, "番茄", "配菜"],
    [/^山芋$/, "山药", "配菜"],
    [/^レンコン$/, "莲藕", "配菜"],
    [/^アスパラ$/, "芦笋", "配菜"],
    [/^エリンギ$/, "杏鲍菇", "配菜"],
    [/^シイタケ$/, "香菇", "配菜"],
    [/^ブリ$/, "鰤鱼", "鱼类料理"],
  ];
  const exact = exactMap.find(([pattern]) => pattern.test(sourceText));
  if (exact) {
    return { translation: exact[1], category: exact[2] };
  }

  const ingredientMap = [
    ["ねぎラー油", "葱辣油"],
    ["ねぎ玉", "葱温泉蛋"],
    ["ねぎ塩", "葱盐"],
    ["自家製", "自制"],
    ["二層の漬け", "双层腌制"],
    ["まぐろ", "金枪鱼"],
    ["トロたく", "金枪鱼腩腌萝卜"],
    ["鯛茶漬け", "鲷鱼茶泡饭"],
    ["茶漬け", "茶泡饭"],
    ["バニラ", "香草"],
    ["アイス", "冰淇淋"],
    ["わらび餅", "蕨饼"],
    ["もなか", "最中饼"],
    ["カツ", "炸猪排"],
    ["イカ", "鱿鱼"],
    ["エビ", "虾"],
    ["ブタ", "猪肉"],
    ["ネギ", "葱"],
    ["ねぎ", "葱"],
    ["ラー油", "辣油"],
    ["スタミナ", "元气"],
    ["から揚げ", "炸鸡"],
    ["からあげ", "炸鸡"],
    ["キムチ", "泡菜"],
    ["チーズ", "芝士"],
    ["モチ", "年糕"],
    ["ホルモン", "内脏"],
    ["和牛", "和牛"],
    ["Mix", "综合"],
    ["MIX", "综合"],
    ["MiX", "综合"],
    ["ミックス", "综合"],
    ["気まぐれ", "主厨随性"],
    ["サラダ", "沙拉"],
    ["ポン酢", "柚子醋"],
    ["おろし", "萝卜泥"],
    ["薬味", "佐料"],
    ["水鶏", "鸡肉"],
    ["鶏", "鸡肉"],
    ["チキン", "鸡肉"],
    ["レバー", "肝"],
    ["砂肝", "砂肝"],
    ["刺し", "刺身"],
    ["もつ", "牛杂"],
    ["煮込み", "炖煮"],
    ["すき焼き", "寿喜烧"],
    ["鍋", "锅"],
    ["アボカド", "牛油果"],
    ["よだれ", "口水"],
    ["肉じゃが", "土豆炖肉"],
    ["チョリソー", "辣香肠"],
    ["チヨリツー", "辣香肠"],
    ["ホルモン", "内脏"],
    ["どじょう", "泥鳅"],
    ["唐揚げ", "日式炸鸡"],
    ["揚げ", "炸"],
    ["赤えび", "赤虾"],
    ["ユッケ", "生拌"],
    ["ユック", "生拌"],
    ["レッドホット", "辣味"],
    ["ハーブ", "香草"],
    ["ガーリック", "蒜香"],
    ["胡麻", "芝麻"],
    ["カンパチ", "红甘鱼"],
    ["温麺", "温面"],
    ["冷麺", "冷面"],
    ["トースト", "吐司"],
    ["カレー", "咖喱"],
    ["ニンニク", "蒜"],
    ["増し増し", "加量"],
    ["冷製", "冷制"],
    ["和え", "拌"],
    ["そば", "荞麦面"],
    ["昔ながらの", "怀旧"],
    ["ナポリタン", "拿坡里意面"],
    ["黒醤油", "黑酱油"],
    ["黒猫油", "黑酱油"],
    ["まっ黒", "黑"],
    ["チャーハン", "炒饭"],
    ["黒胡椒", "黑胡椒"],
    ["レモン", "柠檬"],
    ["焼きそば", "炒面"],
    ["昭和の", "昭和风"],
    ["中華そば", "中华拉面"],
    ["絶品", "绝品"],
    ["かき味噌", "牡蛎味噌"],
    ["豆腐", "豆腐"],
    ["味噌漬け", "味噌腌"],
    ["酒盗", "酒盗"],
    ["シーフード", "海鲜"],
    ["フライドエッグ", "煎蛋"],
    ["タマネギ", "洋葱"],
    ["もも", "腿肉"],
    ["スープ", "汤"],
    ["ドーナッツ", "甜甜圈"],
    ["青唐辛子", "青辣椒"],
    ["焼き餃子", "煎饺"],
    ["水餃子", "水饺"],
    ["餃子", "饺子"],
    ["秘伝", "秘制"],
    ["フライ", "炸物"],
    ["カツ", "炸猪排"],
    ["シソ", "紫苏"],
    ["シシ", "紫苏"],
    ["巻き", "卷"],
    ["とろたく", "金枪鱼腩腌萝卜"],
    ["タワー", "塔"],
    ["いか", "鱿鱼"],
    ["さば", "青花鱼"],
    ["チャーシュー", "叉烧"],
    ["悪魔の", "恶魔"],
    ["ロコット", "可乐饼"],
    ["鶏ハム", "鸡肉火腿"],
    ["豚の角煮", "猪肉角煮"],
    ["あおさ", "海苔"],
    ["湯葉", "腐皮"],
    ["タマゴ", "鸡蛋"],
  ];

  const replaceIngredients = (text) => {
    let result = text;
    for (const [jp, zh] of ingredientMap) {
      result = result.replaceAll(jp, zh);
    }
    return result;
  };

  if (sourceText.endsWith("玉")) {
    const base = replaceIngredients(sourceText.slice(0, -1));
    return {
      translation: `${base || "综合"}大阪烧`,
      category: "烧烤",
    };
  }

  if (sourceText.includes("牛丼")) {
    const replaced = replaceIngredients(sourceText)
      .replace("牛丼", "牛肉盖饭")
      .replace("並", "（普通份）");
    return {
      translation: replaced,
      category: "牛肉盖饭",
    };
  }

  if (sourceText.includes("豚丼")) {
    const replaced = replaceIngredients(sourceText)
      .replace("豚丼", "猪肉盖饭")
      .replace("並", "（普通份）");
    return {
      translation: replaced,
      category: "猪肉盖饭",
    };
  }

  if (sourceText.includes("丼")) {
    const replaced = replaceIngredients(sourceText)
      .replace("丼", "盖饭")
      .replace("並", "（普通份）");
    return {
      translation: replaced,
      category: "主食",
    };
  }

  if (sourceText.endsWith("ネギ")) {
    const base = replaceIngredients(sourceText.slice(0, -2));
    return {
      translation: `${base || "综合"}葱烧`,
      category: "烧烤",
    };
  }

  if (sourceText.endsWith("そば")) {
    const base = replaceIngredients(sourceText.slice(0, -2));
    return {
      translation: `${base || "综合"}炒面`,
      category: "主食",
    };
  }

  if (sourceText.includes("サラダ")) {
    return {
      translation: `${replaceIngredients(sourceText.replace("サラダ", "")) || "综合"}沙拉`,
      category: "沙拉",
    };
  }

  if (sourceText.includes("ステーキ")) {
    const base = replaceIngredients(sourceText.replace("ステーキ", "")).replace(/和牛肉/g, "和牛");
    return {
      translation: `${base || "和牛"}牛排`,
      category: "主菜",
    };
  }

  if (sourceText.includes("タタキ")) {
    const base = replaceIngredients(sourceText.replace("タタキ", "")).replace(/和牛肉/g, "和牛");
    return {
      translation: `${base || "和牛"}炙烤刺身`,
      category: "主菜",
    };
  }

  if (!fallbackTranslation || normalizedFallback === normalizedSource) {
    return {
      translation: replaceIngredients(sourceText),
      category: fallbackCategory || CATEGORY_FALLBACK,
    };
  }

  return {
    translation: fallbackTranslation,
    category: fallbackCategory || CATEGORY_FALLBACK,
  };
}

function pickIllustration(text) {
  const value = String(text || "").toLowerCase();
  if (/kimchi|pickle|pickled|泡菜|キムチ/i.test(value)) return "kimchi";
  if (/salad|沙拉|サラダ/i.test(value)) return "salad";
  if (/soup|汤|湯|スープ|찌개|탕/i.test(value)) return "soup";
  if (/bibimbap|rice bowl|拌饭|石锅|盖饭|밥/i.test(value)) return "bibimbap";
  if (/ramen|noodle|reimen|冷面|拉面|麺|면|우동/i.test(value)) return "ramen";
  if (/udon|乌冬|うどん/i.test(value)) return "udon";
  if (/heart|牛心|ハツ/i.test(value)) return "heart";
  if (/yukke|tartare|生拌|ユッケ/i.test(value)) return "yukke";
  return "senmai";
}

function pickColor(category, label) {
  const source = `${category}:${label}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
}

function buildVisionSystemPrompt() {
  return [
    "You are a fast multilingual restaurant menu OCR engine.",
    "Read all real sellable menu items from the image: dishes, drinks, sides, add-ons, and sets.",
    "Return JSON only. No markdown. No explanations.",
    "Return an array of objects with: original, price, currency, category, lang_code, note.",
    "Keep original exactly as printed. Do not invent food images or URLs.",
    "Use nearest printed section heading as category. Do not output section headings as menu items.",
    "If price is unclear, use 0. Preserve Korean/Japanese/Thai/Vietnamese/English source text.",
  ].join(" ");
}

function buildStructuredVisionSystemPromptClean() {
  return [
    "You are an expert restaurant menu parser for dense multilingual menu photos.",
    "Read the full menu layout and extract as many real sellable menu items as possible.",
    "Return JSON only. No markdown. No explanations.",
    "Return an array of objects with: original, price, currency, category, lang_code, note.",
    "Include dishes, drinks, side dishes, set meals, add-ons, sizes, and combo items when they are separately priced.",
    "Do not output store name, tax notes, business hours, TEL, slogans, or section headings by themselves.",
    "If a menu item has a size word like 並, 大盛, 特盛, 小盛, 1枚盛, 2枚盛, 3個入, 6個入, 9個入, keep it inside original.",
    "For dense takeaway menus, prefer completeness over brevity and extract every priced sellable row you can see.",
  ].join(" ");
}

function buildNormalizerSystemPromptClean() {
  return [
    "You are Kimi K2.6 Pro acting as a high-quality multilingual restaurant menu translator.",
    "Normalize OCR menu rows into accurate Simplified Chinese for Chinese diners.",
    "Return JSON only: an array with original, translation, price, currency, pronunciation, category, lang_code, desc.",
    "Rules:",
    "1. Preserve original exactly in source language. Never replace original with Chinese.",
    "2. translation must be short, natural Simplified Chinese and food-accurate, not literal nonsense.",
    "3. category must be concise Simplified Chinese. Never use 菜单分类. Use 其他 only when truly unknown.",
    "4. For Japanese, pronunciation should be kana plus romaji when possible.",
    "5. For Korean, pronunciation can be romanization if useful; keep Korean original.",
    "6. Translate each row independently. Do not copy one translation across different originals.",
    "7. Keep all valid menu items including drinks and side dishes.",
  ].join("\n");
}

function buildStrictNormalizerSystemPromptClean() {
  return [
    "You are a high-quality multilingual restaurant menu translator.",
    "Normalize OCR menu rows into accurate Simplified Chinese for Chinese diners.",
    "Return JSON only: an array with original, translation, price, currency, pronunciation, category, lang_code, desc.",
    "Rules:",
    "1. Preserve original exactly in source language. Never replace original with Chinese.",
    "2. translation must be short, natural Simplified Chinese and food-accurate, not literal nonsense.",
    "3. Never hallucinate ingredients. Example: せんまい means beef omasum / tripe, not salmon. ユッケ means yukhoe-style raw beef, not fried rice.",
    "4. category must be concise Simplified Chinese. Never use 菜单分类. Use 其他 only when truly unknown.",
    "5. Prefer restaurant-friendly Chinese names that users can understand immediately.",
    "6. When OCR is noisy, infer carefully from the source language, but stay semantically close to the original dish.",
    "7. For Japanese, pronunciation should be kana plus romaji when possible.",
    "8. For Korean, pronunciation can be romanization if useful; keep Korean original.",
    "9. Translate each row independently. Do not copy one translation across different originals.",
    "10. Keep all valid menu items including drinks and side dishes.",
  ].join("\n");
}

function buildStructuredVisionSystemPrompt() {
  return [
    "You are an expert restaurant menu parser for dense multilingual menu photos.",
    "Read the full menu layout and extract as many real sellable menu items as possible.",
    "Return JSON only. No markdown. No explanations.",
    "Return an array of objects with: original, price, currency, category, lang_code, note.",
    "Include dishes, drinks, side dishes, set meals, add-ons, sizes, and combo items when they are separately priced.",
    "Do not output store name, tax notes, business hours, TEL, slogans, or section headings by themselves.",
    "If a menu item has a size/spec word like 並, 大盛, 特盛, 小盛, 一枚盛, 二枚盛, 3個入, 6個入, 9個入, keep it inside original.",
    "For Japanese menus, keep original Japanese exactly and preserve section names such as 牛丼, 豚丼, から揚げ丼, 鰻重, 黒カレー.",
    "For Korean menus, keep original Korean exactly and preserve categories such as 볶음류, 탕/찌개, 마른안주, 사이드, 주류/음료.",
    "Scan every visible panel, every column, and the small rows at the bottom. Do not only parse the largest top-left section.",
    "For a large chain takeaway menu, returning fewer than 25 rows is usually incomplete unless the image truly has fewer rows.",
    "For dense takeaway menus, prefer completeness over brevity and extract every priced sellable row you can see.",
  ].join(" ");
}

function buildNormalizerSystemPrompt() {
  return [
    "You are Kimi K2.6 Pro acting as a high-quality multilingual restaurant menu translator.",
    "Normalize OCR menu rows into accurate Simplified Chinese for Chinese diners.",
    "Return JSON only: an array with original, translation, price, currency, pronunciation, category, lang_code, desc.",
    "Rules:",
    "1. Preserve original exactly in source language. Never replace original with Chinese.",
    "2. translation must be short, natural Simplified Chinese and food-accurate, not literal nonsense.",
    "3. category must be concise Simplified Chinese. Never use 菜单分类 or 招牌菜 unless it is a real printed menu section. Use 其他 only when truly unknown.",
    "4. For Japanese, pronunciation should be kana plus romaji when possible.",
    "5. For Korean, pronunciation can be romanization if useful; keep Korean original.",
    "6. Translate each row independently. Do not copy one translation across different originals.",
    "7. Keep all valid menu items including drinks and side dishes.",
    "8. Do not turn phone numbers, business hours, tax notes, store names, or headings into menu items.",
    "9. Translate dining terms accurately: Highball=高球, 牛丼=牛肉盖饭, 豚丼=猪肉盖饭, お好み焼き=大阪烧, チューハイ=烧酒苏打, 막걸리=马格利米酒.",
  ].join("\n");
}

function buildStrictNormalizerSystemPrompt() {
  return [
    "You are a high-quality multilingual restaurant menu translator.",
    "Normalize OCR menu rows into accurate Simplified Chinese for Chinese diners.",
    "Return JSON only: an array with original, translation, price, currency, pronunciation, category, lang_code, desc.",
    "Rules:",
    "1. Preserve original exactly in source language. Never replace original with Chinese.",
    "2. translation must be short, natural Simplified Chinese and food-accurate, not literal nonsense.",
    "3. Never hallucinate ingredients. Example: せんまい means beef omasum / tripe, not salmon. ユッケ means yukhoe-style raw beef.",
    "4. category must be concise Simplified Chinese. Never use 菜单分类 or 招牌菜 unless it is a real printed menu section. Use 其他 only when truly unknown.",
    "5. Prefer restaurant-friendly Chinese names that users can understand immediately.",
    "6. When OCR is noisy, infer carefully from the source language, but stay semantically close to the original dish.",
    "7. For Japanese, pronunciation should be kana plus romaji when possible.",
    "8. For Korean, pronunciation can be romanization if useful; keep Korean original.",
    "9. Translate each row independently. Do not copy one translation across different originals.",
    "10. Keep all valid menu items including drinks and side dishes.",
    "11. Do not turn phone numbers, business hours, tax notes, store names, or headings into menu items.",
    "12. Translate dining terms accurately: Highball=高球, 牛丼=牛肉盖饭, 豚丼=猪肉盖饭, お好み焼き=大阪烧, チューハイ=烧酒苏打, 막걸리=马格利米酒.",
  ].join("\n");
}

function cleanJsonString(input = "") {
  return String(input).replace(/```json/gi, "").replace(/```/g, "").trim();
}

function extractMessageText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("\n");
  }
  return String(content || "");
}

function extractJsonArray(text) {
  const cleaned = cleanJsonString(text);
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.items)) return parsed.items;
    if (Array.isArray(parsed.menu)) return parsed.menu;
  } catch {}

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {}
  }
  return [];
}

function parseTextRows(text) {
  const rows = [];
  let currentCategory = CATEGORY_FALLBACK;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s\-*•・·]+/, "").trim();
    if (!line) continue;
    const priceMatch = line.match(/([¥￥₩$€฿₫]?\s*[0-9][0-9,.]*)\s*$/);
    if (!priceMatch) {
      if (line.length <= 24 && /[\p{L}\p{Script=Han}]/u.test(line)) {
        currentCategory = line;
      }
      continue;
    }
    const priceText = priceMatch[1];
    const original = line.slice(0, priceMatch.index).replace(/[|:：\t]+$/g, "").trim();
    if (!original || original.length > 80) continue;
    rows.push({
      original,
      price: parsePrice(priceText),
      currency: guessCleanCurrency(priceText) || guessCurrency(priceText),
      category: currentCategory,
      lang_code: inferLangCode(original),
    });
  }
  return rows;
}

function stripMenuNoise(original) {
  return String(original || "")
    .replace(/^酒\s*[¥￥]\s*\d[\d,]*\s*/u, "")
    .replace(/^[\s・•·\-–—.]+/, "")
    .replace(/\s*[¥￥₩$€]\s*\d[\d,.]*\s*/gu, " ")
    .replace(/\s*[\[【(（][^\]】)）]*(?:円|税込|税)[^\]】)）]*[\]】)）]\s*$/u, "")
    .replace(/\d[\d,.]*\s*円\s*\([^)]*\)\s*$/u, "")
    .replace(/\s*[¥₩$€]?\s*\d[\d,.\-~]*\s*(円|원|cc)?\s*$/u, "")
    .replace(/\(\s*[12一二三四五六七八九十]+\s*本[~～-]?\s*\)\s*$/u, "")
    .replace(/[、,，]+$/u, "")
    .trim();
}

function isObviouslyInvalidMenuName(original) {
  const value = String(original || "").trim();
  if (!value) return true;
  if (/^\u8D85\u7279\u76DB$/u.test(value)) return true;
  if (/^Original\s*:/i.test(value)) return true;
  if (/(税込|税抜|税別|消費税|頂戴|ご了承ください|ご了承|致します)/u.test(value)) return true;
  if (/^[\u3040-\u30ff]$/u.test(value)) return true;
  if (/^[+＋].*[+＋]?$/.test(value)) return true;
  if (/^[\u3040-\u30ff]\s*[+＋]\s*\d+/.test(value)) return true;
  if (/^["'“”]?\d[\d,.~\-]*["'“”]?$/.test(value)) return true;
  if (/^※/.test(value)) return true;
  if (/^[¥₩$€]?\s*\d[\d,.]*\s*(円|원|cc)?$/u.test(value)) return true;
  if (/^[+＋]\s*\d*$/u.test(value)) return true;
  if (/^[12一二三四五六七八九十]+\s*合\s*\d[\d,.]*$/u.test(value)) return true;
  if (/^[12一二三四五六七八九十]+\s*本[~～-]?\s*[¥₩$€]?\s*\d[\d,.]*$/u.test(value)) return true;
  if (/^(大盛|中盛|小盛|特盛|並|アタマの大盛|ご飯増量|サイズ変更可|全税込価格|各|TEL|招牌菜|推荐|今日推荐|本日のオススメ|自慢の一品|ドリンクメニュー)$/u.test(value)) return true;
  if (/^(ランチ|ディナー|営業時間|定休日|店頭及び|お電話|instagram|ご案内)$/iu.test(value)) return true;
  return false;
}

function normalizeKnownMenuOcrVariant(input = "") {
  return String(input || "")
    .trim()
    .replace(/^イカタネギ$/, "イカブタネギ")
    .replace(/^イカピネギ$/, "イカエビネギ")
    .replace(/^イカタ玉$/, "イカブタ玉")
    .replace(/^イカピ玉$/, "イカエビ玉");
}

function normalizeKnownMenuOcrPrice(original, price) {
  if (/^(ブタ|イカ|エビ|Mix).*(玉|ネギ)$/.test(original) && price >= 90 && price < 200) {
    return price * 10;
  }
  if (/から揚げ|から牛|ねぎ塩から揚げ/.test(original) && price > 0 && price < 100) {
    return price + 600;
  }
  return price;
}

function isCleanInvalidMenuName(original) {
  const value = String(original || "").normalize("NFKC").trim();
  if (!value) return true;
  if (/^\u8D85\u7279\u76DB$/u.test(value)) return true;
  if (/^\(?\s*(税込|税別|税抜|含税|消費税|全て税込|全税込価格)\s*\d*[\d,.]*\s*(円|¥)?\s*\)?$/iu.test(value)) return true;
  if (/^\d[\d,.]*\s*円\s*\(\s*(税|税込|税別|税抜)\s*\d[\d,.]*\s*円?\s*\)$/iu.test(value)) return true;
  if (/^\d[\d,.]*\s*円\s*$/iu.test(value)) return true;
  if (/^[+＋]\s*\d*$/u.test(value)) return true;
  if (/^(TEL|電話|営業時間|定休日|Instagram|インスタ|店内|店名|テイクアウト|メニュー)$/iu.test(value)) return true;
  if (/^(並|大盛|特盛|小盛|サイズ変更可|ご飯増量\+?|ご飯増量\s*\+?|アタマの大盛|ねぎ|ネギ)$/u.test(value)) return true;
  if (/^(二枚盛|一枚盛|三枚盛),?\s*\d/u.test(value)) return true;
  if (/^(夏季限定|期間限定|季節限定|限定|丼|大盛り\+?|麺大盛り\+?|ミニ炒飯付|炒飯付)$/u.test(value)) return true;
  if (/炒飯付$/u.test(value)) return true;
  if (/^(に変更すると|変更すると|さらにおいしく)$/u.test(value)) return true;
  if (/^(this is|a delicious|delicious dish|menu item)\b/i.test(value)) return true;
  if (/^[A-Za-z\s,.!?-]{55,}$/.test(value)) return true;
  return false;
}

function compactItems(items) {
  return items
    .map((item) => {
      const original = normalizeKnownMenuOcrVariant(
        fixKnownOcrSourceText(stripMenuNoise(item.original || item.name || item.sourceText || "")),
      );
      let price = parsePrice(item.price);
      if (!original || /https?:\/\//i.test(original) || /^image\s*:/i.test(original)) return null;
      if (isCleanInvalidMenuName(original)) return null;
      if (isObviouslyInvalidMenuName(original)) return null;
      if (/^"?\s*(price|original|translation|currency|category|image)\s*"?$/i.test(original)) return null;
      if (/小红书|水印|账号|号$/i.test(original) && price > 1000000) return null;
      const langCode = normalizeLangCode(item.lang_code || item.langCode, original);
      price = normalizeKnownMenuOcrPrice(original, price);
      if (price > 0 && price < 30 && !/^\d+\s*個入$/u.test(original)) return null;
      if (/[+＋]/.test(original) && price > 0 && price <= 250) return null;
      if (/^[\u3040-\u30ff]{1,3}$/u.test(original) && price > 0) return null;
      if (/^\d+\s*個入$/u.test(original) && price <= 20) return null;
      if (price > 5000000) return null;
      return {
        original,
        translation: String(item.translation || item.chineseName || "").trim(),
        price,
      currency: item.currency || guessCleanCurrency(String(item.price || "")) || guessCurrency(String(item.price || "")),
        category: normalizeCategory(item.category || item.section || item.tab),
        lang_code: langCode,
        pronunciation: String(item.pronunciation || "").trim(),
        desc: String(item.desc || item.note || "").trim(),
      };
    })
    .filter((item) => item && item.original && item.price > 0);
}

function isSuspiciousMenuLabel(item) {
  const sourceText = String(item?.sourceText || "").trim();
  if (!sourceText) return true;
  if (/^[ァ-ヶー]{1,2}$/.test(sourceText)) return true;
  if (/^[ァ-ヶー]{3,4}$/.test(sourceText) && !/^(ブリ|カツ|トロ|ユッケ|キムチ|レモン|チーズ)$/.test(sourceText)) {
    return true;
  }
  return false;
}

function hasChineseText(input = "") {
  return /[\u4e00-\u9fff]/.test(String(input || ""));
}

function containsForeignMenuScript(input = "") {
  return /[\u3040-\u30ff\uac00-\ud7af\u0E00-\u0E7F]/.test(String(input || ""));
}

function isKanaOnly(input = "") {
  return /^[\u3040-\u30ff\u30fc\s]+$/.test(String(input || "").trim());
}

function looksLikeHeadingText(input = "") {
  const value = String(input || "").trim();
  if (!value) return true;
  return /^(menu|drink menu|food menu|today'?s special|special|recommend|recommended|category|分類|菜单|菜單|菜单分类|ドリンクメニュー|本日のおすすめ|おすすめ|自慢の一品|今日推荐|招牌菜)$/i.test(
    value,
  );
}

function looksLikeUntranslatedDisplayItem(item) {
  const chineseName = String(item?.chineseName || "").trim();
  const sourceText = String(item?.sourceText || "").trim();
  if (!chineseName) return true;
  if (item?.langCode === "zh-CN") return false;
  return (
    normalizeLoose(chineseName) === normalizeLoose(sourceText) ||
    !hasChineseText(chineseName) ||
    containsForeignMenuScript(chineseName)
  );
}

function hasUsefulMappedCategory(input = "") {
  const value = normalizeLoose(input);
  return Boolean(value && value !== normalizeLoose(CATEGORY_FALLBACK));
}

function translateStructuredJapaneseCategory(input = "") {
  const cleaned = normalizeCategory(input);
  if (/^(麺|麺類|ラーメン|ちゃんぽん)$/u.test(cleaned)) return "面类";
  if (/^(単品|单品)$/u.test(cleaned)) return "单品";
  if (/^(セット|套餐)$/u.test(cleaned)) return "套餐";
  if (/^(一品|主菜)$/u.test(cleaned)) return "主菜";
  if (/^牛丼/.test(cleaned)) return "牛肉盖饭";
  if (/^豚丼/.test(cleaned)) return "猪肉盖饭";
  if (/^から揚げ丼/.test(cleaned)) return "炸鸡盖饭";
  if (/^から揚げ単品/.test(cleaned)) return "炸鸡单品";
  if (/^牛カルビ丼/.test(cleaned)) return "牛五花盖饭";
  if (/^牛プルコギ丼/.test(cleaned)) return "韩式牛肉盖饭";
  if (/^スタミナ丼/.test(cleaned)) return "元气盖饭";
  if (/^鰻重/.test(cleaned)) return "鳗鱼饭";
  if (/^黒カレー/.test(cleaned)) return "黑咖喱";
  if (/^お得なセット/.test(cleaned)) return "超值套餐";
  if (/^小菜$/.test(cleaned)) return "小菜/加点";
  return "";
}

function getCleanJapaneseTranslation(sourceText = "", category = "") {
  const text = String(sourceText || "").normalize("NFKC").trim();
  if (!text) return null;
  const countPack = text.match(/^(\d+)\s*個入$/u);
  if (countPack) {
    const prefix = /から揚げ|唐揚げ/.test(category) ? "炸鸡单品 " : "";
    return { translation: `${prefix}${countPack[1]}个装`, category: translateStructuredJapaneseCategory(category) || "小菜/加点" };
  }
  const peopleServing = text.match(/^(\d+)\s*人前$/u);
  if (peopleServing) {
    return { translation: `${peopleServing[1]}人份`, category: translateStructuredJapaneseCategory(category) || "主菜" };
  }
  let name = text
    .replace(/セット/g, "套餐")
    .replace(/単品/g, "单品")
    .replace(/海鮮/g, "海鲜")
    .replace(/ちゃんぽん/g, "杂烩面")
    .replace(/ラーメン/g, "拉面")
    .replace(/担担麺|担担麵/g, "担担面")
    .replace(/パリパリ麺/g, "脆面")
    .replace(/五目/g, "什锦")
    .replace(/ネギ|ねぎ/g, "葱")
    .replace(/叉焼/g, "叉烧")
    .replace(/冷やし中華|冷し中華|冷书七中华/g, "日式中华冷面")
    .replace(/冷书中华|冷书/g, "日式中华冷面")
    .replace(/ジャージャー麺|ヤージャー麺/g, "炸酱面")
    .replace(/ミニ炒飯付/g, "附迷你炒饭")
    .replace(/手作り焼き餃子/g, "手工煎饺")
    .replace(/ヤンニョム/g, "韩式甜辣")
    .replace(/肉だく/g, "加肉")
    .replace(/ねぎだく/g, "葱加量")
    .replace(/だく/g, "加量")
    .replace(/お新香/g, "日式腌菜")
    .replace(/ソフトドリンク各種/g, "各种软饮")
    .replace(/ケチャップ|チラップ/g, "番茄酱")
    .replace(/マヨソース|マヨネーズ/g, "蛋黄酱")
    .replace(/小鉢/g, "小钵")
    .replace(/一枚盛/g, "单份")
    .replace(/二枚盛/g, "双份")
    .replace(/三枚盛/g, "三份")
    .replace(/白ご飯|白二飯/g, "白米饭")
    .replace(/麺大盛り\+?/g, "面加大")
    .replace(/大盛り\+?/g, "加大份")
    .replace(/炒飯/g, "炒饭")
    .replace(/付/g, "附")
    .replace(/麺/g, "面")
    .replace(/あさり汁/g, "蛤蜊汤")
    .replace(/とん汁/g, "猪肉味噌汤")
    .replace(/牛丼/g, "牛肉盖饭")
    .replace(/豚丼/g, "猪肉盖饭")
    .replace(/丼/g, "盖饭")
    .replace(/牛カルビ/g, "牛五花")
    .replace(/カルビ/g, "五花肉")
    .replace(/鰻/g, "鳗鱼")
    .replace(/ミニ/g, "迷你")
    .replace(/塩/g, "盐")
    .replace(/豚/g, "猪肉")
    .replace(/牛(?!肉)/g, "牛肉")
    .replace(/並/g, "普通份")
    .replace(/半熟/g, "半熟")
    .replace(/玉子/g, "鸡蛋")
    .replace(/納豆/g, "纳豆")
    .replace(/クワトロチーズ|クワトロチェーズ/g, "四重芝士")
    .replace(/ご飯大盛/g, "米饭大份")
    .replace(/ご飯/g, "米饭")
    .replace(/ファミリーパック/g, "家庭包")
    .replace(/黒カレー/g, "黑咖喱")
    .replace(/チーズ/g, "芝士")
    .replace(/から揚げ/g, "炸鸡")
    .replace(/さり汁/g, "蛤蜊汤")
    .replace(/太平燕/g, "太平燕")
    .replace(/チキン/g, "鸡肉")
    .replace(/カレー/g, "咖喱")
    .replace(/ライス/g, "饭")
    .replace(/サラダ/g, "沙拉")
    .replace(/ハイボール/g, "高球")
    .replace(/コーラ/g, "可乐")
    .replace(/ジンジャー/g, "姜汁")
    .replace(/レモン/g, "柠檬");
  if (name === text || containsForeignMenuScript(name)) return null;
  const resolvedCategory =
    translateStructuredJapaneseCategory(category) ||
    (/麺|ラーメン|ちゃんぽん/.test(text) ? "面类" : "");
  return { translation: name, category: resolvedCategory };
}

function getReliableMenuTranslation(sourceText = "", sourceLang = "", currentTranslation = "", category = "") {
  const text = String(sourceText || "").normalize("NFKC").trim();
  if (!text) return null;
  const normalized = normalizeLoose(text);
  const includesAny = (needles) =>
    needles.some((needle) => normalized.includes(normalizeLoose(needle)));
  const pick = (entries) => {
    for (const entry of entries) {
      if (includesAny(entry.match)) return entry;
    }
    return null;
  };

  if (sourceLang === "ja-JP") {
    const sakeMeasure = text.match(/^([12])\s*\u5408(?:\s*\d+)?$/);
    if (sakeMeasure) {
      return {
        translation: `\u65E5\u672C\u6E05\u9152 ${sakeMeasure[1]}\u5408`,
        category: "\u9152\u6C34/\u996E\u6599",
      };
    }

    const entry = pick([
      { match: ["\u30B9\u30BF\u30DF\u30CA\u8D85\u7279\u76DB\u4E3C", "\u30B9\u30BF\u30DF\u30CA", "\u30B9\u30BF\u30DF"], translation: "\u5143\u6C14\u8D85\u5927\u4EFD\u76D6\u996D", category: "\u4E3B\u98DF" },
      { match: ["\u30AA\u30E0\u7389\u5B50", "\u30AA\u30E0\u7389"], translation: "\u86CB\u5305\u9E21\u86CB", category: "\u5C0F\u83DC/\u52A0\u70B9" },
      { match: ["Mix\u30CD\u30AE", "MIX\u30CD\u30AE"], translation: "\u7EFC\u5408\u8471\u70E7", category: "\u70E7\u70E4" },
      { match: ["\u6D77\u9BAE\u3061\u3083\u3093\u307D\u3093\u30BB\u30C3\u30C8"], translation: "\u6D77\u9C9C\u6742\u70E9\u9762\u5957\u9910", category: "\u5957\u9910" },
      { match: ["\u6D77\u9BAE\u3061\u3083\u3093\u307D\u3093"], translation: "\u6D77\u9C9C\u6742\u70E9\u9762", category: "\u9762\u7C7B" },
      { match: ["\u592A\u5E73\u71D5\u30BB\u30C3\u30C8"], translation: "\u592A\u5E73\u71D5\u5957\u9910\uFF08\u718A\u672C\u7C89\u4E1D\u6C64\uFF09", category: "\u5957\u9910" },
      { match: ["\u592A\u5E73\u71D5"], translation: "\u592A\u5E73\u71D5\uFF08\u718A\u672C\u7C89\u4E1D\u6C64\uFF09", category: "\u6C64\u54C1" },
      { match: ["\u62C5\u62C5\u9EBA", "\u62C5\u62C5\u9EB5", "\u62C5\u3005\u9EBA"], translation: "\u62C5\u62C5\u9762", category: "\u9762\u7C7B" },
      { match: ["\u30D1\u30EA\u30D1\u30EA\u9EBA", "\u30D1\u30EA\u30D1\u30EA\u9EB5"], translation: "\u8106\u9762", category: "\u9762\u7C7B" },
      { match: ["\u30C1\u30AD\u30F3\u30AB\u30EC\u30FC\u30E9\u30A4\u30B9"], translation: "\u9E21\u8089\u5496\u55B1\u996D", category: "\u4E3B\u98DF" },
      { match: ["\u30C1\u30AD\u30F3\u30AB\u30EC\u30FC"], translation: "\u9E21\u8089\u5496\u55B1", category: "\u4E3B\u83DC" },
      { match: ["\u30C1\u30AD\u30F3\u30B7\u30FC\u30B6\u30FC\u30B5\u30E9\u30C0"], translation: "\u9E21\u8089\u51EF\u6492\u6C99\u62C9", category: "\u6C99\u62C9" },
      { match: ["\u3068\u308A\u3059\u308B\u3081"], translation: "\u9E21\u8089\u5C0F\u83DC", category: "\u524D\u83DC" },
      { match: ["\u84B8\u3057\u9D8F\u306E\u306D\u304E\u30BD\u30FC\u30B9"], translation: "\u8471\u9171\u84B8\u9E21", category: "\u4E3B\u83DC" },
      { match: ["\u3080\u306D\u8089\u306E\u5C71\u304B\u3051"], translation: "\u5C71\u836F\u9E21\u80F8\u8089", category: "\u4E3B\u83DC" },
      { match: ["\u305B\u305B\u308A\u306A\u3093\u3053\u3064\u9ED2\u3053\u3057\u3087\u3046\u63DA\u3052"], translation: "\u9ED1\u80E1\u6912\u70B8\u9E21\u9888\u8F6F\u9AA8", category: "\u4E3B\u83DC" },
      { match: ["\u3058\u3083\u304C\u3044\u3082\u3068\u3082\u3084\u3057\u306E\u30CA\u30E0\u30EB"], translation: "\u571F\u8C46\u8C46\u82BD\u62CC\u83DC", category: "\u914D\u83DC" },
      { match: ["\u30D6\u30ED\u30C3\u30B3\u30EA\u30FC\u306E\u30C1\u30EA\u30DE\u30E8"], translation: "\u897F\u5170\u82B1\u8FA3\u5473\u86CB\u9EC4\u9171", category: "\u914D\u83DC" },
      { match: ["\u304A\u828B\u3055\u3093\u5869\u30D0\u30BF\u30FC", "\u304A\u828B\u5869\u30D0\u30BF\u30FC"], translation: "\u76D0\u9EC4\u6CB9\u5730\u74DC", category: "\u914D\u83DC" },
      { match: ["\u307E\u3044\u305F\u3051\u306E\u5929\u3077\u3089", "\u821E\u8338\u306E\u5929\u3077\u3089"], translation: "\u821E\u8338\u5929\u5987\u7F57", category: "\u914D\u83DC" },
      { match: ["\u3044\u3061\u3054\u30DF\u30EB\u30AF\u30A2\u30A4\u30B9"], translation: "\u8349\u8393\u725B\u5976\u51B0\u6DC7\u6DCB", category: "\u751C\u54C1" },
      { match: ["\u308A\u3093\u3054\u306E\u5929\u3077\u3089"], translation: "\u82F9\u679C\u5929\u5987\u7F57", category: "\u751C\u54C1" },
      { match: ["\u9AA8\u3064\u304D\u9D8F\u30D9\u30FC\u30B3\u30F3"], translation: "\u5E26\u9AA8\u9E21\u8089\u57F9\u6839", category: "\u4E3B\u83DC" },
      { match: ["\u751F\u305B\u3093\u307E\u3044\u523A\u3057"], translation: "\u751F\u62CC\u725B\u767E\u53F6\u523A\u8EAB", category: "\u524D\u83DC" },
      { match: ["\u3042\u3076\u308A\u30E6\u30C3\u30B1"], translation: "\u7099\u70E4\u751F\u62CC\u725B\u8089", category: "\u524D\u83DC" },
      { match: ["\u3053\u3053\u308D\u523A\u3057"], translation: "\u725B\u5FC3\u523A\u8EAB", category: "\u524D\u83DC" },
      { match: ["\u767D\u83DC\u30AD\u30E0\u30C1"], translation: "\u767D\u83DC\u6CE1\u83DC", category: "\u524D\u83DC" },
      { match: ["\u30CF\u30A4\u30DC\u30FC\u30EB"], translation: "Highball\u9AD8\u7403", category: "\u9152\u6C34/\u996E\u6599" },
      { match: ["\u30B3\u30FC\u30E9\u30CF\u30A4\u30DC\u30FC\u30EB"], translation: "\u53EF\u4E50\u9AD8\u7403", category: "\u9152\u6C34/\u996E\u6599" },
      { match: ["\u30B8\u30F3\u30B8\u30E3\u30FC\u30CF\u30A4\u30DC\u30FC\u30EB"], translation: "\u59DC\u6C41\u9AD8\u7403", category: "\u9152\u6C34/\u996E\u6599" },
    ]);
    if (entry) return { translation: entry.translation, category: entry.category };
    const generic = getCleanJapaneseTranslation(text, category);
    if (generic?.translation) return generic;
  }

  if (sourceLang === "ko-KR") {
    const entry = pick([
      { match: ["\uAE40\uCE58\uB0A0\uCE58\uC54C\uACC4\uB780\uB9D0\uC774"], translation: "\u6CE1\u83DC\u98DE\u9C7C\u7C7D\u9E21\u86CB\u5377", category: "\u4E3B\u83DC/\u4E0B\u9152\u83DC" },
      { match: ["\uC624\uC0BC\uBD88\uACE0\uAE30"], translation: "\u97F1\u9C7C\u4E94\u82B1\u8089\u7092\u70E4", category: "\u4E3B\u83DC/\u4E0B\u9152\u83DC" },
      { match: ["\uACE0\uAC08\uBE44"], translation: "\u70E4\u9752\u82B1\u9C7C", category: "\u4E3B\u83DC/\u4E0B\u9152\u83DC" },
      { match: ["\uC624\uB3CC\uBED0"], translation: "\u8FA3\u7092\u8106\u9AA8", category: "\u4E3B\u83DC/\u4E0B\u9152\u83DC" },
      { match: ["\uBC31\uC624\uB3CC\uBED0"], translation: "\u767D\u5473\u8106\u9AA8", category: "\u4E3B\u83DC/\u4E0B\u9152\u83DC" },
      { match: ["\uB450\uBD80\uAE40\uCE58"], translation: "\u8C46\u8150\u6CE1\u83DC", category: "\u4E3B\u83DC/\u4E0B\u9152\u83DC" },
      { match: ["\uD6C4\uB77C\uC774\uC640\uC2A4\uD338"], translation: "\u714E\u86CB\u5348\u9910\u8089", category: "\u4E3B\u83DC/\u4E0B\u9152\u83DC" },
      { match: ["\uB9E4\uC6B4\uB3FC\uC9C0\uAECD\uB370\uAE30"], translation: "\u8FA3\u732A\u76AE", category: "\u4E3B\u83DC/\u4E0B\u9152\u83DC" },
      { match: ["\uC0B0\uD1A0\uB9AC\uD558\uC774\uBCFC"], translation: "\u4E09\u5F97\u5229Highball", category: "\u9152\u6C34/\u996E\u6599" },
      { match: ["\uBD88\uACE0\uAE30\uBC25"], translation: "\u70E4\u8089\u996D", category: "\u4E3B\u98DF" },
      { match: ["\uBD88\uACE0\uAE30"], translation: "\u97E9\u5F0F\u70E4\u8089", category: "\u4E3B\u83DC" },
      { match: ["\uCF5C\uB77C", "\uC0AC\uC774\uB2E4"], translation: "\u53EF\u4E50 / \u96EA\u78A7", category: "\u9152\u6C34/\u996E\u6599" },
    ]);
    if (entry) return { translation: entry.translation, category: entry.category };
  }

  if (!currentTranslation || normalizeLoose(currentTranslation) === normalizeLoose(sourceText)) return null;
  return null;
}

function scoreMappedItem(item) {
  let score = 0;
  if (hasChineseText(item.chineseName) && !looksLikeUntranslatedDisplayItem(item)) score += 6;
  if (item.phonetic) score += 2;
  if (item.transliteration) score += 1;
  if (item.desc) score += 1;
  if (hasUsefulMappedCategory(item.tab)) score += 1;
  if (looksLikeHeadingText(item.sourceText) || looksLikeHeadingText(item.chineseName)) score -= 8;
  if (isKanaOnly(item.sourceText) && item.phonetic) {
    if (normalizeLoose(item.sourceText) === normalizeLoose(item.phonetic)) {
      score += 2;
    } else {
      score -= 3;
    }
  }
  return score;
}

function getMappedItemKeys(item) {
  const price = Number(item.price || 0);
  const currency = normalizeLoose(item.currency);
  const keys = [`src:${normalizeLoose(item.sourceText)}:${price}:${currency}`];
  const chinese = normalizeLoose(item.chineseName);
  if (chinese && !looksLikeUntranslatedDisplayItem(item)) {
    keys.push(`zh:${chinese}:${price}:${currency}`);
  }
  const transliteration = normalizeLoose(item.transliteration);
  if (transliteration) {
    keys.push(`ro:${transliteration}:${price}:${currency}`);
  }
  return keys;
}

function dedupeMappedItems(items) {
  const deduped = [];
  const keyToIndex = new Map();

  for (const item of items) {
    if (!item?.sourceText || !item?.chineseName || Number(item.price || 0) <= 0) continue;
    if (looksLikeHeadingText(item.sourceText) || looksLikeHeadingText(item.chineseName)) continue;
    const keys = getMappedItemKeys(item);
    const existingIndexes = keys
      .map((key) => keyToIndex.get(key))
      .filter((index) => index !== undefined);

    if (!existingIndexes.length) {
      const nextIndex = deduped.length;
      deduped.push(item);
      keys.forEach((key) => keyToIndex.set(key, nextIndex));
      continue;
    }

    const winnerIndex = existingIndexes[0];
    const current = deduped[winnerIndex];
    const next =
      scoreMappedItem(item) >= scoreMappedItem(current)
        ? {
            ...current,
            ...item,
            id: current.id,
            phonetic: item.phonetic || current.phonetic,
            transliteration: item.transliteration || current.transliteration,
            desc: item.desc || current.desc,
          }
        : current;

    deduped[winnerIndex] = next;
    getMappedItemKeys(next).forEach((key) => keyToIndex.set(key, winnerIndex));
  }

  return deduped;
}

function collapseNearPriceMappedItems(items) {
  const grouped = new Map();
  for (const item of items) {
    const key = [
      normalizeLoose(item.langCode),
      normalizeLoose(item.currency),
      normalizeLoose(item.sourceText),
    ].join("::");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  const collapsed = [];
  for (const group of grouped.values()) {
    if (group.length <= 1) {
      collapsed.push(...group);
      continue;
    }

    const prices = group
      .map((item) => Number(item.price || 0))
      .filter((price) => price > 0)
      .sort((left, right) => left - right);
    const median = prices[Math.floor(prices.length / 2)] || prices[0] || 0;
    const min = prices[0] || 0;
    const max = prices[prices.length - 1] || 0;
    const canCollapse = max - min <= Math.max(120, Math.floor(median * 0.22));

    if (!canCollapse) {
      collapsed.push(...group);
      continue;
    }

    const winner = [...group].sort((left, right) => {
      const scoreDelta = scoreMappedItem(right) - scoreMappedItem(left);
      if (scoreDelta !== 0) return scoreDelta;
      return Math.abs((left.price || 0) - median) - Math.abs((right.price || 0) - median);
    })[0];

    collapsed.push({
      ...winner,
      price:
        [...group]
          .map((item) => Number(item.price || 0))
          .filter((price) => price > 0)
          .sort((left, right) => Math.abs(left - median) - Math.abs(right - median))[0] || winner.price,
    });
  }

  return collapsed;
}

function extractOcrItems(text) {
  const jsonItems = compactItems(extractJsonArray(text));
  if (jsonItems.length) return jsonItems;
  return compactItems(parseTextRows(text));
}

function mergeRawItems(items) {
  const seen = new Set();
  const merged = [];
  for (const item of compactItems(items)) {
    const key = `${normalizeLoose(item.original)}:${parsePrice(item.price)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function fixKnownOcrSourceText(input = "") {
  let value = String(input || "").trim();
  value = value.replace(/丼丼/g, "丼").replace(/ライスライス/g, "ライス");
  value = value.replace(/^アズバラ$/, "アスパラ");
  value = value.replace(/^チキニーササラダ$/, "チキンシーザーサラダ");
  value = value.replace(/^ススメサラダ$/, "おすすめサラダ");
  return value;
}

function getJapanesePronunciation(sourceText) {
  const map = [
    [/生せんまい刺し/, "なませんまいさし (nama senmai sashi)"],
    [/あぶりユッケ/, "あぶりゆっけ (aburi yukke)"],
    [/こころ刺し/, "こころさし (kokoro sashi)"],
    [/白菜キムチ/, "はくさいきむち (hakusai kimuchi)"],
    [/きゅうりキムチ/, "きゅうりきむち (kyuuri kimuchi)"],
    [/キムチ2種盛/, "きむちにしゅもり (kimuchi nishu mori)"],
    [/もやしナムル/, "もやしなむる (moyashi namuru)"],
    [/なすびナムル/, "なすびなむる (nasubi namuru)"],
    [/ほうれん草ナムル/, "ほうれんそうなむる (hourensou namuru)"],
    [/ナムル3種盛/, "なむるさんしゅもり (namuru sanshu mori)"],
    [/チョレギサラダ|チヨレギサラダ/, "ちょれぎさらだ (choregi sarada)"],
    [/チシャ菜|チャラ菜/, "ちしゃな (chisha na)"],
    [/チキンシーザーサラダ|チキニーササラダ|チキンシーザ/, "ちきんしーざーさらだ (chikin shiizaa sarada)"],
    [/わかめスープ/, "わかめすーぷ (wakame suupu)"],
    [/たまごスープ/, "たまごすーぷ (tamago suupu)"],
    [/わか玉スープ/, "わかたますーぷ (wakatama suupu)"],
    [/石焼ビビ/, "いしやきびびんば (ishiyaki bibinba)"],
    [/ビビンバ/, "びびんば (bibinba)"],
    [/盛岡れいめん/, "もりおかれいめん (morioka reimen)"],
    [/ビビンめん/, "びびんめん (bibin men)"],
    [/牛すじ煮うどん/, "ぎゅうすじにうどん (gyuusujini udon)"],
    [/牛モツうどん/, "ぎゅうもつうどん (gyuu motsu udon)"],
    [/わかめうどん/, "わかめうどん (wakame udon)"],
    [/ハイボール/, "はいぼーる (haibooru)"],
    [/コーラハイボール/, "こーらはいぼーる (koora haibooru)"],
    [/ジンジャーハイボール/, "じんじゃーはいぼーる (jinjaa haibooru)"],
    [/ザクギリレモン/, "ざくぎりれもん (zakugiri remon)"],
    [/とりするめ|上りすきの|とりすきの/, "とりするめ (tori surume)"],
    [/蒸し鶏/, "むしどり (mushidori)"],
    [/山かけ/, "やまかけ (yamakake)"],
    [/じゃがいも/, "じゃがいも (jagaimo)"],
    [/ブロッコリー/, "ぶろっこりー (burokkorii)"],
    [/お茶.*塩バター|お芋.*塩バター/, "おいもさんしおばたー (oimo san shio bataa)"],
    [/まいたけの天ぷら|チリの天ぷら/, "まいたけのてんぷら (maitake no tenpura)"],
    [/いちごミルク/, "いちごみるく (ichigo miruku)"],
    [/りんごの天ぷら/, "りんごのてんぷら (ringo no tenpura)"],
    [/骨.*鶏.*ベーコン/, "ほねつきどりべーこん (honetsuki dori beekon)"],
    [/チキンカレー/, "ちきんかれー (chikin karee)"],
  ];
  return map.find(([pattern]) => pattern.test(sourceText))?.[1] || "";
}

function mapRecognizedItems(items) {
  const mapped = compactItems(items).map((item, index) => {
    const sourceText = fixKnownOcrSourceText(stripMenuNoise(item.original || item.translation || "未命名菜品"));
    const sourceLang = normalizeLangCode(item.lang_code, sourceText);
    const japaneseSeedOverride =
      sourceLang === "ja-JP"
        ? getJapaneseMenuOverride(sourceText, item.translation, item.category)
        : null;
    if (japaneseSeedOverride?.translation) item.translation = japaneseSeedOverride.translation;
    if (japaneseSeedOverride?.category) item.category = japaneseSeedOverride.category;
    const translatedCategory =
      translateStructuredJapaneseCategory(item.category) || translateCategoryToChinese(item.category);
    const koreanOverride =
      sourceLang === "ko-KR"
        ? getKoreanMenuOverride(sourceText, item.translation, translatedCategory)
        : null;
    const japaneseOverride =
      sourceLang === "ja-JP"
        ? getJapaneseMenuOverride(sourceText, item.translation, translatedCategory)
        : null;
    const heuristicFallback = getHeuristicMenuTranslation(
      sourceText,
      sourceLang,
      japaneseOverride?.translation || koreanOverride?.translation || item.translation || sourceText,
      japaneseOverride?.category || koreanOverride?.category || translatedCategory || CATEGORY_FALLBACK,
    );
    const preferredChineseName =
      heuristicFallback.translation || item.translation || sourceText;
    const preferredCategory =
      translateStructuredJapaneseCategory(heuristicFallback.category) ||
      translateCategoryToChinese(heuristicFallback.category || translatedCategory || CATEGORY_FALLBACK);
    let forcedChineseName = preferredChineseName;
    let forcedCategory = preferredCategory;
    if (sourceLang === "ja-JP") {
      if (/コーラハイボール/.test(sourceText)) {
        forcedChineseName = "可乐Highball";
        forcedCategory = "酒水/饮料";
      } else if (/ジンジャーハイボール/.test(sourceText)) {
        forcedChineseName = "姜汁Highball";
        forcedCategory = "酒水/饮料";
      } else if (/ザクギリレモン/.test(sourceText)) {
        forcedChineseName = "柠檬块Highball";
        forcedCategory = "酒水/饮料";
      } else if (/ハイボール/.test(sourceText)) {
        forcedChineseName = "Highball";
        forcedCategory = "酒水/饮料";
      } else if (/きゅうりキムチ/.test(sourceText)) {
        forcedChineseName = "黄瓜泡菜";
        forcedCategory = "前菜";
      } else if (/キムチ2種盛/.test(sourceText)) {
        forcedChineseName = "双拼泡菜";
        forcedCategory = "前菜";
      } else if (/もやしナムル/.test(sourceText)) {
        forcedChineseName = "凉拌豆芽";
        forcedCategory = "前菜";
      } else if (/なすびナムル/.test(sourceText)) {
        forcedChineseName = "凉拌茄子";
        forcedCategory = "前菜";
      } else if (/ほうれん草ナムル/.test(sourceText)) {
        forcedChineseName = "凉拌菠菜";
        forcedCategory = "前菜";
      } else if (/塩ダレきゅうり/.test(sourceText)) {
        forcedChineseName = "盐汁黄瓜";
        forcedCategory = "沙拉";
      } else if (/ぶつ切キャベツ/.test(sourceText)) {
        forcedChineseName = "手撕卷心菜";
        forcedCategory = "沙拉";
      } else if (/塩ダレキャベツ/.test(sourceText)) {
        forcedChineseName = "盐汁卷心菜";
        forcedCategory = "沙拉";
      } else if (/チシャ菜/.test(sourceText)) {
        forcedChineseName = "生菜叶";
        forcedCategory = "沙拉";
      } else if (/チャラ菜/.test(sourceText)) {
        forcedChineseName = "生菜叶";
        forcedCategory = "沙拉";
      } else if (/チヨレギサラダ|チョレギサラダ/.test(sourceText)) {
        forcedChineseName = "韩式生菜沙拉";
        forcedCategory = "沙拉";
      } else if (/チキニーササラダ|チキンシーザ|ケチャー?ジャー/.test(sourceText)) {
        forcedChineseName = "鸡肉凯撒沙拉";
        forcedCategory = "沙拉";
      } else if (/上りすきの|とりすきの|とりするめ/.test(sourceText)) {
        forcedChineseName = "鸡肉小菜";
        forcedCategory = "前菜";
      } else if (/蒸し鶏/.test(sourceText)) {
        forcedChineseName = "葱酱蒸鸡";
        forcedCategory = "主菜";
      } else if (/たまごスープ/.test(sourceText)) {
        forcedChineseName = "鸡蛋汤";
        forcedCategory = "汤/炖锅";
      } else if (/わか玉スープ/.test(sourceText)) {
        forcedChineseName = "海带蛋花汤";
        forcedCategory = "汤/炖锅";
      } else if (/ビビンバ/.test(sourceText)) {
        forcedChineseName = /石焼/.test(sourceText) ? "石锅拌饭" : "韩式拌饭";
        forcedCategory = "主食";
      } else if (/牛骨.*天津飯/.test(sourceText)) {
        forcedChineseName = "牛骨高汤天津饭";
        forcedCategory = "主食";
      } else if (/鶏クッパ/.test(sourceText)) {
        forcedChineseName = "鸡肉汤饭";
        forcedCategory = "主食";
      } else if (/牛すじ煮うどん/.test(sourceText)) {
        forcedChineseName = "牛筋炖乌冬";
        forcedCategory = "主食";
      } else if (/牛モツうどん/.test(sourceText)) {
        forcedChineseName = "牛杂乌冬";
        forcedCategory = "主食";
      } else if (/白ごはん/.test(sourceText)) {
        forcedChineseName = "白米饭";
        forcedCategory = "主食";
      } else if (/山かけ/.test(sourceText)) {
        forcedChineseName = "山药鸡胸肉";
        forcedCategory = "主菜";
      } else if (/せせり.*黒|黒こめ揚げ|黒しめき/.test(sourceText)) {
        forcedChineseName = "黑胡椒鸡颈脆骨";
        forcedCategory = "主菜";
      } else if (/じゃがいも.*(ナムル|カレ|カレー)|まやし|じゃがいもとちゃん/.test(sourceText)) {
        forcedChineseName = "土豆豆芽拌菜";
        forcedCategory = "配菜";
      } else if (/ブロッコリー.*チリ|ブドウ.*チリ|ブドウソース|ブドウクリーム/.test(sourceText)) {
        forcedChineseName = "西兰花辣味蛋黄酱";
        forcedCategory = "配菜";
      } else if (/お茶.*塩バター|お芋.*塩バター/.test(sourceText)) {
        forcedChineseName = "盐黄油土豆";
        forcedCategory = "配菜";
      } else if (/一番札\(麦\)/.test(sourceText)) {
        forcedChineseName = "一番札（麦烧酒）";
        forcedCategory = "酒水/饮料";
      } else if (/神の河\(麦\)/.test(sourceText)) {
        forcedChineseName = "神之河（麦烧酒）";
        forcedCategory = "酒水/饮料";
      } else if (/黒霧島\(芋\)/.test(sourceText)) {
        forcedChineseName = "黑雾岛（芋烧酒）";
        forcedCategory = "酒水/饮料";
      } else if (/赤霧島\(芋\)/.test(sourceText)) {
        forcedChineseName = "赤雾岛（芋烧酒）";
        forcedCategory = "酒水/饮料";
      } else if (/赤兎馬\(芋\)/.test(sourceText)) {
        forcedChineseName = "赤兔马（芋烧酒）";
        forcedCategory = "酒水/饮料";
      } else if (/チリの天ぷら|まいたけの天ぷら/.test(sourceText)) {
        forcedChineseName = "舞茸天妇罗";
        forcedCategory = "配菜";
      } else if (/いちごミルク/.test(sourceText)) {
        forcedChineseName = "草莓牛奶冰淇淋";
        forcedCategory = "甜品";
      } else if (/りんごの天ぷら/.test(sourceText)) {
        forcedChineseName = "苹果天妇罗";
        forcedCategory = "甜品";
      } else if (/骨.*鶏.*ベーコン/.test(sourceText)) {
        forcedChineseName = "带骨鸡肉培根";
        forcedCategory = "主菜";
      } else if (/チキンカレー/.test(sourceText)) {
        forcedChineseName = "鸡肉咖喱饭";
        forcedCategory = "主食";
      }
    }
    const reliableTranslation = getReliableMenuTranslation(
      sourceText,
      sourceLang,
      forcedChineseName,
      forcedCategory,
    );
    if (reliableTranslation?.translation) {
      forcedChineseName = reliableTranslation.translation;
      forcedCategory = reliableTranslation.category || forcedCategory;
    }
    const lowQualityChineseName =
      sourceLang !== "zh-CN" &&
      (normalizeLoose(forcedChineseName) === normalizeLoose(sourceText) ||
        !/[\u4e00-\u9fffA-Za-z]/.test(forcedChineseName) ||
        containsForeignMenuScript(forcedChineseName));
    if (lowQualityChineseName) {
      forcedChineseName =
        getHeuristicMenuTranslation(sourceText, sourceLang, "", forcedCategory).translation ||
        getHeuristicMenuTranslation(sourceText, "ja-JP", "", forcedCategory).translation ||
        forcedChineseName;
    }
    let finalCategory =
      translateStructuredJapaneseCategory(forcedCategory) || translateCategoryToChinese(forcedCategory);
    if (/炒飯付|冷书|ラーメン|ちゃんぽん|セット|単品|大盛り|\+/.test(finalCategory)) {
      finalCategory = reliableTranslation?.category || (sourceLang === "ja-JP" ? "其他" : finalCategory);
    }
    const resolvedPronunciation =
      item.pronunciation || (sourceLang === "ja-JP" ? getJapanesePronunciation(sourceText) : "");
    const { phonetic, transliteration } = splitPronunciation(resolvedPronunciation);
    return {
      id: `ai-${Date.now()}-${index}-${normalizeLoose(sourceText).slice(0, 18)}`,
      tab: finalCategory === "菜单分类" ? CATEGORY_FALLBACK : finalCategory,
      sourceText,
      chineseName: forcedChineseName,
      originalCategory: item.category && item.category !== CATEGORY_FALLBACK ? item.category : undefined,
      phonetic,
      transliteration,
      price: parsePrice(item.price),
      currency: formatCleanCurrencySymbol(item.currency),
      desc: item.desc || undefined,
      img: pickIllustration(`${sourceText} ${forcedChineseName}`),
      color: pickColor(finalCategory, sourceText),
      source: "ai",
      langCode: sourceLang,
    };
  });
  const deduped = collapseNearPriceMappedItems(dedupeMappedItems(mapped));

  const shortKeyCounts = new Map();
  for (const item of deduped) {
    const shortKey = normalizeLoose(item.sourceText);
    if (shortKey.length <= 4) {
      shortKeyCounts.set(shortKey, (shortKeyCounts.get(shortKey) || 0) + 1);
    }
  }

  const cleaned = deduped.filter((item) => {
    const shortKey = normalizeLoose(item.sourceText);
    if (isSuspiciousMenuLabel(item) && (shortKeyCounts.get(shortKey) || 0) > 1) return false;
    return true;
  });

  return cleaned.length >= Math.max(8, Math.floor(deduped.length * 0.65)) ? cleaned : deduped;
}

async function requestCompletion(models, messages, options = {}) {
  ensureApiKey();
  const { timeoutMs = 0, temperature = 0.1, maxTokens = 4096 } = options;
  let lastError;
  for (const model of uniqueModels(models)) {
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer =
      timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages }),
        signal: controller?.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`SiliconFlow 请求失败 (${response.status}) ${detail.slice(0, 240)}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error("SiliconFlow 请求失败");
}

async function requestVisionModel(model, imageDataUrl, timeoutMs) {
  const payload = await requestCompletion(
    [model],
    [
      { role: "system", content: buildVisionSystemPrompt() },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl, detail: "auto" } },
          { type: "text", text: "Extract menu OCR rows and prices. Return JSON array only." },
        ],
      },
    ],
    { timeoutMs, maxTokens: 4096 },
  );
  const items = extractOcrItems(extractMessageText(payload));
  if (items.length < 1) throw new Error(`模型 ${model} 没有返回有效菜单 OCR`);
  return items;
}

async function requestVisionStructuredMenu(model, imageDataUrl, timeoutMs) {
  const payload = await requestCompletion(
    [model],
    [
      { role: "system", content: buildStructuredVisionSystemPromptClean() },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
          {
            type: "text",
            text: [
              "Extract the entire menu into JSON rows.",
              "Scan the whole photo from left to right and top to bottom, including small bottom rows and all columns.",
              "Keep every priced sellable row: dishes, drinks, sets, sizes, add-ons, side items, and kids sets.",
              "For dense chain restaurant menus, do not stop after the first section. Completeness is more important than brevity.",
              "Return JSON array only.",
            ].join(" "),
          },
        ],
      },
    ],
    { timeoutMs, maxTokens: 12000 },
  );
  const items = extractOcrItems(extractMessageText(payload));
  if (items.length < 1) throw new Error(`structured vision ${model} returned no menu rows`);
  return items;
}

async function requestVisionPreview(imageDataUrl, preferredVisionModel) {
  const previewModels = uniqueModels([
    "deepseek-ai/DeepSeek-OCR",
    preferredVisionModel,
    ...OCR_FAST_MODELS,
  ]);
  for (const model of previewModels) {
    try {
      const items = await requestVisionModel(model, imageDataUrl, 8500);
      if (items.length) return mergeRawItems(items);
    } catch {}
  }
  return [];
}

async function requestVisionRecognition(imageDataUrl, preferredVisionModel) {
  const fastModels = uniqueModels([
    ...OCR_FAST_MODELS,
    preferredVisionModel,
  ]);
  const fastResults = await Promise.allSettled(
    fastModels.map((model) => requestVisionModel(model, imageDataUrl, 10500)),
  );
  const mergedFast = mergeRawItems(
    fastResults
      .filter((result) => result.status === "fulfilled")
      .flatMap((result) => result.value),
  );
  if (mergedFast.length >= 8) return mergedFast;

  let lastError;
  const slowItems = [];
  for (const model of uniqueModels(OCR_SLOW_MODELS)) {
    try {
      slowItems.push(...(await requestVisionModel(model, imageDataUrl, 14000)));
    } catch (nextError) {
      lastError = nextError;
    }
  }
  const merged = mergeRawItems([...mergedFast, ...slowItems]);
  if (merged.length) return merged;
  throw lastError || new Error("没有模型返回有效菜单 OCR");
}

function buildVisionTasks(slices, models, timeoutMs) {
  const tasks = [];
  for (const slice of slices) {
    for (const model of uniqueModels(models)) {
      tasks.push(async () => requestVisionModel(model, slice, timeoutMs));
    }
  }
  return tasks;
}

async function requestNormalizer(items, model, sectionHint = "") {
  const payload = await requestCompletion(
    [...TEXT_MODEL_FALLBACKS, model],
    [
      { role: "system", content: buildStrictNormalizerSystemPromptClean() },
      {
        role: "user",
        content: [
          sectionHint ? `Menu section heading: ${sectionHint}` : "",
          "Normalize and translate these OCR rows:",
          JSON.stringify(items, null, 2),
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    { timeoutMs: 14000, temperature: 0.05 },
  );
  return compactItems(extractJsonArray(extractMessageText(payload)));
}

async function repairFinalTranslations(items, model) {
  const targets = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.langCode !== "zh-CN" && looksLikeUntranslatedDisplayItem(item));
  if (!targets.length) return items;

  const repaired = new Map();
  const chunks = chunkArray(
    targets.map(({ item, index }) => ({
      index,
      original: item.sourceText,
      currentChinese: item.chineseName,
      category: item.tab,
      language: item.langCode,
      price: item.price,
    })),
    12,
  );

  const tasks = chunks.map((chunk) => async () => {
    const payload = await requestCompletion(
      [...TEXT_MODEL_FALLBACKS, model],
      [
        {
          role: "system",
          content: [
            "You are a professional restaurant menu translator for Chinese diners.",
            "Fix only untranslated or partly untranslated menu item names.",
            "Return JSON array only: [{\"index\":number,\"chineseName\":\"简体中文菜名\",\"tab\":\"简体中文分类\"}].",
            "chineseName must be natural Simplified Chinese and must not contain Japanese kana, Korean, Thai, or raw English words unless they are real brands or Highball.",
            "Do not include shop names, prices, tax text, ads, phone numbers, or explanations as dishes.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify(chunk, null, 2),
        },
      ],
      { timeoutMs: 12000, temperature: 0.05, maxTokens: 4096 },
    );
    return extractJsonArray(extractMessageText(payload));
  });

  await runPool(tasks, 4, (rows) => {
    for (const row of rows || []) {
      const index = Number(row.index);
      const chineseName = String(row.chineseName || row.translation || "").trim();
      if (!Number.isInteger(index) || !chineseName) continue;
      repaired.set(index, {
        chineseName,
        tab: translateCategoryToChinese(row.tab || row.category || ""),
      });
    }
  }).catch(() => {});

  if (!repaired.size) return items;

  return items.map((item, index) => {
    const next = repaired.get(index);
    if (!next?.chineseName) return item;
    const isBetter =
      hasChineseText(next.chineseName) &&
      !containsForeignMenuScript(next.chineseName) &&
      normalizeLoose(next.chineseName) !== normalizeLoose(item.sourceText);
    if (!isBetter) return item;
    return {
      ...item,
      chineseName: next.chineseName,
      tab: next.tab && next.tab !== CATEGORY_FALLBACK ? next.tab : item.tab,
    };
  });
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function runPool(tasks, concurrency, onResult) {
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const current = index;
      index += 1;
      try {
        const result = await tasks[current]();
        if (result) await onResult?.(result);
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

async function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function normalizeRecognizedItemsConcurrently(rawItems, model, onPartial) {
  const baseItems = mergeRawItems(rawItems);
  const chunks = chunkArray(baseItems, NORMALIZER_CHUNK_SIZE);
  const normalized = [];
  const tasks = chunks.map((chunk) => async () => {
    const sectionHint = chunk.find((item) => item.category)?.category || "";
    const result = await requestNormalizer(chunk, model, sectionHint);
    return result.length ? result : chunk;
  });

  await runPool(tasks, NORMALIZER_CONCURRENCY, (result) => {
    normalized.push(...result);
    const mergedNormalized = mergeRawItems([...normalized, ...baseItems]);
    onPartial?.({
      rawItems: mergedNormalized,
      items: mapRecognizedItems(mergedNormalized),
    });
  });

  return mergeRawItems([...normalized, ...baseItems]);
}

async function bufferToDataUrl(buffer, options = {}) {
  const { maxSize = 1600, quality = 82 } = options;
  const output = await sharp(buffer)
    .rotate()
    .resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
  return `data:image/jpeg;base64,${output.toString("base64")}`;
}

async function splitImageBuffer(file) {
  const image = sharp(file.buffer).rotate();
  const metadata = await image.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const slices = [await bufferToDataUrl(file.buffer)];

  const shouldSlice = width >= 1000 || height >= 1000;
  if (!shouldSlice) return slices;

  const base = sharp(file.buffer).rotate();
  const regions = [];
  const thirdWidth = Math.floor(width / 3);
  const thirdHeight = Math.floor(height / 3);
  if (thirdWidth > 0) {
    regions.push(
      { left: 0, top: 0, width: Math.min(thirdWidth + 100, width), height },
      { left: Math.max(thirdWidth - 50, 0), top: 0, width: Math.min(thirdWidth + 140, width), height },
      { left: Math.max(width - thirdWidth - 100, 0), top: 0, width: Math.min(thirdWidth + 100, width), height },
    );
  }
  if (thirdHeight > 0) {
    regions.push(
      { left: 0, top: 0, width, height: Math.min(thirdHeight + 100, height) },
      { left: 0, top: Math.max(thirdHeight - 50, 0), width, height: Math.min(thirdHeight + 140, height) },
      { left: 0, top: Math.max(height - thirdHeight - 100, 0), width, height: Math.min(thirdHeight + 100, height) },
    );
  }
  if (width >= height) {
    const third = Math.floor(width / 3);
    regions.push(
      { left: 0, top: 0, width: Math.max(third + 80, 1), height },
      { left: Math.max(third - 40, 0), top: 0, width: Math.max(third + 120, 1), height },
      { left: Math.max(width - third - 80, 0), top: 0, width: Math.max(third + 80, 1), height },
    );
  } else {
    const third = Math.floor(height / 3);
    regions.push(
      { left: 0, top: 0, width, height: Math.max(third + 80, 1) },
      { left: 0, top: Math.max(third - 40, 0), width, height: Math.max(third + 120, 1) },
      { left: 0, top: Math.max(height - third - 80, 0), width, height: Math.max(third + 80, 1) },
    );
  }

  // Dense takeaway menus often pack many items into small blocks; add an adaptive
  // overlapping grid so OCR can read local regions instead of only the whole page.
  if ((width >= 900 && height >= 1200) || (width >= 1200 && height >= 900)) {
    const columns = width >= 1200 ? 3 : 2;
    const rows = height >= 1800 ? 4 : 3;
    const cellWidth = Math.floor(width / columns);
    const cellHeight = Math.floor(height / rows);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const left = Math.max(column * cellWidth - 40, 0);
        const top = Math.max(row * cellHeight - 40, 0);
        regions.push({
          left,
          top,
          width: Math.min(cellWidth + 80, width - left),
          height: Math.min(cellHeight + 80, height - top),
        });
      }
    }
  }

  for (const region of regions) {
    try {
      const crop = await base.clone().extract(region).jpeg({ quality: 84 }).toBuffer();
      slices.push(await bufferToDataUrl(crop));
    } catch {}
  }
  return [...new Set(slices)].slice(0, 24);
}

async function buildQuickPreviewSlices(file) {
  const image = sharp(file.buffer).rotate();
  const metadata = await image.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const base = sharp(file.buffer).rotate();
  const slices = [await bufferToDataUrl(file.buffer, { maxSize: 960, quality: 70 })];

  if (width < 900 || height < 900) return slices;

  const regions = [];
  const halfWidth = Math.floor(width / 2);
  const halfHeight = Math.floor(height / 2);
  if (width >= height) {
    const thirdWidth = Math.floor(width / 3);
    regions.push(
      { left: 0, top: 0, width: Math.min(thirdWidth + 80, width), height },
      {
        left: Math.max(thirdWidth - 40, 0),
        top: 0,
        width: Math.min(thirdWidth + 120, width - Math.max(thirdWidth - 40, 0)),
        height,
      },
      {
        left: Math.max(width - thirdWidth - 80, 0),
        top: 0,
        width: Math.min(thirdWidth + 80, width - Math.max(width - thirdWidth - 80, 0)),
        height,
      },
    );
  }
  regions.push(
    { left: 0, top: 0, width: Math.min(halfWidth + 80, width), height: Math.min(halfHeight + 100, height) },
    { left: Math.max(halfWidth - 80, 0), top: 0, width: Math.min(halfWidth + 80, width - Math.max(halfWidth - 80, 0)), height: Math.min(halfHeight + 100, height) },
    { left: 0, top: Math.max(halfHeight - 60, 0), width: Math.min(halfWidth + 80, width), height: Math.min(halfHeight + 80, height - Math.max(halfHeight - 60, 0)) },
    { left: Math.max(halfWidth - 80, 0), top: Math.max(halfHeight - 60, 0), width: Math.min(halfWidth + 80, width - Math.max(halfWidth - 80, 0)), height: Math.min(halfHeight + 80, height - Math.max(halfHeight - 60, 0)) },
  );

  if (height > width) {
    const thirdHeight = Math.floor(height / 3);
    regions.push(
      { left: 0, top: 0, width, height: Math.min(thirdHeight + 80, height) },
      { left: 0, top: Math.max(thirdHeight - 40, 0), width, height: Math.min(thirdHeight + 120, height - Math.max(thirdHeight - 40, 0)) },
      { left: 0, top: Math.max(height - thirdHeight - 80, 0), width, height: Math.min(thirdHeight + 80, height - Math.max(height - thirdHeight - 80, 0)) },
    );
  }

  for (const region of regions) {
    try {
      const crop = await base.clone().extract(region).jpeg({ quality: 74 }).toBuffer();
      slices.push(await bufferToDataUrl(crop, { maxSize: 960, quality: 70 }));
    } catch {}
  }

  return [...new Set(slices)].slice(0, 10);
}

async function buildWholeImageSlices(files) {
  const slices = [];
  for (const file of files) {
    slices.push(await bufferToDataUrl(file.buffer, { maxSize: 2400, quality: 90 }));
  }
  return [...new Set(slices)];
}

async function buildDenseRescueSlices(files) {
  const slices = [];
  for (const file of files) {
    const image = sharp(file.buffer).rotate();
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if (width < 900 || height < 900) continue;
    const base = sharp(file.buffer).rotate();
    const columns = width >= height ? 4 : 3;
    const rows = height >= 1800 ? 6 : height >= 1400 ? 5 : 4;
    const cellWidth = Math.max(Math.floor(width / columns), 1);
    const cellHeight = Math.max(Math.floor(height / rows), 1);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const left = Math.max(column * cellWidth - 36, 0);
        const top = Math.max(row * cellHeight - 36, 0);
        const region = {
          left,
          top,
          width: Math.min(cellWidth + 72, width - left),
          height: Math.min(cellHeight + 72, height - top),
        };
        try {
          const crop = await base.clone().extract(region).jpeg({ quality: 86 }).toBuffer();
          slices.push(await bufferToDataUrl(crop, { maxSize: 1400, quality: 78 }));
        } catch {}
      }
    }
  }
  return [...new Set(slices)].slice(0, 36);
}

async function buildStructuredPanelSlices(files) {
  const slices = [];
  for (const file of files) {
    const image = sharp(file.buffer).rotate();
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if (width < 900 || height < 900) continue;

    const base = sharp(file.buffer).rotate();
    const regions = [];
    const columns = width >= height ? 3 : 2;
    const rows = height >= 1800 ? 4 : 3;
    const cellWidth = Math.max(Math.floor(width / columns), 1);
    const cellHeight = Math.max(Math.floor(height / rows), 1);

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const left = Math.max(column * cellWidth - 70, 0);
        const top = Math.max(row * cellHeight - 70, 0);
        regions.push({
          left,
          top,
          width: Math.min(cellWidth + 140, width - left),
          height: Math.min(cellHeight + 140, height - top),
        });
      }
    }

    if (height >= 1500) {
      regions.push({
        left: 0,
        top: Math.floor(height * 0.72),
        width,
        height: height - Math.floor(height * 0.72),
      });
    }

    for (const region of regions) {
      try {
        const crop = await base.clone().extract(region).jpeg({ quality: 88 }).toBuffer();
        slices.push(await bufferToDataUrl(crop, { maxSize: 1700, quality: 86 }));
      } catch {}
    }
  }
  return [...new Set(slices)].slice(0, 10);
}

function shouldRunRescuePass(files, currentCount) {
  if (currentCount >= OCR_RESCUE_MIN_ITEMS) return false;
  return files.some((file) => {
    const byteSize = Number(file?.size || 0);
    return byteSize >= 1200 * 1024 || currentCount < OCR_MIN_ACCEPTABLE_ITEMS;
  });
}

function shouldStartStructuredRace(files) {
  return files.some((file) => Number(file?.size || 0) >= 700 * 1024);
}

async function runStructuredRescueOnWholeImages(wholeImageSlices, onResult) {
  const structuredRescueModels = ["Pro/moonshotai/Kimi-K2.6"];
  for (const imageDataUrl of wholeImageSlices) {
    for (const rescueModel of structuredRescueModels) {
      try {
        const structuredItems = await requestVisionStructuredMenu(
          rescueModel,
          imageDataUrl,
          OCR_RESCUE_TIMEOUT_MS,
        );
        if (structuredItems.length) await onResult(structuredItems);
        if (structuredItems.length >= OCR_RESCUE_MIN_ITEMS) return structuredItems;
      } catch (error) {
        console.error("[structured-whole]", rescueModel, error?.message || error);
      }
    }
  }
  return [];
}

async function runStructuredRescueOnSlices(imageSlices, onResult, concurrency = 3) {
  const tasks = imageSlices.map((imageDataUrl) => async () =>
    requestVisionStructuredMenu("Pro/moonshotai/Kimi-K2.6", imageDataUrl, OCR_PANEL_STRUCTURED_TIMEOUT_MS)
      .catch((error) => {
        console.error("[structured-panel]", error?.message || error);
        return [];
      }),
  );
  const collected = [];
  await runPool(tasks, concurrency, async (items) => {
    if (!items?.length) return;
    collected.push(...items);
    await onResult(items);
  });
  return mergeRawItems(collected);
}

async function getScanCacheKey(files, models) {
  const signatures = await Promise.all(
    files.map(async (file) => {
      const hash = crypto.createHash("sha256").update(file.buffer).digest("hex");
      return `${file.originalname}:${file.size}:${hash}`;
    }),
  );
  return crypto
    .createHash("sha256")
    .update([SCAN_CACHE_VERSION, models.model, models.visionModel, ...signatures.sort()].join("::"))
    .digest("hex");
}

async function readScanCache(key) {
  try {
    return JSON.parse(await fs.readFile(path.join(cacheDir, `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function writeScanCache(key, items) {
  if (!Array.isArray(items) || items.length < 8) return;
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify(items), "utf8");
}

function buildDishImagePrompt(item) {
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

async function requestDishImage(item, preferredModel) {
  ensureApiKey();
  let lastError;
  for (const model of uniqueModels([preferredModel, ...IMAGE_MODEL_FALLBACKS])) {
    try {
      const response = await fetch(IMAGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model,
          prompt: buildDishImagePrompt(item),
          image_size: IMAGE_SIZE,
          batch_size: 1,
          num_inference_steps: 8,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      const url = payload?.data?.[0]?.url;
      if (!url) throw new Error("生图接口未返回图片 URL");
      const image = await fetch(url);
      if (!image.ok) throw new Error("下载生成图片失败");
      return Buffer.from(await image.arrayBuffer());
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("服务端生图失败");
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(API_KEY.trim()),
    model: DEFAULT_MODEL,
    visionModel: DEFAULT_VISION_MODEL,
    imageModel: DEFAULT_IMAGE_MODEL,
  });
});

app.post("/api/generate-image", async (req, res) => {
  try {
    const { item, imageModel = DEFAULT_IMAGE_MODEL } = req.body || {};
    if (!item) return res.status(400).json({ error: "缺少菜品数据" });
    const buffer = await requestDishImage(item, imageModel);
    res.setHeader("Content-Type", "image/jpeg");
    res.send(buffer);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "服务端生图失败",
    });
  }
});

app.post("/api/recognize", upload.array("files"), async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.socket?.setNoDelay(true);
  res.flushHeaders?.();
  sendEvent(res, { type: "ready", count: 0, pad: " ".repeat(2048) });
  const heartbeat = setInterval(() => {
    try {
      sendEvent(res, { type: "ping", ts: Date.now() });
    } catch {}
  }, 8000);

  try {
    ensureApiKey();
    const files = req.files || [];
    if (!Array.isArray(files) || files.length === 0) {
      sendEvent(res, { type: "error", message: "请至少上传一张菜单图片" });
      return res.end();
    }

    const model = String(req.body.model || DEFAULT_MODEL);
    const visionModel = String(req.body.visionModel || DEFAULT_VISION_MODEL);
    const cacheKey = await getScanCacheKey(files, { model, visionModel });
    const cached = await readScanCache(cacheKey);
    if (cached?.length) {
      sendEvent(res, { type: "translated_partial", count: cached.length, items: cached });
      sendEvent(res, { type: "final_cleaned", count: cached.length, items: cached });
      return res.end();
    }

    const mergedItems = [];
    const translatedSeedMap = new Map();
    const translationQueue = [];
    let lastOcrCount = 0;
    let lastTranslatedCount = 0;
    let lastTranslatedSignature = "";
    const translationWorkerPromises = new Set();
    const emitOcrPartial = () => {
      const count = mergeRawItems(mergedItems).length;
      if (count <= lastOcrCount) return;
      lastOcrCount = count;
      sendEvent(res, { type: "ocr_partial", count });
    };
    const mergeIntoTranslatedSeedMap = (rawChunk, overwrite = false) => {
      for (const item of compactItems(rawChunk)) {
        const key = `${normalizeLoose(item.original)}:${parsePrice(item.price)}`;
        if (overwrite || !translatedSeedMap.has(key)) {
          translatedSeedMap.set(key, item);
        }
      }
    };
    const emitTranslatedPartial = () => {
      const items = mapRecognizedItems([...translatedSeedMap.values()]);
      const signature = JSON.stringify(
        items.map((item) => [item.sourceText, item.chineseName, item.tab, item.price]),
      );
      if (items.length <= lastTranslatedCount && signature === lastTranslatedSignature) return;
      lastTranslatedCount = items.length;
      lastTranslatedSignature = signature;
      sendEvent(res, { type: "translated_partial", count: items.length, items });
    };
    const scheduleChunkTranslation = (rawChunk) => {
      const chunk = mergeRawItems(rawChunk);
      if (!chunk.length) return;
      mergeIntoTranslatedSeedMap(chunk, false);
      emitTranslatedPartial();
      translationQueue.push(chunk);
      while (translationWorkerPromises.size < STREAM_TRANSLATION_CONCURRENCY && translationQueue.length) {
        const workerPromise = (async () => {
          while (translationQueue.length) {
            const nextChunk = translationQueue.shift();
            if (!nextChunk?.length) continue;
            const sectionHint = nextChunk.find((item) => item.category)?.category || "";
            const normalizedChunk = await requestNormalizer(nextChunk, model, sectionHint).catch(() => nextChunk);
            mergeIntoTranslatedSeedMap(normalizedChunk, true);
            emitTranslatedPartial();
          }
        })();
        translationWorkerPromises.add(workerPromise);
        workerPromise.finally(() => translationWorkerPromises.delete(workerPromise));
      }
    };

    const quickSlices = [];
    for (const file of files) {
      quickSlices.push(...(await buildQuickPreviewSlices(file)));
    }

    const previewTasks = buildVisionTasks(
      quickSlices.slice(0, Math.min(8, quickSlices.length)),
      ["deepseek-ai/DeepSeek-OCR", visionModel],
      5200,
    );
    const previewPromise = runPool(previewTasks, 4, async (result) => {
      mergedItems.push(...result);
      emitOcrPartial();
      scheduleChunkTranslation(result);
    });

    const slices = [];
    for (const file of files) {
      slices.push(...(await splitImageBuffer(file)));
    }
    const wholeImageSlices = await buildWholeImageSlices(files);
    const isDenseImageBatch = shouldStartStructuredRace(files);
    const structuredPanelSlices = isDenseImageBatch ? await buildStructuredPanelSlices(files) : [];
    const denseRescueSlicesPromise = isDenseImageBatch ? buildDenseRescueSlices(files) : Promise.resolve([]);
    const structuredRacePromise = ENABLE_STRUCTURED_RESCUE && isDenseImageBatch
      ? (async () => {
          const collected = [];
          const onStructuredResult = async (result) => {
            collected.push(...result);
            mergedItems.push(...result);
            emitOcrPartial();
            scheduleChunkTranslation(result);
          };
          await Promise.allSettled([
            runStructuredRescueOnWholeImages(wholeImageSlices, onStructuredResult),
            runStructuredRescueOnSlices(structuredPanelSlices.slice(0, 8), onStructuredResult, 4),
          ]);
          return mergeRawItems(collected);
        })()
      : Promise.resolve([]);

    const fastTasks = buildVisionTasks(
      mergeRawItems(mergedItems).length >= OCR_RESCUE_MIN_ITEMS
        ? []
        : [...slices.slice(0, isDenseImageBatch ? 14 : 24), ...structuredPanelSlices.slice(0, 8)],
      [visionModel, "deepseek-ai/DeepSeek-OCR", "Qwen/Qwen3-VL-8B-Instruct"],
      OCR_FAST_TIMEOUT_MS,
    );
    await withTimeout(
      runPool(fastTasks, OCR_SLICE_CONCURRENCY, async (result) => {
        mergedItems.push(...result);
        emitOcrPartial();
        scheduleChunkTranslation(result);
      }),
      18000,
      "fast OCR pass timed out",
    ).catch(() => {});

    const earlyDenseSlices = await denseRescueSlicesPromise;
    const earlyDenseTasks = isDenseImageBatch
      ? buildVisionTasks(
          earlyDenseSlices.slice(0, 36),
          ["deepseek-ai/DeepSeek-OCR", "Qwen/Qwen3-VL-8B-Instruct", "Qwen/Qwen3-VL-32B-Instruct"],
          OCR_FAST_TIMEOUT_MS,
        )
      : [];
    await withTimeout(
      runPool(earlyDenseTasks, 14, async (result) => {
        mergedItems.push(...result);
        emitOcrPartial();
        scheduleChunkTranslation(result);
      }),
      22000,
      "early dense OCR timed out",
    ).catch(() => {});

    if (isDenseImageBatch) {
      const softWaitMs = mergeRawItems(mergedItems).length < OCR_RESCUE_MIN_ITEMS ? 18000 : 8000;
      await withTimeout(structuredRacePromise, softWaitMs, "structured race soft wait timed out").catch(() => []);
    }

    if (mergeRawItems(mergedItems).length < OCR_MIN_ACCEPTABLE_ITEMS + 8) {
      const wholeImageSlowTasks = buildVisionTasks(
        wholeImageSlices,
        OCR_SLOW_MODELS,
        OCR_SLOW_TIMEOUT_MS,
      );
      const slowTasks = buildVisionTasks(slices.slice(0, isDenseImageBatch ? 4 : 8), OCR_SLOW_MODELS, OCR_SLOW_TIMEOUT_MS);
      await withTimeout(
        runPool(
          [...wholeImageSlowTasks, ...slowTasks],
          Math.max(2, Math.floor(OCR_SLICE_CONCURRENCY / 3)),
          async (result) => {
            mergedItems.push(...result);
            emitOcrPartial();
            scheduleChunkTranslation(result);
          },
        ),
        16000,
        "slow OCR pass timed out",
      ).catch(() => {});
    }

    const currentMergedCount = mergeRawItems(mergedItems).length;
    if (shouldRunRescuePass(files, currentMergedCount)) {
      if (mergeRawItems(mergedItems).length < OCR_RESCUE_MIN_ITEMS) {
        const rescueTasks = buildVisionTasks(
          earlyDenseSlices.slice(0, 36),
          ["deepseek-ai/DeepSeek-OCR", "Qwen/Qwen3-VL-8B-Instruct", "Qwen/Qwen3-VL-32B-Instruct"],
          OCR_SLOW_TIMEOUT_MS,
        );
        await withTimeout(
          runPool(rescueTasks, 8, async (result) => {
            mergedItems.push(...result);
            emitOcrPartial();
            scheduleChunkTranslation(result);
          }),
          16000,
          "dense rescue timed out",
        ).catch(() => {});
      }
    }

    await previewPromise;

    if (translationWorkerPromises.size) {
      await withTimeout(
        Promise.allSettled([...translationWorkerPromises]),
        isDenseImageBatch ? 6000 : 18000,
        "translation queue soft timeout",
      ).catch(() => {});
    }

    const rawItems = mergeRawItems(mergedItems);
    if (!rawItems.length) throw new Error("没有识别到有效菜单项");

    let normalizedItems = rawItems;
    let bestNormalizedItems = rawItems;
    try {
      if (isDenseImageBatch && mapRecognizedItems([...translatedSeedMap.values()]).length >= 20) {
        throw new Error("skip slow normalize for dense menu");
      }
      normalizedItems = await withTimeout(
        normalizeRecognizedItemsConcurrently(rawItems, model, ({ rawItems: nextRawItems, items }) => {
          bestNormalizedItems = nextRawItems;
          if (items.length > lastTranslatedCount) {
            lastTranslatedCount = items.length;
            sendEvent(res, { type: "translated_partial", count: items.length, items });
          }
        }),
        NORMALIZE_TIMEOUT_MS,
        "菜单整理超时，先显示 OCR 结果",
      );
    } catch {
      normalizedItems = bestNormalizedItems?.length ? bestNormalizedItems : rawItems;
    }

    const mappedNormalizedItems = mapRecognizedItems(normalizedItems);
    const mappedVisibleItems = mapRecognizedItems([...translatedSeedMap.values()]);
    const mappedUnionItems = mapRecognizedItems([...normalizedItems, ...translatedSeedMap.values()]);
    const finalItemsBeforeRepair =
      mappedUnionItems.length >= Math.max(mappedNormalizedItems.length, mappedVisibleItems.length)
        ? mappedUnionItems
        : mappedNormalizedItems.length >= Math.max(8, Math.floor(mappedVisibleItems.length * 0.85))
        ? mappedNormalizedItems
        : mappedVisibleItems;
    const finalItems = await repairFinalTranslations(finalItemsBeforeRepair, model);
    await writeScanCache(cacheKey, finalItems);
    sendEvent(res, { type: "final_cleaned", count: finalItems.length, items: finalItems });
    res.end();
  } catch (error) {
    sendEvent(res, {
      type: "error",
      message: error instanceof Error ? error.message : "服务端识别失败",
    });
    res.end();
  } finally {
    clearInterval(heartbeat);
  }
});

app.use(
  express.static(distDir, {
    etag: false,
    lastModified: false,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
    },
  }),
);
app.get(/.*/, async (_req, res, next) => {
  try {
    await fs.access(path.join(distDir, "index.html"));
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(path.join(distDir, "index.html"));
  } catch {
    next();
  }
});

export { app };
export default app;

if (process.env.TCB_HTTP_FUNCTION !== "1") {
  app.listen(PORT, () => {
    console.log(`AI Menu proxy listening on http://127.0.0.1:${PORT}`);
  });
}
