import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronLeft,
  Cog,
  ImageOff,
  ImagePlus,
  LoaderCircle,
  Minus,
  Plus,
  ShoppingCart,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import {
  generateDishImageBlob,
  getDefaultSettings,
  getDishImageCacheKey,
  recognizeMenuFiles,
  sortTabs,
} from "./ai";
import { getCachedDishImageBlob, setCachedDishImageBlob } from "./imageCache";
import { SAMPLE_MENU } from "./sampleMenu";
import type { AppPage, MenuItem, ScanStatus, Settings } from "./types";

const STORAGE_KEYS = {
  cart: "aimenu-v5-cart",
  menu: "aimenu-v5-menu",
  settings: "aimenu-v5-settings",
  sampleVisible: "aimenu-v5-sample-visible",
};

const STALE_TEXT_MODELS = [
  "Pro/moonshotai/Kimi-K2.6",
  "Qwen/Qwen2.5-7B-Instruct",
  "Qwen/Qwen3-14B",
];
const STALE_VISION_MODELS = [
  "Pro/moonshotai/Kimi-K2.6",
  "Qwen/Qwen2.5-VL-7B-Instruct",
  "deepseek-ai/DeepSeek-OCR",
  "Qwen/Qwen3-VL-8B-Instruct",
];
const STALE_IMAGE_MODELS = ["black-forest-labs/FLUX.1-schnell", "Kwai-Kolors/Kolors"];
const IMAGE_WORKER_COUNT = 2;
const FALLBACK_TAB = "\u524D\u83DC";
const YEN = "\u00A5";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function getStoredSettings() {
  const defaults = getDefaultSettings();
  const stored = readJson<Partial<Settings>>(STORAGE_KEYS.settings, {});
  const next = { ...defaults, ...stored };

  if (STALE_TEXT_MODELS.includes(next.model)) next.model = defaults.model;
  if (STALE_VISION_MODELS.includes(next.visionModel)) {
    next.visionModel = defaults.visionModel;
  }
  if (STALE_IMAGE_MODELS.includes(next.imageModel)) {
    next.imageModel = defaults.imageModel;
  }

  return next;
}

function normalizeLoose(input?: string) {
  return input?.replace(/[\s\u3000.,_\-()]+/g, "").toLowerCase() || "";
}

function speakText(text: string, langCode = "ja-JP") {
  if (typeof window === "undefined" || !window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = langCode;
  utter.rate = 0.88;
  window.speechSynthesis.speak(utter);
}

function speakOrder(items: MenuItem[], cart: Record<string, number>) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  for (const item of items) {
    const count = cart[item.id] || 0;
    if (!count) continue;
    const utter = new SpeechSynthesisUtterance(`${item.sourceText} ${count}`);
    utter.lang = item.langCode || "en-US";
    utter.rate = 0.88;
    window.speechSynthesis.speak(utter);
  }
}

function formatMoney(amount: number, currency = YEN) {
  if (amount <= 0) return "\u672A\u6807\u4EF7";
  return `${currency}${Number(amount || 0).toLocaleString("zh-CN")}`;
}

function formatTotal(amount: number, currency = YEN) {
  return `${currency}${Number(amount || 0).toLocaleString("zh-CN")}`;
}

function revokeObjectUrl(url?: string) {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

function FoodImage({
  title,
  photoUrl,
  color,
  imageGenerationEnabled,
  isGenerating = false,
  onClick,
  large = false,
}: {
  title: string;
  photoUrl?: string;
  color: string;
  imageGenerationEnabled: boolean;
  isGenerating?: boolean;
  onClick?: () => void;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const size = large ? "w-32 h-32" : "w-24 h-24";

  useEffect(() => {
    setFailed(false);
  }, [photoUrl]);

  if (photoUrl && !failed) {
    return (
      <div
        className={`${size} relative shrink-0 overflow-hidden rounded-2xl bg-[#f0e1cb] shadow-md`}
      >
        <img
          src={photoUrl}
          alt={title}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick || isGenerating}
      className={`${size} flex shrink-0 flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed border-[#d9b98b] bg-[#fff3df] px-3 text-center shadow-sm transition ${
        onClick ? "cursor-pointer hover:border-[#b67c43] hover:bg-[#fff0d7]" : "cursor-default"
      } disabled:cursor-wait disabled:opacity-80`}
    >
      <div
        className="mb-2 flex h-11 w-11 items-center justify-center rounded-full"
        style={{ backgroundColor: `${color}22`, color }}
      >
        {isGenerating ? <LoaderCircle className="animate-spin" size={20} /> : <ImageOff size={20} />}
      </div>
      <div className="text-xs font-bold tracking-[0.08em] text-[#8a6441]">
        {isGenerating
          ? "\u751F\u6210\u4E2D"
          : imageGenerationEnabled
            ? "\u70B9\u51FB\u751F\u6210"
            : "\u65E0\u56FE"}
      </div>
    </button>
  );
}

function DishText({
  item,
  compact = false,
  primaryLanguage = "chinese",
  showOriginal = true,
  showMeta = true,
  showDesc = true,
}: {
  item: MenuItem;
  compact?: boolean;
  primaryLanguage?: "chinese" | "source";
  showOriginal?: boolean;
  showMeta?: boolean;
  showDesc?: boolean;
}) {
  const titleClass = compact
    ? "text-lg font-black leading-tight text-[#2f1b10]"
    : "text-[22px] font-black leading-tight text-[#2f1b10]";
  const sourceClass = compact
    ? "mt-1 text-sm font-semibold text-[#7a5a42]"
    : "mt-1 text-[15px] font-semibold text-[#7a5a42]";
  const title = primaryLanguage === "source" ? item.sourceText : item.chineseName;
  const secondary = primaryLanguage === "source" ? item.chineseName : item.sourceText;

  const metaLines = [
    item.phonetic &&
    normalizeLoose(item.phonetic) !== normalizeLoose(item.sourceText)
      ? item.phonetic
      : "",
    item.transliteration &&
    normalizeLoose(item.transliteration) !== normalizeLoose(item.sourceText)
      ? item.transliteration
      : "",
  ].filter(Boolean);

  return (
    <div className="min-w-0 flex-1">
      <div className={`${titleClass} whitespace-normal break-words`}>{title}</div>
      {showOriginal ? (
        <div className={`${sourceClass} whitespace-normal break-words`}>{secondary}</div>
      ) : null}
      {showMeta
        ? metaLines.map((line) => (
        <div
          key={line}
          className="whitespace-normal break-words text-xs tracking-[0.02em] text-[#9b775c]"
        >
          {line}
        </div>
          ))
        : null}
      {showDesc && item.desc ? (
        <div className="mt-1 whitespace-normal break-words text-xs font-medium text-[#b26f32]">
          {item.desc}
        </div>
      ) : null}
    </div>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -18 }}
      transition={{ duration: 0.22 }}
      className="flex h-full flex-col"
    >
      {children}
    </motion.div>
  );
}

export default function App() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const photoUrlsRef = useRef<Record<string, string>>({});
  const generatedPhotosRef = useRef<Record<string, string>>({});
  const failedImageKeysRef = useRef(new Set<string>());
  const activeImageJobsRef = useRef(new Set<string>());
  const [page, setPage] = useState<AppPage>("menu");
  const [recognizedMenu, setRecognizedMenu] = useState<MenuItem[]>(() =>
    readJson<MenuItem[]>(STORAGE_KEYS.menu, []),
  );
  const [sampleMenuVisible, setSampleMenuVisible] = useState(() =>
    readJson<boolean>(STORAGE_KEYS.sampleVisible, true),
  );
  const [settings, setSettings] = useState<Settings>(() => getStoredSettings());
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cart, setCart] = useState<Record<string, number>>(() =>
    readJson<Record<string, number>>(STORAGE_KEYS.cart, {}),
  );
  const [scanStatus, setScanStatus] = useState<ScanStatus>("idle");
  const [recognizedCount, setRecognizedCount] = useState(0);
  const [generatedPhotos, setGeneratedPhotos] = useState<Record<string, string>>({});
  const [generatingImageIds, setGeneratingImageIds] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const isUsingSampleMenu = recognizedMenu.length === 0 && sampleMenuVisible;
  const baseMenu =
    recognizedMenu.length > 0 ? recognizedMenu : sampleMenuVisible ? SAMPLE_MENU : [];
  const menu = useMemo(
    () =>
      baseMenu.map((item) =>
        generatedPhotos[item.id] ? { ...item, photoUrl: generatedPhotos[item.id] } : item,
      ),
    [baseMenu, generatedPhotos],
  );
  const tabs = useMemo(
    () => sortTabs(Array.from(new Set(menu.map((item) => item.tab)))),
    [menu],
  );
  const [activeTab, setActiveTab] = useState(tabs[0] || FALLBACK_TAB);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.menu, JSON.stringify(recognizedMenu));
  }, [recognizedMenu]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.cart, JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.sampleVisible, JSON.stringify(sampleMenuVisible));
  }, [sampleMenuVisible]);

  useEffect(() => {
    if (!tabs.includes(activeTab)) {
      setActiveTab(tabs[0] || FALLBACK_TAB);
    }
  }, [tabs, activeTab]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    return () => {
      Object.values(photoUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    failedImageKeysRef.current.clear();
  }, [settings.imageModel]);

  function attachImageBlob(itemId: string, blob: Blob) {
    const objectUrl = URL.createObjectURL(blob);
    const previous = photoUrlsRef.current[itemId];
    revokeObjectUrl(previous);
    photoUrlsRef.current[itemId] = objectUrl;
    generatedPhotosRef.current[itemId] = objectUrl;
    setGeneratedPhotos((prev) => ({ ...prev, [itemId]: objectUrl }));
  }

  async function ensureDishImage(item: MenuItem, forceGenerate = false) {
    const cacheKey = getDishImageCacheKey(item);
    if (activeImageJobsRef.current.has(cacheKey)) return;

    activeImageJobsRef.current.add(cacheKey);
    setGeneratingImageIds((prev) => ({ ...prev, [item.id]: true }));

    try {
      let blob = forceGenerate ? null : await getCachedDishImageBlob(cacheKey);

      if (!blob) {
        blob = await generateDishImageBlob(settings, item);
        await setCachedDishImageBlob(cacheKey, blob);
      }

      attachImageBlob(item.id, blob);
      failedImageKeysRef.current.delete(cacheKey);
    } catch (error) {
      failedImageKeysRef.current.add(cacheKey);
      setToast(
        error instanceof Error
          ? error.message
          : "\u8FD9\u9053\u83DC\u56FE\u751F\u6210\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
      );
    } finally {
      activeImageJobsRef.current.delete(cacheKey);
      setGeneratingImageIds((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }
  }

  useEffect(() => {
    const validIds = new Set(baseMenu.map((item) => item.id));
    const staleIds = Object.keys(photoUrlsRef.current).filter((id) => !validIds.has(id));
    if (staleIds.length === 0) return;

    for (const id of staleIds) {
      revokeObjectUrl(photoUrlsRef.current[id]);
      delete photoUrlsRef.current[id];
      delete generatedPhotosRef.current[id];
    }

    setGeneratedPhotos((prev) => {
      const next = { ...prev };
      for (const id of staleIds) {
        delete next[id];
      }
      return next;
    });
  }, [baseMenu]);

  useEffect(() => {
    let cancelled = false;

    async function loadCachedImages() {
      for (const item of baseMenu) {
        if (cancelled || generatedPhotosRef.current[item.id]) continue;
          const blob = await getCachedDishImageBlob(getDishImageCacheKey(item));
          if (cancelled || !blob) continue;

          attachImageBlob(item.id, blob);
      }
    }

    void loadCachedImages();
    return () => {
      cancelled = true;
    };
  }, [baseMenu]);

  useEffect(() => {
    if (!settings.enableImageGeneration) return;
    if (!settings.apiKey.trim()) return;
    if (scanStatus === "processing") return;

    let cancelled = false;
    const prioritizedMenu = [
      ...baseMenu.filter((item) => item.tab === activeTab),
      ...baseMenu.filter((item) => item.tab !== activeTab),
    ];
    let index = 0;

    async function worker() {
      while (!cancelled) {
        const item = prioritizedMenu[index];
        index += 1;

        if (!item) return;

        const cacheKey = getDishImageCacheKey(item);
        if (
          generatedPhotosRef.current[item.id] ||
          failedImageKeysRef.current.has(cacheKey) ||
          activeImageJobsRef.current.has(cacheKey)
        ) {
          continue;
        }

        activeImageJobsRef.current.add(cacheKey);

        try {
          await ensureDishImage(item);
        } catch {
          failedImageKeysRef.current.add(cacheKey);
        } finally {
          activeImageJobsRef.current.delete(cacheKey);
        }
      }
    }

    void Promise.allSettled(
      Array.from({ length: IMAGE_WORKER_COUNT }, () => worker()),
    );

    return () => {
      cancelled = true;
    };
  }, [activeTab, baseMenu, recognizedMenu.length, scanStatus, settings]);

  const selected = useMemo(
    () => menu.filter((item) => (cart[item.id] || 0) > 0),
    [cart, menu],
  );

  const totalCount = useMemo(
    () => Object.values(cart).reduce((sum, quantity) => sum + quantity, 0),
    [cart],
  );

  const totalCurrency = selected[0]?.currency || YEN;
  const total = useMemo(
    () => selected.reduce((sum, item) => sum + item.price * (cart[item.id] || 0), 0),
    [cart, selected],
  );

  function updateSettings(patch: Partial<Settings>) {
    setSettings((prev) => ({ ...prev, ...patch }));
  }

  function add(id: string) {
    setCart((prev) => ({ ...prev, [id]: (prev[id] || 0) + 1 }));
  }

  function minus(id: string) {
    setCart((prev) => {
      const next = { ...prev };
      if (!next[id]) return next;
      next[id] -= 1;
      if (next[id] <= 0) delete next[id];
      return next;
    });
  }

  function clearCart() {
    setCart({});
  }

  function clearRecognizedMenu() {
    Object.values(photoUrlsRef.current).forEach(revokeObjectUrl);
    photoUrlsRef.current = {};
    generatedPhotosRef.current = {};
    failedImageKeysRef.current.clear();
    activeImageJobsRef.current.clear();
    setGeneratingImageIds({});
    setGeneratedPhotos({});
    setRecognizedMenu([]);
    setSampleMenuVisible(false);
    setCart({});
    setRecognizedCount(0);
    setScanStatus("idle");
    setErrorMessage("");
    setPage("menu");
    setToast("\u5DF2\u6E05\u7A7A\u5F53\u524D\u83DC\u5355\uFF0C\u8BF7\u91CD\u65B0\u5BFC\u5165");
  }

  function resetAndReimport() {
    clearRecognizedMenu();
    setScannerOpen(true);
    window.setTimeout(() => inputRef.current?.click(), 0);
  }

  function clearAndPickImages() {
    clearRecognizedMenu();
    window.setTimeout(() => inputRef.current?.click(), 0);
  }

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    setErrorMessage("");
    setScanStatus("processing");
    setRecognizedCount(0);

    try {
      const items = await recognizeMenuFiles(files, settings, setRecognizedCount);
      setRecognizedMenu(items);
      setSampleMenuVisible(false);
      setCart({});
      setPage("menu");
      setScanStatus("finished");
      setToast(
        `\u8BC6\u522B\u5B8C\u6210\uFF0C\u5171\u5BFC\u5165 ${items.length} \u4E2A\u6761\u76EE`,
      );
      setScannerOpen(false);
    } catch (error) {
      setScanStatus("error");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "\u8BC6\u522B\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
      );
    } finally {
      if (inputRef.current) {
        inputRef.current.value = "";
      }
      window.setTimeout(() => {
        setScanStatus((prev) => (prev === "finished" ? "idle" : prev));
      }, 1800);
    }
  }

  return (
    <div className="min-h-screen bg-[#f2e3cc] px-3 py-4 text-[#321b0d]">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleUpload}
      />

      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[440px] items-center justify-center">
        <div className="relative h-[844px] w-[390px] overflow-hidden rounded-[42px] border border-[#dfc59f] bg-[#fff8eb] shadow-glow">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.85),_transparent_42%)]" />

          <AnimatePresence>
            {scanStatus !== "idle" && (
              <motion.div
                initial={{ y: -80, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -80, opacity: 0 }}
                className={`absolute left-4 right-4 top-4 z-50 rounded-full px-5 py-3 text-sm font-bold shadow-lg ${
                  scanStatus === "finished"
                    ? "bg-[#2d8b57] text-white"
                    : scanStatus === "error"
                      ? "bg-[#c34534] text-white"
                      : "bg-[#3b2418] text-white"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {scanStatus === "processing" ? (
                      <LoaderCircle className="animate-spin" size={18} />
                    ) : null}
                    <span>
                      {scanStatus === "processing"
                        ? "AI \u6B63\u5728\u8BC6\u522B\u591A\u8BED\u8A00\u83DC\u5355"
                        : scanStatus === "finished"
                          ? "\u8BC6\u522B\u5B8C\u6210"
                          : "\u8BC6\u522B\u5931\u8D25"}
                    </span>
                  </div>
                  <span className="rounded-full bg-white/15 px-3 py-1 font-mono text-xs">
                    {scanStatus === "error"
                      ? "\u8BF7\u91CD\u8BD5"
                      : `\u5DF2\u627E\u5230 ${recognizedCount}`}
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex h-full flex-col">
            <AnimatePresence mode="wait">
              {page === "menu" && (
                <MenuPage
                  key="menu"
                  menu={menu}
                  tabs={tabs}
                  activeTab={activeTab}
                  setActiveTab={setActiveTab}
                  cart={cart}
                  add={add}
                  minus={minus}
                  total={total}
                  totalCurrency={totalCurrency}
                  totalCount={totalCount}
                  recognizedMenuCount={recognizedMenu.length}
                  isUsingSampleMenu={isUsingSampleMenu}
                  imageGenerationEnabled={settings.enableImageGeneration}
                  generatingImageIds={generatingImageIds}
                  setPage={setPage}
                  onOpenScanner={() => setScannerOpen(true)}
                  onPickImages={() => inputRef.current?.click()}
                  onResetAndReimport={resetAndReimport}
                  onClearMenu={clearRecognizedMenu}
                  onGenerateImage={(item) => {
                    if (!settings.apiKey.trim()) {
                      setToast("\u8BF7\u5148\u586B\u5199 API Key \u518D\u751F\u6210\u56FE\u7247");
                      setScannerOpen(true);
                      return;
                    }
                    void ensureDishImage(item);
                  }}
                />
              )}

              {page === "cart" && (
                <CartPage
                  key="cart"
                  cart={cart}
                  selected={selected}
                  add={add}
                  minus={minus}
                  clearCart={clearCart}
                  total={total}
                  totalCurrency={totalCurrency}
                  imageGenerationEnabled={settings.enableImageGeneration}
                  setPage={setPage}
                />
              )}

              {page === "waiter" && (
                <WaiterPage
                  key="waiter"
                  cart={cart}
                  selected={selected}
                  total={total}
                  totalCurrency={totalCurrency}
                  imageGenerationEnabled={settings.enableImageGeneration}
                  setPage={setPage}
                />
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence>
            {scannerOpen && (
              <ScannerSheet
                settings={settings}
                hasRecognizedMenu={recognizedMenu.length > 0}
                errorMessage={errorMessage}
                onClose={() => setScannerOpen(false)}
                onSettingsChange={updateSettings}
                onPickImages={() => inputRef.current?.click()}
                onClearRecognizedMenu={clearRecognizedMenu}
                onClearAndPickImages={clearAndPickImages}
              />
            )}
          </AnimatePresence>

          <AnimatePresence>
            {toast && (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 16 }}
                className="absolute left-1/2 top-24 z-[70] -translate-x-1/2 rounded-full bg-[#3b2418]/92 px-5 py-3 text-sm font-medium text-white shadow-xl backdrop-blur"
              >
                {toast}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function MenuPage({
  menu,
  tabs,
  activeTab,
  setActiveTab,
  cart,
  add,
  minus,
  total,
  totalCurrency,
  totalCount,
  recognizedMenuCount,
  isUsingSampleMenu,
  imageGenerationEnabled,
  generatingImageIds,
  setPage,
  onOpenScanner,
  onPickImages,
  onResetAndReimport,
  onClearMenu,
  onGenerateImage,
}: {
  menu: MenuItem[];
  tabs: string[];
  activeTab: string;
  setActiveTab: (tab: string) => void;
  cart: Record<string, number>;
  add: (id: string) => void;
  minus: (id: string) => void;
  total: number;
  totalCurrency: string;
  totalCount: number;
  recognizedMenuCount: number;
  isUsingSampleMenu: boolean;
  imageGenerationEnabled: boolean;
  generatingImageIds: Record<string, boolean>;
  setPage: (page: AppPage) => void;
  onOpenScanner: () => void;
  onPickImages: () => void;
  onResetAndReimport: () => void;
  onClearMenu: () => void;
  onGenerateImage: (item: MenuItem) => void;
}) {
  const list = menu.filter((item) => item.tab === activeTab);

  return (
    <Page>
      <header className="flex items-center justify-between px-6 pb-3 pt-7">
        <div className="flex items-center gap-2">
          <div className="text-3xl">{"\uD83D\uDC2E"}</div>
          <div className="font-display text-[31px] font-bold italic">AIMenu</div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={recognizedMenuCount > 0 ? onResetAndReimport : onPickImages}
            className="rounded-full bg-[#f5dfb7] px-4 py-2 text-sm font-bold text-[#5b3315]"
          >
            {recognizedMenuCount > 0
              ? `\u91CD\u65B0\u5BFC\u5165 ${recognizedMenuCount}`
              : "\u5BFC\u5165\u83DC\u5355\u56FE\u7247"}
          </button>
          <button
            onClick={onClearMenu}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-[#e1ccb0] bg-white/70"
            title="\u6E05\u7A7A\u5F53\u524D\u83DC\u5355"
          >
            <Trash2 size={18} />
          </button>
          <button
            onClick={onOpenScanner}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-[#e1ccb0] bg-white/70"
          >
            <Cog size={18} />
          </button>
        </div>
      </header>

      <div className="px-6 pb-2 text-xs font-medium text-[#8c6d53]">
        {recognizedMenuCount > 0
          ? "\u5F53\u524D\u663E\u793A AI \u8BC6\u522B\u7ED3\u679C\uFF0C\u4F1A\u4FDD\u7559\u83DC\u5355\u539F\u6587\u5E76\u6309\u83DC\u5355\u81EA\u8EAB\u7684\u5206\u7C7B\u6216\u6807\u9898\u751F\u6210\u6807\u7B7E"
          : isUsingSampleMenu
            ? "\u5F53\u524D\u663E\u793A\u9ED1\u677F\u6D4B\u8BD5\u83DC\u5355\uFF0C\u70B9\u51FB\u53F3\u4E0A\u89D2\u5373\u53EF\u5BFC\u5165\u4EFB\u610F\u8BED\u8A00\u83DC\u5355\u56FE\u7247"
            : "\u5F53\u524D\u6CA1\u6709\u83DC\u5355\u3002\u70B9\u51FB\u53F3\u4E0A\u89D2\u53EF\u4EE5\u91CD\u65B0\u5BFC\u5165"}
      </div>

      {tabs.length > 0 ? (
        <div className="flex gap-3 overflow-x-auto px-6 pb-3">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`shrink-0 rounded-full border px-6 py-2 font-bold ${
                activeTab === tab
                  ? "border-[#8a4b12] bg-[#8a4b12] text-white"
                  : "border-[#dfc59f] bg-white/70 text-[#5b3315]"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-5 pb-24">
        {list.length === 0 ? (
          <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-center text-[#8c6d53]">
            <div className="mb-3 text-lg font-bold">
              {"\u5F53\u524D\u6CA1\u6709\u83DC\u5355"}
            </div>
            <button
              onClick={onPickImages}
              className="rounded-full bg-[#8a4b12] px-5 py-3 text-sm font-bold text-white"
            >
              {"\u4E0A\u4F20\u65B0\u83DC\u5355"}
            </button>
          </div>
        ) : list.map((item) => {
          const isOrderable = item.price > 0;
          return (
            <div
              key={item.id}
              className="flex items-center gap-3 border-b border-[#ead7bf] py-3"
            >
                <FoodImage
                  title={item.chineseName}
                  photoUrl={item.photoUrl}
                  color={item.color}
                  imageGenerationEnabled={imageGenerationEnabled}
                  isGenerating={Boolean(generatingImageIds[item.id])}
                  onClick={() => onGenerateImage(item)}
                />

                <DishText item={item} />

              <div className="flex flex-col items-end gap-2">
                <div className="text-lg font-bold">{formatMoney(item.price, item.currency)}</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => speakText(item.sourceText, item.langCode)}
                    className="flex h-9 w-9 items-center justify-center rounded-full border border-[#d9b98b] bg-white"
                  >
                    <Volume2 size={16} />
                  </button>

                  {isOrderable ? (
                    <>
                      {cart[item.id] ? (
                        <button
                          onClick={() => minus(item.id)}
                          className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#d9b98b] bg-white"
                        >
                          <Minus size={17} />
                        </button>
                      ) : null}

                      {cart[item.id] ? (
                        <span className="w-4 text-center font-black">{cart[item.id]}</span>
                      ) : null}

                      <button
                        onClick={() => add(item.id)}
                        className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#d9b98b] bg-white"
                      >
                        <Plus size={18} />
                      </button>
                    </>
                  ) : (
                    <span className="rounded-full bg-[#f6ead8] px-3 py-2 text-xs font-bold text-[#8b5d2f]">
                      {"\u5907\u6CE8\u9879"}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <BottomNav
        page="menu"
        totalCount={totalCount}
        total={total}
        totalCurrency={totalCurrency}
        setPage={setPage}
      />
    </Page>
  );
}

function CartPage({
  cart,
  selected,
  add,
  minus,
  clearCart,
  total,
  totalCurrency,
  imageGenerationEnabled,
  setPage,
}: {
  cart: Record<string, number>;
  selected: MenuItem[];
  add: (id: string) => void;
  minus: (id: string) => void;
  clearCart: () => void;
  total: number;
  totalCurrency: string;
  imageGenerationEnabled: boolean;
  setPage: (page: AppPage) => void;
}) {
  return (
    <Page>
      <header className="flex items-center justify-between px-6 pb-4 pt-7">
        <button
          onClick={() => setPage("menu")}
          className="flex h-10 w-10 items-center justify-center rounded-full"
        >
          <ChevronLeft size={26} />
        </button>
        <div className="text-xl font-bold">
          {"\u5DF2\u70B9\u83DC / \u8D2D\u7269\u8F66"}
        </div>
        <button
          onClick={clearCart}
          className="flex h-10 w-10 items-center justify-center rounded-full"
        >
          <Trash2 size={22} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 pb-32">
        {selected.length === 0 ? (
          <div className="flex h-96 items-center justify-center text-[#9b7655]">
            {"\u8FD8\u6CA1\u6709\u70B9\u83DC"}
          </div>
        ) : (
          selected.map((item) => (
            <div
              key={item.id}
              className="mb-4 rounded-2xl border border-[#ead7bf] bg-white/70 p-3 shadow-sm"
            >
              <div className="flex gap-4">
                <FoodImage
                  title={item.chineseName}
                  photoUrl={item.photoUrl}
                  color={item.color}
                  imageGenerationEnabled={imageGenerationEnabled}
                  large
                />
                <div className="min-w-0 flex-1">
                  <DishText item={item} compact />
                  <div className="mt-2 text-right text-xl font-black">
                    {formatMoney(item.price, item.currency)}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-[#ead7bf] pt-3">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => minus(item.id)}
                    className="rounded-xl border border-[#d9b98b] bg-white px-3 py-2"
                  >
                    <Minus size={16} className="mx-auto" />
                  </button>
                  <span className="text-lg font-black">{cart[item.id]}</span>
                  <button
                    onClick={() => add(item.id)}
                    className="rounded-xl border border-[#d9b98b] bg-white px-3 py-2"
                  >
                    <Plus size={16} className="mx-auto" />
                  </button>
                </div>
                <div className="font-black">
                  {"\u5C0F\u8BA1"} {formatTotal(item.price * cart[item.id], item.currency)}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="absolute bottom-[86px] left-6 right-6 rounded-2xl border border-[#ead7bf] bg-white/90 p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-bold">{"\u5408\u8BA1"}</span>
          <span className="text-3xl font-black">{formatTotal(total, totalCurrency)}</span>
        </div>
        <button
          onClick={() => setPage("waiter")}
          className="h-16 w-full rounded-2xl bg-gradient-to-b from-[#9f5a18] to-[#72360d] text-2xl font-black text-white"
        >
          {"\u4E0B\u5355 / \u7ED9\u5E97\u5458\u770B"}
        </button>
      </div>

      <BottomNav
        page="cart"
        totalCount={selected.reduce((sum, item) => sum + (cart[item.id] || 0), 0)}
        total={total}
        totalCurrency={totalCurrency}
        setPage={setPage}
      />
    </Page>
  );
}

function WaiterPage({
  cart,
  selected,
  total,
  totalCurrency,
  imageGenerationEnabled,
  setPage,
}: {
  cart: Record<string, number>;
  selected: MenuItem[];
  total: number;
  totalCurrency: string;
  imageGenerationEnabled: boolean;
  setPage: (page: AppPage) => void;
}) {
  const sentence = "\u8FD9\u4E9B\u83DC\u8BF7\u5E2E\u6211\u4E0B\u5355";
  const sentenceSub = "\u670D\u52A1\u5458\u9875\u9762\u9ED8\u8BA4\u76F4\u63A5\u663E\u793A\u83DC\u5355\u539F\u6587";

  return (
    <Page>
      <header className="flex items-center justify-between px-6 pb-4 pt-7">
        <button
          onClick={() => setPage("cart")}
          className="flex h-10 w-10 items-center justify-center rounded-full"
        >
          <ChevronLeft size={26} />
        </button>
        <div className="text-xl font-bold">
          {"\u7ED9\u5E97\u5458\u770B / \u539F\u6587\u786E\u8BA4"}
        </div>
        <div className="w-10" />
      </header>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="rounded-3xl border border-[#ead7bf] bg-white p-6 shadow-lg">
          <div className="mb-1 text-center text-[30px] font-black text-[#2f1b10]">{sentence}</div>
          <div className="mb-6 text-center text-base font-semibold text-[#8b6549]">
            {sentenceSub}
          </div>
          <div className="border-t border-dashed border-[#d7b78c]" />

          {selected.length === 0 ? (
            <div className="py-14 text-center text-[#9b7655]">
              {"\u8D2D\u7269\u8F66\u8FD8\u662F\u7A7A\u7684"}
            </div>
          ) : (
            selected.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-4 border-b border-dashed border-[#d7b78c] py-5"
              >
                <FoodImage
                  title={item.chineseName}
                  photoUrl={item.photoUrl}
                  color={item.color}
                  imageGenerationEnabled={imageGenerationEnabled}
                />
                <DishText
                  item={item}
                  compact
                  primaryLanguage="source"
                  showOriginal={false}
                  showMeta={false}
                  showDesc={false}
                />
                <div className="text-3xl font-black">{"\u00D7"}{cart[item.id]}</div>
              </div>
            ))
          )}

          <div className="flex items-center justify-between pt-6">
            <div className="text-2xl font-black">{"\u5408\u8BA1"}</div>
            <div className="text-4xl font-black">{formatTotal(total, totalCurrency)}</div>
          </div>

          <button
            onClick={() => speakOrder(selected, cart)}
            className="mt-6 flex h-16 w-full items-center justify-center gap-3 rounded-2xl border border-[#d9b98b] bg-[#fff3df] text-2xl font-black text-[#6d3b12]"
          >
            <Volume2 size={32} /> {"\u64AD\u653E\u539F\u6587\u83DC\u540D"}
          </button>
        </div>
      </div>
    </Page>
  );
}

function BottomNav({
  page,
  totalCount,
  total,
  totalCurrency,
  setPage,
}: {
  page: AppPage;
  totalCount: number;
  total: number;
  totalCurrency: string;
  setPage: (page: AppPage) => void;
}) {
  return (
    <div className="absolute bottom-0 left-0 right-0 grid h-[82px] grid-cols-3 items-center border-t border-[#ead7bf] bg-[#fff8eb]/95 px-8">
      <button
        onClick={() => setPage("menu")}
        className={`flex flex-col items-center gap-1 ${
          page === "menu" ? "font-black text-[#78420f]" : "text-[#6d4d35]"
        }`}
      >
        <BookOpen size={28} />
        <span className="text-xs">{"\u83DC\u5355"}</span>
      </button>

      <button
        onClick={() => setPage("cart")}
        className={`relative flex flex-col items-center gap-1 ${
          page === "cart" ? "font-black text-[#78420f]" : "text-[#6d4d35]"
        }`}
      >
        <ShoppingCart size={30} />
        {totalCount > 0 && (
          <span className="absolute right-[23px] top-[-8px] flex h-6 w-6 items-center justify-center rounded-full bg-[#c93a2c] text-xs font-black text-white">
            {totalCount}
          </span>
        )}
        <span className="text-xs">
          {total > 0
            ? `\u8D2D\u7269\u8F66 \u00B7 ${formatTotal(total, totalCurrency)}`
            : "\u8D2D\u7269\u8F66"}
        </span>
      </button>

      <button
        onClick={() => setPage("waiter")}
        className={`flex flex-col items-center gap-1 ${
          page === "waiter" ? "font-black text-[#78420f]" : "text-[#6d4d35]"
        }`}
      >
        <UserRound size={28} />
        <span className="text-xs">{"\u5E97\u5458"}</span>
      </button>
    </div>
  );
}

function ScannerSheet({
  settings,
  hasRecognizedMenu,
  errorMessage,
  onClose,
  onSettingsChange,
  onPickImages,
  onClearRecognizedMenu,
  onClearAndPickImages,
}: {
  settings: Settings;
  hasRecognizedMenu: boolean;
  errorMessage: string;
  onClose: () => void;
  onSettingsChange: (patch: Partial<Settings>) => void;
  onPickImages: () => void;
  onClearRecognizedMenu: () => void;
  onClearAndPickImages: () => void;
}) {
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-[60] bg-[#3b2418]/30 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.div
        initial={{ y: 560 }}
        animate={{ y: 0 }}
        exit={{ y: 560 }}
        transition={{ type: "spring", damping: 26, stiffness: 220 }}
        className="absolute bottom-0 left-0 right-0 z-[61] rounded-t-[30px] border-t border-[#dfc59f] bg-[#fff8eb] px-6 pb-7 pt-5 shadow-2xl"
      >
        <div className="mb-5 flex items-center justify-between">
          <div>
            <div className="text-lg font-black">{"\u83DC\u5355\u8BC6\u522B\u8BBE\u7F6E"}</div>
            <div className="text-sm text-[#8c6d53]">
              {"\u73B0\u5DF2\u652F\u6301\u591A\u8BED\u8A00\u83DC\u5355\u8BC6\u522B\u4E0E\u4E2D\u6587\u6574\u7406"}
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/80"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <label className="block">
            <span className="mb-2 block text-sm font-bold text-[#6f4a2d]">
              SiliconFlow API Key
            </span>
            <input
              type="password"
              value={settings.apiKey}
              onChange={(event) => onSettingsChange({ apiKey: event.target.value })}
              placeholder="sk-..."
              className="w-full rounded-2xl border border-[#dfc59f] bg-white px-4 py-3 outline-none transition focus:border-[#9f5a18]"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-bold text-[#6f4a2d]">
              {"\u83DC\u5355\u6574\u7406\u6A21\u578B"}
            </span>
            <input
              type="text"
              value={settings.model}
              onChange={(event) => onSettingsChange({ model: event.target.value })}
              className="w-full rounded-2xl border border-[#dfc59f] bg-white px-4 py-3 outline-none transition focus:border-[#9f5a18]"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-bold text-[#6f4a2d]">
              {"\u89C6\u89C9 OCR \u6A21\u578B"}
            </span>
            <input
              type="text"
              value={settings.visionModel}
              onChange={(event) => onSettingsChange({ visionModel: event.target.value })}
              className="w-full rounded-2xl border border-[#dfc59f] bg-white px-4 py-3 outline-none transition focus:border-[#9f5a18]"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-bold text-[#6f4a2d]">
              {"\u83DC\u56FE\u751F\u6210\u6A21\u578B"}
            </span>
            <input
              type="text"
              value={settings.imageModel}
              onChange={(event) => onSettingsChange({ imageModel: event.target.value })}
              className="w-full rounded-2xl border border-[#dfc59f] bg-white px-4 py-3 outline-none transition focus:border-[#9f5a18]"
            />
          </label>

          <label className="flex items-center justify-between gap-4 rounded-2xl border border-[#dfc59f] bg-white px-4 py-3">
            <div>
              <div className="text-sm font-bold text-[#6f4a2d]">
                {"\u81EA\u52A8\u751F\u6210\u83DC\u56FE"}
              </div>
              <div className="text-xs text-[#8c6d53]">
                {"\u9ED8\u8BA4\u5173\u95ED\uFF0C\u907F\u514D\u9875\u9762\u6253\u5F00\u540E\u540E\u53F0\u81EA\u52A8\u6D88\u8017 API \u989D\u5EA6"}
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                onSettingsChange({
                  enableImageGeneration: !settings.enableImageGeneration,
                })
              }
              className={`relative h-8 w-14 rounded-full transition ${
                settings.enableImageGeneration ? "bg-[#8a4b12]" : "bg-[#d9c3aa]"
              }`}
            >
              <span
                className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition ${
                  settings.enableImageGeneration ? "left-7" : "left-1"
                }`}
              />
            </button>
          </label>

          <div className="rounded-2xl border border-dashed border-[#d8b890] bg-[#fff4e3] p-4 text-sm text-[#7b5434]">
            {settings.enableImageGeneration
              ? "\u5F53\u524D\u5DF2\u5F00\u542F\u83DC\u56FE\u751F\u6210\u3002\u65E0\u56FE\u83DC\u54C1\u4F1A\u5148\u663E\u793A\u5360\u4F4D\uFF0C\u540E\u53F0\u518D\u6309\u83DC\u540D\u751F\u6210\u793A\u610F\u56FE\u3002"
              : "\u5F53\u524D\u5DF2\u5173\u95ED\u81EA\u52A8\u751F\u56FE\u3002\u9875\u9762\u4F1A\u5148\u51FA\u6587\u5B57\u548C\u4EF7\u683C\uFF0C\u6CA1\u6709\u56FE\u7684\u83DC\u76F4\u63A5\u663E\u793A\u201C\u65E0\u56FE\u201D\uFF0C\u4E0D\u4F1A\u540E\u53F0\u81EA\u52A8\u6263\u8D39\u3002"}
          </div>

          {errorMessage ? (
            <div className="rounded-2xl bg-[#c34534]/10 px-4 py-3 text-sm text-[#9a1f1f]">
              {errorMessage}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={onPickImages}
              className="flex items-center justify-center gap-2 rounded-2xl bg-[#7d4513] px-4 py-4 font-bold text-white"
            >
              <Upload size={18} />
              {"\u4E0A\u4F20\u83DC\u5355\u56FE\u7247"}
            </button>
            <button
              onClick={onPickImages}
              className="flex items-center justify-center gap-2 rounded-2xl border border-[#d9b98b] bg-white px-4 py-4 font-bold text-[#6a3b12]"
            >
              <ImagePlus size={18} />
              {"\u7EE7\u7EED\u8BC6\u522B"}
            </button>
          </div>

          {hasRecognizedMenu ? (
            <button
              onClick={onClearAndPickImages}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[#e2c5a0] bg-[#fff8ef] px-4 py-4 font-bold text-[#8a4b12]"
            >
              <Trash2 size={18} />
              {"\u6E05\u7A7A\u5F53\u524D\u83DC\u5355\u5E76\u91CD\u65B0\u5BFC\u5165"}
            </button>
          ) : null}

          {hasRecognizedMenu ? (
            <button
              onClick={onClearRecognizedMenu}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-3 text-sm font-bold text-[#8a6441]"
            >
              <Trash2 size={16} />
              {"\u53EA\u6E05\u7A7A\u5F53\u524D\u83DC\u5355"}
            </button>
          ) : null}
        </div>
      </motion.div>
    </>
  );
}
