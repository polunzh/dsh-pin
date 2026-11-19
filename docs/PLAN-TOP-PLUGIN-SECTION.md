# 顶部插件区实施计划

1. 在客户端增加插件区状态键、文案、DOM 属性和样式。
2. 实现 origin marker、工作区分支定位、原生面板列表移动与安全恢复。
3. 实现折叠按钮、状态持久化、窄屏默认值和 rail 模式协同。
4. 将插件区同步接入现有 MutationObserver、resize 与诊断钩子。
5. 补充纯逻辑测试和浏览器 E2E 契约，更新 DOM 契约文档。
6. 更新中英文 README、插件截图与版本号，生成提交版客户端 bundle。
7. 运行单测、bundle 一致性检查和当前 DSH GUI 验证。
8. 提交并推送到 `main`，确认 GitHub Actions 和 npm 新版本发布。
