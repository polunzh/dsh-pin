#!/usr/bin/env node
/**
 * test/e2e/cdp.mjs — 极简 CDP 驱动（零 npm 依赖，Node >= 22 内置 WebSocket/fetch）。
 *
 * 用途：dsh-pin 的浏览器实验/回归脚本。直接复用已运行的无头 Chrome（默认
 * http://127.0.0.1:9222），不负责启动/关闭 Chrome 或 DSH 实例。
 *
 * 环境变量：
 *   DSH_PIN_CDP         CDP HTTP 端点，默认 http://127.0.0.1:9222
 *   DSH_PIN_LAB_URL     scratch DSH 实例 URL（open 子命令默认值）
 *   DSH_PIN_TARGET     /json/list 中页面 url 的匹配子串（默认 127.0.0.1:3091）
 *   DSH_PIN_SETTLE_MS  页面加载后额外静置时间，默认 5000（DSH 首屏 React 挂载较慢）
 *
 * CLI：
 *   node test/e2e/cdp.mjs info
 *   node test/e2e/cdp.mjs open [url]
 *   node test/e2e/cdp.mjs eval '<js 表达式>'
 *   node test/e2e/cdp.mjs evalfile probe.js
 *   node test/e2e/cdp.mjs wait 1500
 *   node test/e2e/cdp.mjs shot out.png [--full] [--clip=x,y,w,h] [--scale=1]
 *   node test/e2e/cdp.mjs viewport 1600 1000 [reset]
 *   node test/e2e/cdp.mjs click <x> <y>
 *   node test/e2e/cdp.mjs hover <x> <y>
 *
 * 作为模块：
 *   import { CDP, DEFAULTS } from './cdp.mjs';
 *   const cdp = await CDP.connect();
 *   const data = await cdp.evaluate('({a:1})');
 *   await cdp.screenshot('docs/assets/x.png');
 *   await cdp.setViewport(1600, 1000);
 *   await cdp.clickAt(100, 200);
 *   cdp.close();
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULTS = {
  cdp: process.env.DSH_PIN_CDP || 'http://127.0.0.1:9222',
  url:
    process.env.DSH_PIN_LAB_URL || 'http://127.0.0.1:3091/',
  target:
    process.env.DSH_PIN_TARGET ||
    (process.env.DSH_PIN_LAB_URL ? new URL(process.env.DSH_PIN_LAB_URL).host : '127.0.0.1:3091'),
  settleMs: Number(process.env.DSH_PIN_SETTLE_MS || 5000),
  readyTimeoutMs: 30000,
  evalTimeoutMs: 30000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CDP {
  /** @param {{cdp?: string, target?: string}} opts */
  constructor(opts = {}) {
    this.base = (opts.cdp || DEFAULTS.cdp).replace(/\/$/, '');
    this.targetHint = opts.target || DEFAULTS.target;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.targetInfo = null;
  }

  /** 连接（或复用）一个 page target。不会启动第二个 Chrome 实例；仅在没有任何
   * page target 时才通过 /json/new 开一个标签页。 */
  static async connect(opts = {}) {
    const cdp = new CDP(opts);
    await cdp.open();
    return cdp;
  }

  async listTargets() {
    const res = await fetch(`${this.base}/json/list`);
    if (!res.ok) throw new Error(`CDP /json/list 失败: ${res.status}`);
    return res.json();
  }

  async open() {
    let targets = await this.listTargets();
    let page = targets.find((t) => t.type === 'page' && t.url.includes(this.targetHint));
    if (!page) page = targets.find((t) => t.type === 'page');
    if (!page) {
      const res = await fetch(`${this.base}/json/new?${encodeURIComponent('about:blank')}`, {
        method: 'PUT',
      });
      page = await res.json();
    }
    this.targetInfo = { id: page.id, url: page.url, title: page.title };
    await this._attach(page.webSocketDebuggerUrl);
    return this;
  }

  _attach(wsUrl) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) =>
        reject(new Error(`WebSocket 连接失败: ${wsUrl} (${e.message || e.type})`)),
      );
      this.ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) rej(new Error(`CDP ${msg.method || ''} ${JSON.stringify(msg.error)}`));
          else res(msg.result);
        } else if (msg.method) {
          const list = this.listeners.get(msg.method) || [];
          for (const fn of list) fn(msg.params);
        }
      });
      this.ws.addEventListener('close', () => {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('CDP WebSocket 已关闭'));
        }
        this.pending.clear();
      });
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}, timeoutMs = DEFAULTS.evalTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async enable() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    return this;
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /** Runtime.evaluate 同步/异步表达式，返回 JS 值（异常时抛错）。 */
  async evaluate(expression, opts = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: opts.returnByValue !== false,
      awaitPromise: opts.awaitPromise !== false,
      userGesture: opts.userGesture !== false,
      includeCommandLineAPI: opts.includeCommandLineAPI === true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = d.exception?.description || d.text || 'evaluate 异常';
      throw new Error(`页面内异常: ${text}`);
    }
    return res.result?.value;
  }

  async evaluateFile(path, opts) {
    return this.evaluate(readFileSync(path, 'utf8'), opts);
  }

  async waitForLoad({ timeoutMs = DEFAULTS.readyTimeoutMs } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const ready = await this.evaluate('document.readyState').catch(() => null);
      if (ready === 'complete') return true;
      await sleep(250);
    }
    throw new Error(`等待 document.readyState=complete 超时 (${timeoutMs}ms)`);
  }

  /** 把目标页带到前台：无头 Chrome 里标签页隐藏时 CSS transition 会冻结，
   *  截图/尺寸断言前需要这一步，否则 rail 折叠动画会停在中间态。 */
  async bringToFront() {
    await this.send('Page.bringToFront').catch(() => {});
    return this;
  }

  /** 导航并等待 ready + settle（DSH 首屏挂载约 1-3s，默认再等 5s）。 */
  async navigate(url = DEFAULTS.url, { settleMs = DEFAULTS.settleMs } = {}) {
    await this.bringToFront();
    await this.send('Page.navigate', { url });
    await this.waitForLoad();
    if (settleMs > 0) await sleep(settleMs);
    this.targetInfo = null;
    return this;
  }

  /** 轮询直到表达式返回 truthy；返回该值。 */
  async waitFor(expression, { timeoutMs = 15000, intervalMs = 200 } = {}) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeoutMs) {
      last = await this.evaluate(expression).catch((e) => ({ error: String(e) }));
      if (last) return last;
      await sleep(intervalMs);
    }
    throw new Error(`waitFor 超时 (${timeoutMs}ms): ${expression}；最后值=${JSON.stringify(last)}`);
  }

  async wait(ms) {
    await sleep(ms);
  }

  /** 截图。clip 坐标为 CSS px（页面坐标，非视口坐标需自行加 scroll）。 */
  async screenshot(path, { fullPage = false, clip = null, scale = 1 } = {}) {
    const params = { format: 'png', captureBeyondViewport: !!fullPage };
    if (clip) {
      params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale };
    }
    const res = await this.send('Page.captureScreenshot', params, 30000);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    return path;
  }

  /** 模拟真实点击：mouseMoved → mousePressed → mouseReleased。 */
  async clickAt(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: 1,
      clickCount,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount,
    });
  }

  /** 模拟鼠标悬停（只发 mouseMoved；CSS :hover 会生效）。 */
  async hoverAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  /** 把鼠标移出视口外，清除 hover。 */
  async clearHover() {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -100, y: -100 });
  }

  /** 固定视口大小（用于可复现截图/布局断言）。 */
  async setViewport(width, height, { deviceScaleFactor = 1, mobile = false } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
  }

  async resetViewport() {
    await this.send('Emulation.clearDeviceMetricsOverride');
  }

  /** 取元素 bounding rect（CSS px，视口坐标）。 */
  async rect(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) };
    })()`);
  }
}

/* ------------------------------- CLI ------------------------------- */

function usage() {
  console.log(`用法: node test/e2e/cdp.mjs <command> [args]

命令:
  info                     打印当前 tab 信息（url/title/readyState/viewport）
  open [url]               导航到 url（默认 DSH_PIN_LAB_URL）并等待 ready+settle
  eval '<expr>'            执行表达式并打印 JSON 结果
  evalfile <file>          执行文件内容并打印 JSON 结果
  wait <ms>                等待
  shot <out.png> [--full] [--clip=x,y,w,h] [--scale=1] [--viewport=WxH]
  viewport <w> <h>         固定视口；viewport reset 清除
  click <x> <y>            真实鼠标点击
  hover <x> <y>            鼠标悬停

环境变量: DSH_PIN_CDP / DSH_PIN_LAB_URL / DSH_PIN_TARGET / DSH_PIN_SETTLE_MS`);
}

async function main() {
  const [, , cmd = 'info', ...args] = process.argv;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const cdp = await CDP.connect();
  await cdp.enable();
  try {
    if (cmd === 'info') {
      const info = await cdp.evaluate(
        '({ url: location.href, title: document.title, ready: document.readyState, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, sidebar: !!document.querySelector(\'[class*="panelList"]\') })',
      );
      console.log(JSON.stringify(info, null, 2));
    } else if (cmd === 'open') {
      await cdp.navigate(args[0] || DEFAULTS.url);
      console.log(JSON.stringify({ url: await cdp.evaluate('location.href') }));
    } else if (cmd === 'eval') {
      console.log(JSON.stringify(await cdp.evaluate(args.join(' ')), null, 2));
    } else if (cmd === 'evalfile') {
      console.log(JSON.stringify(await cdp.evaluateFile(args[0]), null, 2));
    } else if (cmd === 'wait') {
      await cdp.wait(Number(args[0] || 500));
      console.log('waited');
    } else if (cmd === 'shot') {
      const out = args[0];
      if (!out) throw new Error('shot 需要输出路径');
      const fullPage = args.includes('--full');
      const clipArg = args.find((a) => a.startsWith('--clip='));
      const scaleArg = args.find((a) => a.startsWith('--scale='));
      const viewportArg = args.find((a) => a.startsWith('--viewport='));
      const clip = clipArg
        ? (([x, y, width, height]) => ({ x, y, width, height }))(
            clipArg.slice('--clip='.length).split(',').map(Number),
          )
        : null;
      if (viewportArg) {
        const [w, h] = viewportArg.slice('--viewport='.length).split('x').map(Number);
        await cdp.setViewport(w, h);
        await cdp.wait(400);
      }
      try {
        await cdp.screenshot(out, {
          fullPage,
          clip,
          scale: scaleArg ? Number(scaleArg.split('=')[1]) : 1,
        });
      } finally {
        if (viewportArg) await cdp.resetViewport();
      }
      console.log('saved', out);
    } else if (cmd === 'viewport') {
      if (args[0] === 'reset') await cdp.resetViewport();
      else await cdp.setViewport(Number(args[0]), Number(args[1]));
      console.log('viewport', args.join(' '));
    } else if (cmd === 'click') {
      await cdp.clickAt(Number(args[0]), Number(args[1]));
      console.log('clicked', args[0], args[1]);
    } else if (cmd === 'hover') {
      await cdp.hoverAt(Number(args[0]), Number(args[1]));
      console.log('hovered', args[0], args[1]);
    } else {
      usage();
      process.exitCode = 1;
    }
  } finally {
    cdp.close();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error(e.stack || String(e));
    process.exit(1);
  });
}
