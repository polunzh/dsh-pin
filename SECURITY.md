# Security

## Scope

`@polunzh/dsh-pin` is a browser-side DSH client plugin.

- It adds no HTTP routes, no background services, and no network requests.
- It reads/writes only:
  - the Host's existing `workspaces.insertBefore` RPC (workspace ordering),
  - `localStorage` keys `dsh-pin.workspaces.v1` / `dsh-pin.panels.v1`.
- It never reads session content, credentials, files, or environment variables.

The DOM injection depends on DSH internal markup (`data-row-key`, `panelRow`,
React fiber). A DSH upgrade can break the buttons; it cannot make them exfiltrate
data.

## Reporting

Please report vulnerabilities privately via GitHub Security Advisories:
https://github.com/polunzh/dsh-pin/security/advisories/new

Do not open a public issue for a security report.
