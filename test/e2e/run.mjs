#!/usr/bin/env node
/**
 * test/e2e/run.mjs — dsh-pin 的浏览器 E2E 断言脚本。
 *
 * 依赖：test/e2e/cdp.mjs（零 npm 依赖）+ 已运行的 scratch DSH 实例与无头 Chrome。
 *   DSH_PIN_LAB_URL  默认 http://127.0.0.1:3091/?token=...
 *   DSH_PIN_CDP      默认 http://127.0.0.1:9222
 *
 * 运行：node test/e2e/run.mjs
 * 退出码：0 = 全部通过（允许 SKIP），1 = 有 FAIL。
 *
 * 覆盖：
 *   1) 侧栏选择器表 / 行 key 格式 / DOM 结构
 *   2) workspace 行结构与 hover 行为
 *   3) panel 行 React fiber props.id 读取（PanelRow）
 *   4) panelList 几何 + 绝对定位可行性
 *   5) rail（56px 折叠）时 panel 行保留、workspace 行卸载
 *   6) dsh-pin 注入契约（data-dsh-pin / data-pin-* / 行状态属性 / window.__dshPin）
 *   7) DOM 重排稳定性（React 不还原手动顺序；插件 debounce 后自行还原）
 */

import { CDP, DEFAULTS } from './cdp.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true, detail });
  console.log(`SKIP  ${name}${detail ? `  — ${detail}` : ''}`);
}

const pageExpr = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`;

/* ------------------- page-side helpers (序列化进页面) ------------------- */

function pageGetFiberProps() {
  const root = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    return key ? el[key] : null;
  };
  const name = (t) => (typeof t === 'string' ? t : (t && (t.displayName || t.name)) || String(t && t.$$typeof) || '');
  const getFiberProps = (el, predicate, maxDepth = 12) => {
    let f = root(el);
    for (let d = 0; f && d < maxDepth; d++, f = f.return) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && predicate(p, f, d)) {
        return { depth: d, type: name(f.type), key: f.key, props: p };
      }
    }
    return null;
  };
  return { getFiberProps, fiberRootKey: Object.keys(document.querySelector('button[class*="panelRow"]')).find((k) => k.startsWith('__reactFiber$')) || null };
}

/* --------------------------------- main --------------------------------- */

const cdp = await CDP.connect();
await cdp.enable();
await cdp.bringToFront();

const READY = `document.querySelectorAll('[data-row-key^="workspace:"]').length > 5 && !!document.querySelector('nav[class*="panelList"]')`;

try {
  await cdp.navigate(DEFAULTS.url, { settleMs: DEFAULTS.settleMs });
  await cdp.setViewport(1600, 1000);
  await cdp.waitFor(READY, { timeoutMs: 25000 });
  await cdp.wait(800);

  /* ---------- 1. 选择器与 key 格式 ---------- */
  const basic = await cdp.evaluate(pageExpr(() => {
    const nav = document.querySelector('nav[class*="panelList"]');
    const panelRows = [...document.querySelectorAll('button[class*="panelRow"]')];
    const nativePanelRows = panelRows.filter((b) => !b.hasAttribute('aria-haspopup'));
    const more = panelRows.find((b) => b.hasAttribute('aria-haspopup') === true || b.getAttribute('aria-haspopup') === 'menu');
    const wsRows = [...document.querySelectorAll('[data-row-key^="workspace:"]')];
    const sessionRows = [...document.querySelectorAll('[data-row-key^="session:"]')];
    const ungrouped = document.querySelector('[data-row-key="workspace:"]');
    return {
      rootCount: document.querySelectorAll('[class*="kB3qhq_root"]').length,
      navCount: document.querySelectorAll('nav[class*="panelList"]').length,
      navAria: nav?.getAttribute('aria-label') ?? null,
      nativePanelRows: nativePanelRows.length,
      nativePanelRowsDirectChildren: nativePanelRows.filter((b) => b.parentElement === nav).length,
      moreAria: more?.getAttribute('aria-label') ?? null,
      moreWrapped: more ? more.parentElement !== nav : null,
      wsRows: wsRows.length,
      realWsRows: wsRows.filter((r) => r.getAttribute('data-row-key') !== 'workspace:').length,
      wsKeyBad: wsRows.map((r) => r.getAttribute('data-row-key')).filter((k) => !/^workspace:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(k)),
      sessionRows: sessionRows.length,
      sessionKeyBad: sessionRows.map((r) => r.getAttribute('data-row-key')).filter((k) => !/^session:session-[0-9a-f-]{36}$/.test(k)),
      ungrouped: ungrouped ? { key: ungrouped.getAttribute('data-row-key'), draggable: ungrouped.getAttribute('draggable'), tabindex: ungrouped.getAttribute('tabindex'), text: ungrouped.innerText } : null,
      rowKeyPrefixes: [...new Set([...document.querySelectorAll('[data-row-key]')].map((e) => (e.getAttribute('data-row-key') || '').split(':')[0]))],
      allRowKeysAreKnown: [...document.querySelectorAll('[data-row-key]')].every((e) => /^(workspace|session|overflow):/.test(e.getAttribute('data-row-key')) || ['empty'].includes(e.getAttribute('data-row-key'))),
      platform: document.documentElement.dataset.platform ?? null,
      hoverMedia: matchMedia('(hover: hover)').matches,
      supportsHas: CSS.supports('selector(:has(*))'),
    };
  }));
  check('侧栏根 [class*="kB3qhq_root"] 唯一', basic.rootCount === 1, `count=${basic.rootCount}`);
  check('面板列表 nav[class*="panelList"] 唯一', basic.navCount === 1, `aria-label=${basic.navAria}`);
  check('面板行 button[class*="panelRow"] 存在且是 nav 直接子元素', basic.nativePanelRows >= 1 && basic.nativePanelRowsDirectChildren === basic.nativePanelRows, `native=${basic.nativePanelRows} direct=${basic.nativePanelRowsDirectChildren}`);
  check('More 行可区分（aria-haspopup=menu，且被 span 包裹）', basic.moreAria === 'More' && basic.moreWrapped === true);
  check('workspace 行 key 全为 workspace:<uuid> 或 workspace:（Ungrouped）', basic.wsKeyBad.length === 0, `bad=${JSON.stringify(basic.wsKeyBad)}`);
  check('session 行 key 形如 session:session-<uuid>', basic.sessionKeyBad.length === 0, `count=${basic.sessionRows} bad=${JSON.stringify(basic.sessionKeyBad)}`);
  check('Ungrouped 行 = workspace: 且不可拖拽/无 tabindex', basic.ungrouped?.key === 'workspace:' && basic.ungrouped?.draggable === 'false' && basic.ungrouped?.tabindex === null);
  check(':has() 选择器可用', basic.supportsHas === true);

  /* ---------- 2. workspace 行结构 + hover ---------- */
  const ws = await cdp.evaluate(pageExpr(() => {
    const row = document.querySelector('[data-row-key^="workspace:"]');
    const actions = row.querySelector('[class*="rowActions"]');
    const r = row.getBoundingClientRect();
    const isInjected = (el) => el.matches('[data-dsh-pin], .dsh-pin-button, .dsh-pin-marker');
    return {
      height: getComputedStyle(row).height,
      role: row.getAttribute('role'),
      tabindex: row.getAttribute('tabindex'),
      children: [...row.children].map((c) => c.className).filter((c) => !/dsh-pin/.test(c)),
      hasProjectText: !!row.querySelector('[class*="projectText"]'),
      hasTitle: !!row.querySelector('[class*="title"]'),
      hasFolderSlot: !!row.querySelector('[class*="slot"][class*="folder"]'),
      hasChevronSlot: !!row.querySelector('[class*="slot"][class*="chevron"]'),
      nativeActionButtons: [...actions.children].filter((c) => !isInjected(c)).map((b) => ({ cls: b.className, aria: b.getAttribute('aria-label') })),
      actionsDisplayBefore: getComputedStyle(actions).display,
      actionsGap: getComputedStyle(actions).gap,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  }));
  check('workspace 行高 34px / role=treeitem / tabindex=0', ws.height === '34px' && ws.role === 'treeitem' && ws.tabindex === '0', `h=${ws.height}`);
  check('workspace 行结构：folder slot → chevron slot → projectText(.title) → rowActions', ws.hasFolderSlot && ws.hasChevronSlot && ws.hasProjectText && ws.hasTitle && ws.children.length === 4);
  check('workspace rowActions 原生按钮 = 2 个 iconButton（菜单/新会话）', ws.nativeActionButtons.length === 2 && ws.nativeActionButtons.every((b) => /iconButton/.test(b.cls)), JSON.stringify(ws.nativeActionButtons.map((b) => b.aria)));
  check('未 hover 时 rowActions display=none', ws.actionsDisplayBefore === 'none');
  // 真实鼠标 hover
  await cdp.hoverAt(ws.rect.x + ws.rect.w * 0.6, ws.rect.y + ws.rect.h / 2);
  await cdp.wait(300);
  const wsHover = await cdp.evaluate(pageExpr(() => {
    const row = document.querySelector('[data-row-key^="workspace:"]');
    const actions = row.querySelector('[class*="rowActions"]');
    const rect = actions.getBoundingClientRect();
    return { display: getComputedStyle(actions).display, width: rect.width, gap: getComputedStyle(actions).gap };
  }));
  check('hover 时 rowActions display=flex 且可见（宽 > 0）', wsHover.display === 'flex' && wsHover.width > 0, `display=${wsHover.display} w=${wsHover.width.toFixed(1)} gap=${wsHover.gap}`);
  await cdp.clearHover();
  await cdp.wait(200);

  /* ---------- 3. panel 行 fiber props.id ---------- */
  const fiber = await cdp.evaluate(`(() => {
    const { getFiberProps, fiberRootKey } = ${pageExpr(pageGetFiberProps)};
    const rows = [...document.querySelectorAll('nav[class*="panelList"] > button[class*="panelRow"]')].filter((b) => !b.hasAttribute('aria-haspopup'));
    const pick = (el) => getFiberProps(el, (p) => typeof p.id === 'string' && typeof p.label === 'string' && typeof p.selectPanel === 'function');
    const ids = rows.map((b) => { const f = pick(b); return f ? { aria: b.getAttribute('aria-label'), id: f.props.id, depth: f.depth, type: f.type, key: f.key } : { aria: b.getAttribute('aria-label'), id: null }; });
    const more = [...document.querySelectorAll('button[class*="panelRow"]')].find((b) => b.getAttribute('aria-haspopup') === 'menu');
    return {
      fiberRootKey,
      ids,
      unique: new Set(ids.map((e) => e.id)).size === ids.length,
      allResolved: ids.every((e) => typeof e.id === 'string' && e.id.length > 0),
      moreResolvedAsPanelRow: more ? !!pick(more) : 'no-more',
    };
  })()`);
  check('React fiber key 前缀 __reactFiber$ 存在', typeof fiber.fiberRootKey === 'string' && fiber.fiberRootKey.startsWith('__reactFiber$'), fiber.fiberRootKey?.slice(0, 20));
  check('每个面板行都能从 fiber 取到 PanelRow props.id', fiber.allResolved === true, JSON.stringify(fiber.ids));
  check('面板 id 互不相同', fiber.unique === true);
  check('More 行不是 PanelRow（不能按 id 处理）', fiber.moreResolvedAsPanelRow === false);

  /* ---------- 4. panelList 几何 ---------- */
  const geom = await cdp.evaluate(pageExpr(() => {
    const nav = document.querySelector('nav[class*="panelList"]');
    const rows = [...nav.querySelectorAll(':scope > button[class*="panelRow"]')].filter((b) => !b.hasAttribute('aria-haspopup'));
    return {
      position: getComputedStyle(nav).position,
      gap: getComputedStyle(nav).gap,
      flexDirection: getComputedStyle(nav).flexDirection,
      rows: rows.map((r) => ({ aria: r.getAttribute('aria-label'), offsetTop: r.offsetTop, offsetHeight: r.offsetHeight, offsetParentIsNav: r.offsetParent === nav })),
      navRect: (() => { const r = nav.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })(),
    };
  }));
  check('panelList 为纵向 flex，行高 36、gap 2', geom.flexDirection === 'column' && geom.gap === '2px' && geom.rows.every((r) => r.offsetHeight === 36), `h=${geom.navRect.h}`);
  check('panel 行 offsetParent 是 panelList（可作绝对定位坐标系）', geom.rows.every((r) => r.offsetParentIsNav), `position=${geom.position}`);

  /* ---------- 5. rail 折叠 ---------- */
  const panelSig = await cdp.evaluate(`(() => {
    const nav = document.querySelector('nav[class*="panelList"]');
    nav.__e2eNav = 'nav';
    [...nav.querySelectorAll(':scope > button[class*="panelRow"]')].forEach((b, i) => { b.__e2eRow = 'row-' + i; });
    return { navExists: !!nav, rows: document.querySelectorAll('button[class*="panelRow"]').length };
  })()`);
  const toggle = await cdp.evaluate(`(() => { const b=document.querySelector('button[class*="toggle"]'); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,label:b.getAttribute('aria-label')}; })()`);
  check('侧栏折叠按钮存在（aria-label=Collapse sidebar）', toggle.label === 'Collapse sidebar', toggle.label);
  await cdp.clickAt(toggle.x, toggle.y);
  await cdp.wait(1800);
  const rail = await cdp.evaluate(pageExpr(() => {
    const root = document.querySelector('[class*="kB3qhq_root"]');
    const nav = document.querySelector('nav[class*="panelList"]');
    const rows = [...document.querySelectorAll('button[class*="panelRow"]')];
    return {
      collapsed: root.classList.contains('kB3qhq_collapsed'),
      rootWidth: +root.getBoundingClientRect().width.toFixed(1),
      navExists: !!nav,
      navSameNode: nav?.__e2eNav === 'nav',
      wsRows: document.querySelectorAll('[data-row-key^="workspace:"]').length,
      panelRows: rows.length,
      rowSizes: rows.map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
      titleSpans: document.querySelectorAll('[class*="panelTitle"]').length,
      pluginPanelButtons: [...document.querySelectorAll('[data-dsh-pin="panel"]')].map((b) => b.style.display),
    };
  }));
  check('折叠后侧栏进入 rail（root 有 kB3qhq_collapsed）', rail.collapsed === true, `rootW=${rail.rootWidth}`);
  check('rail：panel 行保留挂载（nav 同一节点）', rail.navExists && rail.navSameNode === true && rail.panelRows === panelSig.rows, `rows=${rail.panelRows}/${panelSig.rows}`);
  check('rail：panel 行 36x36、标题 span 不渲染', rail.rowSizes.every(([w, h]) => w === 36 && h === 36) && rail.titleSpans === 0, `sizes=${JSON.stringify(rail.rowSizes)}`);
  check('rail：workspace 行全部卸载（需重新注入）', rail.wsRows === 0, `wsRows=${rail.wsRows}`);
  // 插件存在时，面板置顶按钮应在 rail 中隐藏
  if (rail.pluginPanelButtons.length > 0) {
    check('rail：dsh-pin 面板按钮自动隐藏（inline display=none）', rail.pluginPanelButtons.every((d) => d === 'none'), JSON.stringify(rail.pluginPanelButtons));
  }
  // 展开
  const toggle2 = await cdp.evaluate(`(() => { const b=document.querySelector('button[class*="toggle"]'); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await cdp.clickAt(toggle2.x, toggle2.y);
  await cdp.wait(2000);
  await cdp.waitFor(READY, { timeoutMs: 15000 });
  const expanded = await cdp.evaluate(pageExpr(() => {
    const root = document.querySelector('[class*="kB3qhq_root"]');
    return { collapsed: root.classList.contains('kB3qhq_collapsed'), wsRows: document.querySelectorAll('[data-row-key^="workspace:"]').length, titleSpans: document.querySelectorAll('[class*="panelTitle"]').length };
  }));
  check('展开后 workspace 行重新挂载、标题恢复', expanded.collapsed === false && expanded.wsRows >= 5 && expanded.titleSpans > 0, `wsRows=${expanded.wsRows} titles=${expanded.titleSpans}`);

  /* ---------- 6. dsh-pin 注入契约 ---------- */
  const plugin = await cdp.evaluate(`(() => {
    const nav = document.querySelector('nav[class*="panelList"]');
    const wsRows = [...document.querySelectorAll('[data-row-key^="workspace:"]')];
    const realWs = wsRows.filter((r) => r.getAttribute('data-row-key') !== 'workspace:');
    const wsButtons = [...document.querySelectorAll('[data-dsh-pin]')].filter((b) => b.getAttribute('data-dsh-pin') === 'workspace');
    const panelButtons = [...document.querySelectorAll('[data-dsh-pin="panel"]')];
    const nativePanelRows = [...nav.querySelectorAll(':scope > button[class*="panelRow"]')].filter((b) => !b.hasAttribute('aria-haspopup'));
    return {
      present: document.querySelectorAll('[data-dsh-pin]').length > 0,
      navListAttr: nav.hasAttribute('data-dsh-pin-list'),
      wsButtons: wsButtons.length,
      realWs: realWs.length,
      wsButtonsInRowActions: wsButtons.every((b) => !!b.closest('[class*="rowActions"]') && !!b.closest('[data-row-key^="workspace:"]')),
      wsButtonIds: wsButtons.map((b) => b.getAttribute('data-pin-workspace-id')),
      realWsIds: realWs.map((r) => r.getAttribute('data-row-key').slice('workspace:'.length)),
      panelButtons: panelButtons.length,
      nativePanelRows: nativePanelRows.length,
      panelBtnAbsolute: panelButtons.every((b) => getComputedStyle(b).position === 'absolute' && b.parentElement === nav),
      panelIds: panelButtons.map((b) => b.getAttribute('data-pin-panel-id')),
      pinnedRowAttrs: {
        workspace: document.querySelectorAll('[data-dsh-pinned-workspace]').length,
        panel: document.querySelectorAll('[data-dsh-pinned-panel]').length,
      },
      markers: document.querySelectorAll('[data-dsh-pin-marker="workspace"]').length,
      hook: window.__dshPin ? {
        keys: Object.keys(window.__dshPin),
        serviceAvailable: window.__dshPin.serviceAvailable,
        lastError: window.__dshPin.lastError,
        panelPins: window.__dshPin.panelPins,
        records: window.__dshPin.workspaceRecords,
        workspaceOrderLen: Array.isArray(window.__dshPin.workspaceOrder()) ? window.__dshPin.workspaceOrder().length : null,
      } : null,
    };
  })()`);
  check('dsh-pin 已注入（存在 [data-dsh-pin]）', plugin.present === true);
  if (plugin.present) {
    const missingWs = plugin.realWsIds.filter((id) => !plugin.wsButtonIds.includes(id));
    check('每个真实 workspace 行内都有 [data-dsh-pin="workspace"][data-pin-workspace-id]', plugin.wsButtonsInRowActions && missingWs.length === 0, `buttons=${plugin.wsButtons}/${plugin.realWs}`);
    check('Ungrouped 行不注入 workspace 按钮', plugin.wsButtons === plugin.realWs, `buttons=${plugin.wsButtons} realWs=${plugin.realWs}`);
    check('每个面板行都有绝对定位的面板置顶按钮（panelList 直接子元素）', plugin.panelButtons === plugin.nativePanelRows && plugin.panelBtnAbsolute, `buttons=${plugin.panelButtons} rows=${plugin.nativePanelRows}`);
    check('面板按钮 data-pin-panel-id 与 PanelRow id 一致', plugin.panelIds.every((id) => fiber.ids.some((e) => e.id === id)), JSON.stringify(plugin.panelIds));
    check('行级置顶状态属性与置顶集合一致（当前未置顶时为空）', plugin.pinnedRowAttrs.workspace === (plugin.hook?.records?.length ?? 0) && plugin.pinnedRowAttrs.panel === (plugin.hook?.panelPins?.length ?? 0), `ws=${plugin.pinnedRowAttrs.workspace} panel=${plugin.pinnedRowAttrs.panel} markers=${plugin.markers}`);
    if (plugin.hook) {
      check('诊断钩子 window.__dshPin 可用且无 lastError', plugin.hook.serviceAvailable === true && plugin.hook.lastError === null, `keys=${JSON.stringify(plugin.hook.keys)}`);
      check('window.__dshPin.workspaceOrder() 与真实 workspace 行数一致', plugin.hook.workspaceOrderLen === plugin.realWs, `${plugin.hook.workspaceOrderLen} vs ${plugin.realWs}`);
    } else {
      check('诊断钩子 window.__dshPin 可用', false, '未找到 window.__dshPin');
    }
  }

  /* ---------- 7. DOM 重排稳定性 ---------- */
  const baseOrder = await cdp.evaluate(`(() => [...document.querySelectorAll('nav[class*="panelList"] > button[class*="panelRow"]')].filter((b)=>!b.hasAttribute('aria-haspopup')).map((b)=>b.getAttribute('aria-label')))()`);
  // 7a. React 重渲染是否同步还原 DOM 顺序：移动行 → 点击面板行触发重渲染 → 在两个 rAF 后读顺序（插件 debounce=120ms，尚未介入）
  const reactReorder = await cdp.evaluate(`(async () => {
    const nav = document.querySelector('nav[class*="panelList"]');
    const rows = () => [...nav.querySelectorAll(':scope > button[class*="panelRow"]')].filter((b)=>!b.hasAttribute('aria-haspopup'));
    const order = () => rows().map((b)=>b.getAttribute('aria-label'));
    const before = order();
    nav.insertBefore(rows()[rows().length - 1], rows()[0]);
    const moved = order();
    // 触发 React 状态更新（切换面板），随后等两个 rAF 让 React 完成渲染
    const target = rows().find((b) => b.getAttribute('aria-label') !== 'Plugins') || rows()[0];
    target.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const afterRender = order();
    return { before, moved, afterRender, restoredByReact: afterRender.join() === before.join() };
  })()`);
  check('React 重渲染不会同步还原手动 DOM 顺序（需 MutationObserver/同步兜底）', reactReorder.restoredByReact === false, `moved=${JSON.stringify(reactReorder.moved)} afterRender=${JSON.stringify(reactReorder.afterRender)}`);
  await cdp.wait(1000);
  const afterPlugin = await cdp.evaluate(`(() => [...document.querySelectorAll('nav[class*="panelList"] > button[class*="panelRow"]')].filter((b)=>!b.hasAttribute('aria-haspopup')).map((b)=>b.getAttribute('aria-label')))()`);
  check('插件 debounce 后会自行把面板顺序还原到期望顺序', afterPlugin.join() === baseOrder.join(), `after=${JSON.stringify(afterPlugin)}`);
  // 7b. workspace 组 DOM 顺序在 rail 重挂后被 state 顺序覆盖（必须用 host API 置顶）
  const wsGroup = await cdp.evaluate(`(() => {
    const list = document.querySelector('.Kjh-qa_list');
    const groups = () => [...list.querySelectorAll(':scope > .Kjh-qa_groupSection')];
    const sig = () => groups().map((g) => (g.innerText || '').split('\\n')[0].trim());
    const before = sig();
    list.insertBefore(groups()[groups().length - 1], groups()[0]);
    return { before, moved: sig() };
  })()`);
  await cdp.wait(400);
  const t1 = await cdp.evaluate(`(() => { const b=document.querySelector('button[class*="toggle"]'); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await cdp.clickAt(t1.x, t1.y);
  await cdp.wait(1800);
  const t2 = await cdp.evaluate(`(() => { const b=document.querySelector('button[class*="toggle"]'); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await cdp.clickAt(t2.x, t2.y);
  await cdp.wait(2000);
  await cdp.waitFor(READY, { timeoutMs: 15000 });
  const wsGroupAfter = await cdp.evaluate(`(() => [...document.querySelectorAll('.Kjh-qa_list > .Kjh-qa_groupSection')].map((g) => (g.innerText || '').split('\\n')[0].trim()))()`);
  check('workspace 组 DOM 重排在 rail 重挂后被 state 顺序覆盖（置顶必须走 host API）', wsGroupAfter.join() !== wsGroup.moved.join() || wsGroupAfter.join() === wsGroup.before.join(), `moved=${JSON.stringify(wsGroup.moved.slice(0, 3))} after=${JSON.stringify(wsGroupAfter.slice(0, 3))}`);
} finally {
  // 收尾：把面板顺序恢复到初始、刷新页面，避免污染共享 scratch 实例
  await cdp.evaluate(`(() => { try { window.__dshPin && window.__dshPin.resync && window.__dshPin.resync(); } catch {} return true; })()`).catch(() => {});
  await cdp.navigate(DEFAULTS.url, { settleMs: 4000 }).catch(() => {});
  cdp.close();
}

const failed = results.filter((r) => !r.ok);
const passed = results.filter((r) => r.ok && !r.skipped);
console.log(`\n总计 ${results.length} 项断言：${passed.length} PASS，${failed.length} FAIL。`);
if (failed.length > 0) {
  console.error('失败项：');
  for (const f of failed) console.error(` - ${f.name} :: ${f.detail}`);
  process.exit(1);
}
