/**
 * 本地语C剧场前端交互逻辑模块。
 *
 * 主要功能：
 * 1. 统一封装 apiFetch（自动处理 JSON 解析、HTTP 错误与可选访问口令 X-Access-Token）。
 * 2. 管理主题、自定义配色、对话字体与字号等本地外观偏好（localStorage）。
 * 3. 打通「轻量世界书」「用户人设卡」「对话补全预设」与服务端 /api/extensions 接口及本地缓存。
 * 4. 驱动角色管理、归档回收站恢复、会话渲染、消息行内编辑/重生成、时间标签编辑及模态框检索。
 * 5. 监听 visualViewport 变化，减少移动端全屏输入时软键盘对输入框与最新消息的遮挡。
 */

const DEFAULT_CUSTOM_THEME = {
  bg: "#121318", panel: "#1a1c24", panel2: "#222530", text: "#e6e8ef",
  accent: "#7c9cff", border: "#2e3240", userBg: "#24324d", aiBg: "#1f222d"
};
const FONT_PRESET_MAP = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Noto Serif SC", "Songti SC", SimSun, serif',
  kai: '"KaiTi", "STKaiti", "FZKai-Z03S", "FangSong", "STFangsong", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'
};
const UI_PREF_KEY = "yc_theater_py_ui_prefs_v5";
const WORLDBOOK_KEY = "yc_theater_py_worldbooks_v1";
const ACCESS_TOKEN_KEY = "yc_theater_access_token";

function createDefaultWorldbooksState() {
  return {
    activeId: "wb_default",
    books: [
      {
        id: "wb_default",
        title: "默认剧场世界观",
        entries: [
          {
            id: "entry_1",
            title: "默认扮演准则",
            keywords: "常驻",
            constant: true,
            enabled: true,
            order: 100,
            content: "遵循现实与人物关系逻辑推进剧情；保持第一人称视角，不替对方行动或越界替写心理。"
          }
        ]
      }
    ]
  };
}

let uiPrefs = {
  showStatusStrip: false,
  showTopbar: false,
  hideDesktopSidebar: false,
  theme: "classic",
  fontPreset: "sans",
  customFontFamily: "",
  chatFontSize: 15,
  customTheme: { ...DEFAULT_CUSTOM_THEME }
};
let worldbookState = createDefaultWorldbooksState();
let extensionsData = {
  active_persona_id: "persona_default",
  personas: [],
  active_preset_id: "preset_default_rp",
  presets: [],
  world_entries: []
};
let editingPersonaId = "";
let editingPresetId = "";

let charactersList = [];
let currentCharId = "";
let currentCharData = null;
let currentCharName = "角色";
let currentMessages = [];
let currentState = {};
let referDraft = "";
let editingIndex = null;
let draftContent = "";
let editingBannerId = null;
let draftBannerLabel = "";
let revealedMsgIndex = null;
let busy = false;
let lastBusyTip = "";
let lastModalCanSaveMemo = false;
let historyViewMode = "list";
let setSubBarOpen = false;

// ==================== 统一 API 请求封装（含网络异常与口令处理） ====================

async function apiFetch(url, options = {}) {
  return await window.LocalTheaterEngine.dispatch(url, options);
}


// ==================== 轻量世界书 / 用户人设卡 / 对话补全预设 ====================

function loadWorldbooks() {
  try {
    const raw = JSON.parse(localStorage.getItem(WORLDBOOK_KEY) || "null");
    if (raw && Array.isArray(raw.books) && raw.books.length > 0) {
      const books = raw.books.map((b, idx) => ({
        id: String(b.id || `wb_${idx + 1}`),
        title: String(b.title || `世界书 ${idx + 1}`),
        entries: Array.isArray(b.entries)
          ? b.entries.map((e, eIdx) => ({
              id: String(e.id || `entry_${idx + 1}_${eIdx + 1}`),
              title: String(e.title || `条目 ${eIdx + 1}`),
              keywords: Array.isArray(e.keywords) ? e.keywords.join(", ") : String(e.keywords || ""),
              constant: Boolean(e.constant),
              enabled: e.enabled !== false,
              order: Number.isFinite(Number(e.order)) ? Number(e.order) : 100,
              content: String(e.content || "")
            }))
          : []
      }));
      const activeId = books.some(b => b.id === raw.activeId) ? raw.activeId : books[0].id;
      worldbookState = { activeId, books };
      return;
    }
  } catch (_) {}
  worldbookState = createDefaultWorldbooksState();
}

function saveWorldbooks() {
  localStorage.setItem(WORLDBOOK_KEY, JSON.stringify(worldbookState));
  renderWorldbookControls();
}

function getActiveWorldbook() {
  if (!Array.isArray(worldbookState.books) || !worldbookState.books.length) {
    worldbookState = createDefaultWorldbooksState();
  }
  return worldbookState.books.find(b => b.id === worldbookState.activeId) || worldbookState.books[0];
}

function parseKeywordsList(rawKeys) {
  if (Array.isArray(rawKeys)) {
    return rawKeys.map(k => String(k || "").trim()).filter(Boolean);
  }
  return String(rawKeys || "")
    .split(/[,，、;；|/\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

async function syncWorldbookToBackend() {
  const book = getActiveWorldbook();
  if (!book) return;
  const serverEntries = Array.isArray(extensionsData.world_entries) ? extensionsData.world_entries : [];
  const bookEntries = Array.isArray(book.entries) ? book.entries : [];
  const localIds = new Set(bookEntries.map(e => String(e.id)));

  for (const oldItem of serverEntries) {
    if (!localIds.has(String(oldItem.id))) {
      await apiFetch("/api/extensions/worldbook/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: oldItem.id })
      }).catch(() => {});
    }
  }

  for (const e of bookEntries) {
    await apiFetch("/api/extensions/worldbook/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: e.id,
        title: e.title || `${book.title}条目`,
        keys: parseKeywordsList(e.keywords),
        content: e.content || "",
        enabled: e.enabled !== false,
        constant: Boolean(e.constant),
        order: Number.isFinite(Number(e.order)) ? Number(e.order) : 100
      })
    }).catch(() => {});
  }
}

async function loadExtensionsFromServer(syncLocalWhenEmpty = false) {
  try {
    const res = await apiFetch("/api/extensions");
    if (!res || !res.ok || !res.data) return;
    extensionsData = Object.assign(
      {
        active_persona_id: "persona_default",
        personas: [],
        active_preset_id: "preset_default_rp",
        presets: [],
        world_entries: []
      },
      res.data
    );

    const srvEntries = Array.isArray(extensionsData.world_entries) ? extensionsData.world_entries : [];
    const activeBook = getActiveWorldbook();
    if (srvEntries.length > 0) {
      const mapped = srvEntries.map((item, idx) => ({
        id: String(item.id || `wb_srv_${idx + 1}`),
        title: String(item.title || `条目 ${idx + 1}`),
        keywords: Array.isArray(item.keys) ? item.keys.join(", ") : String(item.keys || ""),
        constant: Boolean(item.constant),
        enabled: item.enabled !== false,
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : 100,
        content: String(item.content || "")
      }));
      if (!activeBook.entries || !activeBook.entries.length) {
        activeBook.entries = mapped;
      } else {
        const byId = new Map(activeBook.entries.map(e => [String(e.id), e]));
        mapped.forEach(m => {
          if (!byId.has(String(m.id))) activeBook.entries.push(m);
        });
      }
      localStorage.setItem(WORLDBOOK_KEY, JSON.stringify(worldbookState));
    } else if (syncLocalWhenEmpty && activeBook.entries?.length > 0) {
      await syncWorldbookToBackend();
    }

    renderWorldbookControls();
    renderPersonaControls();
    renderPresetControls();
  } catch (err) {
    console.warn("加载扩展配置失败，使用本地兜底:", err);
    renderWorldbookControls();
    renderPersonaControls();
    renderPresetControls();
  }
}

function getMatchedWorldbookEntries(queryText = "") {
  const book = getActiveWorldbook();
  if (!book || !Array.isArray(book.entries)) return [];
  const q = String(queryText || "").toLowerCase();
  return book.entries
    .filter(entry => {
      if (!entry || entry.enabled === false || !String(entry.content || "").trim()) return false;
      const kwRaw = String(entry.keywords || "").trim();
      if (entry.constant || !kwRaw || kwRaw === "常驻" || kwRaw === "全部") return true;
      if (!q) return false;
      const kws = parseKeywordsList(kwRaw).map(s => s.toLowerCase());
      return kws.some(kw => q.includes(kw));
    })
    .sort((a, b) => (Number(a.order) || 100) - (Number(b.order) || 100));
}

function buildWorldbookPromptPrefix(queryText = "") {
  const matched = getMatchedWorldbookEntries(queryText);
  if (!matched.length) return "";
  const lines = matched.map((e, i) => `${i + 1}. ${e.content.trim()}`);
  return `【世界书补充设定】\n${lines.join("\n")}\n\n`;
}

function renderWorldbookControls() {
  const book = getActiveWorldbook();
  const sel = document.getElementById("worldbookSelect");
  const modalSel = document.getElementById("wbModalSelect");
  const badge = document.getElementById("wbActiveBadge");
  const helper = document.getElementById("wbHelperSummary");

  const entries = Array.isArray(book?.entries) ? book.entries : [];
  const enabledCount = entries.filter(e => e.enabled !== false && String(e.content || "").trim()).length;
  const constCount = entries.filter(e => e.enabled !== false && e.constant).length;
  if (badge) badge.textContent = `已启 ${enabledCount} 条`;
  if (helper) {
    helper.textContent = `当前「${book.title || "未命名世界书"}」· 常驻 ${constCount} 条 / 关键词条目 ${Math.max(0, enabledCount - constCount)} 条`;
  }

  const fillSelect = (el) => {
    if (!el) return;
    el.innerHTML = "";
    worldbookState.books.forEach(b => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.title || "未命名世界书";
      if (b.id === book.id) opt.selected = true;
      el.appendChild(opt);
    });
  };
  fillSelect(sel);
  fillSelect(modalSel);

  const titleInp = document.getElementById("wbTitleInput");
  if (titleInp && document.activeElement !== titleInp) {
    titleInp.value = book.title || "";
  }

  const countSpan = document.getElementById("wbEntryCountSpan");
  if (countSpan) countSpan.textContent = String(entries.length);

  const listEl = document.getElementById("wbEntryList");
  if (!listEl) return;
  listEl.innerHTML = "";
  if (!entries.length) {
    listEl.innerHTML = `<div style="font-size:12px;color:var(--muted);">当前世界书暂无条目，可在上方添加。</div>`;
    return;
  }

  entries.forEach((entry, idx) => {
    const card = document.createElement("div");
    card.className = "wb-entry-card";
    const kwLabel = entry.constant ? "常驻生效" : (entry.keywords || "未设关键词");
    const enabled = entry.enabled !== false;
    const titleStr = entry.title ? `${escapeHtml(entry.title)} · ` : "";

    card.innerHTML = `
      <div class="wb-entry-head">
        <span><b>#${idx + 1}</b> ${titleStr}关键词：${escapeHtml(kwLabel)}（序 ${Number(entry.order) || 100}）</span>
        <span style="color:${enabled ? "var(--ok)" : "var(--muted)"};">${enabled ? "已启用" : "已停用"}</span>
      </div>
      <div class="wb-entry-body">${escapeHtml(entry.content || "")}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "history-item-actions";

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = enabled ? "停用" : "启用";
    toggleBtn.onclick = () => toggleWorldbookEntry(entry.id);

    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "删除";
    delBtn.onclick = () => deleteWorldbookEntry(entry.id);

    actions.append(toggleBtn, delBtn);
    card.appendChild(actions);
    listEl.appendChild(card);
  });
}

async function handleWorldbookSelectChange(wbId) {
  if (!wbId) return;
  worldbookState.activeId = wbId;
  saveWorldbooks();
  await syncWorldbookToBackend();
  const book = getActiveWorldbook();
  showToast(`已切换世界书：${book.title}`);
}

function openWorldbookModal() {
  renderWorldbookControls();
  document.getElementById("worldbookModalMask").style.display = "flex";
}

async function switchActiveWorldbook(wbId) {
  if (!wbId) return;
  worldbookState.activeId = wbId;
  saveWorldbooks();
  await syncWorldbookToBackend();
}

async function createNewWorldbook() {
  const name = (prompt("请输入新世界书名称：") || "").trim();
  if (!name) return;
  const newId = `wb_${Date.now()}`;
  worldbookState.books.push({ id: newId, title: name, entries: [] });
  worldbookState.activeId = newId;
  saveWorldbooks();
  await syncWorldbookToBackend();
  showToast(`已新建世界书：${name}`);
}

async function deleteCurrentWorldbook() {
  if (worldbookState.books.length <= 1) {
    return alert("至少需要保留一本世界书。");
  }
  const book = getActiveWorldbook();
  if (!confirm(`确定要删除世界书「${book.title}」吗？`)) return;
  worldbookState.books = worldbookState.books.filter(b => b.id !== book.id);
  worldbookState.activeId = worldbookState.books[0].id;
  saveWorldbooks();
  await syncWorldbookToBackend();
  showToast("已删除世界书");
}

function updateCurrentWorldbookTitle(val) {
  const book = getActiveWorldbook();
  book.title = String(val || "").trim() || "未命名世界书";
  localStorage.setItem(WORLDBOOK_KEY, JSON.stringify(worldbookState));
  const helper = document.getElementById("wbHelperSummary");
  if (helper) {
    const entries = Array.isArray(book.entries) ? book.entries : [];
    const enabledCount = entries.filter(e => e.enabled !== false && String(e.content || "").trim()).length;
    const constCount = entries.filter(e => e.enabled !== false && e.constant).length;
    helper.textContent = `当前「${book.title}」· 常驻 ${constCount} 条 / 关键词条目 ${Math.max(0, enabledCount - constCount)} 条`;
  }
  [document.getElementById("worldbookSelect"), document.getElementById("wbModalSelect")].forEach(el => {
    if (!el) return;
    const opt = el.querySelector(`option[value="${CSS.escape(book.id)}"]`);
    if (opt) opt.textContent = book.title;
  });
}

async function addWorldbookEntry() {
  const titleInput = document.getElementById("wbEntryTitleInput");
  const kwInput = document.getElementById("wbEntryKeyInput");
  const constChk = document.getElementById("wbEntryConstantChk");
  const orderInput = document.getElementById("wbEntryOrderInput");
  const contentInput = document.getElementById("wbEntryContentInput");
  const content = (contentInput?.value || "").trim();
  if (!content) return alert("世界书条目内容不能为空");

  const book = getActiveWorldbook();
  const entry = {
    id: `wb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: (titleInput?.value || "").trim() || `${book.title}条目`,
    keywords: (kwInput?.value || "").trim(),
    constant: Boolean(constChk?.checked),
    enabled: true,
    order: Number.isFinite(Number(orderInput?.value)) ? Number(orderInput.value) : 100,
    content
  };
  book.entries.push(entry);
  if (titleInput) titleInput.value = "";
  if (kwInput) kwInput.value = "";
  if (contentInput) contentInput.value = "";
  saveWorldbooks();

  await apiFetch("/api/extensions/worldbook/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: entry.id,
      title: entry.title,
      keys: parseKeywordsList(entry.keywords),
      content: entry.content,
      enabled: true,
      constant: entry.constant,
      order: entry.order
    })
  }).catch(() => {});

  showToast("已添加世界书条目");
}

async function toggleWorldbookEntry(entryId) {
  const book = getActiveWorldbook();
  const target = (book.entries || []).find(e => e.id === entryId);
  if (!target) return;
  target.enabled = target.enabled === false ? true : false;
  saveWorldbooks();

  await apiFetch("/api/extensions/worldbook/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: target.id,
      title: target.title || `${book.title}条目`,
      keys: parseKeywordsList(target.keywords),
      content: target.content || "",
      enabled: target.enabled,
      constant: Boolean(target.constant),
      order: Number(target.order) || 100
    })
  }).catch(() => {});
}

async function deleteWorldbookEntry(entryId) {
  const book = getActiveWorldbook();
  book.entries = (book.entries || []).filter(e => e.id !== entryId);
  saveWorldbooks();

  await apiFetch("/api/extensions/worldbook/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: entryId })
  }).catch(() => {});
}

// ==================== 用户人设卡（玩家身份） ====================

function getActivePersonaObj() {
  const list = Array.isArray(extensionsData.personas) ? extensionsData.personas : [];
  if (!list.length) {
    return { id: "persona_default", name: "默认玩家身份", title: "剧中人" };
  }
  return list.find(p => String(p.id) === String(extensionsData.active_persona_id)) || list[0];
}

function renderPersonaControls() {
  const list = Array.isArray(extensionsData.personas) && extensionsData.personas.length
    ? extensionsData.personas
    : [{ id: "persona_default", name: "默认玩家身份", title: "剧中人" }];
  const active = getActivePersonaObj();

  const sel = document.getElementById("personaSelect");
  const modalSel = document.getElementById("personaModalSelect");
  const summary = document.getElementById("personaHelperSummary");

  if (summary) {
    summary.textContent = `当前身份：${active.name || "未命名身份"}${active.title ? "（" + active.title + "）" : ""}`;
  }

  [sel, modalSel].forEach(el => {
    if (!el) return;
    el.innerHTML = "";
    list.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.name || "未命名身份"}${p.title ? " · " + p.title : ""}`;
      if (String(p.id) === String(active.id)) opt.selected = true;
      el.appendChild(opt);
    });
  });
}

async function handlePersonaSelectChange(personaId) {
  if (!personaId || busy) return;
  try {
    const res = await apiFetch("/api/extensions/persona/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: personaId })
    });
    if (res && res.ok) {
      extensionsData = Object.assign({}, extensionsData, res.data || {}, { active_persona_id: personaId });
      renderPersonaControls();
      showToast(res.notice || "已切换玩家身份");
    } else {
      showToast(res?.error || "切换身份卡失败");
    }
  } catch (err) {
    showToast("切换身份卡异常：" + err.message);
  }
}

function fillPersonaForm(p) {
  editingPersonaId = p?.id ? String(p.id) : "";
  document.getElementById("personaNameInput").value = p?.name || "";
  document.getElementById("personaTitleInput").value = p?.title || "";
  document.getElementById("personaAppearanceInput").value = p?.appearance || "";
  document.getElementById("personaPersonalityInput").value = p?.personality || "";
  document.getElementById("personaBackgroundInput").value = p?.background || "";
  document.getElementById("personaNotesInput").value = p?.notes || "";
  document.getElementById("personaSetActiveChk").checked = true;
}

function openPersonaModal() {
  renderPersonaControls();
  const active = getActivePersonaObj();
  fillPersonaForm(active);
  const modalSel = document.getElementById("personaModalSelect");
  if (modalSel && active?.id) modalSel.value = active.id;
  document.getElementById("personaModalMask").style.display = "flex";
}

function selectPersonaForEdit(personaId) {
  const list = Array.isArray(extensionsData.personas) ? extensionsData.personas : [];
  const found = list.find(p => String(p.id) === String(personaId));
  if (found) fillPersonaForm(found);
}

function prepareNewPersona() {
  editingPersonaId = "";
  fillPersonaForm({ name: "", title: "", appearance: "", personality: "", background: "", notes: "" });
  document.getElementById("personaNameInput").focus();
}

async function savePersonaCard() {
  const name = (document.getElementById("personaNameInput").value || "").trim();
  if (!name) return alert("请填写身份名称");
  setBusy(true, "正在保存玩家身份卡...");
  try {
    const res = await apiFetch("/api/extensions/persona/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: editingPersonaId || undefined,
        name,
        title: (document.getElementById("personaTitleInput").value || "").trim(),
        appearance: (document.getElementById("personaAppearanceInput").value || "").trim(),
        personality: (document.getElementById("personaPersonalityInput").value || "").trim(),
        background: (document.getElementById("personaBackgroundInput").value || "").trim(),
        notes: (document.getElementById("personaNotesInput").value || "").trim(),
        set_active: Boolean(document.getElementById("personaSetActiveChk").checked)
      })
    });
    if (!res || !res.ok) return alert(res?.error || "保存身份卡失败");
    extensionsData = Object.assign({}, extensionsData, res.data || {});
    editingPersonaId = res.persona?.id || editingPersonaId;
    renderPersonaControls();
    closeSpecificModal("personaModalMask");
    showToast(res.notice || "已保存身份卡");
  } catch (err) {
    alert("保存身份卡异常：" + err.message);
  } finally {
    setBusy(false, "");
  }
}

async function deleteSelectedPersona() {
  const list = Array.isArray(extensionsData.personas) ? extensionsData.personas : [];
  if (list.length <= 1) return alert("至少需要保留一张玩家身份卡");
  const targetId = editingPersonaId || document.getElementById("personaModalSelect")?.value || "";
  if (!targetId) return;
  if (!confirm("确定要删除这张玩家身份卡吗？")) return;
  setBusy(true, "正在删除身份卡...");
  try {
    const res = await apiFetch("/api/extensions/persona/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: targetId })
    });
    if (!res || !res.ok) return alert(res?.error || "删除身份卡失败");
    extensionsData = Object.assign({}, extensionsData, res.data || {});
    renderPersonaControls();
    fillPersonaForm(getActivePersonaObj());
    showToast(res.notice || "已删除身份卡");
  } catch (err) {
    alert("删除身份卡异常：" + err.message);
  } finally {
    setBusy(false, "");
  }
}

// ==================== 对话补全预设与人设补全联动 ====================

function getActivePresetObj() {
  const list = Array.isArray(extensionsData.presets) ? extensionsData.presets : [];
  if (!list.length) {
    return {
      id: "preset_default_rp",
      name: "默认剧场演绎",
      temperature: 0.85,
      max_tokens: 4096,
      context_turns: 24,
      inject_persona: true,
      inject_worldbook: true
    };
  }
  return list.find(pr => String(pr.id) === String(extensionsData.active_preset_id)) || list[0];
}

function renderPresetControls() {
  const list = Array.isArray(extensionsData.presets) && extensionsData.presets.length
    ? extensionsData.presets
    : [getActivePresetObj()];
  const active = getActivePresetObj();

  const sel = document.getElementById("presetSelect");
  const modalSel = document.getElementById("presetModalSelect");
  const summary = document.getElementById("presetHelperSummary");

  if (summary) {
    const t = active.temperature ?? 0.85;
    const turns = active.context_turns ?? 24;
    summary.textContent = `当前预设：${active.name || "未命名预设"}（Temp ${t} · 上下文 ${turns} 轮）`;
  }

  [sel, modalSel].forEach(el => {
    if (!el) return;
    el.innerHTML = "";
    list.forEach(pr => {
      const opt = document.createElement("option");
      opt.value = pr.id;
      opt.textContent = pr.name || "未命名预设";
      if (String(pr.id) === String(active.id)) opt.selected = true;
      el.appendChild(opt);
    });
  });
}

async function handlePresetSelectChange(presetId) {
  if (!presetId || busy) return;
  try {
    const res = await apiFetch("/api/extensions/preset/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: presetId })
    });
    if (res && res.ok) {
      extensionsData = Object.assign({}, extensionsData, res.data || {}, { active_preset_id: presetId });
      renderPresetControls();
      showToast(res.notice || "已切换补全预设");
    } else {
      showToast(res?.error || "切换补全预设失败");
    }
  } catch (err) {
    showToast("切换补全预设异常：" + err.message);
  }
}

function fillPresetForm(pr) {
  editingPresetId = pr?.id ? String(pr.id) : "";
  document.getElementById("presetNameInput").value = pr?.name || "";
  document.getElementById("presetTempInput").value = pr?.temperature ?? 0.85;
  document.getElementById("presetMaxTokensInput").value = pr?.max_tokens ?? 4096;
  document.getElementById("presetContextTurnsInput").value = pr?.context_turns ?? 24;
  document.getElementById("presetInjectPersonaChk").checked = pr?.inject_persona !== false;
  document.getElementById("presetInjectWbChk").checked = pr?.inject_worldbook !== false;
  document.getElementById("presetPrefixInput").value = pr?.system_prefix || "";
  document.getElementById("presetSuffixInput").value = pr?.system_suffix || "";
  document.getElementById("presetSetActiveChk").checked = true;
}

function openPresetModal() {
  renderPresetControls();
  const active = getActivePresetObj();
  fillPresetForm(active);
  const modalSel = document.getElementById("presetModalSelect");
  if (modalSel && active?.id) modalSel.value = active.id;
  document.getElementById("presetModalMask").style.display = "flex";
}

function selectPresetForEdit(presetId) {
  const list = Array.isArray(extensionsData.presets) ? extensionsData.presets : [];
  const found = list.find(pr => String(pr.id) === String(presetId));
  if (found) fillPresetForm(found);
}

function prepareNewPreset() {
  editingPresetId = "";
  fillPresetForm({
    name: "",
    temperature: 0.85,
    max_tokens: 4096,
    context_turns: 24,
    inject_persona: true,
    inject_worldbook: true,
    system_prefix: "",
    system_suffix: ""
  });
  document.getElementById("presetNameInput").focus();
}

async function savePresetConfig() {
  const name = (document.getElementById("presetNameInput").value || "").trim();
  if (!name) return alert("请填写预设名称");
  setBusy(true, "正在保存对话补全预设...");
  try {
    const res = await apiFetch("/api/extensions/preset/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: editingPresetId || undefined,
        name,
        temperature: parseFloat(document.getElementById("presetTempInput").value),
        max_tokens: parseInt(document.getElementById("presetMaxTokensInput").value, 10) || 4096,
        context_turns: parseInt(document.getElementById("presetContextTurnsInput").value, 10) || 24,
        inject_persona: Boolean(document.getElementById("presetInjectPersonaChk").checked),
        inject_worldbook: Boolean(document.getElementById("presetInjectWbChk").checked),
        system_prefix: (document.getElementById("presetPrefixInput").value || "").trim(),
        system_suffix: (document.getElementById("presetSuffixInput").value || "").trim(),
        set_active: Boolean(document.getElementById("presetSetActiveChk").checked)
      })
    });
    if (!res || !res.ok) return alert(res?.error || "保存预设失败");
    extensionsData = Object.assign({}, extensionsData, res.data || {});
    editingPresetId = res.preset?.id || editingPresetId;
    renderPresetControls();
    closeSpecificModal("presetModalMask");
    showToast(res.notice || "已保存预设");
  } catch (err) {
    alert("保存预设异常：" + err.message);
  } finally {
    setBusy(false, "");
  }
}

async function deleteSelectedPreset() {
  const list = Array.isArray(extensionsData.presets) ? extensionsData.presets : [];
  if (list.length <= 1) return alert("至少需要保留一套对话补全预设");
  const targetId = editingPresetId || document.getElementById("presetModalSelect")?.value || "";
  if (!targetId) return;
  if (!confirm("确定要删除这套对话补全预设吗？")) return;
  setBusy(true, "正在删除补全预设...");
  try {
    const res = await apiFetch("/api/extensions/preset/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: targetId })
    });
    if (!res || !res.ok) return alert(res?.error || "删除预设失败");
    extensionsData = Object.assign({}, extensionsData, res.data || {});
    renderPresetControls();
    fillPresetForm(getActivePresetObj());
    showToast(res.notice || "已删除补全预设");
  } catch (err) {
    alert("删除预设异常：" + err.message);
  } finally {
    setBusy(false, "");
  }
}

async function triggerDialogueCompletion() {
  if (busy) return;
  const input = document.getElementById("msgInput");
  const userHint = (input?.value || "").trim();
  const preset = getActivePresetObj();
  const persona = getActivePersonaObj();
  const wbPrefix = preset.inject_worldbook === false
    ? ""
    : buildWorldbookPromptPrefix(userHint || currentState.scene || "");

  const combinedHint = [
    preset.name ? `补全风格：${preset.name}` : "",
    preset.inject_persona !== false && persona?.name ? `当前玩家：${persona.name}` : "",
    wbPrefix.trim(),
    userHint ? `草稿提示：${userHint}` : "请补全下一条自然连贯的玩家回复草稿"
  ]
    .filter(Boolean)
    .join("\n");

  setBusy(true, "正在生成对话补全草稿...");
  try {
    const data = await apiFetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char_id: currentCharId, action: "refer", arg: combinedHint })
    });
    if (!data.ok) return alert("对话补全失败：" + (data.error || ""));
    referDraft = data.refer_text || "";
    renderChatMessages();
    scrollChatToBottom();
    showToast("已生成对话补全草稿");
  } catch (err) {
    alert("对话补全异常：" + err.message);
  } finally {
    setBusy(false, "");
  }
}

async function completeCurrentCharacterDraft() {
  if (busy || !currentCharData) return;
  if (!confirm(`是否调用 API 自动补齐并整理当前角色「${currentCharName}」的身份头衔、开场双轨状态与设定正文？`)) {
    return;
  }
  setBusy(true, "正在补齐当前人物卡设定...");
  try {
    const ds = currentCharData.default_state || {};
    const draft = {
      name: currentCharData.name,
      title: currentCharData.title,
      avatar: currentCharData.avatar || "",
      affection: ds.affection ?? 0,
      current_time: ds.current_time || "",
      scene: ds.scene || "",
      track_a: ds.track_a || "",
      track_b: ds.track_b || "",
      mask_integrity: ds.mask_integrity || "",
      base_prompt: currentCharData.base_prompt || ""
    };
    const comp = await apiFetch("/api/character/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw_text: currentCharData.base_prompt || "",
        draft,
        fallback_name: currentCharData.name
      })
    });
    if (!comp.ok || !comp.character) {
      return alert("补齐失败：" + (comp.error || "未知错误"));
    }
    const c = comp.character;
    const cds = c.default_state || {};
    const saved = await apiFetch("/api/character/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        char_id: currentCharId,
        name: c.name || currentCharData.name,
        title: c.title || currentCharData.title,
        current_time: cds.current_time || ds.current_time || "",
        scene: cds.scene || ds.scene || "默认场景",
        affection: cds.affection ?? ds.affection ?? 0,
        track_a: cds.track_a || ds.track_a || "初识观察中",
        track_b: cds.track_b || ds.track_b || "防备与客套并存",
        mask_integrity: cds.mask_integrity || ds.mask_integrity || "完整",
        base_prompt: c.base_prompt || currentCharData.base_prompt || "",
        sync_current: true
      })
    });
    if (saved.ok) {
      await refreshCharacterList(saved.character.id);
      renderSession(saved, false);
      showToast("已补齐并保存当前人物卡设定");
    } else {
      alert("保存补齐结果失败：" + (saved.error || ""));
    }
  } catch (err) {
    alert("补齐异常：" + err.message);
  } finally {
    setBusy(false, "");
  }
}

// ==================== 外观主题与字体偏好 ====================

function clampFontSize(val) {
  const num = parseInt(val, 10);
  if (Number.isNaN(num)) return 15;
  return Math.min(22, Math.max(12, num));
}

function loadUiPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(UI_PREF_KEY) || "{}");
    const validThemes = ["classic", "dark", "light", "pink", "wechat", "custom"];
    const validFonts = ["sans", "serif", "kai", "mono", "custom"];
    uiPrefs = {
      showStatusStrip: Boolean(raw.showStatusStrip),
      showTopbar: Boolean(raw.showTopbar),
      hideDesktopSidebar: Boolean(raw.hideDesktopSidebar),
      theme: validThemes.includes(raw.theme) ? raw.theme : "classic",
      fontPreset: validFonts.includes(raw.fontPreset) ? raw.fontPreset : "sans",
      customFontFamily: String(raw.customFontFamily || ""),
      chatFontSize: clampFontSize(raw.chatFontSize ?? 15),
      customTheme: Object.assign({}, DEFAULT_CUSTOM_THEME, raw.customTheme || {})
    };
  } catch (_) {}
}

function saveUiPrefs() {
  localStorage.setItem(UI_PREF_KEY, JSON.stringify(uiPrefs));
}

function applyChatFontFamily() {
  const preset = uiPrefs.fontPreset || "sans";
  const customTrim = String(uiPrefs.customFontFamily || "").trim();
  let stack = FONT_PRESET_MAP[preset] || FONT_PRESET_MAP.sans;
  if (preset === "custom" && customTrim) {
    stack = `${customTrim}, ${FONT_PRESET_MAP.sans}`;
  }
  document.documentElement.style.setProperty("--chat-font-family", stack);

  const sel = document.getElementById("chatFontPresetSelect");
  const row = document.getElementById("customFontRow");
  const inp = document.getElementById("customFontFamilyInput");
  if (sel) sel.value = preset;
  if (row) row.style.display = preset === "custom" ? "flex" : "none";
  if (inp && document.activeElement !== inp) inp.value = uiPrefs.customFontFamily || "";
}

function handleFontPresetChange(val) {
  uiPrefs.fontPreset = val;
  saveUiPrefs();
  applyChatFontFamily();
  if (val === "custom") {
    const inp = document.getElementById("customFontFamilyInput");
    if (inp) inp.focus();
  } else {
    showToast("已切换对话字体");
  }
}

function handleCustomFontInput(val) {
  uiPrefs.customFontFamily = val;
  saveUiPrefs();
  applyChatFontFamily();
}

function applyChatFontSize() {
  const px = clampFontSize(uiPrefs.chatFontSize ?? 15);
  uiPrefs.chatFontSize = px;
  document.documentElement.style.setProperty("--chat-font-size", `${px}px`);
  const slider = document.getElementById("chatFontSizeSlider");
  const label = document.getElementById("chatFontSizeLabel");
  if (slider) slider.value = String(px);
  if (label) label.textContent = `${px}px`;
}

function setChatFontSize(px) {
  uiPrefs.chatFontSize = clampFontSize(px);
  saveUiPrefs();
  applyChatFontSize();
  showToast(`对话字体字号已设为 ${uiPrefs.chatFontSize}px`);
}

function handleChatFontSizeChange(val) {
  uiPrefs.chatFontSize = clampFontSize(val);
  saveUiPrefs();
  applyChatFontSize();
}

function isHexLight(hex) {
  const clean = String(hex || "").replace("#", "");
  if (clean.length !== 6) return false;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return false;
  return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.62;
}

function applyTheme() {
  const root = document.documentElement;
  const theme = uiPrefs.theme || "classic";
  root.setAttribute("data-theme", theme);
  const customKeys = ["--bg", "--panel", "--panel-2", "--panel-3", "--input-bg", "--border", "--text", "--accent", "--accent-fg", "--user-bg", "--ai-bg"];
  if (theme === "custom") {
    const ct = Object.assign({}, DEFAULT_CUSTOM_THEME, uiPrefs.customTheme || {});
    const lightBg = isHexLight(ct.bg);
    const lightAccent = isHexLight(ct.accent);
    root.style.setProperty("--bg", ct.bg);
    root.style.setProperty("--panel", ct.panel);
    root.style.setProperty("--panel-2", ct.panel2);
    root.style.setProperty("--panel-3", ct.panel2);
    root.style.setProperty("--input-bg", lightBg ? "#ffffff" : "#12141b");
    root.style.setProperty("--border", ct.border);
    root.style.setProperty("--text", ct.text);
    root.style.setProperty("--accent", ct.accent);
    root.style.setProperty("--accent-fg", lightAccent ? "#111318" : "#ffffff");
    root.style.setProperty("--user-bg", ct.userBg);
    root.style.setProperty("--ai-bg", ct.aiBg);
    const meta = document.getElementById("themeColorMeta");
    if (meta) meta.setAttribute("content", ct.bg);
  } else {
    customKeys.forEach(k => root.style.removeProperty(k));
    const metaMap = { classic: "#121318", dark: "#0b0c0f", light: "#f4f5f8", pink: "#1c1318", wechat: "#ededed" };
    const meta = document.getElementById("themeColorMeta");
    if (meta) meta.setAttribute("content", metaMap[theme] || "#121318");
  }
  const sel = document.getElementById("themeSelect");
  if (sel) sel.value = theme;
  const btnRow = document.getElementById("customThemeBtnRow");
  if (btnRow) btnRow.style.display = theme === "custom" ? "flex" : "none";
}

function handleThemeSelectChange(val) {
  uiPrefs.theme = val;
  saveUiPrefs();
  applyTheme();
  if (val === "custom") openCustomThemeModal();
  else showToast("已切换主题外观");
}

function openCustomThemeModal() {
  const ct = Object.assign({}, DEFAULT_CUSTOM_THEME, uiPrefs.customTheme || {});
  document.getElementById("ctBg").value = ct.bg;
  document.getElementById("ctPanel").value = ct.panel;
  document.getElementById("ctPanel2").value = ct.panel2;
  document.getElementById("ctText").value = ct.text;
  document.getElementById("ctAccent").value = ct.accent;
  document.getElementById("ctBorder").value = ct.border;
  document.getElementById("ctUserBg").value = ct.userBg;
  document.getElementById("ctAiBg").value = ct.aiBg;
  document.getElementById("customThemeModalMask").style.display = "flex";
}

function saveCustomTheme() {
  uiPrefs.customTheme = {
    bg: document.getElementById("ctBg").value || DEFAULT_CUSTOM_THEME.bg,
    panel: document.getElementById("ctPanel").value || DEFAULT_CUSTOM_THEME.panel,
    panel2: document.getElementById("ctPanel2").value || DEFAULT_CUSTOM_THEME.panel2,
    text: document.getElementById("ctText").value || DEFAULT_CUSTOM_THEME.text,
    accent: document.getElementById("ctAccent").value || DEFAULT_CUSTOM_THEME.accent,
    border: document.getElementById("ctBorder").value || DEFAULT_CUSTOM_THEME.border,
    userBg: document.getElementById("ctUserBg").value || DEFAULT_CUSTOM_THEME.userBg,
    aiBg: document.getElementById("ctAiBg").value || DEFAULT_CUSTOM_THEME.aiBg
  };
  uiPrefs.theme = "custom";
  saveUiPrefs();
  applyTheme();
  closeSpecificModal("customThemeModalMask");
  showToast("已保存并应用自定义主题");
}

function resetCustomThemeToClassic() {
  uiPrefs.customTheme = { ...DEFAULT_CUSTOM_THEME };
  saveUiPrefs();
  openCustomThemeModal();
  applyTheme();
}

// ==================== 面板、顶栏与全屏控制 ====================

function applyDesktopSidebarPref() {
  const hidden = Boolean(uiPrefs.hideDesktopSidebar);
  document.body.classList.toggle("desktop-sidebar-hidden", hidden);
  const btn = document.getElementById("desktopSidebarBtn");
  if (btn) btn.textContent = hidden ? "显示面板" : "隐藏面板";
}

function toggleDesktopSidebar() {
  uiPrefs.hideDesktopSidebar = !uiPrefs.hideDesktopSidebar;
  saveUiPrefs();
  applyDesktopSidebarPref();
  showToast(uiPrefs.hideDesktopSidebar ? "已隐藏左侧面板" : "已显示左侧面板");
}

function toggleSetSubBar() {
  setSubBarOpen = !setSubBarOpen;
  const sub = document.getElementById("setSubBar");
  const btn = document.getElementById("setSubBarBtn");
  if (sub) sub.classList.toggle("open", setSubBarOpen);
  if (btn) btn.classList.toggle("primary", setSubBarOpen);
}

function openPanelFromSubBar() {
  if (window.innerWidth <= 1024) {
    toggleDrawer(true);
  } else {
    uiPrefs.hideDesktopSidebar = false;
    saveUiPrefs();
    applyDesktopSidebarPref();
  }
}

function applyHeaderBarsPref() {
  const strip = document.getElementById("statusStrip");
  const tb = document.getElementById("topbar");
  const btn = document.getElementById("statusStripBtn");
  const show = Boolean(uiPrefs.showStatusStrip || uiPrefs.showTopbar);
  if (strip) strip.classList.toggle("show", show);
  if (tb) tb.classList.toggle("visible", show);
  if (btn) btn.classList.toggle("primary", show);
}

function toggleStatusStrip() {
  const currentlyShown = Boolean(uiPrefs.showStatusStrip || uiPrefs.showTopbar);
  const next = !currentlyShown;
  uiPrefs.showStatusStrip = next;
  uiPrefs.showTopbar = next;
  saveUiPrefs();
  applyHeaderBarsPref();
  showToast(next ? "已显示标题栏与状态条" : "已隐藏标题栏与状态条");
}

function hideHeaderBars() {
  uiPrefs.showStatusStrip = false;
  uiPrefs.showTopbar = false;
  saveUiPrefs();
  applyHeaderBarsPref();
}

function isFullscreenActive() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

function updateFullscreenButton() {
  const txt = isFullscreenActive() ? "退出全屏" : "全屏";
  document.querySelectorAll(".fs-toggle-btn").forEach(btn => {
    btn.textContent = txt;
  });
}

async function toggleFullscreen() {
  try {
    if (!isFullscreenActive()) {
      const req = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
      if (req) await req.call(document.documentElement);
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) await exit.call(document);
    }
  } finally {
    updateFullscreenButton();
  }
}

document.addEventListener("fullscreenchange", updateFullscreenButton);
document.addEventListener("webkitfullscreenchange", updateFullscreenButton);

function toggleDrawer(forceState) {
  const sb = document.getElementById("sidebar");
  const bd = document.getElementById("drawerBackdrop");
  const nextState = typeof forceState === "boolean" ? forceState : !sb.classList.contains("expanded");
  sb.classList.toggle("expanded", nextState);
  if (bd) bd.classList.toggle("open", nextState);
}

// ==================== 移动端输入法可视视口补偿 ====================

function getFullscreenInset(vv) {
  if (!vv) return 0;
  const candidates = [
    document.documentElement.clientHeight || 0,
    window.innerHeight || 0,
    window.screen?.height || 0
  ].filter(h => h > 0);
  const fullHeight = Math.max(...candidates);
  const vvBottom = vv.height + (vv.offsetTop || 0);
  const diff = fullHeight - vvBottom;
  if (diff > 60) {
    return Math.round(diff + 24);
  }
  return 0;
}

function syncVisualViewportInset() {
  const vv = window.visualViewport;
  if (!vv || !isFullscreenActive()) {
    document.documentElement.style.setProperty("--vv-bottom-inset", "0px");
    return;
  }

  const inset = getFullscreenInset(vv);
  document.documentElement.style.setProperty("--vv-bottom-inset", `${inset}px`);

  if (inset > 0) {
    requestAnimationFrame(() => scrollChatToBottom());
  }
}

function bindVisualViewportEvents() {
  const scheduleFullscreenSync = () => {
    syncVisualViewportInset();
    [80, 220, 420].forEach(delay => {
      setTimeout(() => {
        syncVisualViewportInset();
        if (isFullscreenActive() && document.activeElement === document.getElementById("msgInput")) {
          scrollChatToBottom();
        }
      }, delay);
    });
  };

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncVisualViewportInset);
    window.visualViewport.addEventListener("scroll", syncVisualViewportInset);
  }
  window.addEventListener("resize", syncVisualViewportInset);
  document.addEventListener("fullscreenchange", syncVisualViewportInset);
  document.addEventListener("webkitfullscreenchange", syncVisualViewportInset);

  const msgInput = document.getElementById("msgInput");
  if (msgInput) {
    msgInput.addEventListener("focus", scheduleFullscreenSync);
    msgInput.addEventListener("click", scheduleFullscreenSync);
    msgInput.addEventListener("input", syncVisualViewportInset);
    msgInput.addEventListener("blur", () => {
      setTimeout(syncVisualViewportInset, 150);
    });
  }
}

// ==================== 提示、模态框与繁忙状态锁 ====================

function showToast(msg) {
  const el = document.getElementById("toast");
  const fl = document.getElementById("floatingToast");
  const tb = document.getElementById("topbar");
  if (el) el.textContent = msg || "";
  const showFloat = Boolean(msg) && (!tb || !tb.classList.contains("visible"));
  if (fl) {
    fl.textContent = msg || "";
    fl.classList.toggle("show", showFloat);
  }
  if (msg) {
    setTimeout(() => {
      if (el && el.textContent === msg) el.textContent = "";
      if (fl && fl.textContent === msg) {
        fl.textContent = "";
        fl.classList.remove("show");
      }
    }, 4500);
  }
}

function showModal(title, content, { allowSaveMemo = false } = {}) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").textContent = content;
  lastModalCanSaveMemo = Boolean(allowSaveMemo);
  document.getElementById("modalMemoBtn").style.display = lastModalCanSaveMemo ? "inline-block" : "none";
  document.getElementById("modalMask").style.display = "flex";
}

async function copyModalContent() {
  try {
    await navigator.clipboard.writeText(document.getElementById("modalBody").textContent || "");
    showToast("已复制到剪贴板");
  } catch (_) {
    showToast("复制失败");
  }
}

function saveModalToMemo() {
  const text = (document.getElementById("modalBody").textContent || "").trim();
  if (!text) return;
  closeSpecificModal("modalMask");
  doAction("memo", `【锚点摘要】${text.replace(/\s+/g, " ").slice(0, 180)}`);
}

function closeSpecificModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "none";
}

function closeModal(e, id) {
  if (e.target.id === id) closeSpecificModal(id);
}

function setBusy(flag, tip = "") {
  busy = flag;
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) sendBtn.disabled = flag;
  document.querySelectorAll(".q-btn").forEach(btn => {
    if (!["desktopSidebarBtn", "statusStripBtn", "setSubBarBtn"].includes(btn.id)) btn.disabled = flag;
  });
  document.querySelectorAll(".msg-tool-btn, .edit-actions button, .refer-actions button, .banner-edit-actions button, .btn-restore-archive").forEach(btn => {
    btn.disabled = flag;
  });
  if (flag && tip) {
    lastBusyTip = tip;
    showToast(tip);
  } else if (!flag) {
    if (tip) {
      showToast(tip);
    } else if (lastBusyTip) {
      const el = document.getElementById("toast");
      const fl = document.getElementById("floatingToast");
      if (el && el.textContent === lastBusyTip) el.textContent = "";
      if (fl && fl.textContent === lastBusyTip) {
        fl.textContent = "";
        fl.classList.remove("show");
      }
    }
    lastBusyTip = "";
  }
}

function scrollChatToBottom() {
  const box = document.getElementById("chatBox");
  if (box) box.scrollTop = box.scrollHeight;
}

function escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeFilename(name) {
  return String(name || "session").replace(/[\\/:*?"<>|]/g, "_");
}

// ==================== 归档回收站（查看与恢复） ====================

function openArchiveModal() {
  const modal = document.getElementById("archiveModal");
  if (!modal) return;
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  loadCharacterArchives();
}

function closeArchiveModal() {
  const modal = document.getElementById("archiveModal");
  if (!modal) return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
}

async function loadCharacterArchives() {
  const bodyEl = document.getElementById("archiveListBody");
  if (!bodyEl) return;
  bodyEl.innerHTML = `<p style="opacity: 0.7;">正在加载归档列表...</p>`;

  try {
    const data = await apiFetch("/api/character/archives");
    if (!data || data.ok === false) {
      bodyEl.innerHTML = `<p style="color: var(--danger);">加载失败：${escapeHtml(data?.error || "未知错误")}</p>`;
      return;
    }

    const list = Array.isArray(data.archives) ? data.archives : [];
    if (!list.length) {
      bodyEl.innerHTML = `<p style="opacity: 0.7;">归档目录中暂无已删除角色记录。</p>`;
      return;
    }

    bodyEl.innerHTML = list.map(item => {
      const archiveId = escapeHtml(item.archive_id || "");
      const name = escapeHtml(item.name || "未命名角色");
      const title = escapeHtml(item.title || "");
      const archivedAt = escapeHtml(item.archived_at || "未知");
      const dialogCount = Number(item.dialog_count || 0);

      return `
        <div class="history-item" style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
          <div style="min-width:0;">
            <div style="font-weight:600;">
              ${name}${title ? `<span style="font-weight:400;opacity:0.75;margin-left:6px;">· ${title}</span>` : ""}
            </div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px;">
              归档时间：${archivedAt} ｜ 对话条数：${dialogCount} 条
            </div>
          </div>
          <button type="button" class="primary btn-restore-archive" data-archive-id="${archiveId}" style="flex-shrink:0;">
            恢复
          </button>
        </div>
      `;
    }).join("");

    bodyEl.querySelectorAll(".btn-restore-archive").forEach(btn => {
      btn.addEventListener("click", async () => {
        const archiveId = btn.getAttribute("data-archive-id") || "";
        if (!archiveId || busy) return;
        await restoreCharacterArchive(archiveId, btn);
      });
    });
  } catch (err) {
    bodyEl.innerHTML = `<p style="color: var(--danger);">请求异常：${escapeHtml(err.message)}</p>`;
  }
}

async function restoreCharacterArchive(archiveId, btnEl = null) {
  const prevText = btnEl ? btnEl.textContent : "";
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "恢复中...";
  }
  setBusy(true, "正在从归档恢复角色与对话历史...");
  try {
    const data = await apiFetch("/api/character/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archive_id: archiveId })
    });
    if (!data || !data.ok) {
      showToast("恢复失败：" + (data?.error || "未知错误"));
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = prevText || "恢复";
      }
      return;
    }

    closeArchiveModal();
    editingIndex = null;
    draftContent = "";
    editingBannerId = null;
    draftBannerLabel = "";
    revealedMsgIndex = null;
    referDraft = "";
    await refreshCharacterList(data.character?.id || "");
    renderSession(data, true);
  } catch (err) {
    showToast("恢复请求异常：" + err.message);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = prevText || "恢复";
    }
  } finally {
    setBusy(false, "");
  }
}

function bindArchiveModalEvents() {
  const openBtn = document.getElementById("btnOpenArchiveModal");
  const closeBtn = document.getElementById("btnCloseArchiveModal");
  const modal = document.getElementById("archiveModal");

  if (openBtn) openBtn.addEventListener("click", openArchiveModal);
  if (closeBtn) closeBtn.addEventListener("click", closeArchiveModal);
  if (modal) {
    modal.addEventListener("click", e => {
      if (e.target === modal) closeArchiveModal();
    });
  }
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && modal && modal.style.display === "flex") {
      closeArchiveModal();
    }
  });
}

// ==================== 角色管理与设定编辑 ====================

function renderCharacterProfileCard(charObj) {
  const img = document.getElementById("charAvatarImg");
  const placeholder = document.getElementById("charAvatarPlaceholder");
  const nameEl = document.getElementById("charProfileName");
  const titleEl = document.getElementById("charProfileTitle");
  if (!charObj) return;
  nameEl.textContent = charObj.name || "未命名角色";
  titleEl.textContent = charObj.title || "语C角色";
  const avatarData = String(charObj.avatar || "").trim();
  if (avatarData) {
    img.src = avatarData;
    img.style.display = "block";
    placeholder.style.display = "none";
  } else {
    img.removeAttribute("src");
    img.style.display = "none";
    placeholder.style.display = "block";
    placeholder.textContent = (charObj.name || "角").slice(0, 1);
  }
}

function handleAvatarUpload(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxSide = 256;
      let { width, height } = img;
      if (width > maxSide || height > maxSide) {
        if (width >= height) {
          height = Math.round((height * maxSide) / width);
          width = maxSide;
        } else {
          width = Math.round((width * maxSide) / height);
          height = maxSide;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, width);
      canvas.height = Math.max(1, height);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      saveAvatarData(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.src = String(reader.result || "");
  };
  reader.readAsDataURL(file);
}

async function saveAvatarData(avatarStr) {
  if (busy) return;
  setBusy(true, "正在上传头像...");
  try {
    const data = await apiFetch("/api/character/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char_id: currentCharId, avatar: avatarStr })
    });
    if (data.ok) renderSession(data, false);
    else showToast(data.error || "更换头像失败");
  } catch (err) {
    showToast("更换头像异常：" + err.message);
  } finally {
    setBusy(false);
  }
}

async function refreshCharacterList(selectedId = "") {
  const data = await apiFetch("/api/characters");
  charactersList = data.characters || [];
  const sel = document.getElementById("charSelect");
  sel.innerHTML = "";
  charactersList.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.name}${c.title ? " - " + c.title : ""}`;
    if (c.id === (selectedId || currentCharId)) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.onchange = () => {
    editingIndex = null;
    draftContent = "";
    editingBannerId = null;
    draftBannerLabel = "";
    revealedMsgIndex = null;
    referDraft = "";
    loadSession(sel.value);
  };
}

async function createNewCharacter() {
  if (busy) return;
  const name = prompt("请输入新角色名称：");
  if (!name || !name.trim()) return;
  setBusy(true, "正在创建角色...");
  try {
    const data = await apiFetch("/api/character/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() })
    });
    if (!data.ok) return alert(data.error || "创建失败");
    await refreshCharacterList(data.character.id);
    renderSession(data, true);
  } finally {
    setBusy(false);
  }
}

async function deleteCurrentCharacter() {
  if (busy) return;
  if (charactersList.length <= 1) return alert("至少需要保留一位角色。");
  if (!confirm(`确定要归档并删除角色「${currentCharName}」吗？（可在“归档回收站”中恢复）`)) return;
  setBusy(true, "正在归档并删除角色...");
  try {
    const data = await apiFetch("/api/character/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char_id: currentCharId })
    });
    if (!data.ok) return alert(data.error || "删除失败");
    await refreshCharacterList(data.character.id);
    renderSession(data, true);
  } finally {
    setBusy(false);
  }
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCurrentCharacter() {
  const c = currentCharData;
  if (!c) return;
  downloadJson(c.file || `${c.name}.json`, {
    name: c.name,
    title: c.title,
    avatar: c.avatar || "",
    affection: c.default_state?.affection ?? 0,
    current_time: c.default_state?.current_time || "",
    scene: c.default_state?.scene || "默认场景",
    track_a: c.default_state?.track_a || "初识观察中",
    track_b: c.default_state?.track_b || "防备与客套并存",
    mask_integrity: c.default_state?.mask_integrity || "完整",
    base_prompt: c.base_prompt || ""
  });
  showToast("已导出当前角色设定 JSON");
}

function handleImportCharFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const text = String(reader.result || "");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) {}
    const baseName = file.name.replace(/\.(json|md|txt)$/i, "");

    let draft = {
      name: parsed?.name || baseName || "导入角色",
      title: parsed?.title || "",
      avatar: parsed?.avatar || "",
      affection: parsed?.affection ?? 0,
      current_time: parsed?.current_time || "",
      scene: parsed?.scene || "",
      track_a: parsed?.track_a || "",
      track_b: parsed?.track_b || "",
      mask_integrity: parsed?.mask_integrity || "",
      base_prompt: parsed?.base_prompt || (parsed ? "" : text)
    };

    const missingKeyFields = !draft.title || !draft.scene || !draft.track_a || !draft.track_b || !draft.base_prompt;
    if (missingKeyFields && confirm("检测到导入的角色设定部分字段不完整，是否唤起 API 自动补齐人设与初始双轨状态？")) {
      setBusy(true, "正在唤起 API 补齐角色设定...");
      try {
        const comp = await apiFetch("/api/character/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            raw_text: text,
            draft,
            fallback_name: baseName
          })
        });
        if (comp.ok && comp.character) {
          const c = comp.character;
          const ds = c.default_state || {};
          draft = Object.assign({}, draft, c, {
            affection: c.affection ?? ds.affection ?? draft.affection ?? 0,
            current_time: c.current_time ?? ds.current_time ?? draft.current_time ?? "",
            scene: c.scene ?? ds.scene ?? draft.scene ?? "",
            track_a: c.track_a ?? ds.track_a ?? draft.track_a ?? "",
            track_b: c.track_b ?? ds.track_b ?? draft.track_b ?? "",
            mask_integrity: c.mask_integrity ?? ds.mask_integrity ?? draft.mask_integrity ?? "",
            base_prompt: c.base_prompt ?? draft.base_prompt ?? ""
          });
        }
      } catch (_) {}
    }

    setBusy(true, "正在创建并导入角色设定...");
    try {
      const data = await apiFetch("/api/character/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name || baseName || "导入角色",
          title: draft.title || "导入设定",
          avatar: draft.avatar || "",
          affection: draft.affection ?? 0,
          current_time: draft.current_time || "",
          scene: draft.scene || "默认场景",
          track_a: draft.track_a || "初识观察中",
          track_b: draft.track_b || "防备与客套并存",
          mask_integrity: draft.mask_integrity || "完整",
          base_prompt: draft.base_prompt || text
        })
      });
      if (data.ok) {
        await refreshCharacterList(data.character.id);
        renderSession(data, true);
      } else {
        alert(data.error || "导入失败");
      }
    } finally {
      setBusy(false, "");
    }
  };
  reader.readAsText(file, "utf-8");
}

function openSettingModal() {
  if (!currentCharData) return;
  const ds = currentCharData.default_state || {};
  document.getElementById("settingFileName").textContent = currentCharData.file || currentCharData.id;
  document.getElementById("setCharName").value = currentCharData.name || "";
  document.getElementById("setCharTitle").value = currentCharData.title || "";
  document.getElementById("setDefaultTime").value = ds.current_time || currentState.current_time || "";
  document.getElementById("setDefaultScene").value = ds.scene || "默认场景";
  document.getElementById("setDefaultAff").value = ds.affection ?? 0;
  document.getElementById("setTrackA").value = ds.track_a || "初识观察中";
  document.getElementById("setTrackB").value = ds.track_b || "防备与客套并存";
  document.getElementById("setMaskIntegrity").value = ds.mask_integrity || "完整";
  document.getElementById("setBasePrompt").value = currentCharData.base_prompt || "";
  document.getElementById("settingModalMask").style.display = "flex";
}

async function saveCharacterSetting() {
  const name = document.getElementById("setCharName").value.trim();
  if (!name) return alert("角色名不能为空");
  setBusy(true, "正在保存设定...");
  try {
    const data = await apiFetch("/api/character/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        char_id: currentCharId,
        name,
        title: document.getElementById("setCharTitle").value.trim(),
        current_time: document.getElementById("setDefaultTime").value.trim(),
        scene: document.getElementById("setDefaultScene").value.trim() || "默认场景",
        affection: parseInt(document.getElementById("setDefaultAff").value, 10) || 0,
        track_a: document.getElementById("setTrackA").value.trim() || "初识观察中",
        track_b: document.getElementById("setTrackB").value.trim() || "防备与客套并存",
        mask_integrity: document.getElementById("setMaskIntegrity").value.trim() || "完整",
        base_prompt: document.getElementById("setBasePrompt").value.trim(),
        sync_current: document.getElementById("syncCurrentStateChk").checked
      })
    });
    if (!data.ok) return alert(data.error || "保存失败");
    closeSpecificModal("settingModalMask");
    await refreshCharacterList(data.character.id);
    renderSession(data, false);
  } finally {
    setBusy(false);
  }
}

// ==================== 对话历史批量编辑与导入导出 ====================

function openHistoryModal() {
  switchHistoryViewMode(historyViewMode || "list");
  renderHistoryModalList();
  reloadBulkHistoryText();
  document.getElementById("historyModalMask").style.display = "flex";
}

function switchHistoryViewMode(mode) {
  historyViewMode = mode === "bulk" ? "bulk" : "list";
  document.getElementById("historyListView").style.display = historyViewMode === "list" ? "block" : "none";
  document.getElementById("historyBulkView").style.display = historyViewMode === "bulk" ? "block" : "none";
  document.getElementById("histModeListBtn").className = historyViewMode === "list" ? "primary" : "";
  document.getElementById("histModeBulkBtn").className = historyViewMode === "bulk" ? "primary" : "";
  if (historyViewMode === "bulk") reloadBulkHistoryText();
  else renderHistoryModalList();
}

function reloadBulkHistoryText() {
  document.getElementById("bulkHistoryTextarea").value = (currentMessages || [])
    .map(m => `${m.role === "user" ? "[用户]" : `[${currentCharName || "角色"}]`}\n${m.content || ""}`)
    .join("\n\n");
  document.getElementById("bulkHistoryError").textContent = "";
}

function escapeRegex(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function saveBulkHistoryText() {
  const raw = document.getElementById("bulkHistoryTextarea").value.replace(/\r\n/g, "\n").trim();
  const errEl = document.getElementById("bulkHistoryError");
  if (!raw) {
    const data = await apiFetch("/api/history/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char_id: currentCharId, items: [] })
    });
    if (data.ok) { renderSession(data, false); renderHistoryModalList(); }
    return;
  }
  const escChar = escapeRegex(currentCharName || "角色");
  const headerRe = new RegExp(`^\\s*\\[(用户|user|玩家|角色|assistant|ai|${escChar})\\]\\s*$`, "i");
  const lines = raw.split("\n");
  const items = [];
  let curRole = null, curLines = [];
  const flush = () => {
    if (!curRole) return;
    const txt = curLines.join("\n").trim();
    if (txt) items.push({ role: curRole, content: txt });
    curRole = null; curLines = [];
  };
  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      flush();
      curRole = ["用户", "user", "玩家"].includes(m[1].toLowerCase()) ? "user" : "assistant";
    } else {
      if (!curRole) { errEl.textContent = "缺少角色标签，如 [用户] 或 [角色]"; return; }
      curLines.push(line);
    }
  }
  flush();
  const data = await apiFetch("/api/history/replace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ char_id: currentCharId, items })
  });
  if (!data.ok) { errEl.textContent = data.error || "保存失败"; return; }
  errEl.textContent = "";
  renderSession(data, false);
  renderHistoryModalList();
}

function renderHistoryModalList() {
  document.getElementById("histCountSpan").textContent = currentMessages.length;
  const container = document.getElementById("historyListView");
  container.innerHTML = "";
  currentMessages.forEach(m => {
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `<div class="history-item-head"><span><b>#${m.index}</b> · ${m.role === "user" ? "你" : escapeHtml(currentCharName)}</span></div>`;
    const ta = document.createElement("textarea");
    ta.className = "edit-textarea";
    ta.style.minHeight = "76px";
    ta.value = m.content || "";
    const actions = document.createElement("div");
    actions.className = "history-item-actions";
    const saveBtn = document.createElement("button");
    saveBtn.className = "primary";
    saveBtn.textContent = "保存修改";
    saveBtn.onclick = async () => {
      const data = await apiFetch("/api/message/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ char_id: currentCharId, index: m.index, mode: "save", content: ta.value })
      });
      if (data.ok) { renderSession(data, false); renderHistoryModalList(); reloadBulkHistoryText(); }
    };
    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "删除";
    delBtn.onclick = async () => {
      const data = await apiFetch("/api/message/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ char_id: currentCharId, index: m.index, mode: "delete", content: "" })
      });
      if (data.ok) { renderSession(data, false); renderHistoryModalList(); reloadBulkHistoryText(); }
    };
    actions.append(saveBtn, delBtn);
    item.append(ta, actions);
    container.appendChild(item);
  });
}

function exportCurrentHistory() {
  downloadJson(`history_${sanitizeFilename(currentCharName)}.json`, {
    messages: currentMessages,
    time_banners: currentState.time_banners || []
  });
  showToast("已导出对话记录 JSON（含时间标签）");
}

function handleImportHistoryFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const rawText = String(reader.result || "").trim();
    if (!rawText) return alert("导入文件内容为空");

    let needsRepair = false;
    try {
      const parsed = JSON.parse(rawText);
      const validTop = parsed && typeof parsed === "object" && Array.isArray(parsed.messages) && parsed.state && typeof parsed.state === "object";
      if (!validTop) needsRepair = true;
    } catch (_) {
      needsRepair = true;
    }

    let autoRepair = true;
    if (needsRepair) {
      autoRepair = confirm("检测到导入的存档不是标准格式（缺少 state/messages 或非标准 JSON），是否唤起 API 自动修复并转换为标准存档？");
      if (!autoRepair) return;
    }

    setBusy(true, needsRepair ? "正在唤起 API 修复并转换存档格式..." : "正在导入标准存档...");
    try {
      const data = await apiFetch("/api/history/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          char_id: currentCharId,
          raw_text: rawText,
          auto_repair: autoRepair
        })
      });
      if (!data.ok) return alert("导入失败：" + (data.error || "未知错误"));
      renderSession(data, true);
      if (typeof renderHistoryModalList === "function") renderHistoryModalList();
      if (typeof reloadBulkHistoryText === "function") reloadBulkHistoryText();
    } catch (err) {
      alert("导入异常：" + err.message);
    } finally {
      setBusy(false, "");
    }
  };
  reader.readAsText(file, "utf-8");
}

// ==================== API 配置模态框 ====================

async function openApiModal() {
  const data = await apiFetch("/api/api_config");
  const cfg = data.config || {};
  document.getElementById("apiKeyInput").value = cfg.key || "";
  document.getElementById("apiUrlInput").value = cfg.url || "";
  document.getElementById("apiModelInput").value = cfg.model || "";
  document.getElementById("apiTempInput").value = cfg.temperature ?? 0.8;
  document.getElementById("apiMaxTokensInput").value = cfg.maxTokens ?? 4096;
  document.getElementById("apiTestStatusText").textContent = "";
  document.getElementById("apiModalMask").style.display = "flex";
}

async function saveApiConfig() {
  const data = await apiFetch("/api/api_config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: document.getElementById("apiKeyInput").value.trim(),
      url: document.getElementById("apiUrlInput").value.trim(),
      model: document.getElementById("apiModelInput").value.trim(),
      temperature: parseFloat(document.getElementById("apiTempInput").value),
      maxTokens: parseInt(document.getElementById("apiMaxTokensInput").value, 10)
    })
  });
  if (data.ok) {
    closeSpecificModal("apiModalMask");
    await loadSession(currentCharId);
    showToast(data.notice || "已保存配置");
  }
}

async function testApiConnection() {
  const statusEl = document.getElementById("apiTestStatusText");
  statusEl.style.color = "var(--muted)";
  statusEl.textContent = "正在测试连接...";
  try {
    const data = await apiFetch("/api/api_config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: document.getElementById("apiKeyInput").value.trim(),
        url: document.getElementById("apiUrlInput").value.trim(),
        model: document.getElementById("apiModelInput").value.trim()
      })
    });
    if (data.ok) {
      statusEl.style.color = "var(--ok)";
      statusEl.textContent = `连接成功：${data.reply}`;
    } else {
      statusEl.style.color = "var(--danger)";
      statusEl.textContent = `连接失败：${data.error}`;
    }
  } catch (err) {
    statusEl.style.color = "var(--danger)";
    statusEl.textContent = `连接异常：${err.message}`;
  }
}

async function clearApiConfig() {
  document.getElementById("apiKeyInput").value = "";
  await saveApiConfig();
}

// ==================== 对话检索、行内编辑与时间标签编辑 ====================

function openSearchModal() {
  document.getElementById("searchQueryInput").value = "";
  document.getElementById("searchRoleFilter").value = "all";
  renderSearchResults();
  document.getElementById("searchModalMask").style.display = "flex";
}

function renderSearchResults() {
  const q = (document.getElementById("searchQueryInput").value || "").trim().toLowerCase();
  const roleFilter = document.getElementById("searchRoleFilter").value;
  const matches = (currentMessages || []).filter(m => {
    if (roleFilter !== "all" && m.role !== roleFilter) return false;
    if (!q) return true;
    return String(m.content || "").toLowerCase().includes(q);
  });
  document.getElementById("searchResultCount").textContent = `匹配到 ${matches.length} 条记录`;
  const listEl = document.getElementById("searchResultList");
  listEl.innerHTML = "";
  matches.forEach(m => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `<div class="history-item-head"><span><b>#${m.index}</b> · ${m.role === "user" ? "你" : escapeHtml(currentCharName)}</span><button style="padding:2px 8px;font-size:11px;" onclick="jumpToMessage(${m.index})">编辑</button></div><div style="white-space:pre-wrap;font-size:13px;">${escapeHtml(m.content || "")}</div>`;
    listEl.appendChild(div);
  });
}

function jumpToMessage(msgIndex) {
  closeSpecificModal("searchModalMask");
  revealedMsgIndex = msgIndex;
  startEditMessage(msgIndex);
}

function startEditMessage(msgIndex) {
  if (busy) return;
  const target = currentMessages.find(m => m.index === msgIndex);
  if (!target) return;
  editingIndex = msgIndex;
  revealedMsgIndex = msgIndex;
  draftContent = target.content || "";
  renderChatMessages();
  const ta = document.getElementById(`editTa_${msgIndex}`);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function cancelEditMessage() {
  if (busy) return;
  editingIndex = null;
  draftContent = "";
  renderChatMessages();
}

async function submitEditMessage(msgIndex, mode) {
  if (busy) return;
  const ta = document.getElementById(`editTa_${msgIndex}`);
  const content = ta ? ta.value : draftContent;
  if (!content.trim()) return alert("消息内容不能为空");
  setBusy(true, "正在处理...");
  try {
    const data = await apiFetch("/api/message/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char_id: currentCharId, index: msgIndex, mode, content })
    });
    if (!data.ok) alert("操作失败：" + (data.error || "未知错误"));
    else { editingIndex = null; draftContent = ""; renderSession(data, false); }
  } catch (err) {
    alert("请求异常：" + err.message);
  } finally { setBusy(false, ""); }
}

async function deleteMessage(msgIndex) {
  if (busy || !confirm("确定要删除这条消息吗？")) return;
  setBusy(true, "正在删除...");
  try {
    const data = await apiFetch("/api/message/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char_id: currentCharId, index: msgIndex, mode: "delete", content: "" })
    });
    if (data.ok) {
      if (revealedMsgIndex === msgIndex) revealedMsgIndex = null;
      renderSession(data, false);
    } else {
      alert(data.error || "删除失败");
    }
  } catch (err) {
    alert("删除异常：" + err.message);
  } finally { setBusy(false, ""); }
}

function startEditBanner(bannerObj) {
  if (busy) return;
  editingBannerId = bannerObj.id;
  draftBannerLabel = bannerObj.label || `${bannerObj.time || ""} · ${bannerObj.scene || ""}`;
  renderChatMessages();
  const inp = document.getElementById(`bannerEditInput_${bannerObj.id}`);
  if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}

function cancelEditBanner() {
  if (busy) return;
  editingBannerId = null;
  draftBannerLabel = "";
  renderChatMessages();
}

async function saveBannerLabel(bannerId) {
  if (busy) return;
  const inp = document.getElementById(`bannerEditInput_${bannerId}`);
  const val = (inp ? inp.value : draftBannerLabel).trim();
  if (!val) return alert("时间标签内容不能为空");
  setBusy(true, "正在保存时间标签...");
  try {
    const data = await apiFetch("/api/time_banner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char_id: currentCharId, id: bannerId, mode: "edit", label: val })
    });
    if (!data.ok) alert("修改失败：" + (data.error || ""));
    else { editingBannerId = null; draftBannerLabel = ""; renderSession(data, false); }
  } catch (err) {
    alert("保存异常：" + err.message);
  } finally { setBusy(false, ""); }
}

async function deleteBanner(bannerId) {
  if (busy || !confirm("确定要删除这个时间标签吗？")) return;
  setBusy(true, "正在删除时间标签...");
  try {
    const data = await apiFetch("/api/time_banner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char_id: currentCharId, id: bannerId, mode: "delete" })
    });
    if (!data.ok) alert("删除失败：" + (data.error || ""));
    else {
      if (editingBannerId === bannerId) { editingBannerId = null; draftBannerLabel = ""; }
      renderSession(data, false);
    }
  } catch (err) {
    alert("删除异常：" + err.message);
  } finally { setBusy(false, ""); }
}

async function requestRefer() {
  if (busy) return;
  const hint = document.getElementById("msgInput").value.trim();
  setBusy(true, "正在生成回复参考...");
  try {
    const data = await apiFetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char_id: currentCharId, action: "refer", arg: hint })
    });
    if (!data.ok) return alert("生成参考失败：" + (data.error || ""));
    referDraft = data.refer_text || "";
    renderChatMessages();
    scrollChatToBottom();
  } catch (err) {
    alert("请求异常：" + err.message);
  } finally { setBusy(false, ""); }
}

// ==================== 聊天区与状态栏渲染 ====================

function renderChatMessages() {
  const box = document.getElementById("chatBox");
  if (!box) return;
  box.innerHTML = "";
  const msgs = currentMessages || [];
  const banners = Array.isArray(currentState.time_banners) ? currentState.time_banners : [];
  const bannerMap = new Map();
  banners.forEach(b => {
    const k = Number(b.after_count ?? 0);
    if (!bannerMap.has(k)) bannerMap.set(k, []);
    bannerMap.get(k).push(b);
  });

  const appendBannersAt = (countVal) => {
    const list = bannerMap.get(countVal) || [];
    list.forEach(b => {
      if (editingBannerId === b.id) {
        const editBox = document.createElement("div");
        editBox.className = "banner-edit-box";
        const inp = document.createElement("input");
        inp.type = "text";
        inp.id = `bannerEditInput_${b.id}`;
        inp.value = draftBannerLabel;
        inp.oninput = () => { draftBannerLabel = inp.value; };
        inp.onkeydown = e => {
          if (e.key === "Enter") { e.preventDefault(); saveBannerLabel(b.id); }
          else if (e.key === "Escape") { e.preventDefault(); cancelEditBanner(); }
        };
        const actions = document.createElement("div");
        actions.className = "banner-edit-actions";
        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "取消";
        cancelBtn.onclick = cancelEditBanner;
        const delBtn = document.createElement("button");
        delBtn.className = "danger";
        delBtn.textContent = "删除";
        delBtn.onclick = () => deleteBanner(b.id);
        const saveBtn = document.createElement("button");
        saveBtn.className = "primary";
        saveBtn.textContent = "保存";
        saveBtn.onclick = () => saveBannerLabel(b.id);
        actions.append(cancelBtn, delBtn, saveBtn);
        editBox.append(inp, actions);
        box.appendChild(editBox);
      } else {
        const tag = document.createElement("div");
        tag.className = "msg-time-banner";
        tag.title = "点击修改或删除时间标签";
        tag.textContent = b.label || `${b.time || ""} · ${b.scene || ""}`;
        tag.onclick = e => {
          e.stopPropagation();
          startEditBanner(b);
        };
        box.appendChild(tag);
      }
    });
  };

  if (!msgs.length && !referDraft && !banners.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<h3>与「${escapeHtml(currentCharName)}」开启语C剧场</h3><p>点击气泡可查看操作与编辑；支持 {{...}} 黑箱独白。</p><div class="empty-chips"><button onclick="requestRefer()">生成首轮参考</button><button onclick="openApiModal()">检查 API 配置</button></div>`;
    box.appendChild(empty);
    return;
  }

  appendBannersAt(0);

  msgs.forEach((m, idx) => {
    const isEditing = editingIndex === m.index;
    const isRevealed = revealedMsgIndex === m.index;
    const div = document.createElement("div");
    div.className = "msg " + (m.role === "user" ? "user" : "assistant") + (isEditing ? " editing" : "") + (isRevealed ? " tools-revealed" : "");
    if (!isEditing) {
      div.addEventListener("click", e => {
        if (e.target.closest("button") || e.target.closest("textarea")) return;
        revealedMsgIndex = (revealedMsgIndex === m.index) ? null : m.index;
        renderChatMessages();
      });
      div.addEventListener("dblclick", e => {
        if (e.target.closest("button") || e.target.closest("textarea")) return;
        startEditMessage(m.index);
      });
    }
    const header = document.createElement("div");
    header.className = "msg-header";
    const roleEl = document.createElement("div");
    roleEl.className = "msg-role";
    roleEl.textContent = m.role === "user" ? "你" : currentCharName;
    const tools = document.createElement("div");
    tools.className = "msg-tools";
    const badge = document.createElement("span");
    badge.className = "msg-idx-badge";
    badge.textContent = `#${m.index}`;
    tools.appendChild(badge);
    if (!isEditing) {
      const editBtn = document.createElement("button");
      editBtn.className = "msg-tool-btn";
      editBtn.textContent = "编辑";
      editBtn.disabled = busy;
      editBtn.onclick = e => { e.stopPropagation(); startEditMessage(m.index); };
      const delBtn = document.createElement("button");
      delBtn.className = "msg-tool-btn danger";
      delBtn.textContent = "删除";
      delBtn.disabled = busy;
      delBtn.onclick = e => { e.stopPropagation(); deleteMessage(m.index); };
      tools.append(editBtn, delBtn);
    }
    header.append(roleEl, tools);
    div.appendChild(header);

    if (isEditing) {
      const ta = document.createElement("textarea");
      ta.id = `editTa_${m.index}`;
      ta.className = "edit-textarea";
      ta.value = draftContent;
      ta.oninput = () => { draftContent = ta.value; };
      const actions = document.createElement("div");
      actions.className = "edit-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "取消";
      cancelBtn.onclick = cancelEditMessage;
      const saveBtn = document.createElement("button");
      saveBtn.className = "primary";
      saveBtn.textContent = "保存";
      saveBtn.onclick = () => submitEditMessage(m.index, "save");
      const regenNextBtn = document.createElement("button");
      regenNextBtn.textContent = "保存并重生成下一条";
      regenNextBtn.onclick = () => submitEditMessage(m.index, "save_regen_next");
      const regenTruncBtn = document.createElement("button");
      regenTruncBtn.className = "danger";
      regenTruncBtn.textContent = "保存并截断后续重生成";
      regenTruncBtn.onclick = () => submitEditMessage(m.index, "save_regen_truncate");
      actions.append(cancelBtn, saveBtn, regenNextBtn, regenTruncBtn);
      div.append(ta, actions);
    } else {
      const bodyEl = document.createElement("div");
      bodyEl.textContent = m.content;
      div.appendChild(bodyEl);
    }
    box.appendChild(div);
    appendBannersAt(idx + 1);
  });

  if (referDraft) {
    const refCard = document.createElement("div");
    refCard.className = "msg refer-card";
    refCard.innerHTML = `<div class="refer-tag">【对话补全 / 回复参考】</div><div class="refer-body">${escapeHtml(referDraft)}</div>`;
    const actions = document.createElement("div");
    actions.className = "refer-actions";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "关闭";
    closeBtn.onclick = () => { referDraft = ""; renderChatMessages(); };
    const fillBtn = document.createElement("button");
    fillBtn.className = "primary";
    fillBtn.textContent = "填入输入框";
    fillBtn.onclick = () => {
      const inp = document.getElementById("msgInput");
      inp.value = referDraft; inp.focus(); referDraft = ""; renderChatMessages();
    };
    actions.append(closeBtn, fillBtn);
    refCard.appendChild(actions);
    box.appendChild(refCard);
  }
}

function renderSession(data, autoScroll = true) {
  if (!data || !data.ok) return;
  currentCharId = data.character.id;
  currentCharData = data.character;
  currentCharName = data.character.name;
  currentMessages = data.messages || [];
  currentState = data.state || {};

  if (data.extensions_summary) {
    if (data.extensions_summary.active_persona?.id) {
      extensionsData.active_persona_id = data.extensions_summary.active_persona.id;
    }
    if (data.extensions_summary.active_preset?.id) {
      extensionsData.active_preset_id = data.extensions_summary.active_preset.id;
    }
    renderPersonaControls();
    renderPresetControls();
  }

  const badge = document.getElementById("apiStatusBadge");
  if (badge) {
    if (data.api_ready) {
      badge.textContent = "API 已就绪";
      badge.className = "api-badge ready";
    } else {
      badge.textContent = "未设 API";
      badge.className = "api-badge";
    }
  }

  renderCharacterProfileCard(currentCharData);
  document.getElementById("topTitle").textContent = `${data.character.name}${data.character.title ? " · " + data.character.title : ""}`;
  document.getElementById("topSub").textContent = `模型：${data.stats.model} ｜ 存档：${data.stats.save_file}`;

  const st = currentState;
  const curTime = st.current_time || "-";
  const curScene = st.scene || "-";
  const curStage = st.relationship_stage || "-";
  document.getElementById("stTime").textContent = curTime;
  document.getElementById("stScene").textContent = curScene;
  document.getElementById("stAff").textContent = st.affection ?? 0;
  document.getElementById("stStage").textContent = curStage;
  document.getElementById("stTrackA").textContent = st.track_a || "-";
  document.getElementById("stTrackB").textContent = st.track_b || "-";
  document.getElementById("stMask").textContent = st.mask_integrity || "-";
  document.getElementById("stTendency").textContent = st.behavior_tendency || "-";
  const unsettled = data.stats.unsettled_rounds ?? 0;
  const interval = data.stats.auto_settle_interval ?? 20;
  document.getElementById("stStats").textContent = `消息 ${data.stats.total_messages} 条（共 ${data.stats.rounds} 轮 ｜ 自动复盘 ${unsettled}/${interval} 轮）`;

  document.getElementById("stripChar").textContent = data.character.name;
  document.getElementById("stripTime").textContent = curTime;
  document.getElementById("stripScene").textContent = curScene;
  document.getElementById("stripAff").textContent = st.affection ?? 0;
  document.getElementById("stripStage").textContent = curStage;

  const memos = data.memos || [];
  document.getElementById("memoCount").textContent = memos.length;
  const ul = document.getElementById("memoList");
  ul.innerHTML = "";
  memos.forEach(m => {
    const li = document.createElement("li");
    li.className = "memo-item";
    const span = document.createElement("span");
    span.className = "memo-text";
    span.textContent = m;
    const delBtn = document.createElement("button");
    delBtn.className = "memo-del-btn danger";
    delBtn.textContent = "×";
    delBtn.onclick = () => doAction("delete_memo", m);
    li.append(span, delBtn);
    ul.appendChild(li);
  });

  renderChatMessages();
  if (autoScroll) scrollChatToBottom();
  if (data.notice) showToast(data.notice);
}

// ==================== 初始化与核心对话/元指令动作 ====================

async function init() {
  loadUiPrefs();
  loadWorldbooks();
  applyTheme();
  applyChatFontFamily();
  applyChatFontSize();
  applyHeaderBarsPref();
  applyDesktopSidebarPref();
  renderWorldbookControls();
  renderPersonaControls();
  renderPresetControls();
  updateFullscreenButton();
  bindVisualViewportEvents();
  bindArchiveModalEvents();
  syncVisualViewportInset();
  try {
    await loadExtensionsFromServer(true);
    await refreshCharacterList();
    if (charactersList.length > 0) {
      await loadSession(charactersList[0].id);
    }
  } catch (err) {
    console.error("初始化失败:", err);
    showToast("加载初始化数据失败，请刷新或检查后端日志");
  }
}

async function loadSession(charId) {
  setBusy(true, "正在加载存档...");
  try {
    const data = await apiFetch(`/api/session?char_id=${encodeURIComponent(charId)}`);
    if (data.ok) renderSession(data, true);
    else showToast(data.error || "加载存档失败");
  } catch (err) {
    showToast("网络或接口异常：" + err.message);
  } finally { setBusy(false); }
}

async function sendMessage() {
  if (busy) return;
  const input = document.getElementById("msgInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  editingIndex = null; draftContent = ""; editingBannerId = null; draftBannerLabel = ""; revealedMsgIndex = null; referDraft = "";
  const preset = getActivePresetObj();
  const wbPrefix = preset.inject_worldbook === false
    ? ""
    : buildWorldbookPromptPrefix(`${text} ${currentState.scene || ""}`);
  setBusy(true, `${currentCharName} 正在思考与回应...`);
  try {
    const data = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        char_id: currentCharId,
        message: text,
        worldbook_prompt: wbPrefix
      })
    });
    if (!data.ok) { input.value = text; alert("请求失败：" + (data.error || "")); }
    else renderSession(data, true);
  } catch (err) {
    input.value = text;
    alert("网络异常：" + err.message);
  } finally { setBusy(false, ""); }
}

async function doAction(action, arg = "") {
  if (busy) return;
  setBusy(true, action === "status" ? "正在推测时间/地点并复盘..." : "正在执行操作...");
  try {
    const data = await apiFetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char_id: currentCharId, action, arg })
    });
    if (!data.ok) return alert(data.error || "操作失败");
    if (window.innerWidth <= 1024) toggleDrawer(false);
    if (data.meta_output) {
      const titles = { check: "【后台状态侧写】", anchor: "【记忆锚点存档】", ooc: "【OOC 场外助手】" };
      showModal(titles[action] || "系统输出", data.meta_output, { allowSaveMemo: action === "anchor" });
    } else {
      if (action === "set_time") document.getElementById("timeInput").value = "";
      if (action === "scene") document.getElementById("sceneInput").value = "";
      if (action === "aff") document.getElementById("affInput").value = "";
      renderSession(data, action === "reset" || action === "status");
    }
  } catch (err) {
    alert("操作异常：" + err.message);
  } finally { setBusy(false, ""); }
}

function addMemo() {
  const val = document.getElementById("memoInput").value.trim();
  if (!val) return;
  document.getElementById("memoInput").value = "";
  doAction("memo", val);
}

function askOoc() {
  const q = prompt("输入 OOC 问题或剧情设定调整要求：");
  if (q && q.trim()) doAction("ooc", q.trim());
}

function confirmReset() {
  if (confirm(`确定要清空 ${currentCharName} 的当前存档并重置初始状态吗？`)) doAction("reset");
}

document.getElementById("msgInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (window.innerWidth > 1024) { e.preventDefault(); sendMessage(); }
  } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault(); sendMessage();
  }
});

init();