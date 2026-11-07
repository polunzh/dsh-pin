/**
 * dsh-pin 客户端主体（源文件）。
 *
 * 构建脚本会把 lib/pin-core.mjs 内联到 /*__PIN_CORE__*\/ 占位处，再包进
 * window.__ModuleLoader__.load({ id: "dsh-pin", factory }) 生成 lib/client.js。
 *
 * 两件事：
 * 1) Workspaces 置顶：在侧边栏工作区行的悬停操作区注入 📌 按钮，
 *    点用宿主现成的 workspaces.insertBefore 把工作区挪到列表最上面；
 *    取消时按记录的前后锚点精确插回原位。
 * 2) 插件面板置顶：在侧边栏 sidebar.panellist 行右侧注入 📌 按钮，
 *    置顶后把该行移到面板列表顶部；顺序 + 置顶集合存 localStorage。
 */

/*__PIN_CORE__*/

// ── 常量 ──────────────────────────────────────────────────────────────

const NS = "dsh-pin";
const STORAGE_WORKSPACES = "dsh-pin.workspaces.v1";
const STORAGE_PANELS = "dsh-pin.panels.v1";
const STYLE_ID = "dsh-pin-style";
const PIN_BUTTON_SIZE = 20;
const PANEL_BUTTON_OFFSET = 6;
const OBSERVE_DEBOUNCE_MS = 120;

const SELECTOR = {
  panelList: '[class*="panelList"]',
  panelRow: 'button[class*="panelRow"]',
  workspaceRow: '[data-row-key^="workspace:"]',
  rowActions: '[class*="rowActions"]',
  pinButton: "[data-dsh-pin]",
};

const ATTR = {
  pin: "data-dsh-pin",
  workspaceId: "data-pin-workspace-id",
  panelId: "data-pin-panel-id",
  pinnedWorkspace: "data-dsh-pinned-workspace",
  pinnedPanel: "data-dsh-pinned-panel",
  marker: "data-dsh-pin-marker",
  markerKind: "data-pin-marker-kind",
  toast: "data-dsh-pin-toast",
  panelList: "data-dsh-pin-list",
  panelButtonVisible: "data-dsh-pin-visible",
};

const PIN_PATHS = [
  "M12 17v4.2",
  "M8.6 10.9a2 2 0 0 1-1.1 1.8l-1.2.6A2 2 0 0 0 5.2 15v.6a1 1 0 0 0 1 1h11.6a1 1 0 0 0 1-1V15a2 2 0 0 0-1.1-1.7l-1.2-.6a2 2 0 0 1-1.1-1.8V7.2a1 1 0 0 1 1-1 1.6 1.6 0 0 0 0-3.2H8.6a1.6 1.6 0 0 0 0 3.2 1 1 0 0 1 1 1v3.7Z",
];

// ── 文案 ──────────────────────────────────────────────────────────────

const DICTIONARIES = {
  zh: {
    "action.pinWorkspace": "置顶工作区",
    "action.unpinWorkspace": "取消置顶工作区",
    "action.pinPanel": "置顶插件",
    "action.unpinPanel": "取消置顶插件",
    "marker.pinned": "已置顶",
    "toast.pinnedWorkspace": "已置顶工作区「{title}」",
    "toast.unpinnedWorkspace": "已取消置顶「{title}」",
    "toast.pinnedPanel": "已置顶插件「{title}」",
    "toast.unpinnedPanel": "已取消置顶「{title}」",
    "toast.failed": "置顶失败：{message}",
    "toast.missing": "找不到要置顶的对象",
  },
  en: {
    "action.pinWorkspace": "Pin workspace",
    "action.unpinWorkspace": "Unpin workspace",
    "action.pinPanel": "Pin plugin",
    "action.unpinPanel": "Unpin plugin",
    "marker.pinned": "Pinned",
    "toast.pinnedWorkspace": "Pinned workspace \u201c{title}\u201d",
    "toast.unpinnedWorkspace": "Unpinned \u201c{title}\u201d",
    "toast.pinnedPanel": "Pinned plugin \u201c{title}\u201d",
    "toast.unpinnedPanel": "Unpinned \u201c{title}\u201d",
    "toast.failed": "Pin failed: {message}",
    "toast.missing": "The pin target is gone",
  },
};

// ── 小工具 ────────────────────────────────────────────────────────────

function format(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式/配额满：本次会话仍可用，只是不持久化 */
  }
}

function sameArray(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function createPinIcon(size) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of PIN_PATHS) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.dsh-pin-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  margin: 0;
  flex: none;
  border: none;
  border-radius: var(--dsw-radius-xs, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8b8f96);
  cursor: pointer;
  opacity: 0.7;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.dsh-pin-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16));
  color: var(--dsw-alias-label-primary, #1d1d1f);
  opacity: 1;
}
.dsh-pin-button:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: -2px;
  opacity: 1;
}
.dsh-pin-button[data-pinned="true"] {
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
  opacity: 1;
}
.dsh-pin-button[data-pinned="true"] svg {
  fill: currentColor;
  fill-opacity: 0.16;
}
.dsh-pin-button:disabled {
  cursor: default;
  opacity: 0.45;
}
/* 工作区行内的置顶按钮：给它与相邻原生按钮一致的 24px 热区与 -4px 负边距，层级置顶 */
.dsh-pin-button[data-dsh-pin="workspace"] {
  width: 24px;
  height: 24px;
  margin: -4px;
  position: relative;
  z-index: 2;
}
.dsh-pin-button[data-dsh-pin="panel"] {
  position: absolute;
  z-index: 3;
  right: ${PANEL_BUTTON_OFFSET}px;
  width: ${PIN_BUTTON_SIZE}px;
  height: ${PIN_BUTTON_SIZE}px;
  opacity: 0;
  pointer-events: none;
  background: color-mix(in srgb, var(--dsw-specific-sidebar-fill, #f4f4f5) 78%, transparent);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
}
/* 置顶状态的面板：常驻显示置顶按钮，用户一眼看出哪些面板已置顶 */
.dsh-pin-button[data-dsh-pin="panel"][data-pinned="true"] {
  opacity: 0.85;
  pointer-events: auto;
}
.dsh-pin-button[data-dsh-pin="panel"][data-pinned="true"]:hover {
  opacity: 1;
}
/* 悬停未置顶面板行时浮现图钉 */
.dsh-pin-button[data-dsh-pin="panel"][data-dsh-pin-visible="true"],
.dsh-pin-button[data-dsh-pin="panel"]:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
/* 键盘模态：工作区行没有 :focus-within 规则，注入的 📌 也需要能聚焦。 */
[data-row-key^="workspace:"]:focus-within [class*="rowActions"] {
  display: inline-flex;
}
/*
 * 已置顶工作区的常驻图钉（只读指示器）。
 *
 * 位置关键：它与 hover 时浮现的置顶按钮都贴在整行的最右端，所以鼠标移上去时
 * 图标几乎不动 —— 用户想点这个图钉，落点正好落在随后出现的可点击按钮上。
 * （早期版本把图钉放在 rowActions 之前，hover 后 rowActions 撑开会把图钉
 * 往左推 ~50px，鼠标下的元素瞬间换掉，看起来就是“按钮消失/点不到”。）
 */
.dsh-pin-marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  margin: 0 2px 0 0;
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
  pointer-events: none;
}
.dsh-pin-marker svg {
  fill: currentColor;
  fill-opacity: 0.16;
}
/* hover / 菜单打开 / 键盘聚焦时让位给操作区里的真按钮，避免同时出现两个图钉 */
[data-row-key^="workspace:"]:hover .dsh-pin-marker,
[data-row-key^="workspace:"].JoiKIa_menuOpen .dsh-pin-marker,
[data-row-key^="workspace:"]:focus-within .dsh-pin-marker {
  display: none;
}
${SELECTOR.rowActions ? "" : ""}
.dsh-pin-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  z-index: 2147483000;
  transform: translateX(-50%);
  max-width: min(420px, calc(100vw - 32px));
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.28));
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  box-shadow: var(--dsw-shadow-lv2, 0 8px 28px rgba(0, 0, 0, 0.18));
  color: var(--dsw-alias-label-primary, #1d1d1f);
  font-size: 12.5px;
  line-height: 1.5;
  pointer-events: none;
  animation: dsh-pin-toast-in 140ms ease-out;
}
.dsh-pin-toast[data-variant="error"] {
  border-color: color-mix(in srgb, #d64545 55%, transparent);
  color: #b42318;
}
@keyframes dsh-pin-toast-in {
  from { opacity: 0; transform: translate(-50%, 4px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
@media (hover: none) {
  .dsh-pin-button[data-dsh-pin="panel"] {
    opacity: 1;
    pointer-events: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-pin-toast { animation: none; }
  .dsh-pin-button { transition: none; }
}
`;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ */
/* 安装                                                               */
/* ------------------------------------------------------------------ */

function install(ctx) {
  const workspacesService = ctx.workspaces;
  const slotsService = ctx.slots;

  // 翻译：注册失败（例如 locale 服务未就绪）时退化为中文原文。
  let translate = (key) => (DICTIONARIES.zh[key] ?? key);
  try {
    if (ctx.locale !== undefined) {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "dsh-pin: dictionaries");
      const bound = ctx.locale.bind(NS);
      translate = (key) => {
        const text = bound(key);
        return text === undefined || text === null || text === key
          ? (DICTIONARIES.zh[key] ?? key)
          : text;
      };
    }
  } catch {
    /* 保持中文兜底 */
  }
  const tr = (key, vars) => format(translate(key), vars);

  ensureStyles();

  /** @type {{workspaceId: string, restoreBeforeId: string|null, pinnedAt: number}[]} */
  let workspaceRecords = parseWorkspaceRecords(readStorage(STORAGE_WORKSPACES));
  /** @type {string[]} */
  let panelPins = parsePanelPins(readStorage(STORAGE_PANELS));

  const saveWorkspaceRecords = () => {
    writeStorage(STORAGE_WORKSPACES, serializeWorkspaceRecords(workspaceRecords));
  };
  const savePanelPins = () => {
    writeStorage(STORAGE_PANELS, serializePanelPins(panelPins));
  };

  let toastTimer = null;
  function toast(message, variant) {
    if (typeof message !== "string" || message === "") return;
    let node = document.querySelector(`[${ATTR.toast}]`);
    if (!node) {
      node = document.createElement("div");
      node.setAttribute(ATTR.toast, "");
      node.className = "dsh-pin-toast";
      node.setAttribute("role", "status");
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.setAttribute("data-variant", variant === "error" ? "error" : "info");
    node.style.display = "block";
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      const current = document.querySelector(`[${ATTR.toast}]`);
      if (current) current.remove();
    }, variant === "error" ? 5000 : 2600);
  }

  // ── 通用 DOM 查找 ────────────────────────────────────────────────

  function sidebarNav() {
    const list =
      document.querySelector(`[${ATTR.panelList}]`) ??
      document.querySelector(SELECTOR.panelList);
    return list ? list.closest("nav") ?? list.parentElement : null;
  }

  function panelListElement() {
    const list =
      document.querySelector(`nav ${SELECTOR.panelList}`) ??
      document.querySelector(SELECTOR.panelList);
    if (!list) return null;
    if (!list.hasAttribute(ATTR.panelList)) {
      list.setAttribute(ATTR.panelList, "");
      if (getComputedStyle(list).position === "static") {
        list.style.position = "relative";
        list.setAttribute("data-dsh-pin-positioned", "");
      }
    }
    return list;
  }

  function workspaceOrder() {
    try {
      const snapshot = workspacesService.list.getSnapshot();
      return (snapshot?.items ?? []).map((item) => item.workspaceId).filter(Boolean);
    } catch {
      return [];
    }
  }

  function workspaceTitles() {
    const titles = new Map();
    try {
      const snapshot = workspacesService.list.getSnapshot();
      for (const item of snapshot?.items ?? []) {
        if (item.workspaceId) titles.set(item.workspaceId, item.title ?? item.path ?? "");
      }
    } catch {
      /* 快照不可用就用 DOM 文本 */
    }
    return titles;
  }

  // ── 工作区置顶 ───────────────────────────────────────────────────

  function workspaceRowTitle(row) {
    const text = (row.innerText ?? "").split("\n")[0].trim();
    return text !== "" ? text : "";
  }

  function ensureWorkspaceRow(row) {
    const id = workspaceIdFromRowKey(row.getAttribute("data-row-key"));
    if (id === null) return;
    if (!workspaceOrder().includes(id)) {
      // Ungrouped 桶 / 非真实工作区：不支持置顶，清理注入物。
      row.removeAttribute(ATTR.pinnedWorkspace);
      row.querySelector(`[${ATTR.marker}="workspace"]`)?.remove();
      row.querySelector('[data-dsh-pin="workspace"]')?.remove();
      return;
    }

    const pinned = findWorkspaceRecord(workspaceRecords, id) !== null;
    if (pinned) row.setAttribute(ATTR.pinnedWorkspace, id);
    else row.removeAttribute(ATTR.pinnedWorkspace);

    // 两个元素、同一位置：
    //   常驻指示器 `.dsh-pin-marker`（只读）贴在整行最右端，hover 时让位；
    //   可点击按钮放在 rowActions 的最后（也是整行最右端），hover 时出现。
    // 两者右对齐，所以鼠标移到图钉上时图标几乎不动，点击直接命中按钮。
    const bindPinClick = (node, label) => {
      node.setAttribute("aria-label", label);
      node.setAttribute("title", label);
      node.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void toggleWorkspace(id, node);
      };
      node.onpointerdown = (event) => {
        event.stopPropagation();
      };
      node.onmousedown = (event) => {
        event.stopPropagation();
      };
    };

    let marker = row.querySelector(`[${ATTR.marker}="workspace"]`);
    if (pinned) {
      if (!marker) {
        marker = document.createElement("span");
        marker.className = "dsh-pin-marker";
        marker.setAttribute(ATTR.marker, "workspace");
        marker.setAttribute("aria-hidden", "true");
        marker.appendChild(createPinIcon(14));
      }
      // 永远挂在行的最后（rowActions 之后），保证与按钮同为最右端。
      if (marker.parentElement !== row || row.lastElementChild !== marker) {
        row.appendChild(marker);
      }
      marker.setAttribute("title", tr("marker.pinned"));
    } else if (marker) {
      marker.remove();
    }

    let button = row.querySelector('[data-dsh-pin="workspace"]');
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "dsh-pin-button";
      button.setAttribute(ATTR.pin, "workspace");
      button.setAttribute(ATTR.workspaceId, id);
      button.appendChild(createPinIcon(15));
    }
    // 放到 rowActions 的最后（最右端），与常驻指示器对齐。
    const actions = row.querySelector(SELECTOR.rowActions);
    const targetHost = actions ?? row;
    if (button.parentElement !== targetHost || targetHost.lastElementChild !== button) {
      targetHost.appendChild(button);
    }
    if (button.getAttribute(ATTR.workspaceId) !== id) {
      button.setAttribute(ATTR.workspaceId, id);
    }
    button.setAttribute("data-pinned", pinned ? "true" : "false");
    bindPinClick(button, pinned ? tr("action.unpinWorkspace") : tr("action.pinWorkspace"));
    button.setAttribute("aria-pressed", pinned ? "true" : "false");
  }

  function syncWorkspaceRows() {
    const order = workspaceOrder();
    if (order.length > 0) {
      const kept = workspaceRecords.filter((record) => order.includes(record.workspaceId));
      if (kept.length !== workspaceRecords.length) {
        workspaceRecords = kept;
        saveWorkspaceRecords();
      }
    }
    for (const row of document.querySelectorAll(SELECTOR.workspaceRow)) {
      try {
        ensureWorkspaceRow(row);
      } catch {
        /* 单行失败不影响其他行 */
      }
    }
  }

  async function toggleWorkspace(workspaceId, button) {
    if (button.disabled) return;
    const order = workspaceOrder();
    if (!order.includes(workspaceId)) {
      toast(tr("toast.missing"), "error");
      return;
    }
    const row = button.closest('[data-row-key^="workspace:"]');
    const title = workspaceTitles().get(workspaceId) || (row ? workspaceRowTitle(row) : "");
    const record = findWorkspaceRecord(workspaceRecords, workspaceId);
    button.disabled = true;
    try {
      if (record !== null) {
        const plan = planUnpinWorkspace({ order, workspaceId, record });
        workspaceRecords = removeWorkspaceRecord(workspaceRecords, workspaceId);
        saveWorkspaceRecords();
        syncWorkspaceRows();
        if (plan !== null && plan.move) {
          await workspacesService.insertBefore(workspaceId, plan.beforeId);
        }
        toast(tr("toast.unpinnedWorkspace", { title }));
      } else {
        const plan = planPinWorkspace({ order, workspaceId });
        if (plan === null) {
          toast(tr("toast.missing"), "error");
          return;
        }
        workspaceRecords = upsertWorkspaceRecord(workspaceRecords, plan.record);
        saveWorkspaceRecords();
        syncWorkspaceRows();
        if (plan.move) {
          await workspacesService.insertBefore(workspaceId, plan.beforeId);
        }
        toast(tr("toast.pinnedWorkspace", { title }));
      }
    } catch (error) {
      // 回滚记录，保持 UI 与宿主顺序一致。
      if (record !== null) {
        workspaceRecords = upsertWorkspaceRecord(workspaceRecords, record);
      } else {
        workspaceRecords = removeWorkspaceRecord(workspaceRecords, workspaceId);
      }
      saveWorkspaceRecords();
      syncWorkspaceRows();
      const message = error && error.message ? error.message : String(error);
      toast(tr("toast.failed", { message }), "error");
    } finally {
      button.disabled = false;
      syncWorkspaceRows();
    }
  }

  // ── 插件面板置顶 ─────────────────────────────────────────────────

  function readPanelId(button) {
    const fiberKey = Object.keys(button).find((key) => key.startsWith("__reactFiber$"));
    if (fiberKey === undefined) return null;
    let fiber = button[fiberKey];
    for (let depth = 0; fiber && depth < 8; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (
        props &&
        typeof props === "object" &&
        typeof props.id === "string" &&
        typeof props.wide === "boolean" &&
        props.selectPanel !== undefined
      ) {
        return props.id;
      }
    }
    return null;
  }

  function panelRows(list) {
    const rows = [];
    for (const row of list.querySelectorAll(SELECTOR.panelRow)) {
      if (row.hasAttribute("aria-haspopup")) continue; // More 启动器不是插件面板
      const id = readPanelId(row);
      if (id === null) continue;
      rows.push({ row, id });
    }
    return rows;
  }

  function panelButton(list, panelId) {
    return list.querySelector(
      `.dsh-pin-button[${ATTR.pin}="panel"][${ATTR.panelId}="${CSS.escape(panelId)}"]`,
    );
  }

  function clearHideTimer() {
    if (hidePanelTimer !== null) {
      clearTimeout(hidePanelTimer);
      hidePanelTimer = null;
    }
  }

  function hidePanelButtons(list, exceptId) {
    clearHideTimer();
    for (const button of list.querySelectorAll(`[${ATTR.pin}="panel"]`)) {
      const id = button.getAttribute(ATTR.panelId);
      const isPinned = panelPins.includes(id);
      if (id !== exceptId && !isPinned) {
        button.setAttribute(ATTR.panelButtonVisible, "false");
      }
    }
  }

  function showPanelButton(list, panelId) {
    clearHideTimer();
    hidePanelButtons(list, panelId);
    const button = panelButton(list, panelId);
    if (button) button.setAttribute(ATTR.panelButtonVisible, "true");
  }

  function ensurePanelButton(list, row, panelId) {
    let button = panelButton(list, panelId);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "dsh-pin-button";
      button.setAttribute(ATTR.pin, "panel");
      button.setAttribute(ATTR.panelId, panelId);
      button.setAttribute(ATTR.panelButtonVisible, "false");
      button.appendChild(createPinIcon(14));
      list.appendChild(button);
    }
    const pinned = panelPins.includes(panelId);
    button.setAttribute("data-pinned", pinned ? "true" : "false");
    const label = pinned ? tr("action.unpinPanel") : tr("action.pinPanel");
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("aria-pressed", pinned ? "true" : "false");

    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      togglePanel(panelId);
    };
    button.onpointerdown = (event) => {
      event.stopPropagation();
    };
    button.onmousedown = (event) => {
      event.stopPropagation();
    };

    const top = row.offsetTop + (row.offsetHeight - PIN_BUTTON_SIZE) / 2;
    if (Number.isFinite(top) && top >= 0) button.style.top = `${top}px`;
    button.style.display = list.clientWidth <= 60 ? "none" : "inline-flex";
    return button;
  }

  /** 面板的注册顺序（与应用 sidebar 的排序规则一致：ordder 升序）。 */
  function basePanelIds() {
    try {
      return slotsService
        .entriesOfSlot("sidebar.panellist")
        .map(({ options }) => ({ id: options.id, order: options.order ?? 0 }))
        .sort((left, right) => left.order - right.order)
        .map((entry) => entry.id)
        .filter((id) => typeof id === "string" && id !== "");
    } catch {
      return [];
    }
  }

  function applyPanelOrder(list, rows) {
    const liveIds = rows.map((entry) => entry.id);
    const base = basePanelIds().filter((id) => liveIds.includes(id));
    const rest = liveIds.filter((id) => !base.includes(id));
    const desired = planPanelOrder([...base, ...rest], panelPins);
    if (sameArray(desired, liveIds)) return;

    // 行必须是面板列表的直接子元素才能安全移动；More 启动器被包在 span 里，
    // 用它所在的直接子元素作为锚点，插到它前面。
    const byId = new Map(rows.map((entry) => [entry.id, entry.row]));
    const moreRow = [...list.querySelectorAll(SELECTOR.panelRow)].find((row) =>
      row.hasAttribute("aria-haspopup"),
    );
    let anchor = null;
    if (moreRow) {
      if (moreRow.parentElement === list) anchor = moreRow;
      else if (moreRow.parentElement && moreRow.parentElement.parentElement === list) {
        anchor = moreRow.parentElement;
      }
    }

    for (const id of desired) {
      const row = byId.get(id);
      if (!row || row.parentElement !== list) continue;
      list.insertBefore(row, anchor);
    }
  }

  function syncPanels() {
    const list = panelListElement();
    if (!list) return;
    const rows = panelRows(list);
    if (rows.length === 0) {
      for (const button of list.querySelectorAll(`[${ATTR.pin}="panel"]`)) button.remove();
      return;
    }

    // 丢弃已卸载面板的置顶记录。
    const liveIds = rows.map((entry) => entry.id);
    const pruned = prunePanelPins(panelPins, liveIds);
    if (!sameArray(pruned, panelPins)) {
      panelPins = pruned;
      savePanelPins();
    }

    // 清掉不再存在的面板按钮。
    const liveSet = new Set(liveIds);
    for (const button of list.querySelectorAll(`[${ATTR.pin}="panel"]`)) {
      if (!liveSet.has(button.getAttribute(ATTR.panelId))) button.remove();
    }

    applyPanelOrder(list, rows);

    for (const { row, id } of rows) {
      ensurePanelButton(list, row, id);
      if (panelPins.includes(id)) row.setAttribute(ATTR.pinnedPanel, id);
      else row.removeAttribute(ATTR.pinnedPanel);
    }
    // 面板行可能因折叠/重排换了位置，按钮重算一次坐标。
    for (const { row, id } of panelRows(list)) {
      const button = panelButton(list, id);
      if (!button) continue;
      const top = row.offsetTop + (row.offsetHeight - PIN_BUTTON_SIZE) / 2;
      if (Number.isFinite(top) && top >= 0) button.style.top = `${top}px`;
    }
  }

  function togglePanel(panelId) {
    const list = panelListElement();
    const label = (() => {
      if (!list) return "";
      const row = panelRows(list).find((entry) => entry.id === panelId)?.row;
      return row?.getAttribute("aria-label") ?? "";
    })();
    panelPins = togglePanelPin(panelPins, panelId);
    savePanelPins();
    syncPanels();
    const pinned = panelPins.includes(panelId);
    toast(tr(pinned ? "toast.pinnedPanel" : "toast.unpinnedPanel", { title: label }));
  }

  // ── DOM 事件与观察 ───────────────────────────────────────────────

  /**
   * 坐标兜底命中：某些主题 / 第三方插件（例如自绘侧栏、悬浮遮罩）会在图钉上方
   * 盖一层透明元素，`event.target` 就不再是图钉本身。这里按点击坐标反查图钉，
   * 只要落点在图钉矩形内就当作命中，保证「看得见的图钉一定点得到」。
   * @param {MouseEvent} event 点击/按下事件。
   * @returns {Element | null} 命中的图钉或其指示器。
   */
  function pinAtPoint(event) {
    const x = event.clientX;
    const y = event.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return null;
    for (const node of document.querySelectorAll(`[${ATTR.pin}], [${ATTR.marker}]`)) {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return node;
    }
    return null;
  }

  function resolvePinTarget(event) {
    const target = event.target instanceof Element ? event.target : null;
    const direct = target ? target.closest(`[${ATTR.pin}], [${ATTR.marker}]`) : null;
    return direct ?? pinAtPoint(event);
  }

  function onClick(event) {
    const button = resolvePinTarget(event);
    if (!button) return;
    // 阻止行自身的点击/展开折叠/选择逻辑。
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const pinKind = button.getAttribute(ATTR.pin) || button.getAttribute(ATTR.marker);
    if (pinKind === "workspace") {
      const id =
        button.getAttribute(ATTR.workspaceId) ||
        workspaceIdFromRowKey(button.closest(SELECTOR.workspaceRow)?.getAttribute("data-row-key"));
      if (id) {
        const row = button.closest(SELECTOR.workspaceRow);
        const realButton = row?.querySelector('[data-dsh-pin="workspace"]') ?? button;
        void toggleWorkspace(id, realButton);
      }
    } else if (pinKind === "panel") {
      const id = button.getAttribute(ATTR.panelId);
      if (id) togglePanel(id);
    }
  }

  function onPointerDown(event) {
    const button = resolvePinTarget(event);
    if (!button) return;
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  let hidePanelTimer = null;

  function onPointerOver(event) {
    const list = panelListElement();
    if (!list || !(event.target instanceof Element)) return;
    const button = event.target.closest(`[${ATTR.pin}="panel"]`);
    if (button) {
      clearHideTimer();
      button.setAttribute(ATTR.panelButtonVisible, "true");
      return;
    }
    const row = event.target.closest(SELECTOR.panelRow);
    if (!row || row.hasAttribute("aria-haspopup")) return;
    const id = readPanelId(row);
    if (id !== null) showPanelButton(list, id);
  }

  function onPointerOut(event) {
    const list = panelListElement();
    if (!list || !(event.target instanceof Element)) return;
    const row = event.target.closest(SELECTOR.panelRow);
    const button = event.target.closest(`[${ATTR.pin}="panel"]`);
    if (!row && !button) return;
    const related = event.relatedTarget;
    if (related instanceof Node) {
      if (row?.contains(related) || button?.contains(related)) return;
      if (row && related instanceof Element && related.closest(`[${ATTR.pin}="panel"]`)) return;
      if (button && related instanceof Element && related.closest(SELECTOR.panelRow)) return;
    }
    clearHideTimer();
    hidePanelTimer = setTimeout(() => {
      hidePanelTimer = null;
      hidePanelButtons(list, null);
    }, 120);
  }

  function onFocusIn(event) {
    const list = panelListElement();
    if (!list || !(event.target instanceof Element)) return;
    const row = event.target.closest(SELECTOR.panelRow);
    if (!row || row.hasAttribute("aria-haspopup")) return;
    const id = readPanelId(row);
    if (id !== null) showPanelButton(list, id);
  }

  let lastError = null;

  const observer = new MutationObserver(() => {
    schedule();
  });

  let scheduled = null;
  function schedule() {
    if (scheduled !== null) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      try {
        syncWorkspaceRows();
        syncPanels();
      } catch (error) {
        lastError = String((error && error.stack) || error);
        /* 一次同步失败不致命，下一次 DOM 变更会重试 */
      }
    }, OBSERVE_DEBOUNCE_MS);
  }

  function attach() {
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();

    let unsubscribe = null;
    try {
      if (workspacesService.list && typeof workspacesService.list.subscribe === "function") {
        unsubscribe = workspacesService.list.subscribe(() => schedule());
      }
    } catch {
      /* 没有订阅能力也不影响按钮刷新 */
    }

    const onResize = () => schedule();
    window.addEventListener("resize", onResize);

    return () => {
      observer.disconnect();
      if (scheduled !== null) {
        clearTimeout(scheduled);
        scheduled = null;
      }
      clearHideTimer();
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("resize", onResize);
      if (typeof unsubscribe === "function") {
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
      }
      for (const node of document.querySelectorAll(
        `[${ATTR.pin}], [${ATTR.marker}], [${ATTR.toast}]`,
      )) {
        node.remove();
      }
      for (const list of document.querySelectorAll(`[${ATTR.panelList}]`)) {
        list.removeAttribute(ATTR.panelList);
        if (list.hasAttribute("data-dsh-pin-positioned")) {
          list.style.position = "";
          list.removeAttribute("data-dsh-pin-positioned");
        }
      }
      try {
        delete window.__dshPin;
      } catch {
        /* ignore */
      }
      document.getElementById(STYLE_ID)?.remove();
    };
  }

  // 测试/诊断钩子（只读为主，不参与任何业务逻辑）。
  try {
    window.__dshPin = {
      get workspaceRecords() {
        return workspaceRecords;
      },
      get panelPins() {
        return panelPins;
      },
      workspaceOrder,
      resync() {
        syncWorkspaceRows();
        syncPanels();
      },
      get lastError() {
        return lastError;
      },
      get serviceAvailable() {
        return workspacesService !== undefined && workspacesService !== null;
      },
    };
  } catch {
    /* ignore */
  }

  ctx.effect(() => attach(), "dsh-pin: sidebar pins");
}

const inject = ["locale", "slots", "workspaces"];

function apply(ctx) {
  install(ctx);
}
