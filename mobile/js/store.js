// 本机存储：设置（含 API Key）放 localStorage；资料库和会议记录放 IndexedDB。
// 所有数据只在这部手机的浏览器里，不会上传到任何服务器（调用各家 API 时除外）。

export const DEFAULTS = {
  sonioxKey: "",
  translate: "two_way",       // two_way（中英互译）| to_zh | to_en | off
  showTranslation: true,
  terms: "",                  // 专有名词，逗号分隔
  contextText: "",

  answerProvider: "claude",   // claude | openai | deepseek
  claudeKey: "", claudeModel: "claude-sonnet-5-5", claudeFast: "claude-haiku-5-5",
  openaiKey: "", openaiModel: "gpt-5.4-mini",
  deepseekKey: "", deepseekModel: "deepseek-flash",

  intentProvider: "llm",      // llm | jev | rules
  jevKey: "", jevUrl: "https://jevmodel.org/v1/systemone", jevModel: "jev-latest", jevThreshold: 0.6,

  summaryLang: "zh",          // zh | en | both
  autoStopMin: 10,
  settleMs: 1200,
  answerOthersOnly: true,
};

const KEY = "mc.settings.v1";

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || "{}")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 隐私模式等情况下存不了，只在本次有效 */ }
}

// ---------------- IndexedDB ----------------
const DB_NAME = "meeting-copilot";
let dbp = null;
const mem = { docs: new Map(), meetings: new Map() }; // IndexedDB 不可用时的兜底（只在本次有效）

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meetings")) db.createObjectStore("meetings", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function getAll(store) {
  const db = await open();
  if (!db) return [...mem[store].values()];
  return tx(store, "readonly", s => reqP(s.getAll()));
}

export async function get(store, id) {
  const db = await open();
  if (!db) return mem[store].get(id);
  return tx(store, "readonly", s => reqP(s.get(id)));
}

export async function put(store, obj) {
  const db = await open();
  if (!db) { mem[store].set(obj.id, structuredClone(obj)); return; }
  return tx(store, "readwrite", s => reqP(s.put(obj)));
}

export async function del(store, id) {
  const db = await open();
  if (!db) { mem[store].delete(id); return; }
  return tx(store, "readwrite", s => reqP(s.delete(id)));
}

export async function clearAll() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  const db = await open();
  if (!db) { mem.docs.clear(); mem.meetings.clear(); return; }
  await tx("docs", "readwrite", s => reqP(s.clear()));
  await tx("meetings", "readwrite", s => reqP(s.clear()));
}
