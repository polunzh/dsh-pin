# dsh-pin 资料调研：DSH 0.2.2-rc.1 客户端插件 API 契约

> 用途：给 dsh-pin 的两位实现者（客户端半 + 宿主半）提供**经过源码核对**的 API 契约、可复制片段与坑位清单。
> 范围：只读调研 DSH 源码；dsh-pin 现有文件仅作上下文参考，本文件不修改实现。
> 证据约定：文中 `文件:行号` 全部来自真实源码，未标注者为推断（会显式写“推断”）。
>
> 源码根：`/tmp/dsh-src/node_modules/@deepseek-ai/`（下称 `$SRC`，DSH `0.2.2-rc.1`，见 `$SRC/dsh-client-modules/package.json:4`）。
>
> 说明：`$SRC` 是开发时从 `app.asar` 解包的临时目录，实验结束后已清理；等价路径是
> `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/`，
> 需要复现时按 `README.md` 的说明重新解包即可。
> 前端外壳（压缩 bundle）：`$SRC/dsh-web-frontend/dist/assets/index-BgUyXZcc.js`（下称 `$SHELL`）。
> 本机参考插件：
> - `<dsh-plugins>/dsh-style-switcher`（自包含 bundle + 宿主 no-op，最接近本插件形态）
> - `<dsh-plugins>/dsh-sticky-notes`、`dsh-recall`（注册 `sidebar.panellist` + `main` 面板）
> - `<DSH_HOME>/plugins/deepseek-price-period`（最小 client-only 插件）
> - `<DSH_HOME>/profiles/pin-lab/package.json`（当前实验 profile，`dsh-pin` 以 link 方式加入 `dsh.profile.bundles`）

---

## 0. 速查（实现者先看这一段）

| 事项 | 结论 | 证据 |
| --- | --- | --- |
| 客户端入口 | `lib/client.js` 必须以 `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => ({ apply, inject }) })` 注册 | `$SRC/dsh-client-modules/lib/index.js:42`、`:518-546`；本机 `dsh-style-switcher/lib/client.js:1`、`:637`、`:713-717` |
| `id` 必须等于包名 | 浏览器按“包名”作为模块身份，对不上会报 `loaded without registering "<id>"` | `$SRC/dsh-client-modules/lib/client.js:760`、`:877`；`$SRC/dsh-client-modules/lib/index.js:792` |
| package.json | 需要 `exports["./client"]`；`dsh.client.platform = "web"` 才会被组合；`dsh.bundle.patch` 是 profile 选中该包时必需的 patch 层 | `$SRC/dsh-client-modules/lib/index.js:783-801`、`:86-98`；`$SRC/dsh-app-boot/lib/index.js:1804` |
| `external` | 只有 `require()` 了“平台 seed 表之外、且不是另一个动态包 row”的模块时才需要；本插件不需要 | `$SRC/dsh-client-modules/README.zh.md:56`、`$SRC/dsh-client-modules/lib/index.js:480-499`；seed 表见 `$SHELL:196` |
| 服务注入 | 用返回对象的 `inject: ["locale", "slots", "workspaces", ...]` 声明；未 inject 时 `ctx.xxx` 抛 `cannot get property "xxx" without inject` | `$SRC/cordis/src/reflect.ts:152`；`$SRC/cordis/lib/index.js:1707` |
| 读取未注入服务 | `ctx.get("name")` 不要求 inject，返回服务或 `undefined`（默认 strict=true 只取 active provider） | `$SRC/cordis/src/reflect.ts:239-257` |
| 清理 | `ctx.effect(() => disposer, "label")`；fiber 卸载时逆序执行，支持 sync/async/generator | `$SRC/cordis/src/fiber.ts:68-93`、`:408-423` |
| 工作区排序 | `ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId?)`：省略锚点=追加到末尾；模型先乐观改本地顺序再按 Host 返回校正 | `$SRC/dsh-api-workspace-controller/lib/client.js:96-107`、`:412-415` |
| 工作区排序失败 | 客户端控制器抛**普通 `Error`**（`workspace reorder failed: <code>: <message>`），不是 `WorkspaceArchiveError` | `$SRC/dsh-api-workspace-controller/lib/client.js:438-440`、`:412-415` |
| 工作区置顶 | DSH **没有**“工作区置顶集合”，只有持久顺序；取消置顶必须由插件自己记住原位置锚点后 `insertBefore` 还原 | `$SRC/dsh-workspace/README.zh.md:118`、`$SRC/dsh-workspace/lib/index.js:473-499` |
| 会话置顶（官方） | `workspaces.pinSession / unpinSession`，`pinnedSessionIds` **最近置顶在前**，宿主持久化 | `$SRC/dsh-api-workspace-controller/lib/client.js:161-178`、`:218-223`；`$SRC/dsh-workspace/lib/index.js:568-604` |
| 面板列表注册 | `ctx.slots.register({ name: "sidebar.panellist", id, order, label }, IconComponent)` | `$SRC/dsh-client-ui-sidebar/README.zh.md:42`；`$SRC/dsh-client-ui-sidebar/lib/client.js:690-704` |
| 面板 pin（DSH 自带） | 仅内存的 `unpinned` 集合（隐藏进 More），重载即丢；默认产品 UI **没有** Pin/排序控件，也不读写 localStorage | `$SRC/dsh-client-ui-sidebar/lib/client.js:14-30`、`:507-540`；`$SRC/dsh-client-ui-entry-customization/README.zh.md:31`、`:68-69` |
| 面板行 DOM | `<nav class="*panelList">` 内是 `<button class="*panelRow" aria-label="<label>">`；More 启动器同样是 `button.panelRow` 但带 `aria-haspopup="menu"`；**没有** `data-panel-id` | `$SRC/dsh-client-ui-sidebar/lib/client.js:206-237`、`:252-278`、`:507-540`；`$SRC/dsh-client-ui-sidebar/lib/client.js:116`（CSS） |
| 工作区行 DOM | `div[data-row-key="workspace:<workspaceId>"]`；行内操作区 `[class*="rowActions"]`（hover 才显示，高度 20px）；Ungrouped 桶的 key 是 `workspace:`（空 id） | `$SRC/dsh-client-ui-workspace/lib/client.js:2224-2302`、`:1041`、`:1044`、`:1955`（CSS） |
| 工作区行没有 action slot | 官方只给 Session 行提供 `sidebar.workspaces.session.row.action`，Workspace 行只能 DOM 注入 | `$SRC/dsh-client-ui-workspace/lib/client.js:6050-6079`、`:6099-6114`；`$SRC/dsh-client-ui-workspace/README.zh.md:131-192` |
| locale | `ctx.effect(() => ctx.locale.register(ns, { zh, en }), "label")` + `ctx.locale.bind(ns)`；**不需要**写进 `dsh.client.inject` | `$SRC/dsh-client-locale/README.zh.md:40`、`:96`；`$SRC/dsh-client-locale/lib/client.js:1675-1710`、`:1838` |
| 宿主半 | 导出 `apply`（+ 可选 `inject`/`name`）；client-only 时保持 no-op 即可，但**必须**是一个可 import 的合法 Cordis 插件 | `$SRC/cordis-plugin-loader/lib/index.js:583-591`、`:812-816`；`dsh-style-switcher/lib/index.js:9-16` |
| 挂载方式 | profile 的 `dsh.profile.bundles` 里列了本包 ⇒ 本包必须有 `dsh.bundle.patch`；否则该 bundle 被静默跳过，插件根本不会加载 | `$SRC/dsh-app-boot/lib/index.js:1795-1822`（缺 `dsh.bundle` 在 `:1804` 抛，`:1811-1821` catch 成 skipped） |
| patch insert | 顶层数组元素 `- insert: [{ id, name, config? }]`；无 `id` 的 insert 追加到根 entry 列表，有 `id` 则要求目标是 group 并追加到其 `config` | `$SRC/cordis-plugin-include/lib/index.js:218-268`、`:210-213` |
| 设计 token | 只用 `--dsw-alias-*` / `--dsw-radius-*` / `--ds-font-family-code`；行操作区高度 20px、官方行内按钮 24px 热区 | `$SRC/dsh-client-ui-theme/lib/client.js:1464`、`:1470`、`:1482`；`$SRC/dsh-client-ui-workspace/lib/client.js:1955`；`$SRC/dsh-client-ui-workspace/README.zh.md:112` |

---

## 1. 客户端插件的加载格式

### 1.1 `window.__ModuleLoader__.load(...)` 的真实契约

页面 `<head>` 里先注入一个**注册队列门面**（不是模块系统本体）：

```js
// $SRC/dsh-client-modules/lib/index.js:518-546（宿主注入到 index.html 的 inline script）
window.__ModuleLoader__ = {
  mode: "queue",
  pendingQueue,
  load(registration) { pendingQueue.push(registration) },
  create(options) { /* 物化 modules bundle，把队列切换为 live 模式 */ },
}
```

- 插件 bundle 脚本执行时只做一件事：把 `{ id, factory }` 推进队列（`$SRC/dsh-client-modules/lib/index.js:42` 的模块文档也这么写）。
- 外壳启动后 `create()` 把队列切换为 live：`target.mode = "live"; target.load = (registration) => this.register(registration)`，并重放队列（`$SRC/dsh-client-modules/lib/client.js:694-702`）。
- `register()` 会拒绝**同一 bundle 被第二次执行**导致的重复注册：`duplicate factory registration for "<id>" (bundle executed twice without invalidate?)`（`:704-716`）。因此 bundle 顶层除了 `load()` 不要有其它副作用；CSS 之类也要放进 factory 内部（`$SRC/dsh-client-modules/README.zh.md:78`）。
- `id` 必须与**包名**一致：浏览器侧模块身份就是 Host 解析出的 `packageName`（`$SRC/dsh-client-modules/lib/index.js:792-800`）；落空时报 `loaded without registering "<id>" via __ModuleLoader__.load`（`$SRC/dsh-client-modules/lib/client.js:760`、`:877`）。
- `factory(require)` 拿到的是**同步 CJS `require`**：解析顺序为平台 seed 表 → 已物化记录 → 图 row → 已注册 factory；循环依赖直接抛错（`$SRC/dsh-client-modules/lib/client.js:805-819` 的 `materialize()`、`$SRC/dsh-client-modules/README.zh.md:78`）。
- 支持 `require.async("./client.<name>.js")` 拉包内 chunk（`$SRC/dsh-client-modules/README.zh.md:43`、`:86`）；本插件单文件即可，不需要 chunk。

参考实现（本机现有插件的最小外壳）：

```js
// dsh-style-switcher/lib/client.js:1-7（dsh-sticky-notes / dsh-recall / deepseek-price-period 同构）
window.__ModuleLoader__.load({
  id: "dsh-style-switcher",
  factory: (require) => {
    const React = require("react");       // 需要 React 时
    // ...模块级常量、纯函数、组件...
    const inject = ["slots", "theme"];    // 见第 2 节
    function apply(ctx) { /* ... */ }
    return { apply, inject };
  },
});
```

### 1.2 `package.json`：`dsh.client` / `dsh.bundle` / `main`

`dsh.client` 只识别这几个字段（`$SRC/dsh-client-modules/lib/index.js:86-98`）：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `platform` | `string`（必填） | 宿主扫描时只接受 `"web"`（`lib/index.js:790`：`decl.platform !== "web"` 返回 null） |
| `external` | `string[]` | `require()` 且**不在**平台 seed 表、也不由其它动态包 row 提供的精确请求；会建图边并保证被请求包先加载（`lib/index.js:480-499`、`README.zh.md:56`） |
| `inject` | `string[]` | **加载/预取图元数据**：先加载这些包的 client bundle，再加载本包；**不是** Cordis 服务注入（`lib/index.js:460-467`、`:779-796`；ui-workspace 的源码注释明确写 “dsh.client.inject edges are informational (loading/prefetch metadata, never apply sequencing)” —— `$SRC/dsh-client-ui-workspace/lib/client.js:5738-5746`） |
| `immediately` | `boolean` | 启动首帧就预取（`lib/index.js:800`、`:465-467`；外壳 `prefetchImmediateTier()` 在 `$SHELL:194`） |

- 宿主侧要求包导出 `./client`：`exports` 里必须有 `"./client"` 子路径，否则启动报 `declares dsh.client but exports no "./client" bundle`（`$SRC/dsh-client-modules/lib/index.js:792`）。参考 `$SRC/dsh-client-ui-sidebar/package.json:16-28`。
- `platform` 声明示例：`$SRC/dsh-client-ui-sidebar/package.json:29-41`（顺带演示了 `dsh.client.inject` 的用法：列出它依赖的其它客户端包 row）。
- `dsh.bundle.patch` 指向本包的 patch 文件；profile 把本包列进 `dsh.profile.bundles` 时，**本包必须声明它**，否则该层被静默跳过（`$SRC/dsh-app-boot/lib/index.js:1804`、`:1811-1821`）。参考 `dsh-style-switcher/package.json:13-21`、`dsh-sticky-notes/package.json:15-23`。
- `main`（或 `exports["."]`）指向宿主半，见 1.3。

本插件当前的 `package.json`（`<repo-root>/package.json:1-40`）已满足以上全部要求：`main: ./lib/index.js`、`exports["./client"]: ./lib/client.js`、`dsh.bundle.patch: ./cordis.patch.yml`、`dsh.client.platform: "web"`、`manifestVersion: 1`。**不需要** `external`（bundle 没有 `require` 平台外模块），也**不需要** `dsh.client.inject`。

### 1.3 宿主半（`lib/index.js`）必须导出什么

Host 的 Loader 对每个 `insert` entry 做：`import(name)` → `unwrapExports()` → `ctx.registry.plugin(plugin, config)`（`$SRC/cordis-plugin-loader/lib/index.js:583-591`、`:812-816`）。

- `unwrapExports` 先取 `exports.default ?? exports`；ESM 命名空间没有 `__esModule`，所以导出对象直接作为 plugin。
- Cordis 接受三种 plugin 形态：函数、类、`{ apply }` 对象；`plugin.inject` 被 `Inject.resolve()` 归一化（`$SRC/cordis/lib/index.js:1691-1707`）。`name` 导出只影响诊断名。
- **纯浏览器插件也必须有一个能 import 的宿主半**，否则 Host Loader 这一行会 import 失败（参考实现都留 no-op）：

```js
// dsh-style-switcher/lib/index.js:7-16
const NS = "dsh-style-switcher";
export const inject = [];
export function apply() {
  // 全部行为在浏览器半；这里只保证它是一个合法 Cordis bundle。
}
export const name = NS;
```

本插件的宿主半（`dsh-pin/lib/index.js`）就是这种 no-op，文档注释也已写明原因（`:1-7`）。只要它还导出 `apply` 就是合法的。

### 1.4 浏览器 bundle 里可以 `require` 什么（平台 seed 表）

外壳在创建模块系统时传入冻结的 `staticModules` 表（`$SHELL:196`，`YZ()`）：

```js
{
  "react": ..., "react/jsx-runtime": ..., "react-dom": ..., "react-dom/client": ...,
  "@deepseek-ai/cordis": ...,
  "zod": ...,
  "@tanstack/react-virtual": ...,
  "@deepseek-ai/dsh-client-store": ...,
  "@deepseek-ai/dsh-client-ui-slots": ...,
  "@deepseek-ai/dsh-client-ui-primitives": ...,
  "@deepseek-ai/dsh-client-ui-dockkit": ...
}
```

- 这些可以直接 `require`，**不用**写进 `dsh.client.external`。
- `@deepseek-ai/dsh-client-ui-slots` 在 npm 包里没有独立目录（它是外壳静态模块）：其导出为 `SlotCore`、`SlotOwnershipError`、`StaleAuthorizationError`、`resolveSlotLabel`、`standardHookPropName`（`$SHELL:123`）。
- 本插件是纯 DOM 方案，bundle 可以完全不用 `require`（即 `factory: () => ({ apply, inject })`，参照 `deepseek-price-period/lib/client.js:1-3,56-58`）。

### 1.5 本插件落地格式

`lib/client.js` 头部已经是正确形态（`dsh-pin/lib/client.js:1-4`），由 `scripts/build-client.mjs` 生成（`:46-55`）。需要保证的只有两件事：

1. `id: "dsh-pin"` 等于包名；
2. `factory` 返回 `{ apply, inject }`，且 `inject` 覆盖实际用到的服务（本插件为 `["locale", "slots", "workspaces"]`，见 2.1/2.4）。

---

## 2. 客户端 `ctx`：inject、effect、服务注入

### 2.1 返回的 `{apply, inject}` 如何被安装

浏览器外壳启动时：

```js
// $SHELL:194（KZ 函数，压缩但可读）
await ctx.plugin(modulesPlugin);          // 先装模块系统
const loader = ctx.loader;
loader.internal = modules;                // 让 Loader 从浏览器 bundle import
await modules.entries.start(loader, manifest);
```

`entries.start()` 为 manifest 中每个插件创建 entry：`{ name: id }` → `loader.create(options)`（`$SRC/dsh-client-modules/lib/client.js:383-400`、`:483-487`）。Loader 用 `name` 调 `tree.import()`，在浏览器里走 `loader.internal.import()`（`$SRC/cordis-plugin-loader/lib/index.js:583` 附近的 `import()`），拿到 factory 的导出后交给 `ctx.registry.plugin(plugin, ...)`（`:591`）。

Cordis 安装一个 `{apply, inject}` 对象时：

```js
// $SRC/cordis/lib/index.js:1691-1707（节选）
plugin(plugin, config, getOuterStack = buildOuterStack()) {
  const callback = this.resolve(plugin);          // typeof fn ? fn : plugin.apply
  ...
  const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);
  ...
}
```

`Inject.resolve()` 接受数组或 `{ name: config }` 映射（`$SRC/cordis/src/registry.ts:65-90`）。所以导出 `inject: ["slots", "workspaces"]` 就是“声明这几个服务必须已提供，才运行 apply”。

### 2.2 未 inject 时访问 `ctx.<service>` 会抛错

Cordis 的 Context 是 Proxy，服务读取有两条路（`$SRC/cordis/src/reflect.ts`）：

- **属性访问** `ctx.workspaces`：走 `ReflectService.handler.get`；属性不在 target 上时，沿 fiber 链找提供者；找不到/未 inject 就抛出
  `cannot get property "workspaces" without inject`（`:152`；若声明了 inject 但提供者 inactive，错误信息变成 `cannot get required service "workspaces" in inactive context`，`:172-174`）。
- **显式读取** `ctx.get(name, strict = true)`：**不需要 inject**，直接查服务表；服务不存在返回 `undefined`（`:239-257`）。`strict=true` 表示只返回 provider fiber 处于 ACTIVE 的实现。

因此：

- 想在 `apply` 里用 `ctx.workspaces` / `ctx.slots` / `ctx.locale`，**必须**把名字写进导出的 `inject` 数组。
- 只想“有就用、没有就算了”的可选依赖，用 `ctx.get("workspaces")` 并判空。官方例子：`ctx.get("productAnalytics")?.track(...)`（`$SRC/dsh-client-ui-sidebar/lib/client.js:723-725`、`$SRC/dsh-client-ui-entry-customization/lib/client.js:173-183`）。

### 2.3 `ctx.effect` 的清理契约

```ts
// $SRC/cordis/src/fiber.ts:408-423 文档注释
/**
 * Register a cleanup-aware effect on this fiber.
 * `execute` runs immediately; the disposers it produces are collected and
 * run (in reverse order) either when the returned disposer is called or
 * when the fiber unloads, whichever comes first. Calling the disposer twice
 * is a no-op. Throws CordisError('INACTIVE_EFFECT') if the fiber is already
 * disposed, and TypeError if execute returns an invalid shape.
 */
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
```

- `execute` 返回值可以是：单个 disposer、disposer 的 Promise、同步/异步 iterable（逐个收集）——`$SRC/cordis/src/fiber.ts:68-93`、`:362-405`。
- 清理顺序：**逆注册序**执行；异步 disposer 会被 await（`fiber.ts:68-74`）。
- `label` 用于 `getEffects()` 诊断；建议所有 effect 都写 `"dsh-pin: ..."` 前缀。
- 非法返回值抛 `TypeError('Invalid effect')`（`fiber.ts:369/378/403`）；fiber 已销毁时再建 effect 抛 `CordisError` code `INACTIVE_EFFECT`（`fiber.ts:172`、`:425-428`）。
- 本插件的用法（`dsh-pin/src/client-src.js`）：`ctx.effect(() => attach(), "dsh-pin: sidebar pins")`，`attach()` 返回的 cleanup 里要断开 `MutationObserver`、移除事件监听/timer/注入的 DOM/style（本仓库实现已在 `attach()` 的 return 段里这么做）。这是正确契约：**插件卸载时 DSH 不会替你删除注入的 DOM**。
- `ctx.slots.inject` 内部也用 `ctx.effect` 管理 callback 的生命周期：slot 声明折叠时清理、恢复时重放（见 2.6）。

### 2.4 inject 的等待语义与失败表现

- `inject` 声明的是“必须已提供”的服务：未提供时 fiber 保持 **PENDING**，等 service 出现后再激活；页面启动审计会把它列出来：`web boot: N entries did not activate ... <id>: pending (waiting for services: a, b)`（`$SHELL:194` 的 `qZ()`）。
- 因此 inject 里不要写“可能不存在”的可选服务（那样插件会一直 pending）；可选依赖用 `ctx.get()`。
- 若服务存在但 provider fiber 非 active，属性访问抛出 `cannot get required service "x" in inactive context`（`$SRC/cordis/src/reflect.ts:172-174`）。
- 另一个细节：`inject` 声明在**返回对象**上，而不是 package.json；写错位置（例如只写 `dsh.client.inject`）不会产生 Cordis 等待。

### 2.5 `dsh.client.inject` ≠ 服务 inject（两个同名概念别混）

| 概念 | 位置 | 作用 |
| --- | --- | --- |
| `inject`（导出对象） | `lib/client.js` 的 `return { apply, inject }` | Cordis fiber 依赖：等待服务后再 apply |
| `dsh.client.inject` | `package.json` → `dsh.client.inject` | 浏览器**模块图装载顺序/预取**元数据，仅列出包名；不影响 apply 时序（`$SRC/dsh-client-ui-workspace/lib/client.js:5738-5746`、`$SRC/dsh-client-modules/lib/index.js:460-467`） |

本插件 `package.json` 里不需要 `dsh.client.inject`；导出对象里声明 `["locale", "slots", "workspaces"]` 即可。

### 2.6 `slots` 服务在哪、怎么用

- 提供者：`@deepseek-ai/dsh-client-ui-renderer` 的 `SlotRegistry extends Service`，`super(ctx, "slots")`（`$SRC/dsh-client-ui-renderer/lib/client.js:1305-1352`）。
- 主要 API：
  - `inject(key, callback)`：依赖某个 slot 的**声明**；声明存在时同步执行 callback，声明折叠时清理、恢复后重放（`:1368-1427`，文档注释在 `:1353-1367`）。**即使 owner 通常已存在，也必须用它**，参考 `$SRC/dsh-client-ui-workspace/README.zh.md:192`。
  - `register(options, component)`：注册项；返回 disposer；经 `ctx.effect` 绑定调用方 fiber（`:1602-1623`、`:1815`）。
  - `entriesOfSlot(key)`：每个 cell 的“胜出项”（list 按 id 去重、按 priority→order 排序）（`:1554-1556`；实现见 `$SHELL:123`）。**slot 尚未声明时返回空冻结数组**（`$SHELL:123`：`if (!t?.spec) return b1`），不会抛错——所以插件可以先用它枚举，等声明出现后由 `subscribe`/DOM 变化再同步。
  - `subscribe(key, fn)` / `entries(key)` / `spec(key)` / `getVersion(key)`（`:1542-1601`）。
  - `installLocale(face)`：boot-once，由 client-locale 安装（`:1450-1457`）。

---

## 3. Workspaces 客户端服务

### 3.1 身份与获取

`@deepseek-ai/dsh-api-workspace-controller` 的客户端入口创建：

```js
// $SRC/dsh-api-workspace-controller/lib/client.js:381-392
var WorkspaceController = class extends cordis.Service {
  model; list;
  constructor(ctx, model) {
    super(ctx, "workspaces");   // 服务名 = "workspaces"
    this.model = model;
    this.list = model;          // list 就是 ClientWorkspaceModel
  }
  ...
};
```

- 服务名：`"workspaces"`（`:389`）。
- 获取方式二选一：
  - `inject: ["workspaces"]` 后 `ctx.workspaces`（推荐，插件会等它出现）；
  - `const w = ctx.get("workspaces")`（不需要 inject，可能 `undefined`）。
- 该服务实现的 `inject` 是 `["remote", "remote.workspace"]`（`:445`），并 `ctx.effect` 管理 follow 流的生命周期（`:450-466`）。

### 3.2 `list` 快照字段与 `WorkspaceView`

```js
// $SRC/dsh-api-workspace-controller/lib/client.js:255-268
getSnapshot() {
  this.refreshSnapshot();
  return this.snapshotCache;   // { items, archivedSessionIds, pinnedSessionIds, state, phase, error }
}
buildSnapshot() {
  return {
    items: this.items,                 // WorkspaceView[]（当前顺序）
    archivedSessionIds: this.archivedSessionIds,
    pinnedSessionIds: this.pinnedSessionIds,
    state, phase, error,
  };
}
```

订阅：`model.subscribe(listener)` 返回 unsubscribe（`:245-250`）；通知是 microtask 批处理的（`:313-330`）。该包 README 明确说它“公开与框架无关的快照和订阅”（`$SRC/dsh-api-workspace-controller/README.zh.md:29`）。

`WorkspaceView` 字段（Host 投影，ISO-8601 字符串）：

```ts
// $SRC/dsh-api-workspace-controller/lib/typert.remote-client.js:47-54
{
  workspaceId: string,
  path: string,        // canonical host directory path
  title: string,       // user-visible title
  sessionIds: string[] // sessions accounted to this Workspace, manual order
  createdAt: string,   // ISO-8601
  updatedAt: string,   // ISO-8601 last-mutation instant
}
```

> 注意：`sessionIds` 是**成员关系**，不是显示顺序（ui-workspace README 也强调这一点：`$SRC/dsh-client-ui-workspace/README.zh.md:202`）。工作区置顶用不到它。

### 3.3 `insertBefore(workspaceId, beforeWorkspaceId?)` 语义

客户端模型层（**乐观更新**发生在这里）：

```js
// $SRC/dsh-api-workspace-controller/lib/client.js:96-107
async insertBefore(workspaceId, beforeWorkspaceId) {
  const requestGeneration = ++this.orderRequestGeneration;
  const frameGeneration = this.orderFrameGeneration;
  const localOrder = this.items.map((workspace) => workspace.workspaceId);
  this.installOrder(insertIdBefore(localOrder, workspaceId, beforeWorkspaceId)); // 先改本地
  const result = await this.remote.insertBefore({
    workspaceId,
    ...beforeWorkspaceId === void 0 ? {} : { beforeWorkspaceId }
  });
  if (requestGeneration === this.orderRequestGeneration && frameGeneration === this.orderFrameGeneration)
    this.installOrder(result.ok ? result.value.workspaceIds : this.committedOrder, result.ok);
  return result;   // generated Remote result: { ok, value } | { ok:false, error }
}
```

- `beforeWorkspaceId` **省略 = 追加到末尾**（文档注释 `:90-95`；Host 实现同样：`$SRC/dsh-workspace/lib/index.js:473-490`）。
- `insertIdBefore()` 对“id 不存在 / 锚点不存在 / 锚点==自身”做保护（`:343-352`）。
- Host 结果是**完整顺序** `{ workspaceIds: string[] }`（`$SRC/dsh-api-workspace-controller/lib/typert.remote-client.js:129-136`）；失败时客户端会回滚到 `committedOrder`（`:105`）。
- 官方 UI 的调用点（可直接对照）：

```js
// $SRC/dsh-client-ui-workspace/lib/client.js:6026-6028
insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
  await workspaces.insertBefore(workspaceId, beforeWorkspaceId);
},
```

### 3.4 失败抛什么、怎么降级

- **模型层**返回 generated result，不抛（除非传输层问题）。
- **控制器（`ctx.workspaces`）层**把失败翻译成异常：

```js
// $SRC/dsh-api-workspace-controller/lib/client.js:412-415
async insertBefore(workspaceId, beforeWorkspaceId) {
  const result = await this.model.insertBefore(workspaceId, beforeWorkspaceId);
  if (!result.ok) throw commandError("reorder", result.error);
}
// :438-440
function commandError(operation, failure) {
  return new Error(`workspace ${operation} failed: ${failure.code}: ${failure.message}`);
}
```

- 所以插件 `await ctx.workspaces.insertBefore(...)` 失败时拿到的是**普通 `Error`**，不是 `WorkspaceArchiveError`（后者只有 `archiveSession` 用，`:371-379`、`:416-419`，且带 `rpcError`）。很多本机/官方代码判断错误类型是靠 `error.name === "WorkspaceArchiveError"`（`$SRC/dsh-client-ui-workspace/lib/client.js:6153-6157` 注释也说明了 bundle 之间不共享错误类身份）。
- Host 侧 `insertBefore` 的错误码：未知 workspace/anchor → `workspace/not-found`（`$SRC/dsh-api-workspace-controller/lib/index.js:262-270`；Host registry 抛 `WorkspaceOrderInvalidError` 的 id，`$SRC/dsh-workspace/lib/index.js:334-343`、`:482-483`）。
- 静默降级建议：
  - `try { await insertBefore(...) } catch { toast("置顶失败") ; 回滚本地记录 }`；
  - 不要依赖错误码（客户端 `commandError` 只有字符串消息）；如需判断，用 `String(err.message).includes("workspace/not-found")`。
  - 若 workspace 已被别的客户端删除，`insertBefore` 失败不会自动撤销“已置顶”记录——必须自己回滚（`dsh-pin/src/client-src.js` 的 catch 分支就是这么做的）。

### 3.5 权限：能不能排序

官方 UI 用 Workspace 资源的 `workspace/insertBefore` action 控制排序：

```js
// $SRC/dsh-client-ui-workspace/lib/client.js:2201-2210
function WorkspaceProjectRow({ workspaceId, ...props }) {
  const { useWorkspaceAccess } = props;
  const access = {
    create: useWorkspaceAccess(workspaceId, "session/create"),
    reorder: useWorkspaceAccess(workspaceId, "workspace/insertBefore"),
  };
  ...
}
```

- `useWorkspaceAccess(workspaceId, action)` 是 ui-workspace 通过 `ctx.slots.provideRoot` 发布的**标准 Hook**，底层是 `ctx.remoteAccess.source("workspace", id, action)`（`$SRC/dsh-client-ui-workspace/lib/client.js:5781-5784`；README `$SRC/dsh-client-ui-workspace/README.zh.md:98`）。
- 对**非 React / DOM 注入**的第三方插件，官方给出的路径是 `ctx.uiWorkspace.whenAccess(workspaceId, action, callback)`：答案 true 期间保持 callback 的 effect，false 时逆序撤销（`$SRC/dsh-client-ui-workspace/lib/client.js:1577-1582`；README 同上 `:98`）。服务名是 `uiWorkspace`（`:1361`、`:1382`）。
- `ctx.remoteAccess` 的公开 API（`$SRC/dsh-api-remote-access/lib/client.js:711-730`）：

```js
var ClientRemoteAccessService = class extends cordis.Service {
  constructor(ctx, state) { super(ctx, "remoteAccess"); ... }
  source(kind, id, action) { return this.state.resource(kind, id, action); } // 返回 identity-stable boolean source
  whenAccess(action, callback) { ... }                                        // global 资源
  whenResourceAccess(kind, id, action, callback) { ... }                      // 指定资源
};
```

  source 形状 = `{ getSnapshot(): boolean, subscribe(fn): () => void }`（`:576-592`）。
- 权限语义（`$SRC/dsh-api-remote-access/README.zh.md:62-68`）：owner 恒 true；无 baseline 的非 owner 页面所有答案 false；资源 grant 不会回退到 global 答案。Host 端每次调用仍会独立校验（`$SRC/dsh-api-remote-access/README.zh.md:34` 的 `allows()`）。
- 实现建议（按成本从低到高）：
  1. 直接注入 `uiWorkspace`，对每行用 `whenAccess(workspaceId, "workspace/insertBefore", () => 安装按钮/返回 disposer)`；
  2. 或 `ctx.get("remoteAccess")?.source("workspace", workspaceId, "workspace/insertBefore")` 读快照 + 订阅（README 建议“只有拥有资源种类的包才调用 source”，第三方优先用 1）；
  3. 即使不判权限也**可以**直接调用，失败会走到 3.4 的 catch；owner（本机日常页面）恒允许。
- 本机 pin-lab 的页面是 owner（`$SRC/dsh-api-remote-access/README.zh.md:48`：owner 页面的注入 baseline 是 `{ type: "baseline", owner: true }`），所以 E2E 里默认一定允许排序；权限分支主要用于 liveshare 读者页。

### 3.6 “工作区置顶/取消置顶”的语义（重要：DSH 没有工作区 pin 集合）

- DSH 的持久状态里只有 `workspaceIds`（权威显示顺序）、`archivedSessionIds`、`pinnedSessionIds`（**会话**置顶集）；没有“置顶的工作区”字段（`$SRC/dsh-workspace/README.zh.md:118`、`$SRC/dsh-workspace/lib/index.js:231-246`）。
- 所以“工作区置顶”只能是**顺序操作**：
  - 置顶：`insertBefore(workspaceId, 当前第一个 workspaceId)`（已经是第一时无需调用）。
  - 取消置顶：需要一个“原位置”记忆。DSH 不提供，插件必须自己记录。可选方案：
    - 记录置顶前**紧跟在它后面的 workspace id**（`restoreBeforeId`），取消时 `insertBefore(id, restoreBeforeId)`；锚点消失则 `insertBefore(id)`（追加到末尾）。本仓库 `lib/pin-core.mjs:83-128` 用的就是这个方案；
    - 或记录索引 + 前后锚点，取消时用“前一个 id 的后一个位置”等；索引会因其它客户端排序而漂移，锚点方案更稳。
- 顺序是**宿主全局持久化**的：置顶会影响同一 Host 上的所有浏览器；但“这一行是否置顶”的标记只能存在本浏览器（localStorage）。跨浏览器会看到“顺序被改过、但没有置顶徽标”的状态，这是预期代价，必要时在 UI 上写清楚（推断）。
- `insertBefore` 对“已经在目标位置”是幂等的（Host 层 `sameIds` 直接返回原数组，`:479-499`；模型层 `installOrder` 也会判等早退 `:279-286`）。

---

## 4. 官方的“会话置顶”（已有能力，别重复实现）

- 客户端 API：`ctx.workspaces.pinSession(sessionId)` / `unpinSession(sessionId)`，返回 `void`，失败抛 `commandError("session pin"/"session unpin", ...)`（`$SRC/dsh-api-workspace-controller/lib/client.js:424-431`、`:438-440`）。
- 模型层：成功即安装 Host 返回的**完整 pin 集合**，并做了“较新的请求/推送覆盖较旧回显”的竞态处理（`:161-178`、`:30-32`）。
- 顺序语义：`pinnedSessionIds` 是 **最近置顶在前**（模型注释 `:216-223`；Host schema 描述 `$SRC/dsh-workspace/lib/index.js:235-246`；Host README `$SRC/dsh-workspace/README.zh.md:118`）。
- Host 持久化 + 归档自动清 pin：`$SRC/dsh-workspace/lib/index.js:538`、`:568-604`；归档时同一次写入清 pin（README `:118`）。
- UI 侧：置顶行会先于普通行渲染（README `$SRC/dsh-client-ui-workspace/README.zh.md:38-40`）。
  - 行内悬停按钮：`archive`（order 100）、`pin`（order 200），注册在 `sidebar.workspaces.session.row.action`（`$SRC/dsh-client-ui-workspace/lib/client.js:6099-6114`）。
  - 行菜单动作：置顶 100、重命名 200、分叉 300、复制 ID 450、归档 600（README `$SRC/dsh-client-ui-workspace/README.zh.md:125`；实现 `lib/client.js:4345` 起）。
  - 权限 action 名是 `workspace/pinSession` / `workspace/unpinSession`（`lib/client.js:4345`、`:4407`）。
- **结论**：dsh-pin 的“工作区置顶”与官方“会话置顶”是两套东西；本插件不要试图复用 `pinnedSessionIds`，也不要修改会话 pin 相关 UI。

---

## 5. 内置 Sidebar 面板 API（`sidebar.panellist`）

### 5.1 `sidebar.panellist` 注册项 shape

侧边栏把该 slot 声明为 root 作用域的 **list**，并直接渲染每个注册项的图标组件（`$SRC/dsh-client-ui-sidebar/lib/client.js:749-752`；README `$SRC/dsh-client-ui-sidebar/README.zh.md:42`）：

```js
ctx.slots.inject("sidebar.panellist", () =>
  ctx.slots.register(
    {
      name: "sidebar.panellist",
      id: "sticky-notes",      // 必填：list slot 用 id 去重
      order: 20,               // 可选：升序，默认 0
      label: "便签墙",          // 字符串，或 () => string（locale-aware；resolveSlotLabel 会调用函数）
    },
    StickyNotesIcon,           // 组件，收 { size, active }
  ),
);
```

参考：`dsh-sticky-notes/lib/client.js:1755-1780`、`dsh-style-switcher/lib/client.js:690-700`。

UI 侧行为：

- 注册项元数据由 `entriesOfSlot("sidebar.panellist")` 派生：`{ id, order: options.order ?? 0, label: resolveSlotLabel(options.label) ?? id }`，按 `order` 升序（`$SRC/dsh-client-ui-sidebar/lib/client.js:688-704`）。
- `resolveSlotLabel(label)` 的语义：**是函数就调用，否则原样返回**（`$SHELL:123`）。
- list slot 要求 `options.id`；同一 id 在**相同 priority** 上重复注册会抛错（不同 priority 允许 shadow，priority 低者渲染）。`entriesOfSlot` 按 id 去重，只保留优先级胜出者（`$SHELL:123` 的 `SlotCore.register` / `entriesOfSlot`）。
- 渲染行时组件收到 `{ size: wide ? 16 : 18, active }`（`$SRC/dsh-client-ui-sidebar/lib/client.js:225-231`）。
- 同一个 id 应能寻址 root 作用域 `main` keyed slot 的组件；选择不存在的主面板会抛错并保留当前选中态（`$SRC/dsh-client-ui-sidebar/README.zh.md:42`；实现 `$SRC/dsh-client-ui-layout/lib/client.js:522-525`：`layout.selectPanel: main panel "x" is not registered`；`main` 由 ui-layout 声明为 keyed，`:705-716`）。**本插件只重排、不选择**，无需提供 `main`。

### 5.2 `sidebar.panellist.actions` 的 props 与 pin 回调

`sidebar.panellist.actions` 也是 root 作用域的 list（`$SRC/dsh-client-ui-sidebar/lib/client.js:753-756`）。当它有注册项时，导航区会显示“更多”启动器（面板行样式，`aria-haspopup="menu"`），菜单内容就是该 list 的注册项（`:239-286`、`:518-539`）。

渲染 actions 注册项时传入的 props（`:279-284`）：

```js
renderSlot("sidebar.panellist.actions", {
  entries,                     // [{ id, label, pinned, active }]，按注册顺序，已排除 "plugins"
  onOpen,                      // (id) => void：选中该面板
  onPinnedChange,              // (id, pinned) => void：修改 DSH 内存里的 unpinned 集合
  onDismiss,                   // () => void：关闭菜单
});
```

- `entries` 的形状见 `:521-526`：`{ id, label, pinned: !unpinned.includes(id), active: id === activePanelId }`；固定排除 `"plugins"`。
- props 来源分三层，别混淆（`$SRC/dsh-client-ui-renderer/lib/client.js:1117-1135`、`:773-799`）：
  - `sidebar` 注册自己的 `inject: injectProps()`（`:712-732`，含 `startSession`/`toggleSidebar`/`selectPanel`/`setPinned`/`trackEntryClick`/`hooks`）只注入给 **SidebarRoot 组件本身**，不会自动传给子 slot 注册项；
  - 子 slot 注册项拿到的公共 props 由 owner 显式传入（`renderSlot("sidebar.panellist.actions", { entries, onOpen, onPinnedChange, onDismiss })`）；
  - 注册项自己声明的 `inject` 工厂（`register({ ..., inject: () => ({...}) })`）返回的值会作为 props 注入（`cachedRootInject`，`:882-887`）；子 slot 声明里的 `inject` 是 per-slot 公共注入（示例：`$SRC/dsh-client-ui-workspace/lib/client.js:6083-6090` 的 `contextMenu.content` 子声明）。
- 官方 More 菜单组件自己使用 `trackEntryClick` 上报点击（`$SRC/dsh-client-ui-sidebar/lib/client.js:240`、`:263-267`、`:518-539`），而不是把它传给 actions 注册项。
- 官方示例（“更多”菜单）：`$SRC/dsh-client-ui-entry-customization/lib/client.js:195-201`（`id: "entry-customization"`，`inject: () => injected("sidebar")`）。

### 5.3 面板 pin 的真实语义（内存、无默认 UI、无持久化）

DSH 自带的“面板 pin”就是 `createPanelPins()`：

```js
// $SRC/dsh-client-ui-sidebar/lib/client.js:14-30
function createPanelPins() {
  const store = createSnapshotStore({ unpinned: NO_PANELS });
  return {
    unpinned: { getSnapshot: () => store.getSnapshot().unpinned, subscribe: ... },
    setPinned: (id, pinned) => {
      const current = store.getSnapshot().unpinned;
      if (id === "plugins" || pinned !== current.includes(id)) return;   // "plugins" 永远不能藏
      store.set({ unpinned: pinned ? current.filter(entry => entry !== id) : [...current, id] });
    },
  };
}
```

- 语义：`pinned: true` 表示**从面板列表移除**（进入 More 菜单），不是“排到顶部”；`unpinned` 是“被收起的 id 集合”（`:507-510` 的过滤：`id === "plugins" || !unpinned.includes(id)`）。
- 只在 SidebarRoot 的内存里（`panelPins`，`:707`）；**重载即恢复默认**；README 明确：“其他注册项仍可调用 Pin 回调，但插件重新加载时选择重置，不读取旧 localStorage 值”（`$SRC/dsh-client-ui-sidebar/README.zh.md:44`）。
- **默认 UI 没有 Pin/排序控件**：
  - sidebar README：默认更多菜单只提供插件浏览和创建，不列出面板或 Pin 控件（`$SRC/dsh-client-ui-sidebar/README.zh.md:44`）。
  - 官方“更多”菜单实现：所有菜单都不提供 Pin 或排序操作；Pin 回调不被消费；不读写 localStorage 里的旧 Pin 值（`$SRC/dsh-client-ui-entry-customization/README.zh.md:31`、`:47`、`:68-69`）。
- **结论**：dsh-pin 的“面板置顶到列表顶部”必须自己实现；不要复用 `onPinnedChange`（语义不同，而且是“隐藏/显示”），也不要写 DSH 的 localStorage（DSH 当前根本不读）。

### 5.4 面板行的 DOM 契约与“不能嵌套按钮”的约束

DOM 结构（源码 `$SRC/dsh-client-ui-sidebar/lib/client.js`）：

```jsx
// :507-509 面板列表容器
<nav className={...panelList} aria-label={t("panels.label")}>
  {/* :510-517 / :206-237 每个面板一行 */}
  <button type="button" className={clsx(...panelRow, active && ...panelActive)}
          aria-label={label} aria-current={active ? "page" : undefined}>
    <span className={...panelGlyph}>{renderSlot("sidebar.panellist", { size, active }, { only: id })}</span>
    {wide && <span className={...panelTitle}>{label}</span>}
  </button>
  {/* :518-539 More 启动器：也是一个 button.panelRow，但带 aria-haspopup="menu" */}
</nav>
```

- **没有 `data-panel-id` 之类的稳定 id 属性**；行上可用的身份只有：
  - `aria-label`（= 当前 locale 的 label，会随语言变化）；
  - 内部 glyph 里的组件（只有你自己注册的组件能被你认出来）；
  - React fiber 上的 `memoizedProps.id`（非公开契约；DOM 实验组已在 `docs/DOM-CONTRACTS.md`（dom-lab 维护）里核实，以那份记录为准）。
- 面板行本身是 `<button>`：**不要在其中再嵌套 `<button>`**（HTML 非法，且点击会被外层 onClick 抢走）。因此“每行一个 Pin 按钮”只能：
  - 作为 `panelList` 的直接子元素做绝对定位叠加（本仓库当前方案：`dsh-pin/src/client-src.js` 里 `ATTR.pin="panel"` 的按钮 append 到 list，`top` 用 `row.offsetTop` 计算）；或
  - 用行上的事件（右键 `contextmenu` / 长按）触发置顶；或
  - 在 More 菜单里放一条“置顶面板”的入口（`sidebar.panellist.actions`）。
- CSS 事实（`$SRC/dsh-client-ui-sidebar/lib/client.js:116`）：
  - `.panelList { display:flex; flex-direction:column; gap:2px; margin-bottom:8px }`；
  - `.panelRow { min-height:36px; padding:7px calc(12px - 3px); border-radius:var(--dsw-radius-md); ... }`；
  - 折叠态（非 Windows）：`.collapsed .panelRow { width:36px; height:36px }`、`.collapsed .panelList { gap:12px }`；
  - Windows 顶栏折叠：`[data-windows-titlebar] .collapsed .panelList { display:none }`（行仍在 DOM，只是不显示→你的绝对定位按钮也应隐藏）。
- 行内 `onClick` 会 `selectPanel(id)`；叠加按钮必须 `stopPropagation`（参考官方 Session 行按钮 `event.stopPropagation()`，`$SRC/dsh-client-ui-workspace/lib/client.js:2272-2279`）。
- 面板行是 sidebar 自己渲染的；重排后 React 不会“记住”你的顺序，任何一次父组件重渲染都可能把行顺序改回 `panels` 快照顺序。必须用 `MutationObserver` 兜底重放（本仓库实现已用 `MutationObserver` + debounce；见 `src/client-src.js` 的 `observer`）。

### 5.5 DOM 重排的现实约束

1. **行集合**：`panelList.querySelectorAll('button[class*="panelRow"]')` 会包含 More 启动器；用 `hasAttribute("aria-haspopup")` 排除（官方启动器在 `:256-262` 设置它）。
2. **行数变化**：别的插件可以被启用/禁用，`order` 也会变；每次同步都以 `ctx.slots.entriesOfSlot("sidebar.panellist")` 为“基础顺序”（按 `order` 排序，与 sidebar 的 `syncPanels` 一致：`$SRC/dsh-client-ui-sidebar/lib/client.js:689-704`），只把仍存在的行做重排。
3. **行与 id 的映射**：不要用 `aria-label` 做持久标识（会随语言切换）；fiber 方案见 DOM 文档；本仓库 `readPanelId()` 在 `src/client-src.js` 里按 `__reactFiber$` 向上找 `memoizedProps`（要求 `props.id`、`props.wide`、`props.selectPanel` 三个特征）。
4. **More 启动器的位置**：More 的 `button.panelRow` 可能被包在 `span.moreAnchor` 里（`:245-251`、CSS `:116` 的 `.moreAnchor{display:flex;flex-direction:column}`），所以“把行插到列表顶部”时不要假设所有直接子元素都是面板行；以“第一个面板行之前”为锚点。
5. **折叠/搜索/切面板**：侧栏折叠到 56px rail 时面板行仍在（非 Windows），但按钮应隐藏（rail 只有 36px 宽）；窗口大小变化要重新计算绝对定位的 `top`（本仓库用 `resize` 监听）。
6. **不要持久化到 DSH 的存储**：DSH 不读旧 Pin 值；用本插件自己的 key（本仓库 `dsh-pin:*`）。

---

## 6. locale

- 客户端 locale 服务：`ctx.locale`（由 `@deepseek-ai/dsh-client-locale` 通过 `ctx.provide("locale", locale)` 提供，`$SRC/dsh-client-locale/lib/client.js:1838`；`installLocale` 把同一个对象装成 slot 的 `t` 席位，`:1845`；服务实现 `LocaleRuntime` 在 `:1475`）。
- 需要 `locale` 写进导出 `inject`，否则 `ctx.locale` 属性访问抛错（第 2.2 节）。
- 注册字典（两种签名都支持，`$SRC/dsh-client-locale/lib/client.js:1675-1700`）：

```js
// 对象形式（一次注册多个 locale；同 ns+locale 重复注册会抛错，:1683）
ctx.effect(
  () => ctx.locale.register("dsh-pin", {
    zh: { pin: "置顶", unpin: "取消置顶", pinned: "已置顶" },
    en: { pin: "Pin", unpin: "Unpin", pinned: "Pinned" },
  }),
  "dsh-pin: dictionaries",
);

// 逐 locale 形式（语言包分包注册）
ctx.locale.register("dsh-pin", "zh", { pin: "置顶" });
```

- 绑定翻译函数（身份稳定，可安全 memo；`$SRC/dsh-client-locale/lib/client.js:1702-1710`；README `$SRC/dsh-client-locale/README.zh.md:96`）：

```js
const t = ctx.locale.bind("dsh-pin");
t("pin");          // 当前语言，缺键回退 ns → common → 键名
t("greet", { name: "x" }); // 支持 {name} 占位符（:1711-1716）
```

- 查找链：当前语言声明的 fallback 链 → `common` 的同一条链 → 返回 key（`:1711-1723`）；字典注册不需要重挂 UI，下次渲染自动生效（README `:40`）。
- `label` 需要随语言变化时传函数（`label: () => t("panel.label")`），sidebar 会在 `locale.subscribe` 时重新同步面板元数据（`$SRC/dsh-client-ui-sidebar/lib/client.js:706`；`resolveSlotLabel` 对函数求值，`$SHELL:123`）。
- **不需要**在 `dsh.client.inject` 里声明 `locale`（那是模块预取元数据，见 2.5）；写在导出 `inject` 里即可。
- 已知限制：在 slot 渲染路径之外、注册时捕获的文案不会随语言切换而更新（README `$SRC/dsh-client-locale/README.zh.md:139`）。本插件自己用 `t()` 在事件发生时取文案即可规避。
- 建议注册 `zh` + `en` 两个基础语言，其余可选（README `:40`）。
- 注意：package 的 `exports["./locale/*.json"]` 是**插件展示元数据**（插件管理页的本地化标题/描述/README 等，见 `$SRC/dsh-official-bundles/lib/index.js:27` 的说明），**不会**自动注册为 `ctx.locale` 字典。客户端 UI 文案必须在 `apply` 里 `ctx.locale.register(...)`（或在构建时把 JSON 内联进 bundle）。

---

## 7. 宿主半 patch 与 profile bundle

### 7.1 `cordis.patch.yml` 的 insert 格式

patch 文件是**顶层 YAML 数组**，每个元素是一条 patch（`$SRC/cordis-plugin-include/README.md:43-47`；本机文件头注释 `<DSH_HOME>/profiles/web/cordis.patch.yml:1-3` 也这么写）。

`insert` 的算法（`$SRC/cordis-plugin-include/lib/index.js:218-268`）：

```js
for (const patch of patches) {
  const { id, insert, name, ...overrides } = patch;
  if (insert) {
    const clone = structuredClone(insert);
    if (id) {                       // 有 id：目标必须是 group，追加进它的 config 数组
      const target = entryMap.get(id);
      if (!target) { warn("patch insert: entry %C not found"); continue; }
      if (!target.group) { warn("patch insert: entry %C is not a group"); continue; }
      target.config.push(...clone);
    } else data.push(...clone);    // 无 id：追加到根 entry 列表
    continue;
  }
  // 非 insert：按 id 覆盖字段；name 用于断言同名
}
```

- 插入项必须有**稳定 id**：运行时变更按 id 路由到插入的 entry；不写 id 会被随机生成、文件重读后重新生成，实例状态会重启（`:210-213`、README `:53`）。
- 插入项的可用字段：`id`、`name`（模块 specifier）、`config`、`disabled`、`group` 等 Loader entry 选项；entry 也可以声明 `inject`（`$SRC/cordis-plugin-loader/lib/index.js:768` 解析 entry.options.inject）。
- 本插件当前的 patch（`dsh-pin/cordis.patch.yml:1-5`）：

```yaml
- insert:
    - id: dsh-pin
      name: dsh-pin
```

与 `dsh-style-switcher/cordis.patch.yml:1-5`、`dsh-sticky-notes/cordis.patch.yml:1-6` 完全同构，正确。

### 7.2 profile 的 `dsh.profile.bundles` 如何生效

profile 目录 = `<DSH_HOME>/profiles/<name>/`：`package.json`（依赖 + `dsh.profile.bundles` 有序列表）+ `cordis.patch.yml`（用户 patch 层）。参考 `<DSH_HOME>/profiles/pin-lab/`。

配置层顺序（`$SRC/dsh/README.zh.md:37-46`）：

1. `dsh.profile.bundles` 中每个组合包的 patch（按列表顺序）；
2. profile 自己的 `cordis.patch.yml`；
3. `$DSH_HOME/cordis.patch.yml`（home 层）；
4. `--patch` 覆盖层。

bundle 解析与失败模式（`$SRC/dsh-app-boot/lib/index.js:1795-1822`）：

```js
for (const packageName of bundles) try {
  const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);
  const bundleManifest = readProfileManifest(binName, packageDir);
  const bundle = bundleManifest.dsh?.bundle;
  if (bundle === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
  assertBundlePlatform(bundle.platforms, process.platform);
  // ...读取 dsh.bundle.patch 指向的文件并解析...
} catch (error) {
  skippedBundles.push({ packageName, reason: String(error) });
}
```

- **含义 1**：包被列进 `dsh.profile.bundles` ⇒ 它**必须**有 `dsh.bundle`（通常是 `dsh.bundle.patch`）。没有的话这一层被跳过，`insert` 不生效，插件根本不会加载（不会崩整机，但会“静默不工作”）。
- **含义 2**：如果不想给插件加 `cordis.patch.yml`，也可以只把包装进 profile 依赖，然后在 profile 的 `cordis.patch.yml` 里直接 `- insert: [{ id, name }]`（本机 web profile 就是这样挂 `deepseek-price-period` 的：`<DSH_HOME>/profiles/web/cordis.patch.yml:26-28`，其 package.json 不在 bundles 里）。
- **含义 3**：pin-lab 当前把 `dsh-pin` 放进了 bundles（`<DSH_HOME>/profiles/pin-lab/package.json:9-13`，依赖是 `link:` `:4-6`），所以 dsh-pin 的 `cordis.patch.yml` 与 package.json 的 `dsh.bundle.patch` 是**加载前提**，不能省。
- 版本兼容：`engines.dsh` 会被检查（`$SRC/dsh/README.zh.md:39`；`$SRC/dsh-app-boot/lib/index.js:1806` 的 `evaluatePluginCompatibility`）。本包 `engines.node >=20` 没问题；不声明 `engines.dsh` 则按 DSH peer 范围检查。
- HMR：`dsh-hmr` 监视 profile manifest 与 patch 文件；没有 HMR 时改动需重启（`$SRC/dsh/README.zh.md:37`）。

---

## 8. 设计 token 与 20px 图标按钮样式

### 8.1 token 来源

- 基础 token（字体、圆角、ease、过渡时长）：`$SRC/dsh-client-ui-theme/lib/client.js:1464`

```css
:root{
  --dsw-font-family: ...;
  --ds-font-family-code: ...;
  --ds-ease-in-out: cubic-bezier(.4, 0, .2, 1);
  --ds-transition-duration: .2s;
  --dsw-radius-xs: 4px; --dsw-radius-sm: 8px; --dsw-radius-md: 12px;
  --dsw-radius-lg: 16px; --dsw-radius-xl: 20px; --dsw-radius-panel: 28px;
}
```

- 语义别名（light/dark 各一套，挂在 `body` / `body[data-ds-dark-theme]`）：`$SRC/dsh-client-ui-theme/lib/client.js:1470`。常用：

| token | 用途 | light 值（dark 见同文件） |
| --- | --- | --- |
| `--dsw-alias-label-primary` | 主文字 | `neutral-bluish-1000` |
| `--dsw-alias-label-secondary` | 次级文字/图标 | `neutral-bluish-700` |
| `--dsw-alias-label-tertiary` | 弱化图标（行内按钮默认色） | `neutral-bluish-600` |
| `--dsw-alias-label-caption` | 最弱文字/置顶标记 | `neutral-bluish-400` |
| `--dsw-alias-interactive-bg-hover` | hover 底色 | `#2631480f` |
| `--dsw-alias-interactive-bg-active` | active 底色 | `#2631481a` |
| `--dsw-alias-border-l2/l3/l4` | 边框 | 黑/白透明度 |
| `--dsw-alias-state-business-primary` | 品牌主色（选中/置顶高亮） | `deepseek-500` |
| `--dsw-alias-bg-layer-1` | 卡片/浮层底 | 白 / 深灰 |
| `--dsw-alias-button-elevated-fill` | 抬升按钮底 | 白 / bluish-750 |
| `--dsw-specific-sidebar-fill` | 侧栏底色 | bluish-50 / bluish-900 |

- 阴影：`--dsw-shadow-lv1/lv2/lv3`（`$SRC/dsh-client-ui-theme/lib/client.js:1482`）；focus ring：`--dsw-focus-ring-color`（fallback `--dsw-alias-state-business-primary`）与 `--dsw-focus-ring-width: 2px`（`:1473`）。
- **只读 token**：不要写死颜色；主题（包括 dsh-style-switcher 的第三方主题）通过覆盖这些变量工作。dsh-style-switcher 面板就是“颜色只读 `--dsw-*` token”的范例（其 panel.css 注释）。

### 8.2 官方行内按钮的真实尺寸

- 侧边栏顶部图标按钮（header controls）：28×28、`border-radius: var(--dsw-radius-sm)`、`color: var(--dsw-alias-label-secondary)`、hover `background: var(--dsw-alias-interactive-bg-hover)`（`$SRC/dsh-client-ui-sidebar/lib/client.js:33`）。
- 工作区/Session 行内按钮：24×24、`border-radius: var(--dsw-radius-xs)`、`color: var(--dsw-alias-label-tertiary)`、`margin:-4px`、hover `color: var(--dsw-alias-label-primary)`、`focus-visible { outline-offset: -2px }`（`$SRC/dsh-client-ui-workspace/lib/client.js:1955` 的 `.iconButton`；README 说明“24px 点击热区，通过补偿外边距保留紧凑布局”：`$SRC/dsh-client-ui-workspace/README.zh.md:112`）。
- 工作区行的操作区容器：`.projectRow .rowActions { height: 20px }`；`.rowActions { display:none }`，仅在 `:hover` / `menuOpen` 时 `display:inline-flex`；`gap:13px`；不支持 hover 的设备（`@media (hover:none)`）里常显，但折叠的 workspace 行 `[aria-expanded=false] .rowActions` 隐藏（`$SRC/dsh-client-ui-workspace/lib/client.js:1955`）。
- 面板行：`min-height:36px`（展开）/ 36×36（rail 折叠）（`$SRC/dsh-client-ui-sidebar/lib/client.js:116`）。

### 8.3 建议的 20px 图标按钮

要求：放进 20px 高的 `rowActions` 不撑高行、hover 才出现、颜色跟主题、focus 可见。

```css
/* 视觉 20px，热区用 ::before 扩到 24px（官方 24px 热区的等价做法） */
.dsh-pin-button {
  position: relative;
  width: 20px;
  height: 20px;
  box-sizing: border-box;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c);
  cursor: pointer;
  transition: color 140ms var(--ds-ease-in-out, ease),
              background-color 140ms var(--ds-ease-in-out, ease);
}
.dsh-pin-button::before {
  content: "";
  position: absolute;
  inset: -2px;            /* 20 + 4 = 24px 热区 */
  border-radius: inherit;
}
@media (hover: hover) {
  .dsh-pin-button:hover {
    color: var(--dsw-alias-label-primary, #0f1115);
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.dsh-pin-button:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;   /* 与官方行内按钮一致 */
}
.dsh-pin-button[aria-pressed="true"] {   /* 已置顶 */
  color: var(--dsw-alias-state-business-primary);
}
.dsh-pin-button:disabled { opacity: .5; cursor: default; }
.dsh-pin-button svg { width: 14px; height: 14px; display: block; }  /* 官方行内图标 14px；顶部控件 16px */
```

说明：

- 20px 正好等于 `rowActions` 高度，不会把 34px 的工作区行撑高；热区用 `::before` 补到 24px（官方行内按钮 24px 热区，`$SRC/dsh-client-ui-workspace/README.zh.md:112`）。
- 颜色用 `--dsw-alias-label-tertiary`，hover 升到 `--dsw-alias-label-primary`（与官方 `.iconButton` 完全一致）。
- 已置顶用 `--dsw-alias-state-business-primary` 或纯字符 📌；**不要**用写死的红/蓝。
- 面板行叠加按钮（36px 行高、绝对定位）建议用同样 20px 视觉 + `top: row.offsetTop + (row.offsetHeight - 20)/2`，并隐藏于 `list.clientWidth <= 60`（rail 折叠）。
- 尊重 `prefers-reduced-motion`：动画包在 `@media (prefers-reduced-motion: reduce) { ... { transition: none } }`。

---

## 9. 已验证的边界 / 坑位清单

1. **重复注册**：`__ModuleLoader__.load` 的 id 重复会抛 `duplicate factory registration`（`$SRC/dsh-client-modules/lib/client.js:704-716`）。构建产物只能有一份注册。
2. **bundle 顶层副作用**：factory 惰性执行；样式要在 factory 内注入（`$SRC/dsh-client-modules/README.zh.md:78`）。`window.__ModuleLoader__.load` 本身是唯一允许的顶层语句。
3. **`id` ≠ 包名** ⇒ `loaded without registering`（`client.js:760`）。包名 `dsh-pin`，bundle 里也必须是 `dsh-pin`。
4. **`dsh.bundle` 缺失** ⇒ profile bundle 静默跳过（`$SRC/dsh-app-boot/lib/index.js:1804`、`:1811-1821`）。
5. **服务未 inject** ⇒ `cannot get property ... without inject`（`$SRC/cordis/src/reflect.ts:152`）。`ctx.get()` 不要求 inject，但不等待。
6. **inject 了不存在的服务** ⇒ 插件永久 PENDING，启动审计会列出来（`$SHELL:194`），页面功能缺失。
7. **`ctx.effect` 清理是自己负责**：DOM、listener、observer、timer 不清理会泄漏到插件重载之后（`fiber.ts:408-423` 只保证执行你返回的 disposer）。
8. **`insertBefore` 失败只给普通 Error**（3.4），不要 catch 后当成功。
9. **工作区没有宿主 pin 集合**（3.6）：跨浏览器的“是否置顶”没有共享状态；顺序则是全局持久的。
10. **`insertBefore` 的 `beforeWorkspaceId` 省略 = 追加到末尾**，不是“移到最前”。
11. **会话 pin ≠ 工作区 pin**：`pinnedSessionIds` 只描述会话（4 节）。
12. **面板 pin 语义是“隐藏进 More”**（5.3），不是排到顶部；且只在内存里。
13. **面板行是 `<button>`**：不要嵌套按钮；叠加按钮需要 `stopPropagation`（5.4）。
14. **面板行没有稳定 data 属性**：id 映射只能靠 fiber/`aria-label`（5.4）。
15. **React 拥有行顺序**：DOM 重排必须 `MutationObserver` 重放（5.4/5.5）。
16. **Windows 折叠态面板列表 `display:none`**（`$SRC/dsh-client-ui-sidebar/lib/client.js:116` 的 `[data-windows-titlebar] ... .panelList{display:none}`），叠加按钮要跟着隐藏。
17. **Ungrouped 工作区的 `data-row-key` 是 `workspace:`（空 id）**（`$SRC/dsh-client-ui-workspace/lib/client.js:1044`），不能当成真实 workspace 置顶。
18. **工作区行只在 hover/展开时显示 rowActions**（CSS `:1955`；`@media hover:none` 下折叠行隐藏），注入到 rowActions 的按钮自动继承该可见性；放到行外则要自己处理。
19. **不要改 DSH 的 `unpinned`/localStorage**（5.3）；本插件用自己的 key。
20. **`main` keyed slot**：如果未来要加“打开面板”，先确认 `main` 有对应 key，否则 `ctx.layout.selectPanel` 会抛错（`$SRC/dsh-client-ui-layout/lib/client.js:522-525`）。

---

## 10. 给实现者的结论摘要

**宿主半（`lib/index.js` + `cordis.patch.yml` + package.json）**

- 当前形态正确：no-op `apply`、`cordis.patch.yml` 单行 insert（`id: dsh-pin` / `name: dsh-pin`）、`dsh.bundle.patch` 指向该文件。
- 前提：pin-lab 把 `dsh-pin` 列进 `dsh.profile.bundles`，所以这三样缺一不可，否则 bundle 被静默跳过。
- 不需要任何 host 服务；也不需要 `dsh.client.inject`/`external`。

**客户端半（`lib/client.js`）**

- 头部契约照抄 `dsh-style-switcher/lib/client.js:1-7`，`id: "dsh-pin"`，`return { apply, inject }`。
- `inject` 必须包含实际用的服务：本实现是 `["locale", "slots", "workspaces"]`：
  - `ctx.workspaces` → 注入 `workspaces`；
  - `ctx.slots.entriesOfSlot("sidebar.panellist")` → 注入 `slots`；
  - `ctx.locale` → 注入 `locale`（可选：也可以全部改成 `ctx.get(...)` 并判空，但会失去“等服务就绪再 apply”的确定性）。
- 所有副作用（样式、事件监听、MutationObserver、定时器、注入的按钮）都放进 `ctx.effect` 的 disposer 里，确保插件卸载/热重载干净。
- **工作区置顶**：
  - 顺序真值来自 `ctx.workspaces.list.getSnapshot().items.map(i => i.workspaceId)`，并 `list.subscribe()` 跟随 Host/其它客户端的变更；
  - 置顶 = `await ctx.workspaces.insertBefore(id, firstId)`；取消 = 用自己记录的 `restoreBeforeId` 调 `insertBefore(id, restoreBeforeId)`，锚点不存在则 `insertBefore(id)`（追加）；
  - 失败（普通 Error，常见 `workspace/not-found`）= toast + 回滚本地记录；
  - 权限：owner 页面恒允许；非 owner 建议用 `ctx.uiWorkspace.whenAccess(id, "workspace/insertBefore", …)` 控制按钮存在性（也可先直接调用，失败降级）。
- **面板置顶**：
  - 不要复用 DSH 的 `onPinnedChange`（它是“隐藏进 More”且不持久化）；用本插件 localStorage 记录 `string[]`（最近置顶在前）；
  - DOM 重排的基础顺序应与 sidebar 一致：`entriesOfSlot("sidebar.panellist")` 按 `order` 升序、只保留 DOM 中仍存在的行；More 启动器（`aria-haspopup`）排除；
  - 行→id 映射用 React fiber（见 dom-lab 的 `docs/DOM-CONTRACTS.md`），不要用 `aria-label`；
  - 面板行是 `<button>`：叠加按钮放 `panelList` 直接子级并绝对定位，点击 `stopPropagation`；rail 折叠（≤60px）与 Windows 折叠态隐藏；
  - MutationObserver 兜底重放顺序，注意不要被自己的移动触发死循环（同序早退）。
- **视觉**：只读 `--dsw-alias-*` / `--dsw-radius-*` / `--ds-font-family-code`；20px 视觉 + 24px 热区，hover 色 `--dsw-alias-label-primary`，选中/置顶色 `--dsw-alias-state-business-primary`；尊重 `prefers-reduced-motion`。

---

## 附录 A：核心证据索引

| 主题 | 文件:行 |
| --- | --- |
| 注册门面 / 启动图 / 平台 seed | `$SRC/dsh-client-modules/lib/index.js:518-546`、`:783-801`；`$SHELL:194`、`:196` |
| 浏览器模块系统 / 条目创建 | `$SRC/dsh-client-modules/lib/client.js:383-400`、`:483-487`、`:694-716`、`:745-796` |
| `dsh.client` 字段校验 | `$SRC/dsh-client-modules/lib/index.js:86-98`、`:460-467`、`:480-499` |
| Cordis plugin 安装 / inject | `$SRC/cordis/lib/index.js:1691-1707`；`$SRC/cordis/src/registry.ts:65-90` |
| `ctx.get` / 属性访问报错 | `$SRC/cordis/src/reflect.ts:140-184`、`:239-257` |
| `ctx.effect` 契约 | `$SRC/cordis/src/fiber.ts:68-93`、`:362-405`、`:408-423` |
| Loader 宿主半 import/plugin | `$SRC/cordis-plugin-loader/lib/index.js:583-591`、`:812-816` |
| WorkspaceController / model | `$SRC/dsh-api-workspace-controller/lib/client.js:15-45`、`:96-107`、`:161-178`、`:181-229`、`:245-286`、`:381-445` |
| Workspace remote schema | `$SRC/dsh-api-workspace-controller/lib/typert.remote-client.js:47-54`、`:129-136`、`:155-161` |
| Host 顺序 / 会话 pin 持久化 | `$SRC/dsh-workspace/lib/index.js:231-246`、`:334-343`、`:473-499`、`:538`、`:568-604`；`$SRC/dsh-workspace/README.zh.md:118` |
| 排序权限 | `$SRC/dsh-client-ui-workspace/lib/client.js:2201-2210`、`:5781-5784`、`:1577-1582`；`$SRC/dsh-api-remote-access/lib/client.js:711-730`；`$SRC/dsh-api-remote-access/README.zh.md:62-68` |
| 会话 pin UI / 动作名 | `$SRC/dsh-client-ui-workspace/lib/client.js:4345`、`:4407`、`:6099-6114`；`$SRC/dsh-client-ui-workspace/README.zh.md:38-40` |
| Sidebar 面板列表 | `$SRC/dsh-client-ui-sidebar/lib/client.js:14-30`、`:116`、`:206-237`、`:239-286`、`:507-540`、`:662-732`、`:733-777`；`$SRC/dsh-client-ui-sidebar/README.zh.md:42-44` |
| 默认无 pin/无持久化 | `$SRC/dsh-client-ui-sidebar/README.zh.md:44`；`$SRC/dsh-client-ui-entry-customization/README.zh.md:31`、`:68-69`；`$SRC/dsh-client-ui-entry-customization/lib/client.js:195-201` |
| slots 服务 | `$SRC/dsh-client-ui-renderer/lib/client.js:1305-1352`、`:1368-1427`、`:1450-1457`、`:1554-1556`、`:1591-1593`、`:1602-1623`；`$SHELL:123` |
| 工作区行 DOM / CSS | `$SRC/dsh-client-ui-workspace/lib/client.js:1041`、`:1044`、`:2224-2302`、`:1955` |
| `main` keyed slot / selectPanel | `$SRC/dsh-client-ui-layout/lib/client.js:522-525`、`:705-716` |
| locale | `$SRC/dsh-client-locale/lib/client.js:1475`、`:1675-1723`、`:1779-1783`、`:1838-1845`；`$SRC/dsh-client-locale/README.zh.md:40`、`:48-68`、`:96` |
| patch insert | `$SRC/cordis-plugin-include/lib/index.js:210-268`；README.md:43-53 |
| profile bundles / patch 层 | `$SRC/dsh-app-boot/lib/index.js:1347`、`:1795-1822`；`$SRC/dsh/README.zh.md:37-46`；`$SRC/dsh-package-manifest/README.zh.md:33`、`:46`、`:55` |
| 本机 profile 实例 | `<DSH_HOME>/profiles/pin-lab/package.json:4-15`、`cordis.yml:1-4`；`<DSH_HOME>/profiles/web/cordis.patch.yml:26-28` |
| 设计 token | `$SRC/dsh-client-ui-theme/lib/client.js:1464`、`:1470`、`:1473`、`:1482` |
| 本机参考插件 | `dsh-style-switcher/lib/client.js:1-7,637-717`、`lib/index.js:9-16`；`dsh-sticky-notes/lib/client.js:1755-1788`；`dsh-sticky-notes/cordis.patch.yml:1-6`；`deepseek-price-period/lib/client.js:1-58` |

## 附录 B：可复跑的自检命令

```bash
SRC=/tmp/dsh-src/node_modules/@deepseek-ai

# 1) 本插件 inject 是否覆盖所有 ctx.<svc> 访问
grep -n "ctx\.[a-zA-Z]" <repo-root>/lib/client.js \
  | grep -v "ctx.effect\|ctx.get\|ctx.fiber"

# 2) bundle id 是否等于包名
grep -n 'id: "' <repo-root>/lib/client.js | head -1
grep -n '"name"' <repo-root>/package.json | head -1

# 3) dsh.bundle.patch / dsh.client.platform / exports["./client"] 是否齐全
node -e 'const p=require("<repo-root>/package.json");console.log(p.exports["./client"],p.dsh?.bundle?.patch,p.dsh?.client?.platform)'

# 4) 构建产物与源码同步（仓库自带）
cd <repo-root> && node scripts/build-client.mjs --check

# 5) 源码证据抽查
grep -n "super(ctx, \"workspaces\")" $SRC/dsh-api-workspace-controller/lib/client.js
grep -n "async insertBefore(workspaceId, beforeWorkspaceId)" $SRC/dsh-api-workspace-controller/lib/client.js
grep -n "createPanelPins" $SRC/dsh-client-ui-sidebar/lib/client.js
grep -n "declares no dsh.bundle" $SRC/dsh-app-boot/lib/index.js
```
