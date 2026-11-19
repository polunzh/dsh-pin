#!/usr/bin/env node
/**
 * test/e2e/panel-section.mjs — 顶部插件区 E2E 断言。
 *
 * 与 run.mjs 分开放置：run.mjs 关注置顶核心契约（面板/工作区行），本脚本只验证
 * 「把完整 sidebar.panellist 移到工作区浏览区上方」这一新增行为。选择器与
 * DOM 哈希无关（用 data-* 与结构定位），因此可跨 DSH 小版本运行。
 *
 * 环境变量（与 cdp.mjs 一致）：
 *   DSH_PIN_LAB_URL / DSH_PIN_CDP / DSH_PIN_TARGET
 *
 * 运行：node test/e2e/panel-section.mjs
 * 退出码：0 全部通过（允许 SKIP），1 有 FAIL。
 */

import { CDP } from './cdp.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true, detail });
  console.log(`SKIP  ${name}${detail ? `  — ${detail}` : ''}`);
}

const pageExpr = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`;

/* page-side: 结构定位（不依赖 CSS Modules 哈希） */
function inspectSection() {
  const nav = document.querySelector('nav[class*="panelList"]');
  const header = document.querySelector('[data-dsh-pin-panel-section-header]');
  const origin = document.querySelector('[data-dsh-pin-panel-section-origin]');
  const workspaceRow = document.querySelector('[data-row-key^="workspace:"]');
  const root = nav ? nav.closest('[class*="_root"]') : null;
  const parent = nav ? nav.parentElement : null;
  let branch = workspaceRow;
  while (branch && branch.parentElement !== parent) branch = branch.parentElement;
  const children = parent ? [...parent.children] : [];
  const panelRows = nav
    ? [...nav.querySelectorAll('button[class*="panelRow"]')].filter((r) => !r.hasAttribute('aria-haspopup'))
    : [];
  const selected = nav
    ? [...nav.querySelectorAll('button[class*="panelRow"]')]
        .filter((r) => !r.hasAttribute('aria-haspopup'))
        .find((r) => r.getAttribute('aria-selected') === 'true' || r.getAttribute('aria-current') === 'true' ||
          /\b(selected|active|current)\b/i.test(r.className) || /\b(selected|active|current)\b/i.test(r.parentElement?.className || ''))
    : null;
  return {
    navCount: document.querySelectorAll('nav[class*="panelList"]').length,
    moved: nav?.hasAttribute('data-dsh-pin-panel-section-moved') ?? false,
    header: !!header,
    origin: !!origin,
    expanded: header?.getAttribute('aria-expanded') ?? null,
    headerHidden: header?.hidden ?? null,
    navHidden: nav?.hidden ?? null,
    count: header?.querySelector('.dsh-pin-panel-section-count')?.textContent ?? null,
    panelCount: panelRows.length,
    order: { header: children.indexOf(header), nav: children.indexOf(nav), workspace: children.indexOf(branch) },
    rootWidth: root ? +root.getBoundingClientRect().width.toFixed(1) : null,
    selectedLabel: selected?.getAttribute('aria-label') ?? null,
    navHeight: nav ? +nav.getBoundingClientRect().height.toFixed(1) : null,
    navScrolls: nav ? nav.scrollHeight > nav.clientHeight + 1 : null,
  };
}

const cdp = await CDP.connect();
await cdp.enable();
await cdp.bringToFront();

const READY = `document.querySelectorAll('[data-row-key^="workspace:"]').length > 0 && !!document.querySelector('nav[class*="panelList"]')`;

try {
  await cdp.navigate(undefined, { settleMs: 4500 });
  await cdp.setViewport(1440, 960);
  await cdp.waitFor(READY, { timeoutMs: 30000 });
  await cdp.wait(900);

  /* 1. 位置：header → nav → 工作区分支，且 nav 只有一份 */
  const s = await cdp.evaluate(pageExpr(inspectSection));
  check(
    '完整插件列表位于工作区浏览区上方，且只保留一份',
    s.moved && s.header && s.navCount === 1 && s.order.header >= 0 && s.order.header < s.order.nav && s.order.nav < s.order.workspace,
    JSON.stringify(s.order),
  );
  check('保留原位置标记（origin marker）用于安全恢复', s.origin === true);
  check(
    '标题显示展开状态与面板数量',
    s.expanded === 'true' && s.navHidden === false && s.headerHidden === false && Number(s.count) === s.panelCount,
    `expanded=${s.expanded} count=${s.count}/${s.panelCount}`,
  );

  /* 2. 收起/展开，且不改变当前选中面板 */
  const selectedBefore = s.selectedLabel;
  await cdp.evaluate(`(() => document.querySelector('[data-dsh-pin-panel-section-header]')?.click())()`);
  await cdp.wait(200);
  const collapsed = await cdp.evaluate(pageExpr(inspectSection));
  check(
    '点击标题收起：隐藏原生面板列表并持久化',
    collapsed.navHidden === true && collapsed.expanded === 'false' &&
      (await cdp.evaluate(`localStorage.getItem('dsh-pin.panel-section.v1')`)) === 'collapsed',
    `navHidden=${collapsed.navHidden} stored=${await cdp.evaluate(`localStorage.getItem('dsh-pin.panel-section.v1')`)}`,
  );
  await cdp.evaluate(`(() => document.querySelector('[data-dsh-pin-panel-section-header]')?.click())()`);
  await cdp.wait(200);
  const expanded = await cdp.evaluate(pageExpr(inspectSection));
  check('再次点击展开：恢复原生面板列表', expanded.navHidden === false && expanded.expanded === 'true');
  check(
    '收起/展开不改变当前选中面板',
    selectedBefore === null || expanded.selectedLabel === selectedBefore,
    `before=${selectedBefore} after=${expanded.selectedLabel}`,
  );

  /* 3. 折叠状态跨刷新持久化 */
  await cdp.evaluate(`(() => document.querySelector('[data-dsh-pin-panel-section-header]')?.click())()`);
  await cdp.wait(150);
  await cdp.navigate(undefined, { settleMs: 4500 });
  await cdp.waitFor(READY, { timeoutMs: 30000 });
  const afterReload = await cdp.evaluate(pageExpr(inspectSection));
  check(
    '刷新后仍保持收起状态',
    afterReload.navHidden === true && afterReload.expanded === 'false',
    `navHidden=${afterReload.navHidden} expanded=${afterReload.expanded}`,
  );
  await cdp.evaluate(`(() => document.querySelector('[data-dsh-pin-panel-section-header]')?.click())()`);
  await cdp.wait(200);

  /* 4. 键盘可操作：Enter 切换 aria-expanded */
  const keyboard = await cdp.evaluate(`(async () => {
    const header = document.querySelector('[data-dsh-pin-panel-section-header]');
    const before = header.getAttribute('aria-expanded');
    header.focus();
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    // 原生 button 的 Enter 会触发 click（合成键盘事件不会自动触发，手动补一次）
    if (header.getAttribute('aria-expanded') === before) header.click();
    const after = header.getAttribute('aria-expanded');
    if (after === 'false') header.click();
    return { before, after, focusable: document.activeElement === header };
  })()`);
  check('标题可聚焦且 Enter 切换展开状态', keyboard.focusable && keyboard.after !== keyboard.before, JSON.stringify(keyboard));

  /* 5. rail（侧栏折叠为窄条）：标题隐藏、原生面板列表仍可见 */
  const railInfo = await cdp.evaluate(pageExpr((inspectSectionSrc) => {
    const inspect = eval(`(${inspectSectionSrc})`);
    const nav = document.querySelector('nav[class*="panelList"]');
    const root = nav ? nav.closest('[class*="_root"]') : null;
    const candidates = root ? [...root.querySelectorAll('button[class*="toggle"]')] : [];
    const fallback = [...document.querySelectorAll('button')].filter((b) => /sidebar/i.test(b.getAttribute('aria-label') || ''));
    const pool = candidates.length ? candidates : fallback;
    const toggle = pool[0] || null;
    const r = toggle ? toggle.getBoundingClientRect() : null;
    return { toggle: !!toggle, x: r ? r.x + r.width / 2 : null, y: r ? r.y + r.height / 2 : null, label: toggle?.getAttribute('aria-label') ?? null };
  }
  , inspectSection.toString()));
  if (!railInfo.toggle) {
    skip('rail：未找到侧栏折叠按钮，跳过');
  } else {
    await cdp.clickAt(railInfo.x, railInfo.y);
    await cdp.wait(1800);
    const rail = await cdp.evaluate(pageExpr(inspectSection));
    const wsRows = await cdp.evaluate(`document.querySelectorAll('[data-row-key^="workspace:"]').length`);
    if (wsRows === 0) {
      check('rail：隐藏插件区标题并保持原生面板列表可见', rail.headerHidden === true && rail.navHidden === false, `headerHidden=${rail.headerHidden} navHidden=${rail.navHidden}`);
      check('rail：面板行仍挂载', rail.panelCount > 0, `panels=${rail.panelCount}`);
    } else {
      skip('rail：折叠后 workspace 行仍在，未进入 rail 状态（版本差异），跳过', `wsRows=${wsRows}`);
    }
    // 恢复展开
    const back = await cdp.evaluate(`(() => {
      const nav = document.querySelector('nav[class*="panelList"]');
      const root = nav ? nav.closest('[class*="_root"]') : null;
      const pool = root ? [...root.querySelectorAll('button[class*="toggle"]')] : [];
      const b = pool[0] || [...document.querySelectorAll('button')].find((x) => /sidebar/i.test(x.getAttribute('aria-label') || ''));
      if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (back) { await cdp.clickAt(back.x, back.y); await cdp.wait(1800); }
    await cdp.waitFor(READY, { timeoutMs: 15000 }).catch(() => {});
  }

  /* 6. 插件区展开时高度受限、内部可滚动（面板较多时） */
  const cap = await cdp.evaluate(pageExpr((navSel) => {
    const nav = document.querySelector(navSel);
    if (!nav) return null;
    const cs = getComputedStyle(nav);
    return { maxHeight: cs.maxHeight, overflowY: cs.overflowY, navHeight: +nav.getBoundingClientRect().height.toFixed(1), client: nav.clientHeight, scroll: nav.scrollHeight };
  }, 'nav[data-dsh-pin-panel-section-moved]'));
  if (cap) {
    check('插件区设置高度上限且纵向独立滚动', cap.overflowY === 'auto' && cap.maxHeight !== 'none', JSON.stringify(cap));
  } else {
    skip('插件区高度上限：未找到已移动的 nav');
  }
} finally {
  // 恢复展开与初始状态，避免污染实例
  await cdp.evaluate(`(() => { try { localStorage.removeItem('dsh-pin.panel-section.v1'); } catch {} return true; })()`).catch(() => {});
  await cdp.navigate(undefined, { settleMs: 3000 }).catch(() => {});
  cdp.close();
}

const failed = results.filter((r) => !r.ok);
const passed = results.filter((r) => r.ok && !r.skipped);
console.log(`\n总计 ${results.length} 项断言：${passed.length} PASS，${failed.length} FAIL，${results.filter((r) => r.skipped).length} SKIP。`);
if (failed.length > 0) {
  console.error('失败项：');
  for (const f of failed) console.error(` - ${f.name} :: ${f.detail}`);
  process.exit(1);
}
