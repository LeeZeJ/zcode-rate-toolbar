/* patch.cjs — ZCode app.asar 注入/卸载工具（速率工具栏，Node 实现，零依赖）。
 * 算法移植自开源 zcode-token-usage-statusbar 的 patch_install.py（实测可行）：
 * 只改 asar 主入口 out/main/index.js（ESM，package.json type:module）——
 * 尾部追加一行 dynamic import 指向本目录 loader.cjs；其余文件流式原样拷贝，
 * unpacked 标记原位保留（node-pty/ssh2 等 native 模块仍从 app.asar.unpacked 加载），
 * 仅对被改文件重算 SHA256 完整性。Electron fuse 无 sentinel（完整性校验关闭），
 * 改动后的 asar 可正常加载。
 *
 * 用法：
 *   node patch.cjs install [asar路径]   # 注入/重定向（幂等，自动替换旧注入行）
 *   node patch.cjs remove  [asar路径]   # 剥离注入行
 *   node patch.cjs check   [asar路径]   # 检查注入状态
 * 客户端运行中：Windows 下 rename 原子替换通常直接成功（运行中进程继续读旧数据），
 * 失败则保留 .ratetb.tmp 并提示退出后执行 finalize（本脚本 install 即 finalize）。 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { execFileSync } = require("child_process");

const RUNTIME = __dirname;
const LOADER = path.join(RUNTIME, "loader.cjs");
const DEFAULT_ASAR = "D:\\Program Files\\ZCode\\resources\\app.asar";
const ENTRY = "/out/main/index.js";
const ALIGN = 4;
const BLOCK = 4194304;

const INJECT_LINE =
  '\n;import("' +
  pathToFileURL(LOADER).href +
  '").then(() => null, (e) => console.error("[rate-tb] load failed", e));';
const LINE_RE =
  /\n;import\("[^"]*zcode-rate-toolbar[^"]*loader\.cjs"\)\.then\(\(\) => null, \(e\) => console\.error\("\[rate-tb\] load failed", e\)\);/g;

function readHeader(f) {
  f.seek(0);
  const prefix = f.read(16);
  const a = prefix.readUInt32LE(0);
  const b = prefix.readUInt32LE(4);
  const c = prefix.readUInt32LE(8);
  const d = prefix.readUInt32LE(12);
  if (a !== 4) throw new Error("unexpected pickle prefix " + a);
  const header = JSON.parse(f.read(d, "utf8"));
  return { header, base: 8 + b };
}

function iterFiles(node, p, out) {
  for (const name of Object.keys(node.files || {})) {
    const ch = node.files[name];
    const cp = p + "/" + name;
    if (ch.files) iterFiles(ch, cp, out);
    else out.set(cp, ch);
  }
}

function computeIntegrity(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK) {
    blocks.push(crypto.createHash("sha256").update(buf.subarray(i, i + BLOCK)).digest("hex"));
  }
  return {
    algorithm: "SHA256",
    hash: crypto.createHash("sha256").update(buf).digest("hex"),
    blockSize: BLOCK,
    blocks,
  };
}

function repack(srcPath, modify, dstPath) {
  const f = fs.openSync(srcPath, "r");
  try {
    const { header, base } = readHeader({ seek: () => {}, read: (n, enc) => {
      const b = Buffer.alloc(n);
      fs.readSync(f, b, 0, n, null);
      if (enc) return b.toString(enc);
      return b;
    }, });
    const nodes = new Map();
    iterFiles(header, "", nodes);
    for (const p of Object.keys(modify)) {
      if (!nodes.has(p)) throw new Error("path not in asar: " + p);
    }

    const parts = [];
    let offset = 0;
    for (const [p, node] of nodes) {
      if (node.unpacked) {
        node.offset = "0";
        continue;
      }
      let data;
      if (Object.prototype.hasOwnProperty.call(modify, p)) {
        data = modify[p];
        node.size = data.length;
        node.integrity = computeIntegrity(data);
      } else {
        const buf = Buffer.alloc(node.size);
        fs.readSync(f, buf, 0, node.size, base + Number(node.offset));
        data = buf;
      }
      node.offset = String(offset);
      parts.push(data);
      offset += data.length;
    }

    const payload = Buffer.concat(parts);
    const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    const d = headerBytes.length;
    const c = Math.ceil((d + 4 + ALIGN - 1) / ALIGN) * ALIGN;
    const bTotal = c + 4;
    const out = fs.openSync(dstPath, "w");
    try {
      const prefix = Buffer.alloc(16);
      prefix.writeUInt32LE(4, 0);
      prefix.writeUInt32LE(bTotal, 4);
      prefix.writeUInt32LE(c, 8);
      prefix.writeUInt32LE(d, 12);
      fs.writeSync(out, prefix);
      fs.writeSync(out, headerBytes);
      fs.writeSync(out, Buffer.alloc(c - d - 4));
      fs.writeSync(out, payload);
    } finally {
      fs.closeSync(out);
    }
  } finally {
    fs.closeSync(f);
  }
}

function entryBytes(asarPath) {
  const f = fs.openSync(asarPath, "r");
  try {
    const fake = {
      seek: () => {},
      read: (n, enc) => {
        const b = Buffer.alloc(n);
        fs.readSync(f, b, 0, n, null);
        return enc ? b.toString(enc) : b;
      },
    };
    const { header, base } = readHeader(fake);
    const nodes = new Map();
    iterFiles(header, "", nodes);
    const node = nodes.get(ENTRY);
    if (!node) throw new Error("entry missing");
    const buf = Buffer.alloc(node.size);
    fs.readSync(f, buf, 0, node.size, base + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(f);
  }
}

function selfCheck(asarPath, expectInjected) {
  const f = fs.openSync(asarPath, "r");
  let count = 0;
  try {
    const fake = {
      seek: () => {},
      read: (n, enc) => {
        const b = Buffer.alloc(n);
        fs.readSync(f, b, 0, n, null);
        return enc ? b.toString(enc) : b;
      },
    };
    const { header } = readHeader(fake);
    const nodes = new Map();
    iterFiles(header, "", nodes);
    count = nodes.size;
  } finally {
    fs.closeSync(f);
  }
  const has = entryBytes(asarPath).includes(Buffer.from(INJECT_LINE));
  const ok = has === expectInjected;
  console.log("  [check] files=" + count + ", injection " + (has ? "present" : "absent") + " (" + (ok ? "ok" : "UNEXPECTED") + ")");
  return ok;
}

function syntaxCheck(asarPath) {
  const exe = path.join(path.dirname(path.dirname(asarPath)), "ZCode.exe");
  if (!fs.existsSync(exe)) {
    console.log("  [check] ZCode.exe not found; syntax check skipped");
    return true;
  }
  const tmp = path.join(RUNTIME, ".entry-check.mjs");
  fs.writeFileSync(tmp, entryBytes(asarPath));
  try {
    const r = execFileSync(exe, ["--check", tmp], {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch (e) {
    console.log("  [check] syntax FAILED: " + String(e.stderr || e.message).slice(0, 300));
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {}
  }
}

function install(asar) {
  if (!fs.existsSync(LOADER)) throw new Error("loader missing: " + LOADER);
  const tmp = path.join(path.dirname(asar), "app.asar.ratetb.tmp");
  const entry = entryBytes(asar);
  const stripped = entry.toString("utf8").replace(LINE_RE, "");
  if (stripped + INJECT_LINE === entry.toString("utf8")) {
    console.log("Already installed; injection line points at current directory.");
    return true;
  }
  const newEntry = Buffer.from(stripped + INJECT_LINE, "utf8");
  console.log("Repacking (~325MB, tens of seconds)...");
  repack(asar, { [ENTRY]: newEntry }, tmp);
  console.log("Self-check:");
  if (!selfCheck(tmp, true) || !syntaxCheck(tmp)) {
    console.log("Self-check FAILED; not replaced. TMP kept:", tmp);
    return false;
  }
  try {
    fs.renameSync(tmp, asar);
    console.log("Replaced. Restart ZCode to activate the toolbar metrics.");
    return true;
  } catch (e) {
    console.log("Replace failed (" + e.message + ").");
    console.log("Quit ZCode completely, then re-run: node patch.cjs install");
    console.log("TMP kept for finalize:", tmp);
    return false;
  }
}

function remove(asar) {
  const tmp = path.join(path.dirname(asar), "app.asar.ratetb.tmp");
  const entry = entryBytes(asar).toString("utf8");
  const stripped = entry.replace(LINE_RE, "");
  if (stripped === entry) {
    console.log("Not injected.");
    return true;
  }
  console.log("Repacking (stripping injection line)...");
  repack(asar, { [ENTRY]: Buffer.from(stripped, "utf8") }, tmp);
  console.log("Self-check:");
  if (!selfCheck(tmp, false) || !syntaxCheck(tmp)) {
    console.log("Self-check FAILED; not replaced. TMP kept:", tmp);
    return false;
  }
  try {
    fs.renameSync(tmp, asar);
    console.log("Injection line stripped. Restart ZCode to take effect.");
    return true;
  } catch (e) {
    console.log("Replace failed (" + e.message + "). Quit ZCode then re-run remove.");
    return false;
  }
}

function check(asar) {
  const injected = LINE_RE.test(entryBytes(asar).toString("utf8"));
  console.log("asar:", asar, fs.statSync(asar).size, "bytes");
  console.log("injection:", injected ? "present" : "absent");
  const tmp = path.join(path.dirname(asar), "app.asar.ratetb.tmp");
  if (fs.existsSync(tmp)) console.log("pending TMP:", tmp, "(quit ZCode, run install to finalize)");
}

const cmd = process.argv[2] || "check";
const asar = process.argv[3] || DEFAULT_ASAR;
if (!fs.existsSync(asar)) {
  console.error("asar not found:", asar);
  process.exit(1);
}
({ install, remove, check }[cmd] || check)(asar);
