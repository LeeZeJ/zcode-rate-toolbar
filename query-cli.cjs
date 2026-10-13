/* query-cli.cjs — 一次性查询子进程入口（降级路径）。
 * 用法：ELECTRON_RUN_AS_NODE=1 ZCode.exe query-cli.cjs <sid1,sid2,...>
 * 输出：单行 JSON（与 querySessions 返回结构一致）。 */
"use strict";
const path = require("path");
const { openDb, querySessions, validSid } = require(path.join(__dirname, "query-lib.cjs"));

const arg = process.argv[2] || "";
const sids = String(arg)
  .split(",")
  .map((s) => s.trim())
  .filter(validSid)
  .slice(0, 8);

if (!sids.length) {
  process.stdout.write(JSON.stringify({ ts: Date.now(), sessions: {} }) + "\n");
  process.exit(0);
}

let db;
try {
  db = openDb();
} catch (e) {
  process.stderr.write("open db failed: " + e.message + "\n");
  process.stdout.write(JSON.stringify({ ts: Date.now(), sessions: {}, error: String(e.message) }) + "\n");
  process.exit(0);
}
try {
  process.stdout.write(JSON.stringify(querySessions(db, sids)) + "\n");
} catch (e) {
  process.stdout.write(JSON.stringify({ ts: Date.now(), sessions: {}, error: String(e.message) }) + "\n");
} finally {
  try {
    db.close();
  } catch (e) {}
}
