# LinuxDo 增强阅读 · 2.0 工作台版

> 在 LINUX DO 与 IDC Flare 列表页点击标题即可弹窗预览整帖：融合 **2.0 工作台界面、默认缩进楼中楼、自动无感载入新回复、全站任意表情点赞回应、列表发帖时间列、虚拟楼层流、右侧日期时间轴、双栏用户资料卡、历史收藏与 Obsidian 快照**，以及上游最新 **投票、模糊剧透、视频播放、KaTeX 数学公式、表情选择器、回复模板、大图压缩与分片上传、删帖、楼层等级标识** 等全部特性。

[![](https://img.shields.io/badge/github-repo-blue?logo=github)](https://github.com/liansishen/linuxdo-read-script)
![version](https://img.shields.io/badge/version-2.2.4-blue)
![platform](https://img.shields.io/badge/platform-Tampermonkey%20%7C%20Violentmonkey-orange)
![license](https://img.shields.io/badge/license-MIT-green)

## 简介

本项目 Fork 自 [fashionzzZ/linuxdo-read-script](https://github.com/fashionzzZ/linuxdo-read-script)，在保留 [ywainzh/linuxdo-read-script](https://github.com/ywainzh/linuxdo-read-script) **2.0 阅读器工作台界面与高性能虚拟流架构**的基础上，完整合入了上游 `v1.9.1` 的全部最新交互能力。

支持 `https://linux.do` 与 `https://idcflare.com`，所有交互（点赞、回复、表情回应、收藏、Boost、投票、上传、删帖、已读上报）均通过当前站点官方接口完成，沿用浏览器现有登录态且按站点与账号隔离缓存。

## 功能特性

### 界面与阅读引擎（2.0 工作台）
- **安静的绿色工作台浮窗**：毛玻璃遮罩、站点图标、分类与全量主题标签胶囊、粘性回应分隔栏、奇偶斑马楼层底色、底部固定工具栏。
- **真实虚拟楼层流**：以逻辑楼层、高度前缀表与上下占位符承载超长帖，主时间流最多挂载 `72` 个节点；图片与回复展开改变高度时保持视口锚点零跳动。
- **快速远跳与智能续读**：列表点击自动定位到第一条未读回复，通知/用户菜单点击直达目标楼层并高亮；主题元数据与目标窗口并行请求，无需顺序加载中间分页。
- **右侧日期时间轴（支持点击、拖拽与到底精准满格）**：显示首尾日期、当前楼层进度 `X / Total` 与日期；支持点击顶部/底部日期、点击轨道、键盘导航及按住圆点上下拖动实时预览跳楼，滚动到底部自动平滑收敛至末尾楼层与 100% 进度。
- **默认楼中楼嵌套树展示**：主时间流仅展示顶层评论，子回复默认以缩进楼中楼直接展开，进入视口时自动补全跨分页子回复，超出条数可点击「展示更多回复」继续展开。
- **自动无感载入新回复**：结合 `message-bus` 实时推送（按 `created` 事件定向单帖拉取）与低频后台兜底同步，新回复出现时无需刷新弹窗即可自动拉取并注入虚拟流与对应楼中楼（顶部工具栏可随时一键暂停/开启）。
- **紧凑胶囊悬停表情点赞（无新增按钮）**：直接点击爱心即默认爱心点赞/取消；鼠标停留在爱心上片刻弹出紧凑胶囊表情栏（仅展示站点启用的合法回应表情），点击即以对应表情点赞。
- **回复框与 Boost 实时字数提示**：动态读取站点配置的最小回复字数，在回复框「发送」与 Boost「✓」右侧实时显示 `x/16` 字数，不足或超限时呈红色高亮提示。
- **列表页「发帖时间列」与新旧颜色梯度**：在话题列表「活动」列左侧注入「发帖」创建时间列，当天新帖以鲜红色突出显示，近 7 天（昨天/前天/x天前）由红向灰逐级平滑变淡，7 天及以上恢复默认灰色。
- **浏览历史、收藏与回应面板**：顶部工具栏（及站点顶栏快捷入口）支持搜索、分页管理浏览历史、回应记录、整帖收藏与单楼层收藏。
- **只看楼主 & 清缓存刷新**：一键过滤仅看楼主楼层；支持 IndexedDB 主题快照缓存（90 秒内秒开，7 天内先显后校）与手动清缓存刷新。
- **请求调度与 429 跨标签页冷却**：三级优先级队列（最多并发 2 个、最小间隔 180ms），已读上报对齐 Discourse 官方 60s 节流与空闲暂停，读写请求统一接入 HTTP 429 `Retry-After` / `wait_seconds` 退避并通过 `BroadcastChannel` 同步同源标签页。

### 内容渲染与互动能力（同步上游最新 v1.9.1）
- **投票（Polls）**：支持任意楼层中的 `regular` 单选与 `multiple` 多选投票，展示票数与进度条比例，支持投票、更新与撤销，并在虚拟列表重挂载后持久保留状态。
- **模糊剧透（Spoilers）**：自动识别 `.spoiler` 内容并默认高斯模糊，点击或按 Enter/Space 展开，点击普通区域可重新隐藏；未展开前点击不会误触内部图片灯箱。
- **视频播放**：识别 Discourse 视频占位符，点击封面直接在弹窗内生成原生 `<video>` 播放器。
- **数学公式（KaTeX）**：自动渲染行内与块级 `.math` 公式（含 `\eqref`、`\ref`、`\label`），优先复用站点 KaTeX 资源，缺失时自动回退至 CDN。
- **表情选择器（Emoji Picker）**：回复框与 Boost 输入框均内置表情面板，支持分组切换、关键词搜索、最近使用记录及智能空格插入 `:emoji:`。
- **回复模板菜单**：回复框内置 `+` 模板按钮，一键插入「隐藏详细信息」（`[details]`）与「模糊剧透」（`[spoiler]`），且不再前端死卡 16 字限制（交由服务端按实际规则校验并返回具体原因）。
- **全类型粘贴上传 & 大图压缩 / 分片直传**：支持在回复框直接粘贴图片、动图、音频、视频或附件；超过 4MB 的图片/GIF 自动尝试转为 WebP，支持 S3 分片并发直传并在不支持分片的站点自动回退标准上传。
- **删除自己的回复**：本人发布的非首楼回复提供删除按钮，删除后即时替换为「（帖子已被作者删除）」占位。
- **等级标识、用户设备图标与双栏用户资料卡**：楼层头部内联显示 `Lv.X` 用户等级，并在其右侧展示官方 App 发帖/回复设备图标（iOS 手机图标与 Mac 桌面图标，悬停或点击提示 `回复自 …`）；点击头像、昵称、`@用户名` 或 Boost 气泡头像均可弹出双栏封面资料卡（含简介、阅读时长、最近活跃、帖子/主题/获赞统计、带图标徽章、关注/私信/免打扰设置），按住 Ctrl/Cmd 点击则直接在新标签页打开用户主页。
- **代码块复制、Base64 解码与原图灯箱**：弹窗代码块自动补齐一键复制按钮；选中 Base64 文本弹出浮动解码卡片；点击正文图片或信息条以原图打开灯箱。
- **保存到 Obsidian**：支持通过 Local REST API 静默写入或 Obsidian URI 将楼主首帖保存/更新为 Markdown 笔记。

## 安装

1. 安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开仓库中的 [`LinuxDo 增强阅读.user.js`](https://raw.githubusercontent.com/liansishen/linuxdo-read-script/main/LinuxDo%20%E5%A2%9E%E5%BC%BA%E9%98%85%E8%AF%BB.user.js) 触发安装。
3. 刷新 `https://linux.do` 或 `https://idcflare.com` 任意页面即可生效。

## 开发验证

```bash
pnpm install
pnpm run check
pnpm test
```

## 许可证与致谢

- [MIT License](./LICENSE)
- 上游项目：[fashionzzZ/linuxdo-read-script](https://github.com/fashionzzZ/linuxdo-read-script)
- 2.0 界面与虚拟流分支：[ywainzh/linuxdo-read-script](https://github.com/ywainzh/linuxdo-read-script)
- 第三方参考说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
