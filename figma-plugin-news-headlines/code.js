figma.showUI(__html__, { width: 540, height: 720 });

const PLACEHOLDER_RE = /^Новость\s*(\d+)/i;
const CACHE_KEY = "news-headlines-cache";

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === "REQUEST_PLACEHOLDERS") {
      const page = findTargetPage(msg.pageName);
      const snapshot = collectPlaceholderSnapshot(page);
      figma.ui.postMessage({ type: "PLACEHOLDER_INFO", snapshot });
      return;
    }

    if (msg.type === "APPLY" && msg.payload) {
      const result = await handleApply(msg.payload);
      figma.ui.postMessage(
        Object.assign(
          {
            type: "RESULT",
          },
          result
        )
      );
      return;
    }

    if (msg.type === "PREVIEW" && msg.payload) {
      const result = await handlePreview(msg.payload);
      figma.ui.postMessage(
        Object.assign(
          {
            type: "PREVIEW_RESULT",
          },
          result
        )
      );
      return;
    }

    if (msg.type === "CLOSE") {
      figma.closePlugin();
      return;
    }
  } catch (err) {
    const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
    figma.ui.postMessage({ type: "RESULT", ok: false, message: `Ошибка: ${message}` });
  }
};

async function handleApply(payload) {
  const {
    sourceType,
    manualText,
    sourceUrl,
    trimLines,
    skipEmpty,
    prefix,
    suffix,
    pageName,
    mapping,
    renameMode,
    renamePattern,
  } = payload;

  const page = findTargetPage(pageName);
  const placeholders = collectNewsTextNodes(page);
  const nodes = toNodeInfos(placeholders);

  if (!nodes.length) {
    return { ok: false, message: "Не нашёл слоёв с именем «Новость N» на целевой странице." };
  }

  const { lines, sourceLabel } = await resolveLines({ sourceType, manualText, sourceUrl });
  const cleanLines = sanitizeLines(lines, trimLines, skipEmpty);

  if (!cleanLines.length) {
    return { ok: false, message: "Пустой список заголовков. Проверь источник или ввод." };
  }

  const occupied = new Set(nodes.map((n) => n.normalized).filter((v) => v.length));
  const preparedLines = buildPreparedLines(
    cleanLines,
    typeof prefix === "string" ? prefix : "",
    typeof suffix === "string" ? suffix : "",
    occupied
  );

  if (!preparedLines.length) {
    return { ok: false, message: "Все заголовки уже присутствуют. Новых строк не нашёл." };
  }

  let changed = 0;
  if (mapping === "byOrder") {
    changed = await replaceByOrder(nodes, preparedLines, renameMode, renamePattern, occupied);
  } else {
    changed = await replaceByNumber(nodes, preparedLines, renameMode, renamePattern, occupied);
  }

  saveCacheSafe({
    sourceType,
    manualText,
    sourceUrl,
    prefix,
    suffix,
    pageName,
    mapping,
    renameMode,
    renamePattern,
    trimLines,
    skipEmpty,
    lines: cleanLines,
  });

  const updatedSnapshot = collectPlaceholderSnapshot(page);
  return {
    ok: changed > 0,
    message: changed
      ? `Готово: добавлено ${changed} заголовков из ${preparedLines.length} (источник: ${sourceLabel}).`
      : "Не удалось применить новые заголовки.",
    stats: {
      placeholders: nodes.length,
      applied: changed,
      available: preparedLines.length,
    },
    snapshot: updatedSnapshot,
  };
}

async function handlePreview(payload) {
  const {
    sourceType,
    manualText,
    sourceUrl,
    trimLines,
    skipEmpty,
    prefix,
    suffix,
    pageName,
  } = payload;

  const page = findTargetPage(pageName);
  const placeholders = collectNewsTextNodes(page);
  const nodes = toNodeInfos(placeholders);

  const { lines, sourceLabel } = await resolveLines({ sourceType, manualText, sourceUrl });
  const cleanLines = sanitizeLines(lines, trimLines, skipEmpty);

  if (!cleanLines.length) {
    return { ok: false, message: "Пустой список заголовков. Проверь источник или ввод." };
  }

  const occupied = new Set(nodes.map((n) => n.normalized).filter((v) => v.length));
  const preparedLines = buildPreparedLines(
    cleanLines,
    typeof prefix === "string" ? prefix : "",
    typeof suffix === "string" ? suffix : "",
    occupied
  );

  return {
    ok: true,
    message: preparedLines.length
      ? `Найдено ${preparedLines.length} новых заголовков (исключены дубли в макете).`
      : "Все строки уже присутствуют в макете.",
    preview: preparedLines.slice(0, 200).map((l) => l.text),
    counts: {
      incoming: cleanLines.length,
      unique: preparedLines.length,
      placeholders: nodes.length,
    },
    snapshot: collectPlaceholderSnapshot(page),
    sourceLabel,
  };
}

function findTargetPage(pageName) {
  if (pageName && pageName.trim().length) {
    const page = figma.root.children.find((p) => p.name === pageName.trim());
    if (page) return page;
  }
  return figma.currentPage;
}

function collectNewsTextNodes(page) {
  const result = [];
  function walk(node) {
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
    if (node.type === "TEXT" && PLACEHOLDER_RE.test(node.name)) {
      result.push(node);
    }
  }
  for (const child of page.children) walk(child);
  return result;
}

function collectPlaceholderSnapshot(page) {
  const nodes = collectNewsTextNodes(page);
  const infos = toNodeInfos(nodes);
  const sample = infos
    .slice(0, 8)
    .map((n) => `${n.idx}: ${truncate(n.node.characters, 64)}`);
  return {
    count: infos.length,
    sample,
    page: page.name,
  };
}

function toNodeInfos(nodes) {
  const result = [];
  for (const node of nodes) {
    const idx = extractIndexFromName(node.name);
    if (!idx) continue;
    result.push({
      node,
      idx,
      normalized: normalizeText(node.characters),
    });
  }
  return result;
}

function extractIndexFromName(name) {
  const match = name.match(PLACEHOLDER_RE);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return Number.isFinite(num) ? num : null;
}

function sanitizeLines(lines, trim, skipEmpty) {
  let arr = trim ? lines.map((l) => l.trim()) : lines.slice();
  if (skipEmpty) arr = arr.filter((l) => l.length > 0);
  return arr;
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function buildPreparedLines(lines, prefix, suffix, occupied) {
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const text = `${prefix}${line}${suffix}`;
    const normalized = normalizeText(text);
    if (!normalized.length) continue;
    if (seen.has(normalized)) continue;
    if (occupied.has(normalized)) continue;
    seen.add(normalized);
    out.push({ text, normalized });
  }
  return out;
}

async function loadAllFontsFor(node) {
  const len = node.characters.length;
  if (len === 0) {
    if (node.fontName !== figma.mixed && node.fontName) {
      await figma.loadFontAsync(node.fontName);
    }
    return;
  }
  const fonts = node.getRangeAllFontNames(0, len);
  for (const font of fonts) {
    await figma.loadFontAsync(font);
  }
}

async function applyTextToNode(info, text, renameMode, renamePattern) {
  await loadAllFontsFor(info.node);
  info.node.characters = text;
  const newName = buildNewName(renameMode, renamePattern, info.idx, text);
  if (newName) info.node.name = newName;
  info.normalized = normalizeText(text);
}

function buildNewName(renameMode, pattern, idx, text) {
  if (renameMode === "none") return null;
  if (renameMode === "toText") return text;
  const tpl = pattern && pattern.length ? pattern : "Заголовок {n}";
  return tpl.split("{n}").join(String(idx)).split("{text}").join(text);
}

async function replaceByNumber(nodes, lines, renameMode, renamePattern, occupied) {
  if (!nodes.length || !lines.length) return 0;
  const sorted = nodes.slice().sort((a, b) => a.idx - b.idx);
  const byIndex = new Map();
  for (const info of sorted) byIndex.set(info.idx, info);

  const used = new Set();
  let changed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const preferredIdx = i + 1;
    let candidate = byIndex.get(preferredIdx) || null;

    if (candidate) {
      if (used.has(candidate.idx)) candidate = null;
      if (candidate && candidate.normalized === line.normalized) candidate = null;
    }

    if (!candidate) {
      for (const info of sorted) {
        if (used.has(info.idx)) continue;
        if (info.normalized === line.normalized) continue;
        candidate = info;
        break;
      }
    }

    if (!candidate) continue;

    await applyTextToNode(candidate, line.text, renameMode, renamePattern);
    occupied.add(line.normalized);
    used.add(candidate.idx);
    changed++;
  }
  return changed;
}

async function replaceByOrder(nodes, lines, renameMode, renamePattern, occupied) {
  if (!nodes.length || !lines.length) return 0;
  const sorted = nodes.slice().sort((a, b) => a.idx - b.idx);
  let changed = 0;
  let lineIndex = 0;

  for (const info of sorted) {
    if (lineIndex >= lines.length) break;
    const line = lines[lineIndex];
    if (info.normalized === line.normalized) {
      lineIndex++;
      continue;
    }
    await applyTextToNode(info, line.text, renameMode, renamePattern);
    occupied.add(line.normalized);
    lineIndex++;
    changed++;
  }
  return changed;
}

async function resolveLines({ sourceType, manualText, sourceUrl }) {
  if (sourceType === "url") {
    if (!sourceUrl || !sourceUrl.trim()) {
      throw new Error("Не указан URL источника.");
    }
    const finalUrl = normalizeFetchUrl(sourceUrl);
    const res = await fetch(finalUrl, { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`Источник вернул ${res.status}: ${res.statusText}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = await res.json();
      const parsed = extractLinesFromJson(json);
      if (parsed.length) {
        return { lines: parsed, sourceLabel: sourceUrl };
      }
    }
    const text = await res.text();
    return { lines: extractLinesFromText(text), sourceLabel: sourceUrl };
  }

  if (!manualText || !manualText.length) {
    throw new Error("Вставьте заголовки в поле ввода.");
  }

  return { lines: extractLinesFromText(manualText), sourceLabel: "ручной ввод" };
}

function normalizeFetchUrl(input) {
  let url = (input || "").trim();
  if (!/^https?:\/\//i.test(url) && /^localhost[:/]/i.test(url)) {
    url = "http://" + url.replace(/^\/+/, "");
  }
  try {
    const u = new URL(url);
    const param = u.searchParams.get("url");
    if (param) {
      // гарантируем корректное кодирование вложенного URL
      const decoded = decodeURIComponentSafe(param);
      u.searchParams.set("url", encodeURIComponent(decoded));
    }
    return u.toString();
  } catch (e) {
    return url;
  }
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function extractLinesFromJson(json) {
  if (Array.isArray(json)) {
    return json.map(normalizeToString).filter((v) => v.length);
  }

  if (json && typeof json === "object") {
    const candidateKeys = ["headlines", "items", "data", "results", "articles", "titles"];
    for (const key of candidateKeys) {
      if (Array.isArray(json[key])) {
        return json[key].map(normalizeToString).filter((v) => v.length);
      }
    }
  }

  return [];
}

function normalizeToString(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    if ("title" in value && typeof value.title === "string") return value.title.trim();
    if ("name" in value && typeof value.name === "string") return value.name.trim();
  }
  return "";
}

function extractLinesFromText(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim());
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

async function loadCacheSafe() {
  try {
    const cached = await figma.clientStorage.getAsync(CACHE_KEY);
    return cached || null;
  } catch (e) {
    return null;
  }
}

function saveCacheSafe(data) {
  const payload = Object.assign(
    {
      savedAt: Date.now(),
    },
    data
  );
  figma.clientStorage.setAsync(CACHE_KEY, payload).catch(() => {});
}

// Send initial snapshot to UI on startup
figma.once("run", async () => {
  const snapshot = collectPlaceholderSnapshot(figma.currentPage);
  figma.ui.postMessage({ type: "PLACEHOLDER_INFO", snapshot });
  const cached = await loadCacheSafe();
  if (cached) {
    figma.ui.postMessage({ type: "CACHE", cache: cached });
  }
});
