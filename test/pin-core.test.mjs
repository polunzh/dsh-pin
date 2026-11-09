import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findWorkspaceRecord,
  orderWithPinnedFirst,
  parsePanelPins,
  parseWorkspaceRecords,
  planPanelOrder,
  planPinRestore,
  planPinWorkspace,
  planUnpinWorkspace,
  prunePanelPins,
  removeWorkspaceRecord,
  serializePanelPins,
  serializeWorkspaceRecords,
  togglePanelPin,
  upsertWorkspaceRecord,
  workspaceIdFromRowKey,
} from "../lib/pin-core.mjs";

const ORDER = ["w-a", "w-b", "w-c", "w-d"];

/** 按宿主 insertBefore 语义依次执行移动序列，返回结果顺序。 */
function applyMoves(order, moves) {
  let current = [...order];
  for (const move of moves) {
    const without = current.filter((id) => id !== move.workspaceId);
    const at = without.indexOf(move.beforeId);
    assert.notEqual(at, -1, `beforeId ${move.beforeId} missing`);
    current = [...without.slice(0, at), move.workspaceId, ...without.slice(at)];
  }
  return current;
}

/** 生成排列，用于穷举验证。 */
function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((id, index) =>
    permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [id, ...rest]),
  );
}

test("planPinWorkspace moves the target before the current first workspace", () => {
  const plan = planPinWorkspace({ order: ORDER, workspaceId: "w-c", now: 42 });
  assert.equal(plan.move, true);
  assert.equal(plan.beforeId, "w-a");
  assert.deepEqual(plan.record, {
    workspaceId: "w-c",
    restoreBeforeId: "w-d",
    pinnedAt: 42,
  });
});

test("planPinWorkspace records an unpin anchor even when already first", () => {
  const plan = planPinWorkspace({ order: ORDER, workspaceId: "w-a" });
  assert.equal(plan.move, false);
  assert.equal(plan.record.workspaceId, "w-a");
  assert.equal(plan.record.restoreBeforeId, "w-b");
});

test("planPinWorkspace rejects unknown workspaces", () => {
  assert.equal(planPinWorkspace({ order: ORDER, workspaceId: "missing" }), null);
  assert.equal(planPinWorkspace({ order: [], workspaceId: "w-a" }), null);
  assert.equal(planPinWorkspace({ order: ORDER, workspaceId: "" }), null);
});

test("planPinWorkspace pins the last workspace with a null anchor", () => {
  const plan = planPinWorkspace({ order: ORDER, workspaceId: "w-d" });
  assert.equal(plan.beforeId, "w-a");
  assert.equal(plan.record.restoreBeforeId, null);
});

test("planUnpinWorkspace restores before the recorded anchor", () => {
  const record = { workspaceId: "w-c", restoreBeforeId: "w-d", pinnedAt: 1 };
  const plan = planUnpinWorkspace({ order: ["w-c", "w-a", "w-b", "w-d"], workspaceId: "w-c", record });
  assert.equal(plan.move, true);
  assert.equal(plan.beforeId, "w-d");
});

test("planUnpinWorkspace does not move when already at the restored slot", () => {
  const record = { workspaceId: "w-c", restoreBeforeId: "w-d", pinnedAt: 1 };
  const plan = planUnpinWorkspace({ order: ["w-a", "w-c", "w-d"], workspaceId: "w-c", record });
  assert.equal(plan.move, false);
  assert.equal(plan.beforeId, "w-d");
});

test("planUnpinWorkspace appends when the anchor is gone", () => {
  const record = { workspaceId: "w-c", restoreBeforeId: "deleted", pinnedAt: 1 };
  const plan = planUnpinWorkspace({ order: ["w-c", "w-a"], workspaceId: "w-c", record });
  assert.equal(plan.move, true);
  assert.equal(plan.beforeId, undefined);
});

test("planUnpinWorkspace treats a null anchor as append, unless already last", () => {
  const record = { workspaceId: "w-d", restoreBeforeId: null, pinnedAt: 1 };
  const plan = planUnpinWorkspace({ order: ["w-d", "w-a", "w-b"], workspaceId: "w-d", record });
  assert.equal(plan.move, true);
  assert.equal(plan.beforeId, undefined);

  const settled = planUnpinWorkspace({
    order: ["w-a", "w-b", "w-d"],
    workspaceId: "w-d",
    record,
  });
  assert.equal(settled.move, false);
});

test("multi-pin records stay independent and restorable", () => {
  let records = [];
  // 先置顶 w-c（原位置在 w-d 前），再置顶 w-b（原位置在 w-c 前）。
  let plan = planPinWorkspace({ order: ORDER, workspaceId: "w-c", now: 1 });
  records = upsertWorkspaceRecord(records, plan.record);
  let order = ["w-c", "w-a", "w-b", "w-d"];
  plan = planPinWorkspace({ order, workspaceId: "w-b", now: 2 });
  records = upsertWorkspaceRecord(records, plan.record);
  order = ["w-b", "w-c", "w-a", "w-d"];

  assert.equal(records.length, 2);
  assert.equal(findWorkspaceRecord(records, "w-c").restoreBeforeId, "w-d");
  assert.equal(findWorkspaceRecord(records, "w-b").restoreBeforeId, "w-d");

  // 取消 w-b：回到 w-c 前面；w-c 仍置顶，其记录不变。
  const unpinB = planUnpinWorkspace({
    order,
    workspaceId: "w-b",
    record: findWorkspaceRecord(records, "w-b"),
  });
  assert.equal(unpinB.beforeId, "w-d");
  order = ["w-c", "w-b", "w-a", "w-d"];
  records = removeWorkspaceRecord(records, "w-b");

  const unpinC = planUnpinWorkspace({
    order,
    workspaceId: "w-c",
    record: findWorkspaceRecord(records, "w-c"),
  });
  assert.equal(unpinC.beforeId, "w-d");
});

test("workspace record storage round-trips and degrades safely", () => {
  const records = [
    { workspaceId: "w-a", restoreBeforeId: "w-b", pinnedAt: 3 },
    { workspaceId: "w-c", restoreBeforeId: null, pinnedAt: 1 },
  ];
  assert.deepEqual(parseWorkspaceRecords(serializeWorkspaceRecords(records)), records);

  assert.deepEqual(parseWorkspaceRecords("not json"), []);
  assert.deepEqual(parseWorkspaceRecords("{}"), []);
  assert.deepEqual(parseWorkspaceRecords(null), []);
  assert.deepEqual(
    parseWorkspaceRecords(
      JSON.stringify([
        { workspaceId: "w-a", restoreBeforeId: "w-b", pinnedAt: 3 },
        { workspaceId: "w-a", restoreBeforeId: "bad", pinnedAt: 9 },
        { workspaceId: "", pinnedAt: 1 },
        null,
      ]),
    ),
    [{ workspaceId: "w-a", restoreBeforeId: "w-b", pinnedAt: 3 }],
  );
});

test("panel pins toggle with newest first and prune dead ids", () => {
  let pins = [];
  pins = togglePanelPin(pins, "a");
  pins = togglePanelPin(pins, "b");
  assert.deepEqual(pins, ["b", "a"]);
  pins = togglePanelPin(pins, "b");
  assert.deepEqual(pins, ["a"]);
  pins = togglePanelPin(pins, "a");
  assert.deepEqual(pins, []);

  assert.deepEqual(prunePanelPins(["b", "gone", "a"], ["a", "b", "c"]), ["b", "a"]);
  assert.deepEqual(parsePanelPins('["b","a","b"]'), ["b", "a"]);
  assert.deepEqual(parsePanelPins("oops"), []);
  assert.deepEqual(parsePanelPins(serializePanelPins(["x", "y"])), ["x", "y"]);
});

test("planPanelOrder leads pinned panels by pin recency, preserving the rest", () => {
  assert.deepEqual(planPanelOrder(["plugins", "a", "b", "c"], ["c", "a"]), [
    "c",
    "a",
    "plugins",
    "b",
  ]);
  // 失效置顶 id 直接忽略。
  assert.deepEqual(planPanelOrder(["a", "b"], ["gone"]), ["a", "b"]);
  assert.deepEqual(planPanelOrder([], ["a"]), []);
});

test("planPinRestore lifts a pinned workspace back above a newly created one", () => {
  // 宿主新建工作区会插到持久顺序最前：置顶项被挤到第二位。
  const order = ["w-new", "w-a", "w-b", "w-c"];
  const moves = planPinRestore({ order, pinnedIds: ["w-a"] });
  assert.deepEqual(moves, [{ workspaceId: "w-a", beforeId: "w-new" }]);
  assert.deepEqual(applyMoves(order, moves), ["w-a", "w-new", "w-b", "w-c"]);
});

test("planPinRestore does nothing when pinned workspaces already lead", () => {
  assert.deepEqual(planPinRestore({ order: ["w-a", "w-new", "w-b"], pinnedIds: ["w-a"] }), []);
  assert.deepEqual(planPinRestore({ order: ORDER, pinnedIds: [] }), []);
  assert.deepEqual(planPinRestore({ order: [], pinnedIds: ["w-a"] }), []);
});

test("planPinRestore ignores pinned ids that no longer exist", () => {
  assert.deepEqual(planPinRestore({ order: ORDER, pinnedIds: ["gone"] }), []);
  // 存活置顶项照常恢复，失效 id 不影响。
  const order = ["w-new", "w-a", "w-b"];
  assert.deepEqual(applyMoves(order, planPinRestore({ order, pinnedIds: ["gone", "w-a"] })), [
    "w-a",
    "w-new",
    "w-b",
  ]);
});

test("planPinRestore keeps the pinned block in its current relative order", () => {
  // 两个置顶项被新工作区挤下去：w-b 在 w-a 前面（与点击顺序无关，尊重当前顺序）。
  const order = ["w-new", "w-b", "w-a", "w-c", "w-d"];
  const moves = planPinRestore({ order, pinnedIds: ["w-a", "w-b"] });
  assert.deepEqual(applyMoves(order, moves), ["w-b", "w-a", "w-new", "w-c", "w-d"]);
  assert.ok(moves.length <= 2, `moves=${JSON.stringify(moves)}`);
});

test("planPinRestore pulls a pinned workspace back from below unpinned ones", () => {
  const order = ["w-b", "w-c", "w-a"];
  const moves = planPinRestore({ order, pinnedIds: ["w-a"] });
  assert.deepEqual(applyMoves(order, moves), ["w-a", "w-b", "w-c"]);
});

test("planPinRestore converges for every order of four workspaces", () => {
  const ids = ["w-a", "w-b", "w-c", "w-d"];
  const pinSets = [[], ["w-a"], ["w-b", "w-d"], ["w-a", "w-b"], ids];
  for (const order of permutations(ids)) {
    for (const pinnedIds of pinSets) {
      const moves = planPinRestore({ order, pinnedIds });
      const applied = applyMoves(order, moves);
      const label = JSON.stringify({ order, pinnedIds, moves });
      assert.deepEqual(applied, orderWithPinnedFirst({ order, pinnedIds }), label);
      const live = order.filter((id) => pinnedIds.includes(id));
      assert.ok(moves.length <= live.length, label);
      // 修好之后不需要再动。
      assert.deepEqual(planPinRestore({ order: applied, pinnedIds }), [], label);
    }
  }
});

test("planPinRestore respects an explicit move limit", () => {
  const order = ["w-new", "w-c", "w-b", "w-a"];
  const moves = planPinRestore({ order, pinnedIds: ["w-a", "w-b", "w-c"], limit: 1 });
  assert.equal(moves.length, 1);
});

test("orderWithPinnedFirst preserves the pinned block and the rest", () => {
  assert.deepEqual(orderWithPinnedFirst({ order: ["x", "p2", "y", "p1"], pinnedIds: ["p1", "p2"] }), [
    "p2",
    "p1",
    "x",
    "y",
  ]);
  assert.deepEqual(orderWithPinnedFirst({ order: ["a", "b"], pinnedIds: [] }), ["a", "b"]);
});

test("workspaceIdFromRowKey parses only workspace keys", () => {
  assert.equal(workspaceIdFromRowKey("workspace:0e5b"), "0e5b");
  assert.equal(workspaceIdFromRowKey("session:abc"), null);
  assert.equal(workspaceIdFromRowKey("workspace:"), null);
  assert.equal(workspaceIdFromRowKey(null), null);
});
