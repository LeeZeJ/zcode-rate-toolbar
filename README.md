# zcode-rate-toolbar · ZCode 工具栏速率指标

在 [ZCode](https://z.ai) 桌面客户端输入框工具栏里，像 Codex 一样显示三项速率指标：

```
首字 2.5s · 84.5 tok/s · E2E 1m23s
```

- **首字 (TTFT)** — 最近一次主链路模型请求的首 token 延迟
- **token/s** — 最近一次完成请求的生成速度（输出 tokens ÷ 首 token 到完成的秒数）
- **E2E (总耗时)** — 最近一个已完成回合的端到端总耗时（不跳动，一轮回答完整出来才更新）

**显示哪些项、靠左还是靠右，安装时自己选**，之后随时一条命令改配置（热生效，无需重启）：

```
靠左（默认）                              靠右
[+][完全访问] 首字·tok/s·E2E  [◯][GLM-5.3]   [+][完全访问]  [首字·tok/s·E2E][◯][GLM-5.3]
```

鼠标悬停可看明细：模型名、整请求耗时、生成段耗时、输出 token 数、本轮请求/工具次数、本轮输入/输出 token。

## 特点

| | 说明 |
| --- | --- |
| 🎯 **精确** | 指标读 ZCode 自己落盘的 SQLite 统计表（`turn_usage` / `model_usage`），不是从 DOM 猜 |
| 🔧 **可定制** | 显示项（TTFT / token/s / E2E）逐项开关，位置靠左（「完全访问」右侧）或靠右（「模型选择」左侧） |
| 🪶 **轻量** | 零 npm 依赖、零构建；正常启动 ZCode 即生效（无需专门启动器） |
| ⚡ **触发式** | fs.watch 监听 db 写入才查询，空闲零查询零轮询；只读、纯本地、不联网 |
| 🖥️ **多窗口** | 各窗口跟随自己的焦点会话，互不串显 |
| 🎨 **跟随主题** | 颜色引用客户端 CSS 变量，深浅主题自动适配；窗口过窄时先于原生控件收起 |

## 环境要求

- Windows 10/11（macOS/Linux 理论可行，未实测）
- Node.js ≥ 18（仅安装/卸载时用；运行时走 ZCode 自带 Node）
- ZCode 桌面版（Electron 应用；fuse 无完整性校验，实测 3.15.x 可改 asar）

## 快速开始

```bash
git clone https://github.com/LeeZeJ/zcode-rate-toolbar.git
cd zcode-rate-toolbar
node install.cjs
```

交互两步：选显示项（1 首字 / 2 token/s / 3 E2E，多选）→ 选位置（1 靠左 / 2 靠右）。
脚本自动定位 ZCode、复制运行时到 `~/.zcode/zcode-rate-toolbar/`、注入 `app.asar`。

- ZCode 未运行：直接替换成功，启动即见
- ZCode 运行中：Windows 原子替换通常直接成功，重启 ZCode 生效；
  失败则留 `app.asar.ratetb.tmp`，完全退出 ZCode 后双击 `finalize.cmd` 收尾

免交互：

```bash
node install.cjs --show ttft,tps,e2e --pos left   # 全三项，靠左
node install.cjs --show tps,e2e --pos right       # 只看速度和总耗时，靠右
node install.cjs --asar "C:\...\ZCode\resources\app.asar"   # 手动指定安装位置
```

## 改配置（已装用户）

```bash
node install.cjs --reconfig        # 交互重选显示项/位置
```

或直接编辑 `~/.zcode/zcode-rate-toolbar/config.json`：

```json
{
  "show": { "ttft": true, "tps": true, "e2e": true },
  "pos": "left",
  "min_interval_ms": 900,
  "heartbeat_ms": 15000,
  "hot_reload": true
}
```

改完约 1–2 秒热生效，无需重启。

## ZCode 升级之后

官方升级会覆盖 `app.asar`，指标消失属正常。重跑一次即可（数据目录不受影响）：

```bash
node install.cjs          # 或保持原选项：node install.cjs --show tps,e2e --pos right
```

## 卸载

```bash
node install.cjs --remove
```

只剥离本工具注入行，不影响官方文件其它内容，也不影响其它注入工具。重启 ZCode 生效。

## 工作原理

```
app.asar 主入口尾部 1 行 dynamic import（patch.cjs 注入，幂等可剥离）
  └─ loader.cjs（主进程，常驻）
       ├─ did-finish-load → 向每个窗口注入 overlay.js
       ├─ ipcMain 监听 "zcode:sync-active-task-session"（客户端自带通道）
       │    → 每窗口焦点会话 id（多窗口各显各的）
       ├─ fs.watch ~/.zcode/cli/db/ → db.sqlite/-wal 一有写入（去抖 300ms）
       │    → 只读查询（优先主进程内 node:sqlite，失败降级
       │      ELECTRON_RUN_AS_NODE 子进程）→ 推送 window.__rateUpdate
       └─ 推送附带 config.json 的 show/pos，配置热生效
  └─ overlay.js（渲染端，自包含 IIFE）
       ├─ 靠左：追加到 [data-composer-leading-actions] 末尾
       │  靠右：插到 [data-composer-trailing-actions] 最前
       ├─ 会话归属：composer 祖先 data-session-id
       └─ 带 data-composer-collapse-priority=4，参与客户端工具栏空间收纳
```

数据口径（全部只读本地库，不联网）：

- `model_usage`（每次模型请求完成落一行）：`time_to_first_token_ms` = 首字；
  token/s = `output_tokens` ÷ (`completed_at` − `first_token_at`)，缺首字时间退化为
  ÷ `duration_ms`；只统计 `query_source='main_turn'`（子代理不抢显示）
- `turn_usage`（每轮完成落一行）：`duration_ms` = E2E 权威值；请求数/工具数/token 数进悬停明细
- TTFT/token/s 在每次请求完成后 ~1s 内刷新；E2E 在回合完整结束后 ~1s 内更新

## 与同类项目的区别

- [zcode-token-usage-statusbar](https://github.com/xhwxt/zcode-token-usage-statusbar)：
  悬浮在窗口最底部的**用量**条（上下文容量/今日合计/子代理等，功能很全）。
  本项目是**嵌进工具栏**的速率指标，位置/显示项可选。两者可共存（注入行互不干扰）。
- [zcode-statusbar](https://github.com/xyqmbyl/zcode-statusbar)：输入框下方的浮动统计条，
  CDP 注入、每次要用带 `--remote-debugging-port` 的启动器启动。本项目打进 asar 一次，
  之后正常启动 ZCode 即生效；代价是官方升级后需重跑 install。

感谢前两个项目验证了 asar 注入与 SQLite 数据口径的可行性。

## 排障

1. **指标不显示**：看 `~/.zcode/zcode-rate-toolbar/loader.log` 有无
   `rate-tb loader v2 active`；没有 = 注入未生效（`node patch.cjs check` 确认）或没重启
2. **显示但数值是 –**：该会话尚无已完成的模型请求（新会话首轮进行中即如此）
3. **改 overlay.js 想立即生效**：默认 `hot_reload: true`，约 2 秒热更新
4. **查询过频/过疏**：调 `config.json` 的 `min_interval_ms` / `heartbeat_ms`
5. **升级后工具栏布局改了**（锚点失效）：DevTools 检查 `[data-composer-leading-actions]`
   是否存在，改 `overlay.js` 的 `scan()` 选择器（热更新即时生效）

## License

[MIT](LICENSE)
