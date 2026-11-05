# Frontend baseline 1.0.0

应用身份与品牌在 app.config.json；API、认证方式和业务路由保留各自实现。Node 26.12.1，npm 11.20.0，使用 npm ci 安装已锁定依赖。

检查：npm run check:baseline；浏览器：npx playwright install chromium 后 npm run test:baseline。浏览器测试通过受控接口与外壳挂载验证 HTTP、导航、移动抽屉、表单值、自定义多选和删除失败恢复，不替代真实业务后端联调。

页面默认 PageShell 全宽；运营列表表头约 32px、行约 36px、单行内容、数值排序；表格内部处理横向滚动。设置页用下划线页签。操作结果用全局 toast，危险操作用 useConfirm；品牌、主题、圆角与颜色优先用共享配置和 token。

升级时逐项比较 template-baseline.json 的文件摘要；保留 cookie/CSRF、角色权限、缓存与静默刷新等本项目扩展，不整目录覆盖。appId 用于隔离存储；此前共享 app: 命名空间的项目首次启动可能需要重新登录和设置偏好。
