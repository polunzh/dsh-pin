#!/usr/bin/env node
/**
 * test/e2e/pin-interaction.mjs — 置顶按钮「可点击 / 不消失 / 不误触」回归测试。
 *
 * 这些断言覆盖 1.0.1 暴露出来的三类真实故障：
 *   1) 点击工作区图钉会连带展开/折叠文件夹（点击落到了整行的 onClick 上）；
 *   2) 鼠标移到图钉上时图标位置被 rowActions 推开 → 点不到（“按钮消失”）；
 *   3) 已置顶面板的图钉在鼠标移开后凭空消失，用户看不出置顶状态。
 *
 * 依赖：test/e2e/cdp.mjs + 一台跑着 dsh-pin 的 DSH 实例 + headless Chrome。
 *   DSH_PIN_LAB_URL   实例 URL（必填，例如 http://127.0.0.1:3091/?token=…）
 *   DSH_PIN_CDP       CDP HTTP 端点，默认 http://127.0.0.1:9222
 *
 * 运行：node test/e2e/pin-interaction.mjs
 * 退出码：0 = 全部通过，1 = 有失败。
 */

import { CDP, DEFAULTS } from './cdp.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS  ' : 'FAIL  '}${name}${detail ? `  — ${detail}` : ''}`);
}

const cdp = await CDP.connect();
await cdp.enable();
await cdp.bringToFront();

const READY = `document.querySelectorAll('[data-row-key^="workspace:"]').length > 3 && !!document.querySelector('nav[class*="panelList"]') && !!window.__dshPin`;

/** 页面侧：读取面板行 → PanelRow.props.id（fiber 回溯）。 */
const PANEL_IDS = `(() => {
  const readId = (row) => {
    const key = Object.keys(row).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return null;
    let fiber = row[key];
    for (let d = 0; fiber && d < 8; d++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (p && typeof p === 'object' && typeof p.id === 'string' && typeof p.wide === 'boolean' && p.selectPanel !== undefined) return p.id;
    }
    return null;
  };
  const nav = document.querySelector('nav[class*="panelList"]');
  const rows = [...nav.querySelectorAll(':scope > button[class*="panelRow"]')].filter((b) => !b.hasAttribute('aria-haspopup'));
  return rows.map((row) => { const r = row.getBoundingClientRect(); return { id: readId(row), label: row.getAttribute('aria-label'), rect: { x: r.x, y: r.y, w: r.width, h: r.height } }; });
})()`;

const center = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
const settle = (ms = 400) => cdp.wait(ms);

/** 把鼠标移到空白处并等 hover 状态清掉。 */
async function parkPointer() {
  await cdp.hoverAt(1400, 860);
  await settle(500);
}

try {
  await cdp.navigate(DEFAULTS.url, { settleMs: DEFAULTS.settleMs });
  await cdp.setViewport(1600, 1000);
  await cdp.waitFor(READY, { timeoutMs: 25000 });
  await settle(800);

  /* ── 0. 干净起点：清掉历史置顶 ───────────────────────────────── */
  await cdp.evaluate(`(() => {
    const dbg = window.__dshPin;
    for (const record of dbg.workspaceRecords.slice()) {
      const btn = document.querySelector('[data-dsh-pin="workspace"][data-pin-workspace-id="' + record.workspaceId + '"]');
      if (btn) btn.click();
    }
    return true;
  })()`);
  await settle(2200);
  await cdp.evaluate(`(() => {
    for (const id of window.__dshPin.panelPins.slice()) {
      const btn = document.querySelector('[data-dsh-pin="panel"][data-pin-panel-id="' + id + '"]');
      if (btn) btn.click();
    }
    return true;
  })()`);
  await settle(800);
  await parkPointer();

  /* ── A. 工作区：hover 按钮可点，且不误触文件夹开合 ─────────────── */
  const target = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-row-key^="workspace:"]')].filter((r) => r.getAttribute('data-row-key') !== 'workspace:');
    const row = rows[1];
    const rect = row.getBoundingClientRect();
    return { key: row.getAttribute('data-row-key'), expanded: row.getAttribute('aria-expanded'), rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  })()`);
  const targetId = target.key.slice('workspace:'.length);

  await cdp.hoverAt(target.rect.x + 60, target.rect.y + target.rect.h / 2);
  await settle(350);

  const btnGeom = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-row-key="${target.key}"]');
    const btn = row.querySelector('[data-dsh-pin="workspace"]');
    const rect = btn.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  })()`);
  const hitTest = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-row-key="${target.key}"]');
    const btn = row.querySelector('[data-dsh-pin="workspace"]');
    const at = document.elementFromPoint(${btnGeom.x + btnGeom.w / 2}, ${btnGeom.y + btnGeom.h / 2});
    return { hit: !!at && (at === btn || btn.contains(at)), tag: at ? at.tagName : null };
  })()`);
  check('A1 工作区置顶按钮热区 24×24（与原生行内按钮一致）', btnGeom.w === 24 && btnGeom.h === 24, `${btnGeom.w}×${btnGeom.h}`);
  check('A2 按钮中心命中自身（没有被行 hover 卡片或相邻按钮盖住）', hitTest.hit === true, `hit=${hitTest.tag}`);

  const btnCenter = { x: btnGeom.x + btnGeom.w / 2, y: btnGeom.y + btnGeom.h / 2 };
  await cdp.clickAt(btnCenter.x, btnCenter.y);
  await settle(2200);

  const pinned = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-row-key="${target.key}"]');
    return {
      expanded: row ? row.getAttribute('aria-expanded') : 'gone',
      pinnedAttr: row ? row.getAttribute('data-dsh-pinned-workspace') : null,
      order0: window.__dshPin.workspaceOrder()[0],
      records: window.__dshPin.workspaceRecords.length,
      hasIndicator: !!row?.querySelector('[data-dsh-pin-marker="workspace"]'),
    };
  })()`);
  check('A3 点击置顶不会连带展开/折叠文件夹', pinned.expanded === target.expanded, `${target.expanded} → ${pinned.expanded}`);
  check('A4 置顶成功：记录 + 排到首位 + 行状态属性', pinned.records === 1 && pinned.order0 === targetId && pinned.pinnedAttr === targetId);
  check('A5 置顶后出现常驻图钉指示器', pinned.hasIndicator === true);

  /* ── B. 常驻图钉位置 = hover 按钮位置（点得到，不消失） ────────── */
  await parkPointer();
  const indicator = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-row-key="${target.key}"]');
    const marker = row.querySelector('[data-dsh-pin-marker="workspace"]');
    const rect = marker.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, display: getComputedStyle(marker).display };
  })()`);
  check('B1 未 hover 时常驻图钉可见', indicator.display !== 'none' && indicator.w > 0, `display=${indicator.display} w=${indicator.w}`);

  // 把鼠标移到“用户看到的图钉”中心：落点必须落在可点击按钮上
  const indicatorCenter = center(indicator);
  await cdp.hoverAt(indicatorCenter.x, indicatorCenter.y);
  await settle(400);
  const landed = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-row-key="${target.key}"]');
    const btn = row.querySelector('[data-dsh-pin="workspace"]');
    const at = document.elementFromPoint(${indicatorCenter.x}, ${indicatorCenter.y});
    const marker = row.querySelector('[data-dsh-pin-marker="workspace"]');
    return {
      hit: !!at && (at === btn || btn.contains(at)),
      tag: at ? at.tagName : null,
      markerDisplay: marker ? getComputedStyle(marker).display : null,
      visiblePins: [...row.querySelectorAll('[data-dsh-pin-marker="workspace"], [data-dsh-pin="workspace"]')]
        .filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0)
        .map((el) => el.tagName),
    };
  })()`);
  check('B2 鼠标移到图钉位置时落点就是可点击按钮（不是死区）', landed.hit === true, `at=${landed.tag}`);
  check('B3 hover 置顶行时只显示一个图钉（指示器让位给按钮）', landed.visiblePins.length === 1 && landed.visiblePins[0] === 'BUTTON', JSON.stringify(landed.visiblePins));

  await cdp.clickAt(indicatorCenter.x, indicatorCenter.y);
  await settle(2200);
  const unpinned = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-row-key="${target.key}"]');
    return {
      expanded: row ? row.getAttribute('aria-expanded') : 'gone',
      pinnedAttr: row ? row.getAttribute('data-dsh-pinned-workspace') : null,
      hasIndicator: !!row?.querySelector('[data-dsh-pin-marker="workspace"]'),
      records: window.__dshPin.workspaceRecords.length,
    };
  })()`);
  check('B4 点图钉位置可取消工作区置顶', unpinned.records === 0 && unpinned.pinnedAttr === null && unpinned.hasIndicator === false);
  check('B5 取消置顶也不会误触文件夹开合', unpinned.expanded === target.expanded, `${target.expanded} → ${unpinned.expanded}`);

  /* ── C. 面板：hover 浮现 / 置顶后常驻 / 可取消 ────────────────── */
  await parkPointer();
  const panels = await cdp.evaluate(PANEL_IDS);
  const panel = panels[0];
  await cdp.hoverAt(panel.rect.x + 60, panel.rect.y + panel.rect.h / 2);
  await settle(400);

  const panelBtn = await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-dsh-pin="panel"][data-pin-panel-id="${panel.id}"]');
    const rect = btn.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, opacity: getComputedStyle(btn).opacity };
  })()`);
  check('C1 hover 面板行时置顶按钮浮现', Number(panelBtn.opacity) > 0.5, `opacity=${panelBtn.opacity}`);

  const panelCenter = center(panelBtn);
  await cdp.clickAt(panelCenter.x, panelCenter.y);
  await settle(700);
  const panelPinned = await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-dsh-pin="panel"][data-pin-panel-id="${panel.id}"]');
    return { pinned: btn?.getAttribute('data-pinned'), pins: window.__dshPin.panelPins.slice() };
  })()`);
  check('C2 面板置顶成功', panelPinned.pinned === 'true' && panelPinned.pins.includes(panel.id), JSON.stringify(panelPinned.pins));

  await parkPointer();
  const panelIdle = await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-dsh-pin="panel"][data-pin-panel-id="${panel.id}"]');
    const style = getComputedStyle(btn);
    return { opacity: style.opacity, pointerEvents: style.pointerEvents };
  })()`);
  check('C3 鼠标移开后已置顶面板的图钉仍然可见（不再凭空消失）', Number(panelIdle.opacity) > 0.5 && panelIdle.pointerEvents !== 'none', `opacity=${panelIdle.opacity} pe=${panelIdle.pointerEvents}`);

  const pinnedBtnRect = await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-dsh-pin="panel"][data-pin-panel-id="${panel.id}"]');
    const rect = btn.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  })()`);
  const pinnedBtnCenter = center(pinnedBtnRect);
  await cdp.clickAt(pinnedBtnCenter.x, pinnedBtnCenter.y);
  await settle(900);
  await parkPointer();
  const panelUnpinned = await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-dsh-pin="panel"][data-pin-panel-id="${panel.id}"]');
    return { pins: window.__dshPin.panelPins.slice(), opacity: btn ? getComputedStyle(btn).opacity : null };
  })()`);
  check('C4 点常驻图钉可取消面板置顶，取消后按钮重新隐藏', panelUnpinned.pins.length === 0 && Number(panelUnpinned.opacity) < 0.5, `pins=${JSON.stringify(panelUnpinned.pins)} opacity=${panelUnpinned.opacity}`);

  /* ── D. 快速跨行移动：不留幽灵隐藏定时器 ─────────────────────── */
  await parkPointer();
  const rowsForHover = await cdp.evaluate(PANEL_IDS);
  for (const row of rowsForHover) {
    await cdp.hoverAt(row.rect.x + 60, row.rect.y + row.rect.h / 2);
    await cdp.wait(30);
  }
  const last = rowsForHover[rowsForHover.length - 1];
  await cdp.hoverAt(last.rect.x + 60, last.rect.y + last.rect.h / 2);
  await cdp.wait(600);
  const settled = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('[data-dsh-pin="panel"]')];
    return buttons.map((b) => ({ id: b.getAttribute('data-pin-panel-id'), opacity: getComputedStyle(b).opacity }));
  })()`);
  const visibleCount = settled.filter((b) => Number(b.opacity) > 0.5).length;
  check('D1 快速跨行后停留行的置顶按钮仍可见（无幽灵定时器）', visibleCount >= 1, JSON.stringify(settled));
} finally {
  // 收尾：清空置顶并刷新，避免污染共享实例
  await cdp.evaluate(`(() => {
    try {
      const dbg = window.__dshPin;
      if (dbg) {
        for (const r of dbg.workspaceRecords.slice()) {
          const b = document.querySelector('[data-dsh-pin="workspace"][data-pin-workspace-id="' + r.workspaceId + '"]');
          if (b) b.click();
        }
      }
    } catch {}
    return true;
  })()`).catch(() => {});
  await cdp.wait(2500);
  await cdp.evaluate(`(() => {
    try { for (const id of window.__dshPin.panelPins.slice()) { const b = document.querySelector('[data-dsh-pin="panel"][data-pin-panel-id="' + id + '"]'); if (b) b.click(); } } catch {}
    return true;
  })()`).catch(() => {});
  await cdp.wait(800);
  cdp.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n总计 ${results.length} 项断言：${results.length - failed.length} PASS，${failed.length} FAIL。`);
if (failed.length > 0) {
  console.error('失败项：');
  for (const f of failed) console.error(` - ${f.name} :: ${f.detail}`);
  process.exit(1);
}
