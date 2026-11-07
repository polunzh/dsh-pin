import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findWorkspaceRecord,
  parsePanelPins,
  parseWorkspaceRecords,
  planPanelOrder,
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

test("workspaceIdFromRowKey parses only workspace keys", () => {
  assert.equal(workspaceIdFromRowKey("workspace:0e5b"), "0e5b");
  assert.equal(workspaceIdFromRowKey("session:abc"), null);
  assert.equal(workspaceIdFromRowKey("workspace:"), null);
  assert.equal(workspaceIdFromRowKey(null), null);
});
