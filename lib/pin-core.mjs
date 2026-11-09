/**
 * dsh-pin 的纯逻辑核心。
 *
 * 这里只放可单测的纯函数：置顶/取消置顶的移动计划、多置顶记录维护、
 * 面板顺序计划、localStorage 记录解析。DOM 与 RPC 在 src/client-src.js。
 *
 * 记录约定：
 * - 工作区置顶记录：{ workspaceId, restoreBeforeId, pinnedAt }
 *   restoreBeforeId 是该工作区被置顶前，紧跟在它后面的工作区 id；
 *   取消置顶时插回这个锚点，从而实现「精确还原」。锚点消失时追加到末尾。
 * - 插件面板置顶：['panel-a', 'panel-b']，最近置顶的在前。
 */

export const WORKSPACE_RECORD_VERSION = 1;

/** 只接受非空字符串 id。 */
export function cleanId(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * 解析工作区置顶记录。损坏或历史版本的数据退化为空表，不抛错。
 * @param {unknown} raw localStorage 里的原始字符串或已是数组
 * @returns {{workspaceId: string, restoreBeforeId: string|null, pinnedAt: number}[]}
 */
export function parseWorkspaceRecords(raw) {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return [];
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const records = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const workspaceId = cleanId(item.workspaceId);
    if (workspaceId === null || seen.has(workspaceId)) continue;
    seen.add(workspaceId);
    const restoreBeforeId = cleanId(item.restoreBeforeId);
    const pinnedAt = Number.isFinite(item.pinnedAt) ? item.pinnedAt : 0;
    records.push({ workspaceId, restoreBeforeId, pinnedAt });
  }
  return records;
}

/** 序列化工作区置顶记录。 */
export function serializeWorkspaceRecords(records) {
  return JSON.stringify(
    (Array.isArray(records) ? records : []).map((record) => ({
      workspaceId: record.workspaceId,
      restoreBeforeId: record.restoreBeforeId === undefined ? null : record.restoreBeforeId,
      pinnedAt: Number.isFinite(record.pinnedAt) ? record.pinnedAt : 0,
    })),
  );
}

/** 查找某工作区的置顶记录。 */
export function findWorkspaceRecord(records, workspaceId) {
  if (!Array.isArray(records)) return null;
  return records.find((record) => record.workspaceId === workspaceId) ?? null;
}

/** 写入一条记录（同 id 覆盖），返回新数组。 */
export function upsertWorkspaceRecord(records, record) {
  const base = Array.isArray(records) ? records : [];
  const next = base.filter((item) => item.workspaceId !== record.workspaceId);
  next.push(record);
  return next;
}

/** 删除某工作区的记录，返回新数组。 */
export function removeWorkspaceRecord(records, workspaceId) {
  return (Array.isArray(records) ? records : []).filter(
    (record) => record.workspaceId !== workspaceId,
  );
}

/**
 * 计划一次「置顶工作区」。
 *
 * @param {{order: string[], workspaceId: string, now?: number}} input
 *   order 是宿主当前工作区顺序（items.map(workspaceId)）。
 * @returns {null | {move: boolean, beforeId: string|undefined, record: object}}
 */
export function planPinWorkspace({ order, workspaceId, now = Date.now() }) {
  const id = cleanId(workspaceId);
  const list = Array.isArray(order) ? order.map(cleanId).filter(Boolean) : [];
  const index = list.indexOf(id);
  if (index === -1) return null;

  // 记录「被置顶前后面是谁」，供取消时精确还原。
  const restoreBeforeId = list[index + 1] ?? null;
  const record = { workspaceId: id, restoreBeforeId, pinnedAt: now };

  if (index === 0) {
    // 已经在最上面：仍写记录，让「取消置顶」可用，但不需要移动。
    return { move: false, beforeId: undefined, record };
  }
  return { move: true, beforeId: list[0], record };
}

/**
 * 计划一次「取消置顶工作区」。
 *
 * @param {{order: string[], workspaceId: string, record: object}} input
 * @returns {null | {move: boolean, beforeId: string|undefined}}
 *   beforeId 为 undefined 表示追加到末尾（insertBefore 省略锚点即追加）。
 */
export function planUnpinWorkspace({ order, workspaceId, record }) {
  const id = cleanId(workspaceId);
  const list = Array.isArray(order) ? order.map(cleanId).filter(Boolean) : [];
  const index = list.indexOf(id);
  if (index === -1) return null;

  const anchor = record ? cleanId(record.restoreBeforeId) : null;
  if (anchor !== null && anchor !== id && list.includes(anchor)) {
    const anchorIndex = list.indexOf(anchor);
    // 已经紧挨在锚点前面就是原位，无需移动。
    return { move: anchorIndex !== index + 1, beforeId: anchor };
  }
  // 锚点已消失（被删除/被移到别处）：回退到末尾。
  return { move: index !== list.length - 1, beforeId: undefined };
}

/** 两段 id 序列是否完全相同。 */
function sameSequence(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * 计算「置顶项在前」的目标顺序。
 *
 * 置顶项保持它们当前已经存在的先后顺序（用户拖拽过置顶项时尊重拖拽结果），
 * 其余工作区保持当前相对顺序。宿主新建工作区会插到最前面，所以这个顺序
 * 和目标顺序不一致时就说明置顶项被挤下去了。
 *
 * @param {{order: string[], pinnedIds: string[]}} input
 * @returns {string[]} 目标顺序；没有存活置顶项时返回当前顺序的副本。
 */
export function orderWithPinnedFirst({ order, pinnedIds }) {
  const list = (Array.isArray(order) ? order : []).map(cleanId).filter(Boolean);
  const pinned = new Set((Array.isArray(pinnedIds) ? pinnedIds : []).map(cleanId).filter(Boolean));
  const pinnedLive = list.filter((id) => pinned.has(id));
  if (pinnedLive.length === 0) return [...list];
  return [...pinnedLive, ...list.filter((id) => !pinned.has(id))];
}

/**
 * 计算把置顶项恢复到列表最前所需的最小移动序列（用于顺序自愈）。
 *
 * 每个 move 都是 `workspaces.insertBefore(workspaceId, beforeId)` 的一次调用，
 * 依次执行即可得到 `orderWithPinnedFirst` 的顺序；返回空数组表示已经正确。
 *
 * @param {{order: string[], pinnedIds: string[], limit?: number}} input
 *   limit 兜底上限，默认按存活置顶项数 + 1 截断，避免异常数据导致死循环。
 * @returns {{workspaceId: string, beforeId: string}[]}
 */
export function planPinRestore({ order, pinnedIds, limit }) {
  const list = (Array.isArray(order) ? order : []).map(cleanId).filter(Boolean);
  const pinned = new Set((Array.isArray(pinnedIds) ? pinnedIds : []).map(cleanId).filter(Boolean));
  const live = list.filter((id) => pinned.has(id));
  if (live.length === 0) return [];

  const target = orderWithPinnedFirst({ order: list, pinnedIds });
  if (sameSequence(list, target)) return [];

  const maxMoves = Number.isFinite(limit) && limit > 0 ? limit : live.length + 1;
  const current = [...list];
  const moves = [];
  // 前 live.length 个位置就是目标前缀；逐个位置把该在的置顶项挪过来。
  for (let index = 0; index < target.length && moves.length < maxMoves; index += 1) {
    const wanted = target[index];
    // 非置顶项处在目标位置说明它前面的置顶前缀已经就位。
    if (current[index] === wanted) continue;
    if (!pinned.has(wanted)) continue;
    const from = current.indexOf(wanted);
    const beforeId = current[index];
    if (from === -1 || beforeId === undefined || beforeId === wanted) continue;
    // 与宿主 insertBefore 同语义：先摘掉目标，再插到锚点前面。
    const without = current.filter((id) => id !== wanted);
    const at = without.indexOf(beforeId);
    if (at === -1) continue;
    current.length = 0;
    current.push(...without.slice(0, at), wanted, ...without.slice(at));
    moves.push({ workspaceId: wanted, beforeId });
  }
  return moves;
}

/**
 * 把置顶集合切换一次：已在置顶里则取消，否则插到最前（最近置顶优先）。
 * @param {string[]} pins
 * @param {string} panelId
 * @returns {string[]}
 */
export function togglePanelPin(pins, panelId) {
  const list = Array.isArray(pins) ? pins.map(cleanId).filter(Boolean) : [];
  const id = cleanId(panelId);
  if (id === null) return list;
  if (list.includes(id)) return list.filter((item) => item !== id);
  return [id, ...list];
}

/** 丢弃已不再注册的面板 id，保留置顶顺序。 */
export function prunePanelPins(pins, panelIds) {
  const live = new Set((Array.isArray(panelIds) ? panelIds : []).map(cleanId).filter(Boolean));
  return (Array.isArray(pins) ? pins.map(cleanId).filter(Boolean) : []).filter((id) =>
    live.has(id),
  );
}

/**
 * 计算面板列表的目标顺序：置顶面板按置顶新→旧在前，其余保持当前顺序。
 * @param {string[]} panelIds 当前 DOM/注册顺序
 * @param {string[]} pins 置顶 id（最近置顶在前）
 * @returns {string[]}
 */
export function planPanelOrder(panelIds, pins) {
  const ids = (Array.isArray(panelIds) ? panelIds : []).map(cleanId).filter(Boolean);
  const live = new Set(ids);
  const pinOrder = (Array.isArray(pins) ? pins.map(cleanId).filter(Boolean) : []).filter((id) =>
    live.has(id),
  );
  const pinned = new Set(pinOrder);
  return [...pinOrder, ...ids.filter((id) => !pinned.has(id))];
}

/** 解析面板置顶记录；损坏退化为空表。 */
export function parsePanelPins(raw) {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return [];
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const pins = [];
  for (const item of value) {
    const id = cleanId(item);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    pins.push(id);
  }
  return pins;
}

/** 序列化面板置顶记录。 */
export function serializePanelPins(pins) {
  return JSON.stringify(Array.isArray(pins) ? pins : []);
}

/** 从 `data-row-key="workspace:<uuid>"` 里取工作区 id。 */
export function workspaceIdFromRowKey(key) {
  if (typeof key !== "string") return null;
  const prefix = "workspace:";
  if (!key.startsWith(prefix)) return null;
  return cleanId(key.slice(prefix.length));
}
