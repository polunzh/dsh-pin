# 项目约定

## 每次改进都要发版

- 每次改进——功能、bug 修复、行为或界面变化——做完并验证后，都要发版，不停留在只 push 代码。
- 发版做法：按 semver 递增 `package.json` 的 `version`（修复和小改动用 patch，新功能用 minor），提交并 push 到 `main`。
- push 到 `main` 会触发 `.github/workflows/publish.yml`，用 OIDC 自动发布到 npm。该 workflow 在版本号已存在于 npm 时会跳过发布，所以**必须递增版本号**才会真正发版。
- 完整发布流程见 skill `dsh-plugin-release`。
