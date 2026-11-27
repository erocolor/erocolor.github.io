/**
 * 本地语C剧场 · 纯静态核心引擎 (engine.js)
 * 1:1 移植 affection.py / config_store.py / llm_service.py / session_store.py / settlement.py
 */

const AFFECTION_MIN = -100;
const AFFECTION_MAX = 100;
const AUTO_SETTLE_ROUNDS = 20;
const ANALYZE_CHUNK_MESSAGES = 8;
const MAX_MESSAGES = 120;
const MODEL_NAME_DEFAULT = "deepseek-chat";
const API_URL_DEFAULT = "https://api.deepseek.com/v1/chat/completions";

const STATE_BLOCK_START = "【当前状态】";
const STATE_BLOCK_END = "【/当前状态】";

const LS_KEYS = {
  API_CONFIG: "yc_py_static_api_config_v1",
  EXTENSIONS: "yc_py_static_extensions_v1",
  CHARACTERS: "yc_py_static_characters_v1",
  SESSIONS: "yc_py_static_sessions_v1",
  ARCHIVES: "yc_py_static_archives_v1"
};

/* ==================== 1. 好感度阶梯与双轨联动 (affection.py) ==================== */

const AFFECTION_TIERS = [
  {
    min: -100,
    max: -60,
    stage: "厌恶敌对 / 彻底疏离",
    track_a: "负面评价固着，质疑与否定为主",
    track_b: "高度戒备排斥，拒绝深入接触",
    mask_integrity: "冷硬防御假面（或懒于维持客套）",
    tendency: "言语冷淡简短或带有明显锋芒与边界感，主动回避独处、试探与肢体接触，对示好持怀疑或冷处理，不展露脆弱面。"
  },
  {
    min: -59,
    max: -20,
    stage: "抵触冷淡 / 芥蒂未消",
    track_a: "心存芥蒂，对言行持怀疑或保留态度",
    track_b: "刻意保持距离，不愿交付信任",
    mask_integrity: "礼貌疏离的社交防线",
    tendency: "回复偏简短克制，客套中带疏离感，保持安全心理与物理边界，仅维持必要沟通，对越界试探容易起防备。"
  },
  {
    min: -19,
    max: 9,
    stage: "初识观望 / 客套试探",
    track_a: "初识观察中",
    track_b: "防备与客套并存",
    mask_integrity: "完整",
    tendency: "礼貌得体但分寸明确，遵循固有社交习惯与面具，会暗中观察对方但不过度投入，不轻易交付隐私或情绪底牌。"
  },
  {
    min: 10,
    max: 29,
    stage: "熟络友善 / 初步认可",
    track_a: "初步认可对方的分寸与某些闪光点",
    track_b: "警惕有所松动，愿意进行日常交流",
    mask_integrity: "基本完整，偶有自然流露",
    tendency: "语气比初识柔和自然，愿意接话并延续日常话题，可接受轻度玩笑，但仍会守住核心隐私与心理防线。"
  },
  {
    min: 30,
    max: 54,
    stage: "好感升温 / 信赖渐生",
    track_a: "欣赏与认同度上升，乐于倾听对方看法",
    track_b: "建立起稳定信任感，开始在意对方反应",
    mask_integrity: "出现松动，愿意流露部分真实情绪",
    tendency: "交流更主动细腻，会留意并回应对方情绪，允许适当靠近与熟稔打趣，面具之下偶尔透出真实想法或偏心。"
  },
  {
    min: 55,
    max: 79,
    stage: "亲密依恋 / 心意偏向",
    track_a: "深度欣赏与偏爱，视为重要而特别的存在",
    track_b: "高度信任与情感依恋，面对对方容易心软",
    mask_integrity: "显著软化，仅在敏感时刻保留少许掩饰",
    tendency: "带有明确偏爱、耐心与专属感，言行中自然透出关心、在意、轻度吃味或别扭（依性格而定），能接纳亲昵举动并愿分享心事。"
  },
  {
    min: 80,
    max: 100,
    stage: "深情羁绊 / 毫无保留",
    track_a: "毫无保留的欣赏、偏袒与精神共鸣",
    track_b: "深度依恋与托付感，视作无可替代的归属",
    mask_integrity: "近乎卸下，坦诚展现真实自我",
    tendency: "情感浓度饱满自然，言语与举动带有高度默契、依恋感与偏袒/保护欲（仍受原有人格底色制约，不可OOC），几乎不再设防。"
  }
];

function safeInt(val, def = 0) {
  if (val === null || val === undefined || typeof val === "boolean") return def;
  if (typeof val === "number") return Number.isFinite(val) ? Math.trunc(val) : def;
  const s = String(val).trim();
  if (!s) return def;
  const n = Number(s);
  if (Number.isFinite(n)) return Math.trunc(n);
  const m = s.match(/[+-]?\d+/);
  return m ? parseInt(m[0], 10) : def;
}

function clampAffection(val) {
  return Math.max(AFFECTION_MIN, Math.min(AFFECTION_MAX, safeInt(val, 0)));
}

function getAffectionTier(affection) {
  const aff = clampAffection(affection);
  for (const tier of AFFECTION_TIERS) {
    if (tier.min <= aff && aff <= tier.max) return tier;
  }
  return AFFECTION_TIERS[2];
}

function _hasNegativeSentiment(text) {
  const keys = ["厌恶", "敌意", "排斥", "戒备", "抵触", "芥蒂", "怀疑", "疏离", "冷硬", "否定", "拒绝"];
  return keys.some(k => text.includes(k));
}

function _hasPositiveIntimacy(text) {
  const negs = ["不", "无", "缺", "拒绝", "怀疑", "防备", "戒备"];
  if (negs.some(neg => text.includes(neg))) return false;
  const keys = ["稳定信任", "高度信任", "深度依恋", "情感依恋", "深度欣赏", "偏爱", "偏袒", "托付", "归属", "亲密", "深爱"];
  return keys.some(k => text.includes(k));
}

function reconcileStateLinkage(state, customTendency = "", forceTierTracks = false) {
  const aff = clampAffection(state.affection ?? 0);
  state.affection = aff;
  const tier = getAffectionTier(aff);
  state.relationship_stage = tier.stage;

  if (forceTierTracks) {
    state.track_a = tier.track_a;
    state.track_b = tier.track_b;
    state.mask_integrity = tier.mask_integrity;
    state.behavior_tendency = tier.tendency;
    return;
  }

  let ta = String(state.track_a || "").trim() || tier.track_a;
  let tb = String(state.track_b || "").trim() || tier.track_b;
  let mask = String(state.mask_integrity || "").trim() || tier.mask_integrity;

  if (aff >= 30) {
    if (ta === "初识观察中" || _hasNegativeSentiment(ta)) ta = tier.track_a;
    if (tb === "防备与客套并存" || _hasNegativeSentiment(tb)) tb = tier.track_b;
  }
  if (aff >= 55 && mask === "完整") {
    mask = tier.mask_integrity;
  }

  if (aff <= -20) {
    if (ta === "初识观察中" || _hasPositiveIntimacy(ta)) ta = tier.track_a;
    if (tb === "防备与客套并存" || _hasPositiveIntimacy(tb)) tb = tier.track_b;
    if (["卸下", "毫无保留", "显著软化"].some(k => mask.includes(k))) {
      mask = tier.mask_integrity;
    }
  }

  state.track_a = ta;
  state.track_b = tb;
  state.mask_integrity = mask;

  let tendency = String(customTendency || "").trim() || String(state.behavior_tendency || "").trim();
  if (!tendency) tendency = tier.tendency;
  state.behavior_tendency = tendency.slice(0, 200);
}

function clampChunkDelta(rawDelta, majorTurningPoint) {
  const limit = majorTurningPoint ? 5 : 3;
  return Math.max(-limit, Math.min(limit, safeInt(rawDelta, 0)));
}

function applySettlementAntiSpike(totalRawDelta, currentAffection, newRounds, anyMajorTurningPoint) {
  let delta = safeInt(totalRawDelta, 0);
  if (delta === 0) return 0;

  const baseAff = clampAffection(currentAffection);
  let cap = 8;
  if (newRounds <= 1) cap = anyMajorTurningPoint ? 3 : 2;
  else if (newRounds <= 3) cap = anyMajorTurningPoint ? 4 : 3;
  else if (newRounds <= 6) cap = anyMajorTurningPoint ? 5 : 4;
  else if (newRounds <= 12) cap = 6;

  delta = Math.max(-cap, Math.min(cap, delta));

  if (delta > 0) {
    if (baseAff >= 90) delta = Math.min(delta, newRounds <= 6 ? 1 : 2);
    else if (baseAff >= 75) delta = Math.max(1, Math.trunc(delta / 2));
    else if (baseAff <= -25) delta = Math.min(delta, newRounds <= 6 ? 2 : 3);
  } else if (delta < 0) {
    if (baseAff <= -85) delta = Math.max(delta, newRounds <= 6 ? -1 : -2);
    else if (baseAff <= -60) delta = Math.min(-1, -Math.trunc((-delta) / 2));
    else if (baseAff >= 65 && !anyMajorTurningPoint) delta = Math.max(delta, -2);
  }

  const finalAff = clampAffection(baseAff + delta);
  return finalAff - baseAff;
}

/* ==================== 2. 配置、文本清洗与扩展模块 (config_store.py) ==================== */

const DEFAULT_PRESETS = [
  {
    id: "preset_default_rp",
    name: "默认剧场演绎",
    system_prefix: "你是沉浸式语C剧场角色扮演引擎。严格遵循当前角色设定、场景状态、双轨关系与当前生效的玩家身份卡。",
    system_suffix: "输出保持细腻、有画面感与角色张力，支持 {{...}} 括号独白或动作描写。",
    temperature: 0.85,
    max_tokens: 4096,
    context_turns: 24,
    inject_worldbook: true,
    inject_persona: true
  },
  {
    id: "preset_slow_burn",
    name: "细腻慢热推进",
    system_prefix: "注重情绪铺垫、微表情、试探与环境细节，避免剧情跳步或突兀转折。",
    system_suffix: "先描写感官与氛围变化，再自然推进对话与互动。",
    temperature: 0.75,
    max_tokens: 4096,
    context_turns: 28,
    inject_worldbook: true,
    inject_persona: true
  },
  {
    id: "preset_high_tension",
    name: "强张力对峙",
    system_prefix: "强化冲突、潜台词、心理博弈与情绪反差，每轮回应都有明确推进。",
    system_suffix: "保持句式紧凑有力，凸显角色防备、试探或情绪失控瞬间。",
    temperature: 0.92,
    max_tokens: 4096,
    context_turns: 20,
    inject_worldbook: true,
    inject_persona: true
  }
];

const DEFAULT_PERSONAS = [
  {
    id: "persona_default",
    name: "默认玩家身份",
    title: "剧中人",
    appearance: "",
    background: "",
    personality: "",
    notes: ""
  }
];

const DEFAULT_WORLD_ENTRIES = [
  {
    id: "wb_sample_1",
    title: "雨夜与旧书店设定示例",
    keys: ["雨", "书店", "旧书", "深夜"],
    content: "当场景涉及雨夜或书店时，空气中常带着潮湿纸张、旧木头与微苦咖啡的气息，适合展开低声交谈与试探。",
    enabled: true,
    constant: false,
    order: 100
  }
];

function escapeRegexStr(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanReplyText(text) {
  let s = String(text || "").trim();
  if (!s) return "";
  const re = new RegExp(`${escapeRegexStr(STATE_BLOCK_START)}[\\s\\S]*?${escapeRegexStr(STATE_BLOCK_END)}`, "g");
  s = s.replace(re, "");
  return s.trim();
}

function stripStateBlock(text) {
  let s = String(text || "");
  const re = new RegExp(`\\n?${escapeRegexStr(STATE_BLOCK_START)}[\\s\\S]*?${escapeRegexStr(STATE_BLOCK_END)}`, "g");
  s = s.replace(re, "");
  return s.trim();
}

function sanitizeBlackboxForAnalyzer(text) {
  return String(text || "").replace(/\{\{[\s\S]*?\}\}/g, "【黑箱内容：仅玩家内心活动，角色完全不可知】");
}

function extractJsonObject(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const cleaned = s.replace(/^```(?:json)?|```$/gm, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch (_) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch (_) {
      return null;
    }
  }
  return null;
}

function formatNowStr(dateObj = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}:${pad(dateObj.getSeconds())}`;
}

function formatHM(dateObj = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
}

function loadApiConfigStore() {
  const cfg = {
    key: "",
    url: API_URL_DEFAULT,
    model: MODEL_NAME_DEFAULT,
    temperature: 0.85,
    maxTokens: 4096
  };
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEYS.API_CONFIG) || "null");
    if (saved && typeof saved === "object") {
      for (const k of ["key", "url", "model", "temperature", "maxTokens"]) {
        if (saved[k] !== null && saved[k] !== undefined && saved[k] !== "") {
          cfg[k] = saved[k];
        }
      }
    }
  } catch (_) {}
  if (!cfg.url) cfg.url = API_URL_DEFAULT;
  if (!cfg.model) cfg.model = MODEL_NAME_DEFAULT;
  return cfg;
}

function saveApiConfigStore(newCfg) {
  const cur = loadApiConfigStore();
  if (newCfg && typeof newCfg === "object") {
    for (const k of ["key", "url", "model", "temperature", "maxTokens"]) {
      if (k in newCfg && newCfg[k] !== null && newCfg[k] !== undefined) {
        cur[k] = newCfg[k];
      }
    }
  }
  localStorage.setItem(LS_KEYS.API_CONFIG, JSON.stringify(cur));
  return cur;
}

function defaultExtensionsData() {
  return {
    active_persona_id: DEFAULT_PERSONAS[0].id,
    personas: JSON.parse(JSON.stringify(DEFAULT_PERSONAS)),
    active_preset_id: DEFAULT_PRESETS[0].id,
    presets: JSON.parse(JSON.stringify(DEFAULT_PRESETS)),
    world_entries: JSON.parse(JSON.stringify(DEFAULT_WORLD_ENTRIES))
  };
}

function loadExtensionsStore() {
  const base = defaultExtensionsData();
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEYS.EXTENSIONS) || "null");
    if (!raw || typeof raw !== "object") {
      saveExtensionsStore(base);
      return base;
    }
    const personas = Array.isArray(raw.personas) && raw.personas.length ? raw.personas : base.personas;
    const presets = Array.isArray(raw.presets) && raw.presets.length ? raw.presets : base.presets;
    const world_entries = Array.isArray(raw.world_entries) ? raw.world_entries : base.world_entries;

    let active_persona_id = String(raw.active_persona_id || personas[0].id);
    if (!personas.some(p => String(p.id) === active_persona_id)) active_persona_id = String(personas[0].id);

    let active_preset_id = String(raw.active_preset_id || presets[0].id);
    if (!presets.some(pr => String(pr.id) === active_preset_id)) active_preset_id = String(presets[0].id);

    return { active_persona_id, personas, active_preset_id, presets, world_entries };
  } catch (_) {
    saveExtensionsStore(base);
    return base;
  }
}

function saveExtensionsStore(data) {
  localStorage.setItem(LS_KEYS.EXTENSIONS, JSON.stringify(data));
  return data;
}

function getActivePersonaStore(extData = null) {
  const data = extData || loadExtensionsStore();
  const pid = data.active_persona_id;
  return (data.personas || []).find(p => String(p.id) === String(pid)) || (data.personas || DEFAULT_PERSONAS)[0];
}

function getActivePresetStore(extData = null) {
  const data = extData || loadExtensionsStore();
  const prid = data.active_preset_id;
  return (data.presets || []).find(pr => String(pr.id) === String(prid)) || (data.presets || DEFAULT_PRESETS)[0];
}

function matchWorldEntries(extData, recentTexts) {
  const entries = extData.world_entries || [];
  const haystack = (recentTexts || []).map(t => String(t || "")).join("\n").toLowerCase();
  const matched = [];

  for (const item of entries) {
    if (item.enabled === false) continue;
    const isConstant = Boolean(item.constant);
    const rawKeys = item.keys || [];
    let keys = [];
    if (typeof rawKeys === "string") {
      keys = rawKeys.split(/[,，、;；\s]+/).map(k => k.trim().toLowerCase()).filter(Boolean);
    } else if (Array.isArray(rawKeys)) {
      keys = rawKeys.map(k => String(k).trim().toLowerCase()).filter(Boolean);
    }
    if (isConstant || keys.some(k => haystack.includes(k))) {
      matched.push(item);
    }
  }
  matched.sort((a, b) => safeInt(a.order ?? 100, 100) - safeInt(b.order ?? 100, 100));
  return matched;
}

function buildExtensionPromptBlocks(extData = null, recentTexts = []) {
  const data = extData || loadExtensionsStore();
  const persona = getActivePersonaStore(data);
  const preset = getActivePresetStore(data);

  const injectPersona = Boolean(preset.inject_persona ?? true);
  const injectWorld = Boolean(preset.inject_worldbook ?? true);

  let persona_block = "";
  if (injectPersona && persona) {
    const lines = [`姓名：${String(persona.name || "").trim() || "未命名玩家"}`];
    for (const [field, label] of [
      ["title", "身份定位"],
      ["appearance", "外貌特征"],
      ["personality", "性格气质"],
      ["background", "背景经历"],
      ["notes", "补充设定"]
    ]) {
      const val = String(persona[field] || "").trim();
      if (val) lines.push(`${label}：${val}`);
    }
    persona_block = "【当前玩家身份卡】\n" + lines.join("\n");
  }

  let world_block = "";
  let matched_world_entries = [];
  if (injectWorld) {
    matched_world_entries = matchWorldEntries(data, recentTexts);
    if (matched_world_entries.length) {
      const secList = [];
      matched_world_entries.forEach((entry, idx) => {
        const title = String(entry.title || `条目${idx + 1}`).trim();
        const content = String(entry.content || "").trim();
        if (content) secList.push(`[${idx + 1}] ${title}\n${content}`);
      });
      if (secList.length) {
        world_block = "【生效世界书设定】\n" + secList.join("\n\n");
      }
    }
  }

  return {
    persona,
    preset,
    matched_world_entries,
    persona_block,
    world_block,
    system_prefix: String(preset.system_prefix || "").trim(),
    system_suffix: String(preset.system_suffix || "").trim(),
    temperature: preset.temperature,
    max_tokens: preset.max_tokens,
    context_turns: safeInt(preset.context_turns ?? 24, 24)
  };
}

/* ==================== 3. LLM 请求调用 (llm_service.py) ==================== */

function resolveChatEndpoint(baseUrl) {
  const u = String(baseUrl || API_URL_DEFAULT).trim().replace(/\/+$/, "");
  if (u.endsWith("/chat/completions")) return u;
  if (u.endsWith("/v1")) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

async function callChatApi(messages, { apiCfg = null, temperature = null, maxTokens = null, jsonMode = false, timeout = 120000 } = {}) {
  const cfg = apiCfg || loadApiConfigStore();
  const apiKey = String(cfg.key || "").trim();
  if (!apiKey) {
    return [false, "尚未配置 API Key，请先在右上角或侧边栏打开「API 配置」设置。"];
  }

  const endpoint = resolveChatEndpoint(cfg.url || API_URL_DEFAULT);
  const model = String(cfg.model || MODEL_NAME_DEFAULT).trim() || MODEL_NAME_DEFAULT;
  const temp = temperature !== null && temperature !== undefined
    ? Number(temperature)
    : Number(cfg.temperature !== null && cfg.temperature !== undefined ? cfg.temperature : 0.85);
  const tokens = maxTokens !== null && maxTokens !== undefined
    ? safeInt(maxTokens, 4096)
    : safeInt(cfg.maxTokens ?? 4096, 4096);

  const payload = {
    model,
    messages,
    temperature: temp,
    max_tokens: tokens
  };
  if (jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);

    const raw = await resp.text();
    if (!resp.ok) {
      return [false, `API HTTP ${resp.status}: ${raw.slice(0, 300)}`];
    }
    const parsed = JSON.parse(raw);
    const choices = parsed.choices || [];
    if (!choices.length) return [false, "模型返回为空（choices 为空）"];
    const content = choices[0]?.message?.content;
    if (!content) return [false, "模型返回消息内容为空"];
    return [true, String(content).trim()];
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return [false, "请求超时，请检查网络或调大超时时间"];
    return [false, `请求异常: ${err.message || err}`];
  }
}

/* ==================== 4. 角色与会话管理 (session_store.py) ==================== */

function buildBaseSystemPrompt(charData) {
  if (String(charData.base_prompt || "").trim()) {
    return String(charData.base_prompt).trim();
  }
  const lines = [
    "你正在进行一场语C角色扮演。",
    `角色名：${String(charData.name || "").trim()}`
  ];
  for (const [field, label] of [
    ["title", "身份"],
    ["personality", "性格"],
    ["style", "说话风格"],
    ["rules", "规则"]
  ]) {
    const val = String(charData[field] || "").trim();
    if (val) lines.push(`${label}：${val}`);
  }
  return lines.join("\n");
}

function syncStateToSystemPrompt(messages, state, extraTexts = []) {
  reconcileStateLinkage(state);
  const ext = loadExtensionsStore();

  const recentTexts = [
    String(state.current_time || ""),
    String(state.scene || ""),
    String(state.track_a || ""),
    String(state.track_b || "")
  ];
  if (Array.isArray(extraTexts)) {
    extraTexts.forEach(t => recentTexts.push(String(t || "")));
  }
  for (const m of (messages || []).slice(-6)) {
    if (m && (m.role === "user" || m.role === "assistant")) {
      recentTexts.push(String(m.content || ""));
    }
  }

  const blocks = buildExtensionPromptBlocks(ext, recentTexts);
  if (!messages || !messages.length || messages[0].role !== "system") return blocks;

  const rawContent = String(messages[0].content || "");
  const preservedExtras = stripStateBlock(rawContent)
    .split("\n")
    .filter(line => line.startsWith("【重要记忆】：") || line.startsWith("【阶段摘要"));

  const stateBlock = [
    STATE_BLOCK_START,
    `当前时间：${state.current_time || "未设定时间"}`,
    `当前场景：${state.scene || "未知场景"}`,
    `参考好感度数值：${state.affection ?? 0}（硬性范围：-100~100，关系阶段：${state.relationship_stage || "初识观望 / 客套试探"}）`,
    `轨道A（欣赏与认可）：${state.track_a || "初识观察中"}`,
    `轨道B（情感信任与依恋）：${state.track_b || "防备与客套并存"}`,
    `面具完整度：${state.mask_integrity || "完整"}`,
    `当前行为倾向：${state.behavior_tendency || ""}`,
    "扮演约束：请严格贴合以上好感阶段、双轨描述与行为倾向把控语气、主动性与心理防线，严禁在对话中直接播报好感数值；玩家写在 {{...}} 里的内容属于绝对黑箱，角色完全不可知，扮演时严禁察觉、暗示或引用。",
    STATE_BLOCK_END
  ].join("\n");

  const sections = [];
  if (blocks.system_prefix) sections.push(blocks.system_prefix);

  const baseCore = stripStateBlock(rawContent);
  const coreLines = baseCore
    .split("\n")
    .filter(line =>
      !line.startsWith("【重要记忆】：") &&
      !line.startsWith("【阶段摘要") &&
      !line.startsWith("【当前玩家身份卡】") &&
      !line.startsWith("【生效世界书设定】")
    );
  const coreText = coreLines.join("\n").trim();
  if (coreText) sections.push(coreText);

  sections.push(stateBlock);
  if (blocks.persona_block) sections.push(blocks.persona_block);
  if (blocks.world_block) sections.push(blocks.world_block);
  if (preservedExtras.length) sections.push(preservedExtras.join("\n"));
  if (blocks.system_suffix) sections.push(blocks.system_suffix);

  messages[0].content = sections.filter(s => s.trim()).join("\n\n");
  return blocks;
}

function getDefaultCharactersMap() {
  const linwan = {
    id: "linwan.json",
    name: "林晚",
    title: "沉默寡言的旧书店店主",
    avatar: "",
    file: "linwan.json",
    default_state: {
      affection: 0,
      current_time: "傍晚 18:30",
      scene: "旧书店柜台后",
      track_a: "初识观察中",
      track_b: "防备与客套并存",
      mask_integrity: "完整"
    },
    base_prompt: [
      "你正在进行一场语C角色扮演。",
      "角色名：林晚",
      "身份：沉默寡言的旧书店店主",
      "性格：温和、慢热、偶尔冷幽默",
      "说话风格：简短自然，不说教，不替用户行动",
      "规则：只扮演林晚，用第一人称；根据场景与具体情况来判断每次回复字数；保持沉浸感。"
    ].join("\n")
  };
  reconcileStateLinkage(linwan.default_state);
  return { "linwan.json": linwan };
}

function loadCharactersStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEYS.CHARACTERS) || "null");
    if (raw && typeof raw === "object" && Object.keys(raw).length > 0) {
      for (const k of Object.keys(raw)) {
        if (raw[k]?.default_state) reconcileStateLinkage(raw[k].default_state);
      }
      return raw;
    }
  } catch (_) {}
  const def = getDefaultCharactersMap();
  localStorage.setItem(LS_KEYS.CHARACTERS, JSON.stringify(def));
  return def;
}

function saveCharactersStore(charsMap) {
  localStorage.setItem(LS_KEYS.CHARACTERS, JSON.stringify(charsMap));
}

function normalizeTimeBanners(rawBanners, maxDialogCount) {
  if (!Array.isArray(rawBanners)) return [];
  const normalized = [];
  rawBanners.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    let label = String(item.label || "").trim();
    const tStr = String(item.time || "").trim();
    const sStr = String(item.scene || "").trim();
    if (!label) label = `${tStr} · ${sStr}`.replace(/^ · | · $/g, "");
    if (!label) return;
    const bannerId = String(item.id || "").trim() || `banner_${idx + 1}_${safeInt(item.after_count ?? 0, 0)}`;
    const afterCount = Math.max(0, Math.min(maxDialogCount, safeInt(item.after_count ?? maxDialogCount, maxDialogCount)));
    normalized.push({ id: bannerId, after_count: afterCount, time: tStr, scene: sStr, label });
  });
  return normalized;
}

function clampStatusIndex(messages, state) {
  const maxIdx = Math.max(1, messages.length);
  const curIdx = safeInt(state.last_message_index ?? 1, 1);
  state.last_message_index = Math.max(1, Math.min(curIdx, maxIdx));
}

function getMemos(systemContent) {
  return stripStateBlock(systemContent)
    .split("\n")
    .filter(line => line.startsWith("【重要记忆】：") || line.startsWith("【阶段摘要"));
}

function buildStandardArchive(charInfo, { messages = null, state = null, sourceText = "", fromImport = false } = {}) {
  const basePrompt = charInfo.base_prompt || buildBaseSystemPrompt(charInfo);
  const charDs = charInfo.default_state || {};

  const defaultTime = String(charDs.current_time || "").trim() || formatHM();
  const defaultScene = String(charDs.scene || "").trim() || "默认场景";
  const defaultAff = clampAffection(safeInt(charDs.affection ?? 0, 0));
  const defaultTrackA = String(charDs.track_a || "").trim() || "初识观察中";
  const defaultTrackB = String(charDs.track_b || "").trim() || "防备与客套并存";
  const defaultMask = String(charDs.mask_integrity || "").trim() || "完整";

  const stdState = JSON.parse(JSON.stringify(charDs));
  if (state && typeof state === "object") {
    for (const [k, v] of Object.entries(state)) {
      if (v !== null && v !== undefined && String(v).trim() !== "") {
        stdState[k] = v;
      }
    }
  }

  const combinedText = sourceText || (messages || []).map(m => String(m?.content || "")).join("\n");
  if (fromImport) {
    if (!String(stdState.current_time || "").trim()) stdState.current_time = defaultTime;
    if (!String(stdState.scene || "").trim()) stdState.scene = defaultScene;
    if (stdState.affection === null || stdState.affection === undefined) stdState.affection = defaultAff;
    if (!String(stdState.track_a || "").trim()) stdState.track_a = defaultTrackA;
    if (!String(stdState.track_b || "").trim()) stdState.track_b = defaultTrackB;
    if (!String(stdState.mask_integrity || "").trim()) stdState.mask_integrity = defaultMask;
  } else {
    stdState.current_time = stdState.current_time || defaultTime;
    stdState.scene = stdState.scene || defaultScene;
    stdState.affection = stdState.affection ?? defaultAff;
    stdState.track_a = stdState.track_a || defaultTrackA;
    stdState.track_b = stdState.track_b || defaultTrackB;
    stdState.mask_integrity = stdState.mask_integrity || defaultMask;
  }

  stdState.affection = clampAffection(safeInt(stdState.affection ?? defaultAff, defaultAff));
  stdState.last_message_index = stdState.last_message_index ?? 1;
  stdState.last_status_time = stdState.last_status_time || formatNowStr();
  if (!Array.isArray(stdState.settlement_history)) stdState.settlement_history = [];
  reconcileStateLinkage(stdState);

  const cleanedMsgs = [];
  const rawMsgs = Array.isArray(messages) ? messages : [];
  for (const item of rawMsgs) {
    if (!item || typeof item !== "object") continue;
    const role = String(item.role || "").trim();
    if (!["system", "user", "assistant"].includes(role)) continue;
    let content = String(item.content || "");
    if (role === "assistant") content = cleanReplyText(content);
    else if (role === "user") content = content.trim();
    if (content) cleanedMsgs.push({ role, content });
  }

  let stdMessages = [];
  if (!cleanedMsgs.length || cleanedMsgs[0].role !== "system") {
    const dialogOnly = cleanedMsgs.filter(m => m.role === "user" || m.role === "assistant");
    stdMessages = [{ role: "system", content: basePrompt }, ...dialogOnly];
  } else {
    const oldSys = cleanedMsgs[0].content;
    const extraLines = stripStateBlock(oldSys)
      .split("\n")
      .filter(line => line.startsWith("【重要记忆】：") || line.startsWith("【阶段摘要"));
    let mergedSys = stripStateBlock(basePrompt);
    if (extraLines.length) mergedSys += "\n" + extraLines.join("\n");
    const dialogOnly = cleanedMsgs.slice(1).filter(m => m.role === "user" || m.role === "assistant");
    stdMessages = [{ role: "system", content: mergedSys }, ...dialogOnly];
  }

  const dialogCount = stdMessages.slice(1).length;
  stdState.time_banners = normalizeTimeBanners(stdState.time_banners, dialogCount);
  clampStatusIndex(stdMessages, stdState);
  syncStateToSystemPrompt(stdMessages, stdState, [combinedText.slice(0, 1000)]);

  return { schema_version: 1, state: stdState, messages: stdMessages };
}

function normalizeCharacterPayload(data, fallbackName = "", forApiComplete = false) {
  const name = String(data.name || fallbackName || "").trim() || "未命名角色";
  const title = String(data.title || "").trim() || (forApiComplete ? "待补齐身份设定" : "语C角色");
  const avatar = String(data.avatar || "").trim();
  const dsSrc = data.default_state && typeof data.default_state === "object" ? data.default_state : data;

  const default_state = {
    affection: clampAffection(safeInt(dsSrc.affection ?? 0, 0)),
    current_time: String(dsSrc.current_time || "").trim() || (forApiComplete ? "" : formatHM()),
    scene: String(dsSrc.scene || "").trim() || (forApiComplete ? "" : "默认场景"),
    track_a: String(dsSrc.track_a || "").trim() || (forApiComplete ? "" : "初识观察中"),
    track_b: String(dsSrc.track_b || "").trim() || (forApiComplete ? "" : "防备与客套并存"),
    mask_integrity: String(dsSrc.mask_integrity || "").trim() || (forApiComplete ? "" : "完整")
  };
  if (!forApiComplete) reconcileStateLinkage(default_state);

  let rawPrompt = String(data.base_prompt || "").trim();
  if (!rawPrompt) {
    rawPrompt = buildBaseSystemPrompt({
      name,
      title,
      personality: data.personality || "",
      style: data.style || "",
      rules: data.rules || ""
    });
  }
  if (!rawPrompt && !forApiComplete) {
    rawPrompt = `你正在进行一场语C角色扮演。\n角色名：${name}\n身份：${title}\n规则：只扮演${name}，用第一人称；根据场景与具体情况判断回复字数；保持沉浸感。`;
  }

  return { name, title, avatar, default_state, base_prompt: rawPrompt };
}

function loadSessionsMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEYS.SESSIONS) || "null");
    if (raw && typeof raw === "object") return raw;
  } catch (_) {}
  return {};
}

function saveSessionForChar(charId, messages, state) {
  const all = loadSessionsMap();
  const charStub = {
    name: "",
    base_prompt: messages[0]?.role === "system" ? messages[0].content : "",
    default_state: state
  };
  const archive = buildStandardArchive(charStub, { messages, state });
  Object.assign(state, archive.state);
  messages.splice(0, messages.length, ...archive.messages);
  all[charId] = archive;
  localStorage.setItem(LS_KEYS.SESSIONS, JSON.stringify(all));
}

function loadOrInitSession(charInfo) {
  const all = loadSessionsMap();
  const saved = all[charInfo.id];
  if (saved && typeof saved === "object" && Array.isArray(saved.messages)) {
    const archive = buildStandardArchive(charInfo, {
      messages: saved.messages,
      state: saved.state
    });
    return { messages: archive.messages, state: archive.state, saveFile: `localStorage:${charInfo.file}` };
  }
  const archive = buildStandardArchive(charInfo);
  saveSessionForChar(charInfo.id, archive.messages, archive.state);
  return { messages: archive.messages, state: archive.state, saveFile: `localStorage:${charInfo.file}` };
}

function trimContextWindow(messages, maxItems = MAX_MESSAGES, state = null) {
  if (messages.length <= maxItems) return;
  const sysMsg = messages[0];
  const keepCount = maxItems - 2;
  const tail = keepCount > 0 ? messages.slice(-keepCount) : [];
  while (tail.length && tail[0].role !== "user") {
    tail.shift();
  }
  const dropped = (messages.length - 1) - tail.length;
  messages.splice(0, messages.length, sysMsg, ...tail);
  if (state && dropped > 0) {
    state.last_message_index = Math.max(1, safeInt(state.last_message_index ?? 1, 1) - dropped);
    if (Array.isArray(state.settlement_history)) {
      const nextHist = [];
      for (const cp of state.settlement_history) {
        if (!cp || typeof cp !== "object") continue;
        const newSdc = safeInt(cp.settled_dialog_count ?? 0, 0) - dropped;
        if (newSdc >= 0) {
          const copyCp = JSON.parse(JSON.stringify(cp));
          copyCp.settled_dialog_count = newSdc;
          if (copyCp.before) copyCp.before.last_message_index = Math.max(1, safeInt(copyCp.before.last_message_index ?? 1, 1) - dropped);
          if (copyCp.after) copyCp.after.last_message_index = Math.max(1, safeInt(copyCp.after.last_message_index ?? 1, 1) - dropped);
          nextHist.push(copyCp);
        }
      }
      state.settlement_history = nextHist;
    }
  }
}

async function generateCharacterReply(charInfo, messages, state, userHintText = "", extraWorldbookPrompt = "") {
  const extraTexts = userHintText ? [userHintText] : [];
  const extBlocks = syncStateToSystemPrompt(messages, state, extraTexts);

  const cfg = loadApiConfigStore();
  const temp = extBlocks.temperature !== null && extBlocks.temperature !== undefined ? extBlocks.temperature : (cfg.temperature ?? 0.85);
  const maxTok = extBlocks.max_tokens !== null && extBlocks.max_tokens !== undefined ? extBlocks.max_tokens : (cfg.maxTokens ?? 4096);

  const ctxTurns = Math.max(4, Math.min(60, safeInt(extBlocks.context_turns ?? 24, 24)));
  const maxItems = Math.min(120, Math.max(6, ctxTurns * 2 + 2));
  trimContextWindow(messages, maxItems, state);

  // 构造发往 API 的临时副本，防止前端传入的世界书前缀写入持久化历史或聊天气泡
  const payloadMessages = messages.map(m => ({ role: m.role, content: m.content }));
  const wbExtra = String(extraWorldbookPrompt || "").trim();
  if (wbExtra && payloadMessages.length > 0 && payloadMessages[0].role === "system") {
    // 避免与引擎自带的【生效世界书设定】重复堆叠
    if (!payloadMessages[0].content.includes(wbExtra)) {
      payloadMessages[0].content += `\n\n${wbExtra}`;
    }
  }

  const [ok, rawReply] = await callChatApi(payloadMessages, {
    apiCfg: cfg,
    temperature: Number(temp),
    maxTokens: safeInt(maxTok, 4096),
    jsonMode: false,
    timeout: 120000
  });
  if (!ok) return [false, rawReply, extBlocks];

  const cleaned = cleanReplyText(rawReply);
  if (!cleaned) return [false, "模型返回内容为空", extBlocks];
  return [true, cleaned, extBlocks];
}

/* ==================== 5. 剧情复盘结算与回滚 (settlement.py) ==================== */

function buildCharacterContextForAnalyzer(charInfo, messages, state) {
  const charName = String(charInfo.name || "角色").trim();
  const charTitle = String(charInfo.title || "").trim();
  let rawPersona = stripStateBlock(charInfo.base_prompt || "");
  if (rawPersona.length > 3200) rawPersona = rawPersona.slice(0, 3200).trimEnd() + "\n...（后略）";

  const sysContent = messages[0]?.content || "";
  const importantMemos = stripStateBlock(sysContent).split("\n").filter(l => l.startsWith("【重要记忆】：")).slice(-8);
  const stageSummaries = stripStateBlock(sysContent).split("\n").filter(l => l.startsWith("【阶段摘要")).slice(-4);

  const curAff = clampAffection(state.affection ?? 0);
  const tier = getAffectionTier(curAff);
  const tierGuideLines = AFFECTION_TIERS.map(t => `  * [${t.min} ~ ${t.max}] ${t.stage}：${t.tendency}`).join("\n");

  const parts = [
    `【角色档案】\n角色名：${charName}${charTitle ? `（${charTitle}）` : ""}`,
    `角色核心性格与设定：\n${rawPersona || "无额外设定"}`,
    [
      "【当前状态基线】",
      `- 当前时间：${state.current_time || "未设定时间"}`,
      `- 当前场景：${state.scene || "未知场景"}`,
      `- 当前好感度：${curAff}（硬性范围 ${AFFECTION_MIN}~${AFFECTION_MAX}，当前阶段：${tier.stage}）`,
      `- 当前轨道A（欣赏与认可）：${state.track_a || "初识观察中"}`,
      `- 当前轨道B（情感信任与依恋）：${state.track_b || "防备与客套并存"}`,
      `- 当前面具完整度：${state.mask_integrity || "完整"}`,
      `- 当前行为倾向：${state.behavior_tendency || tier.tendency}`
    ].join("\n"),
    `【好感度区间与行为倾向参考标尺】\n${tierGuideLines}`
  ];
  if (importantMemos.length) parts.push("【已建立的永久记忆】\n" + importantMemos.join("\n"));
  if (stageSummaries.length) parts.push("【近期阶段剧情摘要】\n" + stageSummaries.join("\n"));
  return parts.join("\n\n");
}

async function analyzeConversation(newMsgs, charInfo, messages, state) {
  const baseTime = String(state.current_time || formatHM());
  const currentScene = String(state.scene || "默认场景");
  if (!newMsgs || !newMsgs.length) {
    return {
      ok: true,
      affection_change: 0,
      major_turning_point: false,
      inferred_time: baseTime,
      new_scene: currentScene,
      summary: "",
      track_a: String(state.track_a || "初识观察中"),
      track_b: String(state.track_b || "防备与客套并存"),
      mask_integrity: String(state.mask_integrity || "完整"),
      behavior_tendency: String(state.behavior_tendency || "")
    };
  }

  const charName = String(charInfo.name || "角色").trim();
  const contextBlock = buildCharacterContextForAnalyzer(charInfo, messages, state);

  const transcriptLines = [];
  for (const m of newMsgs) {
    if (m.role === "user") {
      transcriptLines.push(`玩家：${sanitizeBlackboxForAnalyzer(m.content || "")}`);
    } else if (m.role === "assistant") {
      transcriptLines.push(`角色（${charName}）：${cleanReplyText(m.content || "")}`);
    }
  }
  const transcript = transcriptLines.join("\n");

  const analyzePrompt = [
    "你是一个严谨的语C剧场后台状态与心理分析器。请结合下方【角色档案】【当前状态基线】以及【新增对话】，完成本阶段复盘评估。\n",
    contextBlock,
    "\n【黑箱与防暴涨暴跌严格规则】",
    "1. 绝对黑箱规则：玩家原文中写在 {{...}} 里的内容属于黑箱心理活动，已被屏蔽为【黑箱内容：仅玩家内心活动，角色完全不可知】。角色完全不知道、也听不到黑箱内容！严禁依据黑箱标记推测玩家心思去增减好感、改变双轨/面具，或将其当作客观已发生的场景/时间推进。",
    "2. 人设惯性与防暴涨暴跌原则：",
    "   - 必须延续【当前状态基线】与角色核心性格惯性：若当前互动平淡、过渡或仅有单方独白/轻描淡写，优先维持原有状态节奏，affection_change 可为 0；",
    "   - affection_change 单块允许范围严格限定在 -5 到 +5 之间（±4~±5 仅限重大转折且 major_turning_point 必须为 true）；",
    "3. 数值与双轨/行为倾向联动：全部使用精炼文字描述，严禁出现百分比或数字打分条。",
    "4. 时间、场景与摘要：inferred_time 合理推测时间；new_scene 提取新地点或维持原场景；summary 用一句话总结客观进展（不超过50字）。",
    "\n请严格返回纯 JSON 格式（不要附加 Markdown 解释）：",
    '{"affection_change": 0, "major_turning_point": false, "inferred_time": "周五 21:05", "summary": "两人在玄关简短交谈，氛围略微缓和。", "new_scene": "一楼玄关", "track_a": "觉得对方说话有分寸", "track_b": "仍保持礼貌防备", "mask_integrity": "基本完整", "behavior_tendency": "语气温和但保持距离"}',
    `\n【新增对话】\n${transcript}`
  ].join("\n");

  const [ok, content] = await callChatApi([{ role: "user", content: analyzePrompt }], {
    temperature: 0.1,
    maxTokens: 2048,
    jsonMode: true,
    timeout: 50000
  });
  if (!ok) return { ok: false, error: content };

  const resJson = extractJsonObject(content);
  if (!resJson) return { ok: false, error: "分析器未返回有效的 JSON 数据" };

  const majorTp = Boolean(resJson.major_turning_point);
  const rawDelta = clampChunkDelta(resJson.affection_change ?? 0, majorTp);
  return {
    ok: true,
    affection_change: rawDelta,
    major_turning_point: majorTp,
    inferred_time: String(resJson.inferred_time || "").trim() || baseTime,
    new_scene: String(resJson.new_scene || currentScene).trim() || currentScene,
    summary: String(resJson.summary || "").trim(),
    track_a: String(resJson.track_a || state.track_a || "初识观察中").trim() || "初识观察中",
    track_b: String(resJson.track_b || state.track_b || "防备与客套并存").trim() || "防备与客套并存",
    mask_integrity: String(resJson.mask_integrity || state.mask_integrity || "完整").trim() || "完整",
    behavior_tendency: String(resJson.behavior_tendency || "").trim()
  };
}

async function performSettlement(charInfo, messages, state, triggerLabel = "复盘") {
  clampStatusIndex(messages, state);
  const lastIdx = state.last_message_index ?? 1;
  const unsettledSlice = messages.slice(lastIdx).filter(m => m.role === "user" || m.role === "assistant");

  if (!unsettledSlice.length) {
    reconcileStateLinkage(state);
    syncStateToSystemPrompt(messages, state);
    saveSessionForChar(charInfo.id, messages, state);
    return [true, false, "距离上次复盘暂无新增对话，已同步当前状态（不重复结算好感度）"];
  }

  if (!unsettledSlice.some(m => m.role === "user")) {
    reconcileStateLinkage(state);
    syncStateToSystemPrompt(messages, state);
    saveSessionForChar(charInfo.id, messages, state);
    return [true, false, "尚未开始双向互动，暂不结算好感度与阶段摘要"];
  }

  const nowTime = formatNowStr();
  const oldAff = clampAffection(state.affection ?? 0);
  reconcileStateLinkage(state);

  const beforeSnapshot = {
    affection: oldAff,
    current_time: String(state.current_time || ""),
    scene: String(state.scene || ""),
    track_a: String(state.track_a || ""),
    track_b: String(state.track_b || ""),
    mask_integrity: String(state.mask_integrity || ""),
    behavior_tendency: String(state.behavior_tendency || ""),
    relationship_stage: String(state.relationship_stage || ""),
    last_message_index: lastIdx,
    last_status_time: String(state.last_status_time || "")
  };

  const workingState = JSON.parse(JSON.stringify(state));
  const newRounds = Math.max(1, Math.floor(unsettledSlice.length / 2));
  let rawDeltaSum = 0;
  let anyMajor = false;
  const summariesAdded = [];
  let latestTendency = "";

  let idx = 0;
  while (idx < unsettledSlice.length) {
    const chunk = unsettledSlice.slice(idx, Math.min(idx + ANALYZE_CHUNK_MESSAGES, unsettledSlice.length));
    const res = await analyzeConversation(chunk, charInfo, messages, workingState);
    if (!res.ok) return [false, false, String(res.error || "后台复盘分析失败")];

    rawDeltaSum += safeInt(res.affection_change ?? 0, 0);
    if (res.major_turning_point) anyMajor = true;

    workingState.affection = clampAffection(oldAff + rawDeltaSum);
    workingState.scene = res.new_scene;
    workingState.current_time = res.inferred_time;
    workingState.track_a = res.track_a;
    workingState.track_b = res.track_b;
    workingState.mask_integrity = res.mask_integrity;
    if (res.behavior_tendency) latestTendency = res.behavior_tendency;
    reconcileStateLinkage(workingState, latestTendency);

    const summaryText = String(res.summary || "").trim();
    if (summaryText) {
      summariesAdded.push(`【阶段摘要 (${nowTime.slice(5, 10)})】：${summaryText}`);
    }
    idx += ANALYZE_CHUNK_MESSAGES;
  }

  const actualDelta = applySettlementAntiSpike(rawDeltaSum, oldAff, newRounds, anyMajor);
  state.affection = clampAffection(oldAff + actualDelta);
  state.scene = workingState.scene;
  state.current_time = workingState.current_time;
  state.track_a = workingState.track_a;
  state.track_b = workingState.track_b;
  state.mask_integrity = workingState.mask_integrity;
  reconcileStateLinkage(state, latestTendency);

  if (summariesAdded.length && messages[0]?.role === "system") {
    messages[0].content += "\n" + summariesAdded.join("\n");
  }

  const totalDialogCount = messages.slice(1).filter(m => m.role === "user" || m.role === "assistant").length;
  const banners = normalizeTimeBanners(state.time_banners, totalDialogCount);
  const bannerId = `banner_${totalDialogCount}_${Date.now()}`;
  banners.push({
    id: bannerId,
    after_count: totalDialogCount,
    time: state.current_time,
    scene: state.scene,
    label: `${state.current_time} · ${state.scene}`
  });
  state.time_banners = banners.slice(-50);
  state.last_status_time = nowTime;
  state.last_message_index = messages.length;

  const checkpoint = {
    settled_dialog_count: totalDialogCount,
    banner_id: bannerId,
    summaries_added: summariesAdded,
    aff_delta: actualDelta,
    manual_aff_overridden: false,
    before: beforeSnapshot,
    after: {
      affection: state.affection,
      current_time: state.current_time,
      scene: state.scene,
      track_a: state.track_a,
      track_b: state.track_b,
      mask_integrity: state.mask_integrity,
      behavior_tendency: state.behavior_tendency,
      relationship_stage: state.relationship_stage,
      last_message_index: state.last_message_index,
      last_status_time: nowTime
    }
  };
  if (!Array.isArray(state.settlement_history)) state.settlement_history = [];
  state.settlement_history.push(checkpoint);
  state.settlement_history = state.settlement_history.slice(-100);

  syncStateToSystemPrompt(messages, state);
  saveSessionForChar(charInfo.id, messages, state);

  const sign = actualDelta > 0 ? "+" : "";
  return [
    true,
    true,
    `${triggerLabel}完成（${state.current_time} @ ${state.scene}，好感度 ${sign}${actualDelta} → ${state.affection} [${state.relationship_stage}]）`
  ];
}

function removeSummaryLines(sysContent, linesToRemove) {
  if (!linesToRemove || !linesToRemove.length) return sysContent;
  const contentLines = sysContent.split("\n");
  for (let i = linesToRemove.length - 1; i >= 0; i--) {
    const target = linesToRemove[i];
    if (!target) continue;
    for (let idx = contentLines.length - 1; idx >= 0; idx--) {
      if (contentLines[idx].startsWith("【阶段摘要") && contentLines[idx] === target) {
        contentLines.splice(idx, 1);
        break;
      }
    }
  }
  return contentLines.join("\n");
}

function rollbackSettlementsAfter(messages, state, validSettledDialogCount, { pruneBannersAfter = null, deletedDialogPos = null } = {}) {
  const validDc = Math.max(0, safeInt(validSettledDialogCount, 0));
  if (!Array.isArray(state.settlement_history)) state.settlement_history = [];
  const history = state.settlement_history;

  let rolledBack = 0;
  const removedBannerIds = new Set();

  while (history.length && safeInt(history[history.length - 1].settled_dialog_count ?? 0, 0) > validDc) {
    const cp = history.pop();
    rolledBack += 1;
    const before = cp.before || {};
    const after = cp.after || {};

    const curAff = safeInt(state.affection ?? 0, 0);
    const afterAff = safeInt(after.affection ?? curAff, curAff);
    if (curAff === afterAff) {
      state.affection = clampAffection(before.affection ?? curAff);
    } else if (!cp.manual_aff_overridden) {
      state.affection = clampAffection(curAff - safeInt(cp.aff_delta ?? 0, 0));
    }

    if (state.current_time === after.current_time) state.current_time = before.current_time ?? state.current_time ?? "";
    if (state.scene === after.scene) state.scene = before.scene ?? state.scene ?? "";

    state.track_a = before.track_a ?? state.track_a ?? "初识观察中";
    state.track_b = before.track_b ?? state.track_b ?? "防备与客套并存";
    state.mask_integrity = before.mask_integrity ?? state.mask_integrity ?? "完整";
    state.behavior_tendency = before.behavior_tendency ?? "";
    state.last_message_index = Math.max(1, safeInt(before.last_message_index ?? 1, 1));
    if (before.last_status_time) state.last_status_time = before.last_status_time;

    if (messages[0]?.role === "system" && Array.isArray(cp.summaries_added)) {
      messages[0].content = removeSummaryLines(messages[0].content, cp.summaries_added);
    }
    if (cp.banner_id) removedBannerIds.add(String(cp.banner_id));
  }

  if (rolledBack === 0 && safeInt(state.last_message_index ?? 1, 1) - 1 > validDc) {
    state.last_message_index = Math.max(1, validDc + 1);
  }

  if (Array.isArray(state.time_banners)) {
    const nextBanners = [];
    for (const b of state.time_banners) {
      if (!b || typeof b !== "object") continue;
      if (b.id && removedBannerIds.has(String(b.id))) continue;
      const ac = safeInt(b.after_count ?? 0, 0);
      if (pruneBannersAfter !== null && ac > pruneBannersAfter) continue;
      if (deletedDialogPos !== null && ac >= deletedDialogPos) {
        nextBanners.push({ ...b, after_count: Math.max(0, ac - 1) });
      } else {
        nextBanners.push(b);
      }
    }
    state.time_banners = nextBanners;
  }

  const dialogCount = messages.slice(1).filter(m => m.role === "user" || m.role === "assistant").length;
  state.time_banners = normalizeTimeBanners(state.time_banners, dialogCount);
  clampStatusIndex(messages, state);
  reconcileStateLinkage(state, String(state.behavior_tendency || ""));
  syncStateToSystemPrompt(messages, state);
  return rolledBack;
}

/* ==================== 6. 统一本地 API 路由器 (替代 Flask 后端) ==================== */

function buildClientPayload(charInfo, messages, state, saveFile, { notice = "", metaOutput = "", referText = "", extBlocks = null } = {}) {
  const cfg = loadApiConfigStore();
  const ext = loadExtensionsStore();
  const dialogMessages = [];
  for (let idx = 1; idx < messages.length; idx++) {
    const m = messages[idx];
    if (m && (m.role === "user" || m.role === "assistant")) {
      dialogMessages.push({ index: idx, role: m.role, content: m.content || "" });
    }
  }
  clampStatusIndex(messages, state);
  reconcileStateLinkage(state);
  state.time_banners = normalizeTimeBanners(state.time_banners, dialogMessages.length);

  const unsettledCount = messages.slice(state.last_message_index ?? 1).filter(m => m.role === "user" || m.role === "assistant").length;
  return {
    ok: true,
    notice,
    meta_output: metaOutput,
    refer_text: referText,
    api_ready: Boolean(String(cfg.key || "").trim()),
    character: {
      id: charInfo.id,
      name: charInfo.name,
      title: charInfo.title || "",
      avatar: charInfo.avatar || "",
      file: charInfo.file || charInfo.id,
      base_prompt: charInfo.base_prompt || "",
      default_state: charInfo.default_state || {}
    },
    state,
    memos: getMemos(messages[0]?.content || ""),
    messages: dialogMessages,
    extensions_summary: {
      active_persona: getActivePersonaStore(ext),
      active_preset: getActivePresetStore(ext),
      world_entries_count: (ext.world_entries || []).length,
      matched_world_entries: extBlocks?.matched_world_entries || []
    },
    stats: {
      total_messages: messages.length,
      max_messages: MAX_MESSAGES,
      rounds: Math.floor((messages.length - 1) / 2),
      unsettled_rounds: Math.floor(unsettledCount / 2),
      auto_settle_interval: AUTO_SETTLE_ROUNDS,
      save_file: saveFile,
      model: cfg.model || MODEL_NAME_DEFAULT
    }
  };
}

function resolveChar(charId) {
  const chars = loadCharactersStore();
  const keys = Object.keys(chars).sort();
  if (!keys.length) return [null, chars];
  const cid = String(charId || "").trim();
  if (cid && chars[cid]) return [chars[cid], chars];
  if (cid) {
    for (const k of keys) {
      if (chars[k].name === cid || chars[k].file === cid) return [chars[k], chars];
    }
  }
  return [chars[keys[0]], chars];
}

function loadArchivesStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEYS.ARCHIVES) || "null");
    if (Array.isArray(raw)) return raw;
  } catch (_) {}
  return [];
}

function saveArchivesStore(list) {
  localStorage.setItem(LS_KEYS.ARCHIVES, JSON.stringify(list));
}

window.LocalTheaterEngine = {
  async dispatch(url, options = {}) {
    const u = new URL(url, window.location.origin);
    const path = u.pathname;
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};

    // 1. API 配置
    if (path === "/api/api_config") {
      if (method === "GET") return { ok: true, config: loadApiConfigStore() };
      const saved = saveApiConfigStore(body);
      return { ok: true, config: saved, notice: "API 配置已保存" };
    }
    if (path === "/api/api_config/test") {
      const baseCfg = loadApiConfigStore();
      const testCfg = {
        key: body.key || baseCfg.key,
        url: body.url || baseCfg.url,
        model: body.model || baseCfg.model,
        temperature: 0.5,
        maxTokens: 64
      };
      const [ok, reply] = await callChatApi([{ role: "user", content: "请回复“连接正常”四个字。" }], {
        apiCfg: testCfg,
        temperature: 0.5,
        maxTokens: 64,
        timeout: 30000
      });
      return ok ? { ok: true, reply } : { ok: false, error: reply };
    }

    // 2. 扩展模块（身份卡 / 世界书 / 预设）
    if (path === "/api/extensions") {
      const ext = loadExtensionsStore();
      return { ok: true, data: ext, active_persona: getActivePersonaStore(ext), active_preset: getActivePresetStore(ext) };
    }
    if (path === "/api/extensions/persona/select") {
      const ext = loadExtensionsStore();
      const pid = String(body.id || "").trim();
      if (!ext.personas.some(p => String(p.id) === pid)) return { ok: false, error: "指定的玩家身份卡不存在" };
      ext.active_persona_id = pid;
      saveExtensionsStore(ext);
      const persona = getActivePersonaStore(ext);
      return { ok: true, data: ext, active_persona: persona, notice: `已切换玩家身份：${persona.name}` };
    }
    if (path === "/api/extensions/persona/save") {
      const ext = loadExtensionsStore();
      const pid = String(body.id || "").trim() || `persona_${Date.now()}`;
      const name = String(body.name || "").trim() || "未命名身份";
      const record = {
        id: pid,
        name,
        title: String(body.title || "").trim(),
        appearance: String(body.appearance || "").trim(),
        personality: String(body.personality || "").trim(),
        background: String(body.background || "").trim(),
        notes: String(body.notes || "").trim()
      };
      const idx = ext.personas.findIndex(p => String(p.id) === pid);
      if (idx >= 0) ext.personas[idx] = record;
      else ext.personas.push(record);
      if (body.set_active || !ext.active_persona_id) ext.active_persona_id = pid;
      saveExtensionsStore(ext);
      return { ok: true, persona: record, data: ext, notice: `已保存身份卡「${name}」` };
    }
    if (path === "/api/extensions/persona/delete") {
      const ext = loadExtensionsStore();
      const pid = String(body.id || "").trim();
      if (ext.personas.length <= 1) return { ok: false, error: "至少需要保留一张玩家身份卡" };
      ext.personas = ext.personas.filter(p => String(p.id) !== pid);
      if (String(ext.active_persona_id) === pid) ext.active_persona_id = String(ext.personas[0].id);
      saveExtensionsStore(ext);
      return { ok: true, data: ext, notice: "已删除玩家身份卡" };
    }
    if (path === "/api/extensions/worldbook/save") {
      const ext = loadExtensionsStore();
      const eid = String(body.id || "").trim() || `wb_${Date.now()}`;
      const title = String(body.title || "").trim() || "未命名世界书条目";
      const keys = Array.isArray(body.keys)
        ? body.keys.map(k => String(k).trim()).filter(Boolean)
        : String(body.keys || "").split(/[,，、;；\s]+/).map(k => k.trim()).filter(Boolean);
      const entry = {
        id: eid,
        title,
        keys,
        content: String(body.content || "").trim(),
        enabled: Boolean(body.enabled ?? true),
        constant: Boolean(body.constant ?? false),
        order: safeInt(body.order ?? 100, 100)
      };
      const idx = ext.world_entries.findIndex(e => String(e.id) === eid);
      if (idx >= 0) ext.world_entries[idx] = entry;
      else ext.world_entries.push(entry);
      saveExtensionsStore(ext);
      return { ok: true, entry, data: ext, notice: `已保存世界书条目「${title}」` };
    }
    if (path === "/api/extensions/worldbook/delete") {
      const ext = loadExtensionsStore();
      const eid = String(body.id || "").trim();
      ext.world_entries = ext.world_entries.filter(e => String(e.id) !== eid);
      saveExtensionsStore(ext);
      return { ok: true, data: ext, notice: "已删除世界书条目" };
    }
    if (path === "/api/extensions/preset/select") {
      const ext = loadExtensionsStore();
      const prid = String(body.id || "").trim();
      if (!ext.presets.some(pr => String(pr.id) === prid)) return { ok: false, error: "指定的补全预设不存在" };
      ext.active_preset_id = prid;
      saveExtensionsStore(ext);
      const preset = getActivePresetStore(ext);
      return { ok: true, data: ext, active_preset: preset, notice: `已切换补全预设：${preset.name}` };
    }
    if (path === "/api/extensions/preset/save") {
      const ext = loadExtensionsStore();
      const prid = String(body.id || "").trim() || `preset_${Date.now()}`;
      const name = String(body.name || "").trim() || "自定义预设";
      const tempVal = Math.max(0, Math.min(2, Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.85));
      const record = {
        id: prid,
        name,
        system_prefix: String(body.system_prefix || "").trim(),
        system_suffix: String(body.system_suffix || "").trim(),
        temperature: tempVal,
        max_tokens: Math.max(128, Math.min(32768, safeInt(body.max_tokens ?? 4096, 4096))),
        context_turns: Math.max(4, Math.min(60, safeInt(body.context_turns ?? 24, 24))),
        inject_worldbook: Boolean(body.inject_worldbook ?? true),
        inject_persona: Boolean(body.inject_persona ?? true)
      };
      const idx = ext.presets.findIndex(pr => String(pr.id) === prid);
      if (idx >= 0) ext.presets[idx] = record;
      else ext.presets.push(record);
      if (body.set_active || !ext.active_preset_id) ext.active_preset_id = prid;
      saveExtensionsStore(ext);
      return { ok: true, preset: record, data: ext, notice: `已保存预设「${name}」` };
    }
    if (path === "/api/extensions/preset/delete") {
      const ext = loadExtensionsStore();
      const prid = String(body.id || "").trim();
      if (ext.presets.length <= 1) return { ok: false, error: "至少需要保留一套对话补全预设" };
      ext.presets = ext.presets.filter(pr => String(pr.id) !== prid);
      if (String(ext.active_preset_id) === prid) ext.active_preset_id = String(ext.presets[0].id);
      saveExtensionsStore(ext);
      return { ok: true, data: ext, notice: "已删除补全预设" };
    }

    // 3. 角色与归档管理
    if (path === "/api/characters") {
      const chars = loadCharactersStore();
      return { ok: true, characters: Object.keys(chars).sort().map(k => chars[k]) };
    }
    if (path === "/api/character/create") {
      const name = String(body.name || "").trim();
      if (!name) return { ok: false, error: "角色名不能为空" };
      const chars = loadCharactersStore();
      const slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "") || `char_${Date.now()}`;
      let fname = `${slug}.json`;
      let idx = 1;
      while (chars[fname]) {
        idx += 1;
        fname = `${slug}_${idx}.json`;
      }
      const norm = normalizeCharacterPayload(body, name, false);
      const charObj = { id: fname, file: fname, ...norm };
      chars[fname] = charObj;
      saveCharactersStore(chars);
      const { messages, state, saveFile } = loadOrInitSession(charObj);
      saveSessionForChar(charObj.id, messages, state);
      return buildClientPayload(charObj, messages, state, saveFile, { notice: `已创建角色「${name}」` });
    }
    if (path === "/api/character/update") {
      const [charObj, chars] = resolveChar(body.char_id);
      if (!charObj) return { ok: false, error: "角色不存在" };
      if (body.name && String(body.name).trim()) charObj.name = String(body.name).trim();
      if ("title" in body) charObj.title = String(body.title || "").trim();
      if ("avatar" in body) charObj.avatar = String(body.avatar || "").trim();
      if ("base_prompt" in body) charObj.base_prompt = String(body.base_prompt || "").trim();

      const ds = charObj.default_state || (charObj.default_state = {});
      for (const f of ["current_time", "scene", "track_a", "track_b", "mask_integrity"]) {
        if (f in body && String(body[f] || "").trim()) ds[f] = String(body[f]).trim();
      }
      if ("affection" in body) ds.affection = clampAffection(safeInt(body.affection, ds.affection ?? 0));
      reconcileStateLinkage(ds);
      chars[charObj.id] = charObj;
      saveCharactersStore(chars);

      const { messages, state, saveFile } = loadOrInitSession(charObj);
      if (body.sync_current) {
        for (const f of ["current_time", "scene", "affection", "track_a", "track_b", "mask_integrity"]) {
          if (f in ds) state[f] = ds[f];
        }
        reconcileStateLinkage(state);
      }
      const extBlocks = syncStateToSystemPrompt(messages, state);
      saveSessionForChar(charObj.id, messages, state);
      return buildClientPayload(charObj, messages, state, saveFile, { notice: "角色设定已保存", extBlocks });
    }
    if (path === "/api/character/complete") {
      const prompt = [
        "请根据以下角色设定文本，补全缺失字段并仅输出 JSON 对象（不要 markdown 代码块）：",
        '{"name":"","title":"","scene":"","track_a":"","track_b":"","mask_integrity":"","affection":0,"base_prompt":""}\n',
        `已有草稿：${JSON.stringify(body.draft || {})}`,
        `原始文本：${String(body.raw_text || "").slice(0, 2000)}`
      ].join("\n");
      const [ok, ans] = await callChatApi([{ role: "user", content: prompt }], { temperature: 0.4, maxTokens: 1200, timeout: 60000 });
      if (!ok) return { ok: false, error: ans };
      const parsed = extractJsonObject(ans);
      if (!parsed) return { ok: false, error: "模型未返回合法 JSON" };
      const merged = Object.assign({}, body.draft || {});
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null && v !== undefined && v !== "") merged[k] = v;
      }
      return { ok: true, character: normalizeCharacterPayload(merged, body.fallback_name || "导入角色", false) };
    }
    if (path === "/api/character/delete") {
      const [charObj, chars] = resolveChar(body.char_id);
      if (!charObj) return { ok: false, error: "角色不存在" };
      if (Object.keys(chars).length <= 1) return { ok: false, error: "至少需要保留一位角色" };

      const { messages, state } = loadOrInitSession(charObj);
      const archives = loadArchivesStore();
      archives.unshift({
        archive_id: `${charObj.id}_${Date.now()}`,
        char_id: charObj.id,
        name: charObj.name,
        title: charObj.title || "",
        archived_at: formatNowStr(),
        dialog_count: messages.slice(1).filter(m => m.role === "user" || m.role === "assistant").length,
        character_data: JSON.parse(JSON.stringify(charObj)),
        session_data: { messages, state }
      });
      saveArchivesStore(archives);

      delete chars[charObj.id];
      saveCharactersStore(chars);
      const allSess = loadSessionsMap();
      delete allSess[charObj.id];
      localStorage.setItem(LS_KEYS.SESSIONS, JSON.stringify(allSess));

      const [nextChar] = resolveChar(null);
      const nextSess = loadOrInitSession(nextChar);
      return buildClientPayload(nextChar, nextSess.messages, nextSess.state, nextSess.saveFile, { notice: `已归档「${charObj.name}」` });
    }
    if (path === "/api/character/archives") {
      return { ok: true, archives: loadArchivesStore() };
    }
    if (path === "/api/character/restore") {
      const archiveId = String(body.archive_id || "").trim();
      const archives = loadArchivesStore();
      const idx = archives.findIndex(a => a.archive_id === archiveId);
      if (idx < 0) return { ok: false, error: "归档记录不存在" };
      const item = archives[idx];
      const chars = loadCharactersStore();
      let targetId = item.character_data.id || `restored_${Date.now()}.json`;
      if (chars[targetId]) targetId = `restored_${Date.now()}.json`;

      const restoredChar = { ...item.character_data, id: targetId, file: targetId };
      chars[targetId] = restoredChar;
      saveCharactersStore(chars);

      const archive = buildStandardArchive(restoredChar, {
        messages: item.session_data?.messages,
        state: item.session_data?.state
      });
      saveSessionForChar(targetId, archive.messages, archive.state);

      archives.splice(idx, 1);
      saveArchivesStore(archives);
      return buildClientPayload(restoredChar, archive.messages, archive.state, `localStorage:${targetId}`, { notice: `已恢复角色「${restoredChar.name}」` });
    }

    // 4. 会话、对话、编辑与元指令
    if (path === "/api/session") {
      const [charObj] = resolveChar(u.searchParams.get("char_id"));
      if (!charObj) return { ok: false, error: "未找到角色" };
      const { messages, state, saveFile } = loadOrInitSession(charObj);
      const extBlocks = syncStateToSystemPrompt(messages, state);
      return buildClientPayload(charObj, messages, state, saveFile, { extBlocks });
    }
    if (path === "/api/chat") {
      const [charObj] = resolveChar(body.char_id);
      if (!charObj) return { ok: false, error: "角色不存在" };
      const userMsg = String(body.message || "").trim();
      const wbPrompt = String(body.worldbook_prompt || "").trim();
      if (!userMsg) return { ok: false, error: "消息内容不能为空" };

      const { messages, state, saveFile } = loadOrInitSession(charObj);
      messages.push({ role: "user", content: userMsg });

      const [ok, reply, extBlocks] = await generateCharacterReply(charObj, messages, state, userMsg, wbPrompt);
      if (!ok) return { ok: false, error: reply };

      messages.push({ role: "assistant", content: reply });
      saveSessionForChar(charObj.id, messages, state);

      const unsettledMsgs = messages.slice(state.last_message_index ?? 1).filter(m => m.role === "user" || m.role === "assistant").length;
      const unsettledRounds = Math.floor(unsettledMsgs / 2);

      const noticeParts = [];
      if (extBlocks.persona?.name) noticeParts.push(`身份:${extBlocks.persona.name}`);
      if (extBlocks.preset?.name) noticeParts.push(`预设:${extBlocks.preset.name}`);
      const wbNames = (extBlocks.matched_world_entries || []).map(w => w.title).filter(Boolean);
      if (wbNames.length) noticeParts.push(`世界书:${wbNames.slice(0, 3).join("、")}`);

      if (unsettledRounds >= AUTO_SETTLE_ROUNDS) {
        const [sOk, didSettle, sMsg] = await performSettlement(charObj, messages, state, "自动复盘");
        if (sOk && didSettle) noticeParts.push(sMsg);
      }
      return buildClientPayload(charObj, messages, state, saveFile, { notice: noticeParts.join(" | "), extBlocks });
    }
    if (path === "/api/message/edit") {
      const [charObj] = resolveChar(body.char_id);
      if (!charObj) return { ok: false, error: "角色不存在" };
      const idx = safeInt(body.index ?? -1, -1);
      const mode = String(body.mode || "save").trim();
      const content = String(body.content || "");

      const { messages, state, saveFile } = loadOrInitSession(charObj);
      if (idx < 1 || idx >= messages.length) return { ok: false, error: "消息索引越界" };

      const dialogPosBefore = messages.slice(1, idx).filter(m => m.role === "user" || m.role === "assistant").length;

      if (mode === "delete") {
        messages.splice(idx, 1);
        rollbackSettlementsAfter(messages, state, dialogPosBefore, { deletedDialogPos: dialogPosBefore });
        saveSessionForChar(charObj.id, messages, state);
        return buildClientPayload(charObj, messages, state, saveFile, { notice: "已删除消息并同步状态" });
      }

      const cleanedContent = messages[idx].role === "assistant" ? cleanReplyText(content) : content.trim();
      messages[idx].content = cleanedContent;
      rollbackSettlementsAfter(messages, state, dialogPosBefore, { pruneBannersAfter: dialogPosBefore });

      if (mode === "save_regen_next") {
        const [ok, reply] = await generateCharacterReply(charObj, messages.slice(0, idx + 1), state, cleanedContent);
        if (!ok) return { ok: false, error: reply };
        if (idx + 1 < messages.length) messages[idx + 1] = { role: "assistant", content: reply };
        else messages.push({ role: "assistant", content: reply });
      } else if (mode === "save_regen_truncate") {
        messages.splice(idx + 1);
        const [ok, reply] = await generateCharacterReply(charObj, messages, state, cleanedContent);
        if (!ok) return { ok: false, error: reply };
        messages.push({ role: "assistant", content: reply });
      }
      saveSessionForChar(charObj.id, messages, state);
      return buildClientPayload(charObj, messages, state, saveFile, { notice: "消息已更新" });
    }
    if (path === "/api/history/replace") {
      const [charObj] = resolveChar(body.char_id);
      if (!charObj) return { ok: false, error: "角色不存在" };
      const cleaned = [];
      for (const it of body.items || []) {
        if (!it || typeof it !== "object") continue;
        const role = it.role === "user" ? "user" : "assistant";
        const txt = role === "assistant" ? cleanReplyText(it.content) : String(it.content || "").trim();
        if (txt) cleaned.push({ role, content: txt });
      }
      const { messages, state, saveFile } = loadOrInitSession(charObj);
      messages.splice(0, messages.length, { role: "system", content: charObj.base_prompt }, ...cleaned);
      state.last_message_index = 1;
      state.settlement_history = [];
      state.time_banners = normalizeTimeBanners(state.time_banners, cleaned.length);
      const extBlocks = syncStateToSystemPrompt(messages, state);
      saveSessionForChar(charObj.id, messages, state);
      return buildClientPayload(charObj, messages, state, saveFile, { notice: "已批量更新对话历史", extBlocks });
    }
    if (path === "/api/history/import") {
      const [charObj] = resolveChar(body.char_id);
      if (!charObj) return { ok: false, error: "角色不存在" };
      const rawText = String(body.raw_text || "").trim();
      if (!rawText) return { ok: false, error: "导入内容不能为空" };

      const { messages, state, saveFile } = loadOrInitSession(charObj);
      try {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
          const archive = buildStandardArchive(charObj, {
            messages: parsed.messages,
            state: parsed.state && typeof parsed.state === "object" ? parsed.state : null,
            sourceText: rawText,
            fromImport: true
          });
          messages.splice(0, messages.length, ...archive.messages);
          Object.assign(state, archive.state);
          saveSessionForChar(charObj.id, messages, state);
          return buildClientPayload(charObj, messages, state, saveFile, { notice: "已导入存档" });
        }
      } catch (_) {}

      if (!body.auto_repair) return { ok: false, error: "存档格式非标准 JSON，且未开启自动修复" };

      const prompt = [
        "请将以下非标准语C存档或聊天记录转换为标准 JSON（仅输出 JSON，不要 markdown）：",
        '{"state":{"current_time":"","scene":"","affection":0,"track_a":"","track_b":"","mask_integrity":""},"messages":[{"role":"user","content":""},{"role":"assistant","content":""}]}\n',
        `内容：\n${rawText.slice(0, 4000)}`
      ].join("\n");
      const [ok, ans] = await callChatApi([{ role: "user", content: prompt }], { temperature: 0.3, maxTokens: 2500, timeout: 60000 });
      if (!ok) return { ok: false, error: `自动修复失败: ${ans}` };
      const fixed = extractJsonObject(ans);
      if (!fixed || !Array.isArray(fixed.messages)) return { ok: false, error: "自动修复未返回合法 JSON 结构" };

      const archive = buildStandardArchive(charObj, {
        messages: fixed.messages,
        state: fixed.state && typeof fixed.state === "object" ? fixed.state : null,
        sourceText: rawText,
        fromImport: true
      });
      messages.splice(0, messages.length, ...archive.messages);
      Object.assign(state, archive.state);
      saveSessionForChar(charObj.id, messages, state);
      return buildClientPayload(charObj, messages, state, saveFile, { notice: "已自动修复并导入存档" });
    }
    if (path === "/api/time_banner") {
      const [charObj] = resolveChar(body.char_id);
      if (!charObj) return { ok: false, error: "角色不存在" };
      const { messages, state, saveFile } = loadOrInitSession(charObj);
      let banners = [...(state.time_banners || [])];
      if (body.mode === "delete") {
        banners = banners.filter(b => String(b.id) !== String(body.id));
      } else {
        for (const b of banners) {
          if (String(b.id) === String(body.id)) b.label = String(body.label || "").trim();
        }
      }
      const dialogCount = messages.slice(1).filter(m => m.role === "user" || m.role === "assistant").length;
      state.time_banners = normalizeTimeBanners(banners, dialogCount);
      saveSessionForChar(charObj.id, messages, state);
      return buildClientPayload(charObj, messages, state, saveFile, { notice: "时间标签已更新" });
    }
    if (path === "/api/action") {
      const [charObj] = resolveChar(body.char_id);
      if (!charObj) return { ok: false, error: "角色不存在" };
      const action = String(body.action || "").trim();
      const arg = String(body.arg || "").trim();
      const { messages, state, saveFile } = loadOrInitSession(charObj);

      if (action === "set_time") {
        if (arg) {
          state.current_time = arg;
          const dialogCount = messages.slice(1).filter(m => m.role === "user" || m.role === "assistant").length;
          const banners = normalizeTimeBanners(state.time_banners, dialogCount);
          banners.push({
            id: `banner_${dialogCount}_${Date.now()}`,
            after_count: dialogCount,
            time: arg,
            scene: state.scene || "",
            label: `${arg} · ${state.scene || "场景推进"}`
          });
          state.time_banners = banners.slice(-50);
        }
        const extBlocks = syncStateToSystemPrompt(messages, state);
        saveSessionForChar(charObj.id, messages, state);
        return buildClientPayload(charObj, messages, state, saveFile, { notice: "已更新时间并插入时间横幅", extBlocks });
      }
      if (action === "scene") {
        if (arg) state.scene = arg;
        const extBlocks = syncStateToSystemPrompt(messages, state);
        saveSessionForChar(charObj.id, messages, state);
        return buildClientPayload(charObj, messages, state, saveFile, { notice: "已更新当前场景", extBlocks });
      }
      if (action === "aff") {
        const delta = safeInt(arg, 0);
        state.affection = clampAffection(safeInt(state.affection ?? 0, 0) + delta);
        reconcileStateLinkage(state);
        const extBlocks = syncStateToSystemPrompt(messages, state);
        saveSessionForChar(charObj.id, messages, state);
        return buildClientPayload(charObj, messages, state, saveFile, { notice: `好感度调整 ${delta >= 0 ? "+" : ""}${delta}`, extBlocks });
      }
      if (action === "memo") {
        if (arg && messages[0]?.role === "system") {
          const memoLine = arg.startsWith("【重要记忆】：") ? arg : `【重要记忆】：${arg}`;
          if (!messages[0].content.split("\n").includes(memoLine)) {
            messages[0].content += `\n${memoLine}`;
          }
        }
        const extBlocks = syncStateToSystemPrompt(messages, state);
        saveSessionForChar(charObj.id, messages, state);
        return buildClientPayload(charObj, messages, state, saveFile, { notice: "已写入永久记忆", extBlocks });
      }
      if (action === "delete_memo") {
        if (arg && messages[0]?.role === "system") {
          messages[0].content = messages[0].content.split("\n").filter(ln => ln !== arg).join("\n");
        }
        const extBlocks = syncStateToSystemPrompt(messages, state);
        saveSessionForChar(charObj.id, messages, state);
        return buildClientPayload(charObj, messages, state, saveFile, { notice: "已删除记忆", extBlocks });
      }
      if (action === "undo") {
        if (messages.length <= 1) return { ok: false, error: "没有可撤回的对话" };
        if (messages[messages.length - 1].role === "assistant") {
          messages.pop();
          if (messages.length > 1 && messages[messages.length - 1].role === "user") messages.pop();
        } else {
          messages.pop();
        }
        const validDc = messages.slice(1).filter(m => m.role === "user" || m.role === "assistant").length;
        rollbackSettlementsAfter(messages, state, validDc, { pruneBannersAfter: validDc });
        saveSessionForChar(charObj.id, messages, state);
        return buildClientPayload(charObj, messages, state, saveFile, { notice: "已撤回上一轮对话" });
      }
      if (action === "retry") {
        if (messages.length < 3) return { ok: false, error: "没有可重生成的对话" };
        if (messages[messages.length - 1].role === "assistant") messages.pop();
        if (messages[messages.length - 1].role !== "user") return { ok: false, error: "当前末尾不是用户输入" };
        const validDc = messages.slice(1).filter(m => m.role === "user" || m.role === "assistant").length;
        rollbackSettlementsAfter(messages, state, validDc, { pruneBannersAfter: validDc });
        const [ok, reply, extBlocks] = await generateCharacterReply(charObj, messages, state, messages[messages.length - 1].content);
        if (!ok) return { ok: false, error: reply };
        messages.push({ role: "assistant", content: reply });
        saveSessionForChar(charObj.id, messages, state);
        return buildClientPayload(charObj, messages, state, saveFile, { notice: "已重新生成回复", extBlocks });
      }
      if (action === "backup") {
        const blob = new Blob([JSON.stringify({ state, messages }, null, 2)], { type: "application/json;charset=utf-8" });
        const dlUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = dlUrl;
        a.download = `backup_${charObj.name}_${formatNowStr().replace(/[-:\s]/g, "_")}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(dlUrl), 1000);
        return buildClientPayload(charObj, messages, state, saveFile, { notice: "已导出备份 JSON 文件" });
      }
      if (action === "reset") {
        Object.keys(state).forEach(k => delete state[k]);
        Object.assign(state, JSON.parse(JSON.stringify(charObj.default_state)), {
          time_banners: [],
          last_message_index: 1,
          last_status_time: formatNowStr(),
          settlement_history: []
        });
        reconcileStateLinkage(state);
        messages.splice(0, messages.length, { role: "system", content: charObj.base_prompt });
        const extBlocks = syncStateToSystemPrompt(messages, state);
        saveSessionForChar(charObj.id, messages, state);
        return buildClientPayload(charObj, messages, state, saveFile, { notice: "已重置当前角色存档", extBlocks });
      }
      if (action === "refer") {
        const ext = loadExtensionsStore();
        const recentTexts = messages.slice(-6).filter(m => m.role === "user" || m.role === "assistant").map(m => m.content || "");
        if (arg) recentTexts.push(arg);
        const blocks = buildExtensionPromptBlocks(ext, recentTexts);
        const refPrompt = [
          `当前扮演角色：${charObj.name}（${charObj.title}）`,
          `当前场景：${state.scene}｜时间：${state.current_time}`,
          blocks.persona_block,
          blocks.world_block,
          "请为玩家/对手提供 2 条自然、有张力的回复参考（可直接复制或微调）。",
          arg ? `方向提示：${arg}` : ""
        ].filter(Boolean).join("\n");

        const recentMsgs = messages.slice(-8).filter(m => m.role === "user" || m.role === "assistant").map(m => ({
          role: m.role === "user" ? "user" : "assistant",
          content: String(m.content || "")
        }));
        recentMsgs.push({ role: "user", content: refPrompt });
        const [ok, refText] = await callChatApi(recentMsgs, { temperature: 0.85, maxTokens: 800, timeout: 60000 });
        if (!ok) return { ok: false, error: refText };
        return buildClientPayload(charObj, messages, state, saveFile, { referText: refText, extBlocks: blocks });
      }
      if (["check", "anchor", "ooc", "settle", "status"].includes(action)) {
        if (action === "settle" || action === "status") {
          const [ok, , msg] = await performSettlement(charObj, messages, state, "剧情复盘");
          if (!ok) return { ok: false, error: msg };
          const extBlocks = syncStateToSystemPrompt(messages, state);
          return buildClientPayload(charObj, messages, state, saveFile, { notice: msg, metaOutput: msg, extBlocks });
        }
        const recentMsgs = messages.slice(-12).filter(m => m.role === "user" || m.role === "assistant").map(m => ({
          role: m.role === "user" ? "user" : "assistant",
          content: String(m.content || "")
        }));
        const instructionMap = {
          check: "请基于当前对话与状态，简要侧写角色当下的表象心理（轨道A）、深层潜台词（轨道B）与面具完整度。",
          anchor: "请提炼当前剧情的关键记忆锚点摘要（150字以内），便于后续长线续写。",
          ooc: `作为场外剧场助手，请回答或处理以下 OOC 请求：${arg || "给出当前剧情推进建议"}`
        };
        recentMsgs.push({ role: "user", content: instructionMap[action] });
        const [ok, outText] = await callChatApi(recentMsgs, { temperature: 0.6, maxTokens: 900, timeout: 60000 });
        if (!ok) return { ok: false, error: outText };
        return buildClientPayload(charObj, messages, state, saveFile, { metaOutput: outText });
      }
      return { ok: false, error: `不支持的操作: ${action}` };
    }

    return { ok: false, error: `未知请求路径: ${path}` };
  }
};