# agy-monitor

**专为 Google Antigravity IDE 打造的侧边栏与双栖实时用量 / 吐字速率监控插件。**

> 本项目基于 [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor)（`v1.4.5`）二次开发，遵循 **GPL-3.0-only** 开源协议。  
> **界面语言说明**：当前插件 UI 界面（侧边栏面板、顶栏胶囊、设置项等）**仅支持简体中文**。

---

## 界面预览

![界面预览](./preview.png)

> 如需替换预览截图，只需将你的截图重命名为 `preview.png` 并放置于仓库根目录即可。

---

## 核心功能亮点

### 本仓库新增与强化能力
- **输入框下方极简实时吐字速率浮标**：在主聊天输入框正下方右侧轻量展示当前速率（如 `156 tok/s`），无点击拦截，不遮挡操作。
  - **流式生成中**：亮起绿色呼吸点，基于 `3.5s` 滑动窗口实时估算当前吐字速度（带 EMA 平滑与缓冲毛刺收敛）；
  - **生成完成后**：自动切换为扣除原生首字延迟（TTFT）后的**纯解码吐字速率（Decode TPS）**，同时跳过 `< 1.0s` 短缓冲工具调用导致的 1000+ tok/s 假峰值，且不破坏原面板的端到端测速统计口径。

### 完整监控能力
- **实时速度与延迟监控**：精准追踪端到端输出速度（TPS）、首字延迟（TTFT）、会话有效平均速度与单步 / 累计折算费用。
- **十维上下文窗口占用拆解**：实时分析模型回复、工具结果、用户消息、子代理通知、压缩摘要、系统提示词、系统工具、MCP 工具、Skill 与用户规则的占比变化。
- **多池模型可用额度追踪**：同步展示 `Gemini`、`Gemini 4 Argon`、`Gemini 4 Carbon` 与 `Claude & GPT` 模型池的 5 小时限额、每周限额及重置倒计时。
- **14 天用量趋势与费用统计**：支持按今日、1 天、7 天、14 天、30 天、全部或自定义区间统计总 Token、缓存命中率、缓存节省金额、用量趋势曲线及分模型排行。
- **主代理与子代理独立追踪**：支持全部汇总或按主/子代理分别查看调用明细与上下文窗口。
- **双栖无侵入挂载**：同时支持右上角顶栏胶囊悬浮面板与右侧辅助栏展开，全程不修改宿主 `app.asar`。

---

## 前置依赖说明

- **完全独立运行，不需要提前安装或运行原版 Token Monitor。**
- **无需打包 `.vsix`，零第三方 `npm` 依赖，无需执行 `npm install`。**
- 插件通过 Google Antigravity 宿主自动注入的本地 Language Server Connect RPC（`ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN`）及本地 `~/.gemini/antigravity/` 会话轨迹文件获取数据，仅依赖 Google Antigravity IDE 自带的 Node.js 运行时。
- 本仓库已内置编译好的前端静态资源（`sidecars/panel/app.js` 与 `sidecars/panel/styles.css`），拉取后即可直接启用；默认关闭自动与弹窗更新提醒（可在 **偏好设置 -> 版本更新** 中随时开启）。

---

## 保姆级安装与使用步骤

> 这是一个 **Google Antigravity 原生插件**（由根目录 `plugin.json` 与 `sidecars/panel/sidecar.json` 驱动），**不是 VS Code `.vsix` 扩展**，直接放到 Antigravity 插件目录即可生效。

### 第 1 步：下载插件到 Antigravity 插件目录

#### 方式 A：使用 Git 克隆（推荐）

**Windows（PowerShell）：**
```powershell
$pluginsDir = "$env:USERPROFILE\.gemini\config\plugins"
New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
git clone https://github.com/llcc-bit/agy-monitor.git "$pluginsDir\agy-monitor"
```

**macOS / Linux：**
```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/llcc-bit/agy-monitor.git ~/.gemini/config/plugins/agy-monitor
```

#### 方式 B：直接下载 ZIP 压缩包（未装 Git 时可用）

1. 在本仓库页面点击 **Code -> Download ZIP**（或前往 Releases 下载压缩包）。
2. 将压缩包解压后重命名文件夹为 `agy-monitor`，确保文件夹内直接包含 `plugin.json`。
3. 把整个 `agy-monitor` 文件夹放到：
   - **Windows**：`C:\Users\<你的用户名>\.gemini\config\plugins\agy-monitor`
   - **macOS / Linux**：`~/.gemini/config/plugins/agy-monitor`

### 第 2 步：在 Antigravity 中启用

1. 打开 Google Antigravity IDE，进入左侧边栏 **Customizations** -> **Installed**。
2. 找到 **`AGY Monitor`**（`agy-monitor`），打开启用开关；若已在运行且更新了代码，关闭后重新开启一次即可热重载。
3. **打开面板方式**：
   - **顶部栏双栖悬浮模式（默认开启）**：右上角顶部栏会自动出现实时状态胶囊，悬停查看速览，左键点击展开完整监控面板，主聊天输入框右下角会同步展示实时速率。
   - **右侧辅助栏**：点击窗口右上角 `⋮` -> **Extensions** -> **用量监控**。
   - **快捷唤起**：直接在对话中输入「打开用量监控面板」。

---

## 本地开发与测试

如果你修改了 `sidecars/panel/src/` 下的前端代码，需要在 `sidecars/panel` 目录重新编译静态资源后再重载插件：

```powershell
cd sidecars/panel

# 重新打包前端 app.js 与 styles.css
node scripts/build-bundle.mjs

# 运行全部单元测试（零额外依赖）
node --test test/*.test.mjs
```

> 提示：在开启严格执行策略的 Windows PowerShell 环境中若 `npm test` 受限，直接使用上述 `node` 命令即可正常运行。

---

## 开源协议与致谢

- 本项目基于 [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor) 二次开发，特此向原作者 `yuhuan-dev` 致谢。
- 依据上游许可证要求，本项目继续完整遵循 **GNU General Public License v3.0 only (`GPL-3.0-only`)** 开源，详见 [LICENSE](./LICENSE)。
