/* install.cjs — ZCode 速率工具栏一键安装（零 npm 依赖，Node 18+）。
 * 用法：
 *   node install.cjs                        # 交互式：选择显示项、左/右位置，然后注入
 *   node install.cjs --show ttft,tps,e2e --pos left   # 免交互
 *   node install.cjs --show tps --pos right --asar "D:\...\app.asar"
 *   node install.cjs --remove               # 卸载（剥离 asar 注入行 + 可选删数据目录）
 *   node install.cjs --reconfig             # 只改显示项/位置（已装用户改配置用）
 *
 * 做的事：
 *   1) 定位 ZCode 安装（--asar / 环境变量 ZCODE_ASAR / 常见目录探测，校验同级 ZCode.exe）；
 *   2) 把运行时（loader/overlay/query-lib/query-cli/patch/finalize.cmd）复制到
 *      数据目录 ~/.zcode/zcode-rate-toolbar/（升级 ZCode 不受影响，clone 目录可删）；
 *   3) 合并写入 config.json（保留已有 min_interval_ms 等设置）；
 *   4) 调 patch.cjs 注入 app.asar（幂等；运行中 Windows 原子替换通常直接成功，
 *      失败则留 .ratetb.tmp，退出 ZCode 后双击 finalize.cmd 收尾）。
 * 改配置（显示项/位置）以后随时可再跑 --reconfig 或直接编辑数据目录 config.json，
 * 下一次数据推送即热生效，无需重启 ZCode。 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

const SRC = __dirname;
const DATA = path.join(os.homedir(), ".zcode", "zcode-rate-toolbar");
const RUNTIME_FILES = [
  "loader.cjs",
  "overlay.js",
  "query-lib.cjs",
  "query-cli.cjs",
  "patch.cjs",
  "finalize.cmd",
];

/* ---------- 参数 ---------- */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--remove") out.remove = true;
    else if (a === "--reconfig") out.reconfig = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--show") out.show = argv[++i];
    else if (a === "--pos") out.pos = argv[++i];
    else if (a === "--asar") out.asar = argv[++i];
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/* ---------- 探测 ZCode 安装 ---------- */
function candidateAsars() {
  const list = [];
  if (process.env.ZCODE_ASAR) list.push(process.env.ZCODE_ASAR);
  const roots = [
    "D:\\Program Files\\ZCode",
    "C:\\Program Files\\ZCode",
    path.join(os.homedir(), "AppData", "Local", "Programs", "ZCode"),
  ];
  for (const r of roots) list.push(path.join(r, "resources", "app.asar"));
  return list;
}
function looksLikeZcode(asar) {
  const dir = path.dirname(asar);
  if (fs.existsSync(path.join(dir, "..", "ZCode.exe"))) return true;
  if (fs.existsSync(path.join(dir, "..", "zcode"))) return true; // Linux/macOS 可执行名
  return false;
}
function detectAsar() {
  if (args.asar) {
    if (!fs.existsSync(args.asar)) throw new Error("指定的 asar 不存在: " + args.asar);
    return args.asar;
  }
  for (const c of candidateAsars()) {
    if (fs.existsSync(c) && looksLikeZcode(c)) return c;
  }
  for (const c of candidateAsars()) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    "未找到 ZCode 的 app.asar。用 --asar <路径> 指定，或设置环境变量 ZCODE_ASAR。" +
      "（常见位置：D:\\Program Files\\ZCode\\resources\\app.asar）",
  );
}

/* ---------- 交互 ---------- */
async function ask(rl, question, { fallback } = {}) {
  return new Promise((resolve) => {
    const hint = fallback ? `（回车 = ${fallback}）` : "";
    rl.question(question + hint + " ", (answer) => resolve((answer || "").trim()));
  });
}

async function promptConfig() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\n—— 显示项（多选，输入编号用逗号分隔）——");
    console.log("  1. 首字 TTFT   2. token/s   3. E2E 总耗时");
    let show;
    for (let i = 0; i < 3; i++) {
      const a = await ask(rl, "选择要显示的项 [1-3，可多选，如 1,2,3]", { fallback: "1,2,3（全部）" });
      const picks = a
        .split(/[,\s，]+/)
        .map((s) => s.trim())
        .filter((s) => ["1", "2", "3"].includes(s));
      if (picks.length) {
        show = picks;
        break;
      }
      if (!a) {
        show = ["1", "2", "3"];
        break;
      }
      console.log("  没有有效编号，请重新输入。");
    }
    console.log("\n—— 位置 ——");
    console.log("  1. 靠左：「完全访问」右侧（默认）");
    console.log("  2. 靠右：「用量 / 模型选择」左侧");
    let pos;
    for (let i = 0; i < 3; i++) {
      const a = await ask(rl, "选择位置 [1/2]", { fallback: "1（靠左）" });
      if (a === "2") {
        pos = "right";
        break;
      }
      if (!a || a === "1") {
        pos = "left";
        break;
      }
      console.log("  请输入 1 或 2。");
    }
    return { show, pos };
  } finally {
    rl.close();
  }
}

function configFromArgs() {
  const show = { ttft: false, tps: false, e2e: false };
  if (args.show !== undefined) {
    const wanted = String(args.show)
      .split(/[,\s，]+/)
      .map((s) => s.trim().toLowerCase());
    if (wanted.includes("ttft") || wanted.includes("1")) show.ttft = true;
    if (wanted.includes("tps") || wanted.includes("2")) show.tps = true;
    if (wanted.includes("e2e") || wanted.includes("3")) show.e2e = true;
    if (!show.ttft && !show.tps && !show.e2e) throw new Error("--show 至少要选一项（ttft/tps/e2e）");
  } else {
    Object.assign(show, { ttft: true, tps: true, e2e: true });
  }
  let pos = "left";
  if (args.pos) {
    if (args.pos !== "left" && args.pos !== "right") throw new Error("--pos 只能是 left 或 right");
    pos = args.pos;
  }
  return { show, pos };
}

/* ---------- config.json 合并 ---------- */
function writeConfig(cfgPatch) {
  const file = path.join(DATA, "config.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {}
  cfg.show = cfgPatch ? cfgPatch.show : cfg.show || { ttft: true, tps: true, e2e: true };
  if (cfgPatch) cfg.pos = cfgPatch.pos;
  else if (!cfg.pos) cfg.pos = "left";
  if (!cfg.min_interval_ms) cfg.min_interval_ms = 900;
  if (!cfg.heartbeat_ms) cfg.heartbeat_ms = 15000;
  if (cfg.hot_reload === undefined) cfg.hot_reload = true;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return cfg;
}

/* ---------- 主流程 ---------- */
async function main() {
  if (args.remove) return await doRemove();

  const asar = detectAsar();
  console.log("ZCode:", path.join(path.dirname(path.dirname(asar))));

  let cfgPatch = null;
  if (args.show !== undefined || args.pos !== undefined) {
    cfgPatch = configFromArgs();
  } else if (!args.reconfig) {
    if (process.stdin.isTTY && !args.yes) {
      cfgPatch = await promptConfig();
    } else {
      cfgPatch = { show: { ttft: true, tps: true, e2e: true }, pos: "left" };
    }
  }

  /* 复制运行时到数据目录（源目录之后可删）。 */
  fs.mkdirSync(DATA, { recursive: true });
  for (const f of RUNTIME_FILES) {
    const src = path.join(SRC, f);
    if (!fs.existsSync(src)) throw new Error("缺少运行时文件: " + src);
    fs.copyFileSync(src, path.join(DATA, f));
  }
  const cfg = writeConfig(cfgPatch);
  console.log(
    "配置：显示 [" +
      ["ttft", "tps", "e2e"]
        .filter((k) => cfg.show && cfg.show[k])
        .map((k) => ({ ttft: "首字TTFT", tps: "token/s", e2e: "E2E" }[k]))
        .join(" + ") +
      "]，位置：" +
      (cfg.pos === "right" ? "靠右（模型选择左侧）" : "靠左（完全访问右侧）"),
  );

  if (args.reconfig) {
    console.log("\n已更新配置。ZCode 正在运行的话约 1-2 秒热生效；未运行则下次启动生效。");
    return;
  }

  console.log("\n注入 app.asar ...");
  const r = execFileSync(process.execPath, [path.join(DATA, "patch.cjs"), "install", asar], {
    stdio: "inherit",
  });
  console.log(
    "\n完成。重启 ZCode 后，输入框工具栏即出现速率指标。\n" +
      "以后想改显示项/位置：node install.cjs --reconfig（交互选择），或直接编辑\n" +
      DATA + "\\config.json —— 热生效，无需重启。\n" +
      "ZCode 官方升级后指标消失属正常，重跑 node install.cjs 即可。",
  );
}

async function doRemove() {
  const asar = detectAsar();
  console.log("剥离 asar 注入行 ...");
  const patch = path.join(DATA, "patch.cjs");
  if (fs.existsSync(patch)) {
    execFileSync(process.execPath, [patch, "remove", asar], { stdio: "inherit" });
  } else {
    console.log("数据目录里没有 patch.cjs，跳过 asar 剥离（可能从未安装过）。");
  }
  let answer = "n";
  if (process.stdin.isTTY && !args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    answer = await ask(rl, "\n是否同时删除数据目录 " + DATA + "？[y/N]", { fallback: "n" });
    rl.close();
  }
  if (/^y(es)?$/i.test(answer) || args.yes) {
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log("数据目录已删除。");
  } else {
    console.log("数据目录保留（" + DATA + "），下次 node install.cjs 可直接复用。");
  }
  console.log("重启 ZCode 后恢复原样。");
}

main().catch((e) => {
  console.error("\n[install] 失败:", e.message);
  process.exit(1);
});
