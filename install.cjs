/* install.cjs — ZCode 速率工具栏一键安装（零 npm 依赖，Node 18+）。
 * 用法：
 *   node install.cjs                        # 交互式：选择显示项、左/右位置，然后注入
 *   node install.cjs --show ttft,tps,e2e --pos right   # 免交互（默认：三项 + 靠右）
 *   node install.cjs --show ttft,tps,cache,in,out --pos left
 *   node install.cjs --asar "D:\...\app.asar"
 *   node install.cjs --remove               # 卸载（剥离 asar 注入行 + 可选删数据目录）
 *   node install.cjs --reconfig             # 只改显示项/位置（交互重选；当前配置为回车默认值）
 *
 * 显示项（show）：ttft 首字 / tps token/s / e2e 总耗时 / cache 缓存命中率 /
 *   in 本轮输入 token / out 本轮输出 token；默认只开前三项。位置（pos）默认 right。
 *
 * 做的事：
 *   1) 定位 ZCode 安装（--asar / 环境变量 ZCODE_ASAR / 常见目录探测，校验同级 ZCode.exe）；
 *   2) 把运行时（loader/overlay/query-lib/query-cli/patch/finalize.cmd）复制到
 *      数据目录 ~/.zcode/zcode-rate-toolbar/（升级 ZCode 不受影响，clone 目录可删）；
 *   3) 合并写入 config.json（保留已有 min_interval_ms 等设置）；
 *   4) 调 patch.cjs 注入 app.asar（幂等；运行中 Windows 原子替换通常直接成功，
 *      失败则留 .ratetb.tmp，退出 ZCode 后双击 finalize.cmd 收尾）。
 * 改配置（显示项/位置）以后随时可再跑 --reconfig 或直接编辑数据目录 config.json，
 * 下一次数据推送即热生效，无需重启 ZCode（新显示项 cache/in/out 需重启一次，
 * 因为主进程缓存了旧查询模块）。 */
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

/* 已实测支持的 ZCode 版本（app.asar 内 package.json 的 version）。
 * 其他版本理论可装（注入方式通用），但工具栏锚点选择器未验证。 */
const VERIFIED_VERSIONS = ["3.15.1"];

/* 读 app.asar 根 package.json 的 version（只读头部 + 一个小文件，秒级）。 */
function asarVersion(asar) {
  try {
    const f = fs.openSync(asar, "r");
    try {
      const b = Buffer.alloc(16);
      fs.readSync(f, b, 0, 16, null);
      if (b.readUInt32LE(0) !== 4) return null;
      const headerLen = b.readUInt32LE(12);
      const base = 8 + b.readUInt32LE(4);
      const hb = Buffer.alloc(headerLen);
      fs.readSync(f, hb, 0, headerLen, null);
      const pkg = JSON.parse(hb.toString("utf8")).files["package.json"];
      if (!pkg || pkg.unpacked) return null;
      const pb = Buffer.alloc(pkg.size);
      fs.readSync(f, pb, 0, pkg.size, base + Number(pkg.offset));
      return JSON.parse(pb.toString("utf8")).version || null;
    } finally {
      fs.closeSync(f);
    }
  } catch (e) {
    return null;
  }
}

/* ---------- 交互 ----------
 * 行队列式提问：rl.question 在「管道一次性送入多行 + await 分隔多次提问」时
 * 会丢行（第二行在第二个问题注册前就被消费），改为缓存行 + 等待者配对，
 * TTY 手输和管道/脚本输入都正确；EOF 时按空输入处理（= 用默认值）。 */
function makeAsker() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else lines.push(l);
  });
  rl.on("close", () => {
    closed = true;
    for (const w of waiters.splice(0)) w(undefined);
  });
  return {
    ask(question, { fallback } = {}) {
      return new Promise((resolve) => {
        const hint = fallback ? `（回车 = ${fallback}）` : "";
        process.stdout.write(question + hint + " ");
        const done = (l) => resolve(String(l == null ? "" : l).trim());
        const buffered = lines.shift();
        if (buffered !== undefined) done(buffered);
        else if (closed) done(undefined);
        else waiters.push(done);
      });
    },
    close: () => rl.close(),
  };
}

/* current：已有 config.json 的 show/pos（没有则用默认），作为回车默认值。 */
async function promptConfig(current) {
  const KEYS = ["ttft", "tps", "e2e", "cache", "in", "out"];
  const KEY2NUM = { ttft: "1", tps: "2", e2e: "3", cache: "4", in: "5", out: "6" };
  const NUM2KEY = { 1: "ttft", 2: "tps", 3: "e2e", 4: "cache", 5: "in", 6: "out" };
  const NAME = {
    ttft: "首字TTFT",
    tps: "token/s",
    e2e: "E2E",
    cache: "缓存命中率",
    in: "本轮输入",
    out: "本轮输出",
  };
  const VALID = ["1", "2", "3", "4", "5", "6"];
  const curShow = current && current.show ? current.show : { ttft: true, tps: true, e2e: true };
  const curPos = current && current.pos === "left" ? "left" : "right";
  const curNums = KEYS.filter((k) => curShow[k]).map((k) => KEY2NUM[k]);

  const ui = makeAsker();
  try {
    console.log("\n—— 显示项（多选，输入编号用逗号分隔；默认只开 1-3）——");
    console.log("  1. 首字 TTFT     2. token/s      3. E2E 总耗时");
    console.log("  4. 缓存命中率    5. 本轮输入 tok  6. 本轮输出 tok");
    let show;
    for (let i = 0; i < 3; i++) {
      const a = await ui.ask("选择要显示的项 [1-6，可多选，如 1,2,3]", {
        fallback: curNums.map((n) => NAME[NUM2KEY[n]]).join("+"),
      });
      if (!a) {
        show = curShow;
        break;
      }
      const picks = a
        .split(/[,\s，]+/)
        .map((s) => s.trim())
        .filter((s) => VALID.includes(s));
      if (picks.length) {
        show = {};
        for (const k of KEYS) show[k] = picks.includes(KEY2NUM[k]);
        break;
      }
      console.log("  没有有效编号，请重新输入。");
    }
    console.log("\n—— 位置 ——");
    console.log("  1. 靠左：「完全访问」右侧");
    console.log("  2. 靠右：「用量 / 模型选择」左侧（默认）");
    let pos;
    for (let i = 0; i < 3; i++) {
      const a = await ui.ask("选择位置 [1/2]", {
        fallback: curPos === "left" ? "1（靠左，保持现状）" : "2（靠右，保持现状）",
      });
      if (a === "2") {
        pos = "right";
        break;
      }
      if (a === "1") {
        pos = "left";
        break;
      }
      if (!a) {
        pos = curPos;
        break;
      }
      console.log("  请输入 1 或 2。");
    }
    return { show, pos };
  } finally {
    ui.close();
  }
}

function configFromArgs() {
  const show = { ttft: false, tps: false, e2e: false, cache: false, in: false, out: false };
  if (args.show !== undefined) {
    const wanted = String(args.show)
      .split(/[,\s，]+/)
      .map((s) => s.trim().toLowerCase());
    if (wanted.includes("ttft") || wanted.includes("1")) show.ttft = true;
    if (wanted.includes("tps") || wanted.includes("2")) show.tps = true;
    if (wanted.includes("e2e") || wanted.includes("3")) show.e2e = true;
    if (wanted.includes("cache") || wanted.includes("4")) show.cache = true;
    if (wanted.includes("in") || wanted.includes("5")) show.in = true;
    if (wanted.includes("out") || wanted.includes("6")) show.out = true;
    const on = Object.keys(show).filter((k) => show[k]);
    if (!on.length) throw new Error("--show 至少要选一项（ttft/tps/e2e/cache/in/out）");
  } else {
    Object.assign(show, { ttft: true, tps: true, e2e: true });
  }
  let pos = "right";
  if (args.pos) {
    if (args.pos !== "left" && args.pos !== "right") throw new Error("--pos 只能是 left 或 right");
    pos = args.pos;
  }
  return { show, pos };
}

/* ---------- config.json 合并 ---------- */
function readExistingConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8"));
  } catch (e) {
    return null;
  }
}

function writeConfig(cfgPatch) {
  const file = path.join(DATA, "config.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {}
  cfg.show = cfgPatch
    ? cfgPatch.show
    : Object.assign({ ttft: true, tps: true, e2e: true, cache: false, in: false, out: false }, cfg.show || {});
  if (cfgPatch) cfg.pos = cfgPatch.pos;
  else if (!cfg.pos) cfg.pos = "right";
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
  const ver = asarVersion(asar);
  const verNote = ver
    ? VERIFIED_VERSIONS.includes(ver)
      ? `（app 版本 ${ver}，已实测支持）`
      : `（app 版本 ${ver}，未实测——已实测版本：${VERIFIED_VERSIONS.join(" / ")}；装完若不显示见 README 排障）`
    : "";
  console.log("ZCode:", path.join(path.dirname(path.dirname(asar))), verNote);

  let cfgPatch = null;
  if (args.show !== undefined || args.pos !== undefined) {
    cfgPatch = configFromArgs();
    /* --reconfig 时没明确指定的部分保持现状，不悄悄重置为默认。 */
    if (args.reconfig) {
      const cur = readExistingConfig() || {};
      if (args.pos === undefined && cur.pos) cfgPatch.pos = cur.pos;
      if (args.show === undefined) {
        cfgPatch.show = Object.assign(
          { ttft: true, tps: true, e2e: true, cache: false, in: false, out: false },
          cur.show || {},
        );
      }
    }
  } else if (process.stdin.isTTY && !args.yes) {
    /* 交互选择：首次安装和 --reconfig 都走这里，当前配置作回车默认值。 */
    cfgPatch = await promptConfig(readExistingConfig());
  } else if (!args.reconfig) {
    cfgPatch = { show: { ttft: true, tps: true, e2e: true, cache: false, in: false, out: false }, pos: "right" };
  } else {
    console.log("非交互环境且未指定 --show/--pos，保持现有配置不变（改配置可加 --show tps --pos right）。");
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
      ["ttft", "tps", "e2e", "cache", "in", "out"]
        .filter((k) => cfg.show && cfg.show[k])
        .map((k) =>
          ({ ttft: "首字TTFT", tps: "token/s", e2e: "E2E", cache: "缓存命中率", in: "本轮输入", out: "本轮输出" }[k]),
        )
        .join(" + ") +
      "]，位置：" +
      (cfg.pos === "right" ? "靠右（模型选择左侧）" : "靠左（完全访问右侧）"),
  );

  if (args.reconfig) {
    console.log(
      "\n已更新配置。改显示项开关/位置约 1-2 秒热生效；但首次启用 cache/in/out" +
        " 这三个新指标需重启 ZCode 一次（主进程要加载新查询模块）。",
    );
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
    const ui = makeAsker();
    answer = await ui.ask("\n是否同时删除数据目录 " + DATA + "？[y/N]", { fallback: "n" });
    ui.close();
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
