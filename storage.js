/*
 * 漆线雕 · 线材回潮准入与贴线复核台 —— 存储层
 * 负责 localStorage 持久化、版本迁移、种子数据与事务提交。
 * transact(fn)：在状态副本上执行业务函数，仅当返回 2xx 才落盘；
 * 非 2xx（如 409/422）丢弃副本，保证“冲突不写入”。
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "zfl42RehumidReviewStation.v2";
  var LEGACY_KEY = "zfl42Works"; // 旧版单文件应用数据，检测到后让位给新模型

  function clone(obj) {
    return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
  }

  /* 种子数据（演示四类场景：占用中 / 留检-潮 / 留检-超期 / 可领；待复核与留档各一） */
  function seedState() {
    return {
      version: 2,
      batches: [
        {
          id: "b04", batchNo: "漆线-丁", moisture: 11.0, checkedAt: "2026-09-20",
          activeIssue: { pieceId: "p03", issuedAt: "2026-09-20" },
          logs: ["2026-09-20 09:00:00 批次建档：含水率 11%，检测日期 2026-09-20（种子）",
                 "2026-09-20 09:00:00 准入判定：合格，可发料（种子）",
                 "2026-09-20 14:00:00 更正换批发料 → 《云雷纹》（竹胎笔筒）v2（种子）"]
        },
        {
          id: "b03", batchNo: "漆线-丙", moisture: 9.8, checkedAt: "2026-09-10",
          activeIssue: null,
          logs: ["2026-09-10 09:00:00 批次建档：含水率 9.8%，检测日期 2026-09-10（种子）",
                 "2026-09-10 09:00:00 准入判定：合格，可发料（种子）"]
        },
        {
          id: "b02", batchNo: "漆线-乙", moisture: 13.2, checkedAt: "2026-09-15",
          activeIssue: null,
          logs: ["2026-09-15 09:00:00 批次建档：含水率 13.2%，检测日期 2026-09-15（种子）",
                 "2026-09-15 09:00:00 准入判定：留检：含水率 13.2% 高于上限 12%（种子）"]
        },
        {
          id: "b01", batchNo: "漆线-甲", moisture: 10.5, checkedAt: "2026-09-18",
          activeIssue: { pieceId: "p01", issuedAt: "2026-09-18" },
          logs: ["2026-09-18 09:00:00 批次建档：含水率 10.5%，检测日期 2026-09-18（种子）",
                 "2026-09-18 09:00:00 准入判定：合格，可发料（种子）",
                 "2026-09-18 10:00:00 发料 → 《缠枝莲》（脱胎香盒）v1（种子）"]
        }
      ],
      pieces: [
        {
          id: "p03", lineageId: "line03", version: 2,
          base: "竹胎笔筒", theme: "云雷纹", batchId: "b04", progress: 0,
          stage: "待复核", status: "current", createdAt: "2026-09-20",
          correctedFrom: "p03old",
          logs: ["2026-09-20 14:00:00 由 v1 更正生成（胎体：木胎笔筒 → 竹胎笔筒）：旧贴线进度已失效，待复核（种子）"]
        },
        {
          id: "p02", lineageId: "line02", version: 1,
          base: "木胎盘", theme: "折枝梅", batchId: null, progress: 0,
          stage: "待领料", status: "current", createdAt: "2026-09-19",
          correctedFrom: null,
          logs: ["2026-09-19 11:00:00 建档，等待领料（种子）"]
        },
        {
          id: "p01", lineageId: "line01", version: 1,
          base: "脱胎香盒", theme: "缠枝莲", batchId: "b01", progress: 60,
          stage: "贴线中", status: "current", createdAt: "2026-09-18",
          correctedFrom: null,
          logs: ["2026-09-18 10:00:00 建档，等待领料（种子）",
                 "2026-09-18 10:00:00 领用 漆线-甲（含水率 10.5%，复检在 7 日内），进入贴线（种子）",
                 "2026-09-20 16:00:00 贴线进度更新为 60%（种子）"]
        }
      ],
      archive: [
        {
          id: "p03old", lineageId: "line03", version: 1,
          base: "木胎笔筒", theme: "云雷纹", batchId: "b04", progress: 35,
          stage: "贴线中", status: "archived", createdAt: "2026-09-19",
          correctedFrom: null, archivedAt: "2026-09-20 14:00:00",
          archivedReason: "胎体：木胎笔筒 → 竹胎笔筒",
          logs: ["2026-09-19 10:00:00 建档，等待领料（种子）",
                 "2026-09-20 13:00:00 贴线进度更新为 35%（种子）",
                 "2026-09-20 14:00:00 旧版因更正立即失效（胎体：木胎笔筒 → 竹胎笔筒），留档备查，退出当前队列（种子）"]
        }
      ]
    };
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* file:// 受限环境兜底 */ }
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.version === 2 && Array.isArray(parsed.batches) &&
            Array.isArray(parsed.pieces) && Array.isArray(parsed.archive)) {
          return parsed;
        }
      } catch (e) { /* 数据损坏时回落到种子 */ }
    }
    return seedState();
  }

  function persist(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 忽略写入受限 */ }
  }

  function reset() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 忽略 */ }
  }

  function createStore() {
    var state = load();
    return {
      getState: function () { return state; },
      transact: function (fn) {
        var draft = clone(state);
        var result;
        try {
          result = fn(draft);
        } catch (e) {
          return R(500, "INTERNAL_ERROR", "规则执行异常：" + (e && e.message ? e.message : e));
        }
        if (result && result.ok) {
          state = draft; // 仅 2xx 提交；4xx 时 draft 被整体丢弃
          persist(state);
        }
        return result;
      },
      exportJSON: function () { return JSON.stringify(state, null, 2); },
      reset: function () { reset(); state = seedState(); persist(state); }
    };
  }

  function R(status, code, message, data) {
    return { ok: false, status: status, code: code, message: message, data: data || {} };
  }

  global.Storage = { createStore: createStore, STORAGE_KEY: STORAGE_KEY, LEGACY_KEY: LEGACY_KEY };
})(window);
