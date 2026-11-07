# dsh-pin DOM 契约（侧边栏）

> 面向 `dsh-pin` 实现者的浏览器侧 DOM/React 契约说明。所有结论均在 scratch 实例
> `http://127.0.0.1:3091`（profile `pin-lab`）+ headless Chrome CDP 上实测，测量时间
> 2026-11-07 13:43–14:05（Asia/Shanghai）。可复跑的断言脚本见 `test/e2e/run.mjs`。

## 0. TL;DR（给实现者的 6 条硬结论）

1. **选择器稳定**：`nav[class*="panelList"]`、`button[class*="panelRow"]`（需排除
   `[aria-haspopup]` 的 More）、`[data-row-key^="workspace:"]`、`[data-row-key^="session:"]`
   在本版本稳定；类名前缀 `kB3qhq_`/`JoiKIa_` 是 CSS Modules 哈希，**不要**直接依赖。
2. **panel id 只能靠 React fiber 取**：从 `button[class*="panelRow"]` 的
   `__reactFiber$*` 向上找第 3 层 `PanelRow`，`memoizedProps.id` 可用（见 §4 的
   `getFiberProps`，用谓词匹配而不是组件名，避免压缩后名字变化）。
3. **React 不会在普通重渲染时还原你手动移动的面板行 DOM 顺序**（切换面板、折叠/展开、
   改窗口大小都不还原，节点复用）。因此“置顶面板”必须由插件自己保持顺序；面板行被
   React 卸载/重挂（如面板注册变化）后顺序会回到应用状态顺序，需要重新应用。
4. **workspace 置顶不要靠 DOM 顺序**：workspace 组在 rail 折叠/展开时会整棵卸载重挂，
   DOM 顺序会被应用 state 顺序覆盖。必须用宿主 API（`workspaces.insertBefore`，当前
   实现如此）。
5. **侧栏折叠成 56px rail 时**：panel 行**不卸载**（同一 `nav` 节点、行 36×36、标题 span
   被移除）；workspace 行**全部卸载**（`wsRows=0`）。所以注入的 workspace 按钮/标记
   在折叠后消失、展开后必须重新注入；panel 的绝对定位按钮需要随 `nav.clientWidth`
   变化隐藏/重算坐标。
6. **注入节点用 `data-*` 表达状态**：React 会重写 `className`（实测：手动加的 class
   在一次面板切换后丢失），但不会清除它不管理的 `data-*` 属性；行内追加的按钮在
   普通重渲染中存活（同一 DOM 节点），随行卸载而消失。

## 1. 环境与版本

| 项 | 值 |
| --- | --- |
| DSH 客户端 | 0.2.2-rc.1-c59d10a（`dsh-client-ui-sidebar` / `dsh-client-ui-workspace` / `dsh-client-ui-layout`） |
| 浏览器 | HeadlessChrome 156（CDP `http://127.0.0.1:9222`，user-data-dir `/tmp/pin-chrome`） |

> 说明：本文记录的 scratch 实例、headless Chrome 和 `~/.dsh/profiles/pin-lab` 都是开发期临时实验环境，实验结束后已清理。
> 复跑方法见 `README.md` 的「开发 / E2E」一节：新建一个含 `dsh-pin` 的 profile，`dsh --profile <name> --no-open --port 3091` 启动，
> 再起 headless Chrome 的 CDP，然后 `DSH_PIN_LAB_URL=… node test/e2e/run.mjs`。
| 视口 | 1600×1000（`Emulation.setDeviceMetricsOverride`，DPR 1） |
| 平台属性 | Web 模式，`<html>` 上**没有** `data-platform`（macOS 桌面壳才会是 `darwin`；这会影响折叠宽度行为，见 §6） |
| scratch 实例 | `http://127.0.0.1:3091`，token 会随实例重启变化 → 用 `DSH_PIN_LAB_URL` 覆盖 |

> **面板数量是动态的**：测量时 scratch profile 里注册了 5 个面板（`plugins`、`schedules`
> 以及另外 3 个插件面板 `token-stats`/`sticky-notes`/`recall`）。写选择器/断言时不要
> 硬编码面板数或 `aria-label` 文案；用 fiber 的 `props.id` 做身份。

## 2. 选择器表

| 目标 | 选择器 | 备注 |
| --- | --- | --- |
| 侧栏根 | `[class*="kB3qhq_root"]` | 宽 280px；折叠时加 `kB3qhq_collapsed` |
| 面板列表 | `nav[class*="panelList"]` | `aria-label="Global panels"`；`display:flex; flex-direction:column; gap:2px`；**原生 position 为 static**（当前插件给它设了内联 `position:relative`） |
| 面板行 | `button[class*="panelRow"]` | 面板行都是 `nav` 的直接子元素；通用选择器会把 More 也算进来 |
| 面板行（排除 More） | `button[class*="panelRow"]:not([aria-haspopup])` | More 是 `aria-haspopup="menu"`，且被 `<span class="...moreAnchor">` 包住，不是 `nav` 直接子元素 |
| 面板置顶按钮（当前实现） | `[data-dsh-pin="panel"][data-pin-panel-id]` | `position:absolute`，`nav` 直接子元素 |
| workspace 列表 | `.Kjh-qa_list[role="tree"]` | `aria-label="Sessions"`；其直接子元素是 29 个 `.Kjh-qa_groupSection`（含 Ungrouped） |
| workspace 组 | `.Kjh-qa_list > .Kjh-qa_groupSection` | 每组的 DOM：`groupSection > span._root_bgejw_3 > div[data-row-key]` |
| workspace 行 | `[data-row-key^="workspace:"]` | `div[role="treeitem"]`，高 34px，可拖拽 |
| session 行 | `[data-row-key^="session:"]` | `div[role="treeitem"]`，高 32px |
| 行操作区 | `[class*="rowActions"]` | workspace 行的原生按钮容器（hover 才显示） |
| 行文本 | `[class*="projectText"]` / `[class*="title"]` | 标题文本 |
| 折叠按钮 | `button[class*="toggle"][aria-label="Collapse sidebar"]` | 折叠后 aria-label 变为 Expand sidebar |
| 诊断钩子 | `window.__dshPin` | `{ workspaceRecords, panelPins, workspaceOrder(), resync(), lastError, serviceAvailable }`（当前实现提供，见 §8） |

**行 key 格式（实测）**

| 行类型 | `data-row-key` | 说明 |
| --- | --- | --- |
| workspace | `workspace:<uuid>` | 例 `workspace:5fa81607-f03d-4f2d-ac39-d0567521628f` |
| Ungrouped | `workspace:`（空后缀） | `draggable="false"`、无 `tabindex`，**不能置顶**（实现需跳过） |
| session | `session:session-<uuid>` | 例 `session:session-48d6dd0a-4f32-473c-98f0-accc897415bc`（注意重复前缀 `session-`） |
| 溢出组 | `overflow:<groupKey>` | 仅出现在分组会话溢出时（源码 `Rows` 中有该分支；本次实测未出现） |
| 空态 | `empty` | 源码中的空列表占位（本次实测未出现） |

## 3. workspace 行内部结构（原生）

```html
<div class="JoiKIa_projectRow" data-row-key="workspace:5fa81607-f03d-4f2d-ac39-d0567521628f"
     role="treeitem" aria-expanded="false" tabindex="0" draggable="true">
  <span class="JoiKIa_slot JoiKIa_folder"><svg data-icon="dsw-icon-folder-close-regular"/></span>
  <span class="JoiKIa_slot JoiKIa_chevron"><svg class="JoiKIa_arrow" data-icon="dsw-icon-triangle-right-fill-regular"/></span>
  <span class="JoiKIa_projectText"><span class="JoiKIa_title">dsh-pin</span></span>
  <span class="JoiKIa_rowActions">
    <button class="JoiKIa_iconButton" data-context-menu-trigger="true"
            aria-label="Workspace actions for dsh-pin" aria-haspopup="menu" aria-expanded="false">…</button>
    <button class="JoiKIa_iconButton" aria-label="New session in dsh-pin">…</button>
  </span>
</div>
```

| 测点 | 实测值 |
| --- | --- |
| 行高 | `34px`（CSS 固定），`padding-inline-start: 9px`，`display:flex` |
| 原生 rowActions | `display:none`；`@media (hover:hover)` 下 `.projectRow:hover .rowActions{display:inline-flex}` |
| hover 后 | `display:flex`、`gap:13px`、宽 78px；两个原生 `24×24` iconButton；`projectText` 从 x=42 起、宽 135（280px 侧栏、无注入按钮时） |
| 键盘 | 行是 `div[role=treeitem][tabindex=0]`；**projectRow 没有 `:focus-within` 显示 rowActions 的规则**（只有 sessionRow 有）。实测 keyboard 模态下 focus 行后 rowActions 仍 `display:none`、注入按钮 `offsetParent=null`、无法聚焦 → 注入到 rowActions 的按钮键盘不可达（见 §9 建议） |
| 触屏 | `@media (hover:none)` 下 DSH 强制 `.projectRow .rowActions{display:inline-flex}` |

## 4. panel 行与 React fiber 取 `props.id`

`PanelRow` 组件结构（源码 `dsh-client-ui-sidebar/lib/client.js`）：

```
button.kB3qhq_panelRow  →  Provider  →  Tooltip(Mn)  →  PanelRow  →  ...
        depth 0                1              2             3
```

- 从 button 元素上取 `Object.keys(el).find(k => k.startsWith('__reactFiber$'))` 得到 fiber；
- 向上 3 层 `fiber.return` 是 `PanelRow`，`fiber.memoizedProps` 含
  `{ id, label, wide, usePanelInfo, selectPanel, trackEntryClick, renderSlot }`；
- `fiber.key` 也等于 `id`（例 `"plugins"`、`"schedules"`、`"token-stats"`），但 **depth
  和组件名都可能随构建压缩/内部结构变化**，推荐用「谓词向上找」而不是写死 depth：

```js
// 可直接粘贴到页面 Runtime.evaluate 里使用
function getFiberProps(el, predicate, maxDepth = 12) {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  let fiber = key ? el[key] : null;
  for (let depth = 0; fiber && depth < maxDepth; depth++, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (props && typeof props === 'object' && predicate(props, fiber, depth)) {
      return { depth, type: fiber.type, key: fiber.key, props };
    }
  }
  return null;
}

// 面板行：id 是 string、有 label、selectPanel 是函数
const readPanel = (button) =>
  getFiberProps(button, (p) =>
    typeof p.id === 'string' &&
    typeof p.label === 'string' &&
    typeof p.selectPanel === 'function'
  );

// 面板 id 列表（排除 More：More 的 fiber 链是 button → Provider → Tooltip → span，没有 props.id）
const ids = [...document.querySelectorAll('nav[class*="panelList"] > button[class*="panelRow"]')]
  .filter((b) => !b.hasAttribute('aria-haspopup'))
  .map((b) => readPanel(b)?.props.id);
// 实测：["plugins","schedules","token-stats","sticky-notes","recall"]
```

同一套 `getFiberProps` 还能取其它行的数据（辅助定位行）：

```js
// workspace 行：ProjectRow（depth 3），props.group = { key, workspaceId, cwd, label, expanded, sessions, ... }
getFiberProps(row, (p) => p.group && typeof p.group === 'object' && 'workspaceId' in p.group);
// session 行：SessionNodeItem（depth 3），props.node = { id, title, blank, running, pinned, archived, updatedAt, cwd, ... }
getFiberProps(row, (p) => p.node && typeof p.node === 'object' && typeof p.node.id === 'string');
```

## 5. panelList 几何（1600×1000、5 个面板时）

| 测点 | 实测值 |
| --- | --- |
| `nav` rect | x=8, y=114, w=264, h=226（flex column） |
| `nav` position | 原生 `static`；**当前插件**加了 `data-dsh-pin-list` + 内联 `position:relative` |
| `nav` offsetParent | `div.PIRFFq_frame`（网格容器），但给 nav 设 `position:relative` 后，行的 `offsetParent` 变成 `nav` 本身 |
| 行几何 | 每行 `offsetTop = 0, 38, 76, 114, 152`、`offsetHeight=36`、`gap=2px` |
| 绝对定位公式 | `top = row.offsetTop + (row.offsetHeight - 20) / 2 = row.offsetTop + 8`（实测插件 `inline top` = 8/46/84/122/160，与公式完全一致） |
| More 行 | 在 `span._root_1p5el_1.kB3qhq_moreAnchor` 内，是 nav 直接子元素；重排面板行时用它作为锚点（插到 span 前） |

结论：把置顶按钮作为 `nav` 的直接子元素、`position:absolute; right:6px; z-index:3;`，用
`row.offsetTop + 8` 计算 top 是可行的；前提是 nav 是定位上下文（原生 static → 需要
插件设置 `position:relative`，React 不管理 nav 的 `style`，重渲染不会清除）。

## 6. 侧栏折叠（56px rail）

折叠前后对比（实测，2026-11-07）：

| 测点 | 展开 280px | 折叠 rail |
| --- | --- | --- |
| 根节点 | `div.kB3qhq_root` | 加 `kB3qhq_collapsed`（短时还有 `kB3qhq_railIn`） |
| frame 内联 grid | `280px minmax(0px,1fr) minmax(0px,0px)` | `56px …`（`56 - 1px` 边框 → root 实测 **55px**；见下方注意） |
| `nav` | 同一 DOM 节点 | **同一节点**（`data-dsh-pin-list`/内联 style 保留） |
| `nav.clientWidth` | 264 | 35 |
| `nav` gap | 2px | 12px |
| panel 行 | 264×36，含 `span.panelTitle` | 36×36，**不卸载**；标题 span 从 DOM 移除（React 卸载，`titles=0`） |
| workspace 行 | 29 个 | **0 个（全部卸载）**；`regionArea` 容器还在但为空 |
| 插件面板按钮 | 可见（hover 时 opacity 1） | 当前实现设 `inline display:none`（`nav.clientWidth<=60` 时），实测 5 个按钮全部隐藏 |

注意：
- 本机是 **Web 模式（`<html>` 无 `data-platform`）**，DSH layout 的 `collapsedWidth=56`；
  若 `<html data-platform="darwin">`（桌面壳），`collapsedWidth=0`，rail 会改成覆盖式
  （grid 轨道保持 280、rail 内容浮在内容区左侧）。写死 56px 只用在本实验环境。
- 无头 Chrome 标签页不可见时 CSS transition 会冻结，`grid-template-columns` 计算值可能停在
  280px（`data-animating` 一直为 true）。截图/尺寸断言前调 `Page.bringToFront`
  （`test/e2e/cdp.mjs` 的 `navigate()` 已内置）。
- 折叠/展开时 MutationObserver 能稳定观察到：首次 mutation ≈16ms；workspace 行消失
  ≈174ms；展开后重新出现 ≈15ms。插件用 ~120ms debounce 重新同步是够的。

## 7. DOM 重排稳定性（实验结论）

### 7.1 React 是否还原手动重排？— **不会（普通重渲染）**

实验（`test/e2e/run.mjs` §7a 复跑）：把 panelList 最后一个面板行 `insertBefore` 到第一行，
然后 `click()` 另一个面板行触发 React 状态更新，等两个 `requestAnimationFrame` 后读顺序：

```
moved      = ["记忆卡","Plugins","Automation tasks","用量统计","便签墙"]
afterRender= ["记忆卡","Plugins","Automation tasks","用量统计","便签墙"]   // React 未还原
```

另在 exp3 中做了更激进的实验（临时挂起插件的 120ms debounce，然后依次触发：切换面板、
折叠/展开侧栏、视口 1600→1500→1600 改大小）：面板行顺序始终保留手动顺序，且 `nav`、
各行 DOM 节点都是同一批（`sameNodes=true`）。**结论：React 不会主动把顺序恢复成 state
顺序；面板行只要不卸载，手动移动的顺序会一直保留。**

### 7.2 但顺序会丢/被覆盖的两种场景

1. **面板行被卸载重挂**（面板注册列表变化等）：顺序回到应用状态顺序 → 插件需要重新
   `applyPanelOrder`（当前实现靠 body 级 MutationObserver + 120ms debounce）。
2. **workspace 组在 rail 折叠/展开时整棵卸载重挂**：实测手动移动的 `.Kjh-qa_groupSection`
   顺序在展开后被状态顺序覆盖（`after=["workspace-a","workspace-b","workspace-c",…]`）。→ workspace
   置顶必须走宿主 API（`workspaces.insertBefore`），DOM 移动只适合面板行。

### 7.3 MutationObserver 兜底可行

- `observer.observe(document.body, { childList: true, subtree: true })` 足以：
  两轮 rail 折叠/展开记录到 3 次事件、20 added / 20 removed（exp3）。
- 在观察者回调里重新注入/修复不会自激（实测 fixer 只触发 1 次；注意在修复时先判断
  `data-dsh-pin` 是否已存在，避免死循环）。
- 插件实测：手动重排面板行后，插件在 ~150ms（debounce 120ms + 渲染）内把顺序还原到
  期望顺序（run.mjs 断言通过）。

### 7.4 注入节点的存活规律（实测）

| 注入位置 | 普通重渲染 | 折叠/展开 rail | 面板切换 |
| --- | --- | --- | --- |
| workspace 行 `[class*="rowActions"]` 内按钮 + projectText 内 marker + 行 `data-*` 属性 | 存活（同一节点、属性保留） | **丢失**（workspace 行全部卸载；展开后需重注入） | 存活 |
| `nav` 直接子元素的绝对定位按钮 | 存活（nav 节点复用） | 存活（nav 不卸载；但需按 rail 宽度隐藏） | 存活 |
| 面板行（React 管理节点）上的 `className` 追加 | **丢失**（React 重写 className，如 `panelActive` 变化时） | — | 丢失 |
| 面板行上的 `data-*` 自定义属性 | 存活（React 不清除它不管理的属性） | 存活 | 存活 |

→ 状态表达一律用 `data-*`；不要靠给 React 管理的元素加 class 来标记状态。

## 8. dsh-pin 注入契约（以当前已生效实现为准）

> 当前 scratch profile 中 dsh-pin 已安装并生效；`test/e2e/run.mjs` 会校验以下契约
> （37 项断言全部通过）。任务说明中提到的 `data-dsh-pinned="workspace|panel"` 实际实现
> 拆成了两个属性，见下表。

| 元素 | 契约 |
| --- | --- |
| 面板列表定位 | `nav[class*="panelList"]` 上 `data-dsh-pin-list=""`；若 `getComputedStyle(nav).position === "static"` 则设 `nav.style.position = "relative"` |
| 面板置顶按钮 | `<button type="button" class="dsh-pin-button" data-dsh-pin="panel" data-pin-panel-id="<PanelRow.id>" data-dsh-pin-visible="false" data-pinned="false" aria-label="Pin plugin" aria-pressed="false" style="top: <row.offsetTop + 8>px; display: inline-flex;">`，**nav 直接子元素**、`position:absolute; right:6px; z-index:3`，默认 `opacity:0; pointer-events:none`，hover/focus 时 `data-dsh-pin-visible="true"` → opacity 1 |
| workspace 置顶按钮 | `<button type="button" class="dsh-pin-button" data-dsh-pin="workspace" data-pin-workspace-id="<uuid>" data-pinned="false" aria-label="Pin workspace" aria-pressed="false">`，追加到行的 `[class*="rowActions"]`（找不到时回退到行末尾） |
| workspace 置顶标记 | `<span class="dsh-pin-marker" data-dsh-pin-marker="workspace" aria-hidden="true">`，置顶时**插到 `[class*="rowActions"]` 之前** |
| 行级状态 | `data-dsh-pinned-workspace="<uuid>"`（workspace 行）、`data-dsh-pinned-panel="<PanelRow.id>"`（面板行） |
| 跳过 Ungrouped | `data-row-key="workspace:"` 不支持置顶（当前实现通过 `workspaceOrder()` 判断并清理注入物） |
| 诊断钩子 | `window.__dshPin = { workspaceRecords, panelPins, workspaceOrder(), resync(), lastError, serviceAvailable }`，用于 E2E/排障 |

实测校验结果（1600×1000，5 个面板 / 29 个 workspace 行）：

- `[data-dsh-pin="workspace"]` = **28** 个（29 行 - Ungrouped），且全部在
  `[data-row-key^="workspace:"] [class*="rowActions"]` 内；
- `[data-dsh-pin="panel"]` = **5** 个，全部是 `nav` 直接子元素、`position:absolute`，
  `data-pin-panel-id` 与 fiber 取到的 `PanelRow.id` 一一对应；
- 置顶后：行属性出现、marker 出现、`aria-label` 变为 `Unpin …`、`aria-pressed="true"`；
  取消置顶后全部还原；
- `window.__dshPin.lastError === null`，`workspaceOrder()` 长度 = 28。

## 9. 可访问性与输入模态（实现注意）

- workspace 行是 `div[role=treeitem][tabindex=0]`，但 `projectRow` 只在 `:hover` /
  菜单打开时显示 rowActions；**没有 `:focus-within` 规则**。实测 keyboard 模态下
  focus 行后 rowActions 仍 `display:none`，注入的置顶按钮无法聚焦。
  建议插件 CSS 增加：
  `[data-row-key^="workspace:"]:focus-within [class*="rowActions"]{display:inline-flex}`。
- panel 行本身就是 `button`，focus 时插件 `focusin` 能显示置顶按钮（实测 focus 可落到
  `[data-dsh-pin="panel"]`）。
- 触屏：`@media (hover:none)` 下 DSH 强制显示 projectRow 的 rowActions；插件自己的
  CSS 也对 panel 按钮做了 `@media (hover:none)` 常显。
- `:has()` 可用（`CSS.supports('selector(:has(*))') === true`），可用于 hover 定位；
  但面板按钮是行的**兄弟节点**而不是子节点，`row:has(button)` 不成立，需用
  `nav:has(> [data-dsh-pin="panel"]:hover)` 之类的兄弟/父级选择器或直接 JS 控制。

## 10. 截图索引

开发期截图按 workspace 名单做过脱敏处理，仓库中只保留 README 使用的演示截图：

| 截图 | 说明 |
| --- | --- |
| [01-sidebar-baseline.png](../../assets/01-sidebar-baseline.png) | 1600×1000 视口下侧栏基线（未 hover 时置顶按钮不可见） |
| [02-workspace-hover.png](../../assets/02-workspace-hover.png) | workspace 行 hover：原生操作按钮 + 插件置顶按钮 |
| [03-sidebar-pinned.png](../../assets/03-sidebar-pinned.png) | workspace 置顶后：置顶标记/蓝色按钮可见 |
| [04-panel-hover.png](../../assets/04-panel-hover.png) | 面板行 hover：右侧浮出置顶按钮；置顶面板在列表顶部 |

> 其余开发期细节截图（panel-list / panel-row-hover / panel-pinned-top / rail-56px 等）只存在于本地实验记录，未随仓库发布。
