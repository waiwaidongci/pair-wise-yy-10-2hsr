/* 业务规则验证台：模拟浏览器 window/localStorage，加载 rules.js + storage.js */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const mem = new Map();
const sandbox = {
  console,
  Date,
  Math,
  JSON,
  Promise,
  setTimeout: (fn) => fn(),
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "rules.js"), "utf8"), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "storage.js"), "utf8"), sandbox);

const { Storage, Rules } = sandbox;
const store = Storage.createStore();
const svc = Rules.createService(store, { clock: () => "2026-09-21" });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  => " + JSON.stringify(extra) : "")); }
}
function sync(p) { return vm.isPromise ? null : null; }

(async () => {
  let s = store.getState();

  console.log("【场景0】种子数据");
  check("3 个当前工件", s.pieces.length === 3);
  check("4 个批次", s.batches.length === 4);
  check("漆线-甲被 p01 占用", s.batches.find(b => b.batchNo === "漆线-甲").activeIssue.pieceId === "p01");
  check("漆线-乙含水率13.2%判定留检", svc.evaluate(s.batches.find(b => b.batchNo === "漆线-乙")).admit === false);
  check("漆线-丙复检于09-10已11天判定留检", (() => {
    const ev = svc.evaluate(s.batches.find(b => b.batchNo === "漆线-丙"));
    return !ev.admit && ev.reasons.some(r => r.includes("超过 7 天"));
  })());
  check("漆线-丁(09-20)合格可领", svc.evaluate(s.batches.find(b => b.batchNo === "漆线-丁")).admit === true);
  check("留档 1 个旧版，不进当前队列", s.archive.length === 1 && s.pieces.every(p => p.status === "current"));

  console.log("【场景1】同批贴线未完成再领给第二件 → 409 且不写入");
  const before = JSON.stringify(s);
  const r1 = await svc.issue({ pieceId: "p02", batchId: "b01" }); // 漆线-甲 正贴 p01
  check("返回 409 BATCH_IN_PROGRESS", r1.status === 409 && r1.code === "BATCH_IN_PROGRESS", r1);
  check("状态完全未变化（不写入）", JSON.stringify(store.getState()) === before);

  console.log("【场景2】含水率超 12% / 复检超 7 天 → 只能留检 422 且不写入");
  const before2 = JSON.stringify(store.getState());
  const r2 = await svc.issue({ pieceId: "p02", batchId: "b02" }); // 13.2%
  check("高湿返回 422 HOLD_FOR_INSPECTION", r2.status === 422 && r2.code === "HOLD_FOR_INSPECTION", r2);
  check("高湿原因含含水率", r2.data.reasons.some(x => x.includes("含水率")));
  const r2b = await svc.issue({ pieceId: "p02", batchId: "b03" }); // 09-10 超期
  check("超期返回 422", r2b.status === 422 && r2b.data.reasons.some(x => x.includes("超过 7 天")), r2b);
  check("留检拦截不写入", JSON.stringify(store.getState()) === before2);

  console.log("【场景3】重复领用沿用首次结果（已绑重放）");
  const r3 = await svc.issue({ pieceId: "p01", batchId: "b01" });
  check("返回 200 ISSUE_REPLAY", r3.status === 200 && r3.code === "ISSUE_REPLAY", r3);
  check("replayed 标记", r3.data.replayed === true);
  check("重放不新增日志", store.getState().pieces.find(p => p.id === "p01").logs.filter(l => l.includes("领用")).length === 1);

  console.log("【场景4】并发领用同一在途结果");
  const [c1, c2] = await Promise.all([
    svc.issue({ pieceId: "p02", batchId: "b04" }),
    svc.issue({ pieceId: "p02", batchId: "b04" }),
  ]);
  // b04 正贴 p03(待复核但批次锁还在) → 两次都应是同一 409
  check("并发第1次 409", c1.status === 409, c1);
  check("并发第2次沿用同一结果对象", c2 === c1);
  check("冲突未写入，p02 仍待领料无批次", (() => {
    const p = store.getState().pieces.find(x => x.id === "p02");
    return p.batchId === null && p.stage === "待领料";
  })());

  console.log("【场景5】合格批次可正常领料并建立占用");
  // 先让漆线-丁空闲：p03 是待复核且持锁 —— 改为新建合格批次
  const nb = svc.createBatch({ batchNo: "漆线-戊", moisture: 10.0, checkedAt: "2026-09-21" });
  check("建批 201", nb.status === 201 && nb.data.admitted === true, nb);
  const r5 = await svc.issue({ pieceId: "p02", batchId: nb.data.batchId });
  check("领料 201 ISSUED", r5.status === 201 && r5.code === "ISSUED", r5);
  s = store.getState();
  check("工件进入贴线中、占用锁建立", (() => {
    const p = s.pieces.find(x => x.id === "p02");
    const b = s.batches.find(x => x.id === nb.data.batchId);
    return p.stage === "贴线中" && p.batchId === b.id && b.activeIssue.pieceId === "p02";
  })());
  const r5b = await svc.issue({ pieceId: "p01", batchId: nb.data.batchId });
  check("占用后第二件 409", r5b.status === 409, r5b);

  console.log("【场景6】贴线完成释放批次，之后可领给第二件");
  const rp = svc.setProgress({ pieceId: "p02", progress: 50 });
  check("中途进度 200", rp.status === 200 && rp.data.progress === 50);
  const rp100 = svc.setProgress({ pieceId: "p02", progress: 100 });
  check("完成 200 PROGRESS_DONE", rp100.status === 200 && rp100.code === "PROGRESS_DONE", rp100);
  s = store.getState();
  check("批次占用释放", s.batches.find(x => x.id === nb.data.batchId).activeIssue === null);
  check("p02 进入贴线完成", s.pieces.find(x => x.id === "p02").stage === "贴线完成");
  const np2 = svc.createPiece({ base: "陶胎瓶", theme: "宝相花" });
  const r6 = await svc.issue({ pieceId: np2.data.pieceId, batchId: nb.data.batchId });
  check("释放后可领给第二件 201", r6.status === 201, r6);

  console.log("【场景7】复检：合格后解除留检，改潮后重新留检");
  const rc1 = svc.recheck({ batchId: "b02", moisture: 10.8, checkedAt: "2026-09-21" });
  check("乙批复检合格 RECHECK_PASS", rc1.status === 200 && rc1.code === "RECHECK_PASS" && rc1.data.admitted === true, rc1);
  const r7 = await svc.issue({ pieceId: "p03", batchId: "b02" });
  // p03 自身已领 b04 → 409 PIECE_ALREADY_ISSUED
  check("已领他批再领 → 409 PIECE_ALREADY_ISSUED", r7.status === 409 && r7.code === "PIECE_ALREADY_ISSUED", r7);
  const rc2 = svc.recheck({ batchId: "b02", moisture: 12.6, checkedAt: "2026-09-21" });
  check("复检改高湿 RECHECK_HOLD", rc2.status === 200 && rc2.code === "RECHECK_HOLD", rc2);
  const rc3 = svc.recheck({ batchId: "b03", moisture: 9.0, checkedAt: "2026-09-21" });
  check("丙批今日复检合格（解决超期）", rc3.data.admitted === true);

  console.log("【场景8】胎体/纹样更正：旧版留档、进度清零、回到待复核");
  const beforeArc = store.getState().archive.length;
  const cr1 = svc.correct({ pieceId: "p01", base: "脱胎香盒", theme: "缠枝莲纹", batchId: "b01" });
  check("更正 200 CORRECTED", cr1.status === 200 && cr1.code === "CORRECTED", cr1);
  s = store.getState();
  check("旧版进入 archive 且不进队列", s.archive.length === beforeArc + 1 &&
    s.archive[0].id === "p01" && s.archive[0].progress === 60 && s.archive[0].status === "archived");
  const newP = s.pieces.find(x => x.id === cr1.data.newId);
  check("新版 v2、进度 0、待复核", newP.version === 2 && newP.progress === 0 && newP.stage === "待复核");
  check("占用锁移交新版", s.batches.find(b => b.id === "b01").activeIssue.pieceId === newP.id);
  check("同 lineageId", newP.lineageId === "line01");
  check("旧版不在看板(当前)集合", !s.pieces.some(x => x.id === "p01"));

  console.log("【场景9】更正时换领到留检/占用批次 → 整笔回滚，旧版保留");
  const piecesBefore = store.getState().pieces.length;
  const archiveBefore = store.getState().archive.length;
  const crHold = svc.correct({ pieceId: newP.id, base: "脱胎香盒", theme: "缠枝莲纹", batchId: "b02" }); // b02 现 12.6%
  check("换留检批 → 422", crHold.status === 422, crHold);
  const crBusy = svc.correct({ pieceId: newP.id, base: "脱胎香盒", theme: "缠枝莲纹", batchId: nb.data.batchId }); // 被 np2 占
  check("换占用批 → 409", crBusy.status === 409, crBusy);
  check("两次失败后数据零变化（旧版仍在、无新增留档）",
    store.getState().pieces.length === piecesBefore && store.getState().archive.length === archiveBefore);

  console.log("【场景10】更正为合格换批：旧锁释放、新锁建立、待复核");
  // b03 今日复检合格且空闲
  const cr3r = svc.correct({ pieceId: newP.id, base: "脱胎香盒", theme: "缠枝莲纹", batchId: "b03" });
  check("换批更正 200", cr3r.status === 200, cr3r);
  s = store.getState();
  const v3 = s.pieces.find(x => x.id === cr3r.data.newId);
  check("v3 待复核、批次 b03、进度 0", v3.stage === "待复核" && v3.batchId === "b03" && v3.progress === 0);
  check("b01 锁释放", s.batches.find(b => b.id === "b01").activeIssue === null);
  check("b03 锁归 v3", s.batches.find(b => b.id === "b03").activeIssue.pieceId === v3.id);
  const appr = svc.approve({ pieceId: v3.id });
  check("复核通过回到贴线中（持批）", appr.status === 200 && appr.data.stage === "贴线中", appr);
  const appr2 = svc.approve({ pieceId: v3.id });
  check("非待复核再次复核 → 409", appr2.status === 409);

  console.log("【场景11】输入校验与边界");
  check("建档缺字段 400", svc.createPiece({ base: "", theme: "x" }).status === 400);
  check("批次号重复 409", svc.createBatch({ batchNo: "漆线-戊", moisture: 8, checkedAt: "2026-09-21" }).status === 409);
  check("含水率非法 400", svc.createBatch({ batchNo: "漆线-己", moisture: 150, checkedAt: "2026-09-21" }).status === 400);
  check("对不存在工件领料 404", (await svc.issue({ pieceId: "nope", batchId: "b03" })).status === 404);
  const q2 = svc.createPiece({ base: "木胎盒", theme: "回纹" });
  const c2r = svc.correct({ pieceId: q2.data.pieceId, base: "木胎盒", theme: "回纹二", batchId: null });
  const issuePending = await svc.issue({ pieceId: c2r.data.newId, batchId: "b01" });
  check("待复核且无批件领料 → 409 PENDING_REVIEW", issuePending.status === 409 && issuePending.code === "PENDING_REVIEW", issuePending);
  check("无变化更正 400 NO_CHANGE", svc.correct({ pieceId: "p02", base: "木胎盘", theme: "折枝梅", batchId: nb.data.batchId }).status === 400);
  // p02 已贴线完成，非「贴线中」状态登记进度 → 409
  check("非贴线中登记进度 409", svc.setProgress({ pieceId: "p02", progress: 10 }).status === 409);

  console.log("【场景12】非 2xx 不落盘（localStorage 层验证）");
  const persisted = JSON.parse(mem.get(Storage.STORAGE_KEY));
  check("持久化数据中没有任何失败痕迹：b01 锁最终为空（已被成功换批释放）",
    persisted.batches.find(b => b.id === "b01").activeIssue === null);
  check("留档数 = 4（种子 p03old + p01 v1/v2 + 场景11 q2 v1）", persisted.archive.length === 4, persisted.archive.map(a => a.id + "@v" + a.version));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
