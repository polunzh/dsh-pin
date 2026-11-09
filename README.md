**English** | [中文](./README.zh-CN.md)

# dsh-pin

[![npm](https://img.shields.io/npm/v/@polunzh/dsh-pin)](https://www.npmjs.com/package/@polunzh/dsh-pin)
[![CI](https://github.com/polunzh/dsh-pin/actions/workflows/ci.yml/badge.svg)](https://github.com/polunzh/dsh-pin/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Pin workspaces and sidebar plugin panels to the top of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sidebar. Hover a row, click 📌; click again and the item returns to its exact former slot. Pins survive reloads and restarts.

![Pinned workspaces and panels](assets/03-pinned.png)

| Hover a workspace row | Hover a plugin panel row |
|---|---|
| ![Workspace row](assets/02-workspace-hover.png) | ![Plugin panel row](assets/04-panel-hover.png) |

## Install

```bash
dsh plugin --profile desktop add @polunzh/dsh-pin
```

GitHub and local checkouts work too (`github:polunzh/dsh-pin`, `link:/path/to/dsh-pin`), as does the plugin marketplace in DSH settings. Restart DSH or reload the profile afterwards.

## Use

- **Pin a workspace** — hover any row under Workspaces, click 📌. It moves to the top; with several pins the most recent comes first.
- **Pin a panel** — hover any sidebar plugin row (third-party panels, `Plugins`, `Automation tasks`), click 📌. The other panels keep their registration order.
- **Unpin** — click 📌 again, or click the small pin that pinned items always display.

The button matches the native row buttons (24×24 hit area) and never opens or collapses the workspace folder behind it. Pinned rows keep a visible pin so their state reads without hovering.

## What DSH already ships

| | Built in | dsh-pin adds |
|---|---|---|
| Workspace order | drag only | pin to top |
| Workspace pin state | none | persisted, exact restore |
| Session pin | `pinnedSessionIds` | left alone |
| Panel `order` | fixed at registration | pin to top, ordered per browser |

## How it works

- Workspace order uses the host's own `workspaces.insertBefore` RPC, so the durable registry stores it and every client agrees on it.
- Unpinning inserts the item before the workspace that used to follow it; a missing anchor falls back to the end of the list.
- New workspaces are created at the head of the registry. The plugin watches order changes and pulls pins back up, leaving the remaining order alone.
- Panel order is DOM-only: rows get reordered and the order recorded under `dsh-pin.panels.v1`, with unpin restoring slot registration order.
- A `MutationObserver` re-injects buttons after React re-renders and replays panel order.
- The host half is a no-op; all logic lives in `lib/client.js`.

## Limits

- Web GUI and the desktop web layer only; the TUI has no sidebar.
- "Ungrouped" is not a real workspace and cannot be pinned.
- Workspace order is global to the host; panel order is per browser.
- Dragging a pinned item down snaps it back — unpin first.
- Depends on internal DOM (`data-row-key`, `panelRow`, React fiber), so a major DSH upgrade can disable the buttons until the selectors are updated.
- Debug hook: `window.__dshPin` (`workspaceOrder()`, `panelPins`, `lastError`, `reassertPins()`).

## Development

```bash
npm test        # pure-logic unit tests (node:test, no dependencies)
npm run build   # regenerate lib/client.js from src/client-src.js
npm run check   # verify the committed bundle matches the source
```

End-to-end tests need a running DSH web instance and headless Chrome reachable over CDP:

```bash
DSH_PIN_LAB_URL="http://127.0.0.1:3091/?token=…" npm run test:e2e   # sidebar DOM and injection contracts
DSH_PIN_LAB_URL="http://127.0.0.1:3091/?token=…" npm run test:pin   # pin button clickability and regressions
```

API contracts and DOM experiments: [docs/API-NOTES.md](docs/API-NOTES.md), [docs/DOM-CONTRACTS.md](docs/DOM-CONTRACTS.md).

## Publishing

CI runs the unit tests and the bundle check. A push to `main` publishes through npm trusted publishing (OIDC) whenever `package.json` carries a new version, so the repo holds no long-lived token.

## License

MIT — see [LICENSE](LICENSE).
