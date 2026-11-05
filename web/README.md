# MC Panel 前端

公共约定以 [BASELINE.md](./BASELINE.md) 为准；以下业务说明保留本项目的接口与流程。

由 frontend-template 派生，当前使用本项目的真实认证、API 与业务页面。

技术栈:Vite 6 · React 19 · TypeScript 5.6 · Tailwind 3 · shadcn/ui(Radix)· lucide · motion · recharts。

---

## 快速开始

在本目录运行：

```bash
npm ci
npm run dev
npm run check:baseline
npx playwright install chromium
npm run test:baseline
```

Node 26.12.1、npm 11.20.0。端口和代理见 vite.config.ts，业务启动方式见项目根 README。这里使用真实后端；品牌与身份在 app.config.json 中维护。

---

## 内核 vs 业务:边界在哪

派生时**不该动**的是内核(chrome / 底座);**该替换**的是业务。

| 层 | 文件 | 派生时 |
|----|------|--------|
| 设计系统 | `src/index.css`(`ops-*` 类 + 主题 token)、`tailwind.config.js` | 改色板,基本不动结构 |
| UI 原子 | `src/components/ui/*`(shadcn) | 不动;要加组件用 shadcn 同款方式 |
| 布局骨架 | `src/components/layout/*`、`pages/Dashboard.tsx` 外壳 | 改导航项,不改结构 |
| 跨切面基建 | `theme` `i18n` `font-load-coordinator` `ChunkLoadBoundary` `global-toast` `lib/*` | 不动 |
| API 层 | `src/api/client.ts`、`src/api/auth.ts` | 按后端调整,模式不变 |
| **业务** | `src/pages/*`、`src/api/<feature>.ts` | **这里才是你要写的** |

---

## 核心约定(参考时照这套来)

### 1. 设计语言固化在 CSS,页面只描述内容
所有页面壳走 `PageScaffold`(`PageShell` / `PageSurface` / `PageStat` / `PageStatStrip`),
对应 `index.css` 里的 `ops-*` 语义类。页面代码里**不要散写卡片/边框/阴影的 Tailwind 组合** ——
要改外观就改 `ops-*` 一处,全站统一。公共列表参考 `components/layout/ResourceTable.tsx`，业务概览保留自身结构。

### 2. 主题用 HSL token,不写死颜色
颜色一律 `hsl(var(--primary))` 之类,light/dark 两套定义在 `index.css :root` / `.dark`。
换主色只改 token。深色模式由 `theme.tsx` 切换,切换时加 `html.theme-switching` 临时禁用过渡防闪烁;
首屏防闪由 `index.html` 内联脚本处理。

### 3. 数据获取统一走 `useResource`,不要手搓 useEffect
```ts
const { data, loading, error, refresh } = useResource(() => getOverview(range), [range])
```
它处理 loading / error / 竞态 / 刷新。**禁止**再写「`useEffect` + 三个 useState + 用 `refreshKey` 一路透传」那套样板。

### 4. 网络细节关在 `api/` 层
页面不直接 `fetch`。所有请求经 `api/client.ts` 的 `apiRequest`(自动注入鉴权头、x-request-id、结构化日志、`ApiError`)。
每个业务域一个 `api/<feature>.ts`,导出类型化函数,页面只调函数、不碰 URL。

### 5. 应用命名空间
品牌与稳定 appId 在 app.config.json 维护，存储和事件通过 nsKey() 生成，不能使用共享 app: 前缀。首屏主题由同一 appId 注入。

### 6. 页面懒加载 + 切换动画
页面一律 `lazy()` + `<Suspense>`,外层 `ChunkLoadBoundary` 兜底「部署后旧 chunk 404 → 自动 reload 一次」。

### 7. 为什么不引 react-router
内部后台是「登录后单视图、页面有限、无深链接需求」,用 `Dashboard.tsx` 里的 `useState<Page>` 切页足够,
省一层心智负担。**这是刻意取舍**:一旦需要深链接 / 多级路由 / 浏览器前进后退,把 `currentPage` 换成 router 即可,其余结构不动。

### 8. 单语言项目也保留 i18n 层
`i18n/` 目前是单语言(zh-CN)直通实现,但 `datetime-picker`、`global-toast` 已通过它取文案。
要做多语言时只扩 `i18n/`,不用改调用点。

---

## 加一个新页面(checklist)

1. `src/api/<feature>.ts`:用 `apiRequest` 写类型化的数据函数。
2. `src/pages/<Name>.tsx`:用 `PageShell` 搭壳，独立表单区块才加 `PageSurface`,数据用 `useResource`,照抄 `Overview.tsx` 结构。
3. `src/pages/Dashboard.tsx`:在 `navItems` 加一项,在 `lazy()` 区和 `<main>` 的条件渲染里各加一行。
4. `npm run lint && npm run build` 应全绿。

> 「带选项卡的设置类页面」另有范本:`pages/Settings.tsx` + `TabbedSettingsPage`。

---

## 已知取舍

- **无 react-router**:理由见约定 7。
- **无 TanStack Query**:`useResource` 覆盖了 80% 取数场景;真出现复杂缓存/失效再引。
- **页面文案目前硬编码中文**:i18n 层已就位,需要多语言时再迁。
- **验证**：公共交互由 test:baseline 覆盖，业务关键逻辑按各项目需要补测试。

前端公共基线与验证命令见 [BASELINE.md](./BASELINE.md)。
