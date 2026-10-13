/* query-lib.cjs — ZCode 速率工具栏数据查询（共享库）。
 * 数据源：~/.zcode/cli/db/db.sqlite（只读）。
 *   model_usage  —— 每次模型请求一行（完成时落库）：
 *     time_to_first_token_ms（首字）、duration_ms、output_tokens、
 *     first_token_at / completed_at（用于生成段耗时 = 完成减首字）。
 *   turn_usage   —— 每轮对话一行（完成时落库）：duration_ms（E2E 权威值）、
 *     time_to_first_token_ms、model_request_count 等。
 * 口径与开源 zcode-token-usage-statusbar 项目一致：
 *   token/s = output_tokens ÷ 生成段耗时（首 token 之后到完成；缺 first_token_at
 *   时退化为整请求 duration_ms，与上游 calculateOutputTps 相同）。 */
"use strict";
const os = require("os");
const path = require("path");

function dbPath() {
  return path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
}

/* 打开只读连接；WAL 下多读者安全。失败抛异常由调用方降级。 */
function openDb() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(dbPath(), { readOnly: true });
}

function validSid(s) {
  return typeof s === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(s);
}

/* 生成段毫秒：优先 completed_at - first_token_at，退化 duration_ms。 */
function genMs(row) {
  if (row && row.first_token_at && row.completed_at && row.completed_at > row.first_token_at) {
    return row.completed_at - row.first_token_at;
  }
  if (row && row.duration_ms > 0) return row.duration_ms;
  return 0;
}

function tpsOf(row) {
  if (!row) return null;
  const g = genMs(row);
  if (!g || !Number.isFinite(row.output_tokens) || row.output_tokens <= 0) return null;
  const t = (row.output_tokens * 1000) / g;
  return Number.isFinite(t) ? Math.round(t * 10) / 10 : null;
}

/* 查询一批会话；返回 { ts, sessions: { sid: snapshot } }。
 * snapshot.turn —— 最近一轮（任意状态，完成时才有行）
 * snapshot.last —— 最近一次已完成的主链路模型请求（query_source='main_turn'，
 *                  排除子代理/后台请求抢走工具栏显示） */
function querySessions(db, sids) {
  const turnStmt = db.prepare(
    "select turn_id, status, started_at, first_model_start_at, first_token_at, completed_at," +
      " duration_ms, time_to_first_token_ms, model_request_count, tool_call_count," +
      " input_tokens, output_tokens from turn_usage where session_id=? order by started_at desc limit 1",
  );
  const lastStmt = db.prepare(
    "select model_id, status, started_at, first_token_at, completed_at, duration_ms," +
      " time_to_first_token_ms, output_tokens from model_usage" +
      " where session_id=? and query_source='main_turn' order by completed_at desc limit 1",
  );
  const sessions = {};
  for (const sid of sids) {
    if (!validSid(sid)) continue;
    const turn = turnStmt.get(sid) || null;
    const last = lastStmt.get(sid) || null;
    const tps = tpsOf(last);
    const ttftMs =
      last && Number.isFinite(last.time_to_first_token_ms) && last.time_to_first_token_ms > 0
        ? last.time_to_first_token_ms
        : turn && Number.isFinite(turn.time_to_first_token_ms) && turn.time_to_first_token_ms > 0
          ? turn.time_to_first_token_ms
          : null;
    sessions[sid] = {
      turn: turn
        ? {
            status: turn.status,
            startedAt: turn.started_at,
            firstTokenAt: turn.first_token_at,
            completedAt: turn.completed_at,
            durationMs: turn.duration_ms,
            ttftMs: turn.time_to_first_token_ms > 0 ? turn.time_to_first_token_ms : null,
            requests: turn.model_request_count,
            tools: turn.tool_call_count,
            inputTokens: turn.input_tokens,
            outputTokens: turn.output_tokens,
          }
        : null,
      last: last
        ? {
            model: last.model_id,
            startedAt: last.started_at,
            firstTokenAt: last.first_token_at,
            completedAt: last.completed_at,
            durationMs: last.duration_ms,
            ttftMs: last.time_to_first_token_ms > 0 ? last.time_to_first_token_ms : null,
            outputTokens: last.output_tokens,
            genMs: genMs(last),
            tps,
          }
        : null,
      ttftMs,
      tps,
    };
  }
  return { ts: Date.now(), sessions };
}

module.exports = { dbPath, openDb, querySessions, validSid };
