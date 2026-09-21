/*
 * 存储层：localStorage 持久化、种子数据、原子读写。
 * 规则层通过 repo.load() / repo.save(state) 访问，与业务判定解耦。
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "lacquer.thread.review.v1";

  function genId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function dateOffset(days) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function seed() {
    // 四批线材：合格在领 / 合格待领 / 含水率超标留检 / 复检超期留检
    var b1 = { id: genId(), code: "X-001", moisture: 10.5, inspectDate: dateOffset(-2), holderId: null, logs: ["入库 0.35mm 朱红漆线，复检合格"] };
    var b2 = { id: genId(), code: "X-002", moisture: 11.8, inspectDate: dateOffset(-4), holderId: null, logs: ["入库 0.5mm 金箔线，复检合格"] };
    var b3 = { id: genId(), code: "X-003", moisture: 13.2, inspectDate: dateOffset(-1), holderId: null, logs: ["入库 0.35mm 朱红漆线，含水率超标留检"] };
    var b4 = { id: genId(), code: "X-004", moisture: 9.4, inspectDate: dateOffset(-10), holderId: null, logs: ["复检报告超期，只能留检"] };

    var p1 = {
      id: genId(), seq: 1, code: "J-001",
      base: "木胎香盒", theme: "海水江崖",
      batchId: b1.id, progress: 60, status: "贴线中", blockReason: "",
      logs: ["建档，进入待复核", "领用 X-001（含水率 10.5%），准入通过，开始贴线"],
      versions: []
    };
    b1.holderId = p1.id;

    var p2 = {
      id: genId(), seq: 2, code: "J-002",
      base: "脱胎盘", theme: "折枝梅",
      batchId: null, progress: 0, status: "待复核", blockReason: "",
      logs: ["建档，进入待复核"],
      versions: []
    };

    var p3 = {
      id: genId(), seq: 3, code: "J-003",
      base: "竹胎笔筒", theme: "缠枝莲",
      batchId: b2.id, progress: 0, status: "待复核", blockReason: "",
      logs: [
        "建档，进入待复核",
        "曾领用 X-001，贴线 40%",
        "更正（纹样：云雷纹 → 缠枝莲；已领批次：X-001 → X-002），旧贴线进度立即失效，回到待复核；旧版已留档"
      ],
      versions: [
        {
          id: genId(), seq: 3, code: "J-003",
          base: "竹胎笔筒", theme: "云雷纹",
          batchId: b1.id, progress: 40, status: "贴线中", blockReason: "",
          logs: ["建档，进入待复核", "曾领用 X-001，贴线 40%"],
          versions: [],
          archivedAt: "旧版留档（种子数据）",
          archiveReason: "纹样：云雷纹 → 缠枝莲；已领批次：X-001 → X-002"
        }
      ]
    };

    return { batches: [b1, b2, b3, b4], pieces: [p3, p2, p1] };
  }

  function load() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && Array.isArray(data.pieces) && Array.isArray(data.batches)) return data;
      }
    } catch (e) { /* 损坏数据回退种子 */ }
    var fresh = seed();
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    return fresh;
  }

  function save(state) {
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function reset() {
    global.localStorage.removeItem(STORAGE_KEY);
    return load();
  }

  global.LacquerStorage = { key: STORAGE_KEY, load: load, save: save, reset: reset, seed: seed };
})(window);
