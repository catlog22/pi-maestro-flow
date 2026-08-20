/**
 * submit-gate 时序模拟测试(node:test + mock timers)
 * 验证：空闲提交放行 / 压缩中拦截排队 / settled 串行重放 / streaming 放行 / 超时兜底
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import registerSubmitGate from "../src/submit-gate/extension.ts";

type Handler = (event: any, ctx: any) => any;

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  const sent: string[] = [];
  const notified: string[] = [];
  const pi: any = {
    on(name: string, h: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
    },
    // 模拟 sendUserMessage：完整走 prompt → input(extension) → run → agent_settled
    async sendUserMessage(content: any) {
      const text = typeof content === "string" ? content : content[0]?.text;
      sent.push(text);
      for (const h of handlers.get("input") ?? []) {
        const r = await h(
          { text, images: undefined, source: "extension", streamingBehavior: undefined },
          { ui: { notify() {} } },
        );
        assert.equal(r?.action, "continue", `flush message "${text}" must pass the gate`);
      }
      for (const h of handlers.get("agent_settled")!) await h({}, {});
    },
  };
  return { handlers, sent, notified, pi };
}

function emitInput(handlers: Map<string, Handler[]>, notified: string[], text: string, opts: any = {}) {
  return handlers.get("input")![0](
    { text, images: undefined, source: "interactive", streamingBehavior: undefined, ...opts },
    { ui: { notify: (msg: string) => notified.push(msg) } },
  );
}

test("空闲提交放行；压缩中空闲提交被拦截排队；settled 后自动重放", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { handlers, sent, notified, pi } = createHarness();
  registerSubmitGate(pi);

  // 提交 A（空闲）→ 放行，门禁置位
  let r = await emitInput(handlers, notified, "A");
  assert.equal(r.action, "continue");

  // 提交 B（压缩中，仍判定为空闲）→ 拦截排队 + 提示
  r = await emitInput(handlers, notified, "B");
  assert.equal(r.action, "handled");
  assert.equal(notified.length, 1);

  // A 完成（agent_settled）→ 门禁解除，B 自动重放
  for (const h of handlers.get("agent_settled")!) await h({}, {});
  await mock.timers.tick(0);
  assert.deepEqual(sent, ["B"]);
});

test("streaming 提交直接放行；多条排队消息按序串行重放", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { handlers, sent, notified, pi } = createHarness();
  registerSubmitGate(pi);

  let r = await emitInput(handlers, notified, "A");
  assert.equal(r.action, "continue");

  // A 运行中用户打断（streaming steer）→ 放行给核心层队列
  r = await emitInput(handlers, notified, "S", { streamingBehavior: "steer" });
  assert.equal(r.action, "continue");

  // 压缩中再来两条空闲提交 → 都拦截排队
  r = await emitInput(handlers, notified, "B");
  assert.equal(r.action, "handled");
  r = await emitInput(handlers, notified, "C");
  assert.equal(r.action, "handled");
  assert.equal(notified.length, 2);

  for (const h of handlers.get("agent_settled")!) await h({}, {});
  await mock.timers.tick(0);
  await mock.timers.tick(0);
  await mock.timers.tick(0);
  assert.deepEqual(sent, ["B", "C"]);
});

test("前奏失败无 agent_settled 时，60s 超时自动解除门禁", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { handlers, notified, pi } = createHarness();
  registerSubmitGate(pi);

  let r = await emitInput(handlers, notified, "A");
  assert.equal(r.action, "continue");

  // 无 settled（模拟压缩抛错）→ 61s 后门禁解除
  mock.timers.tick(61_000);
  r = await emitInput(handlers, notified, "B");
  assert.equal(r.action, "continue");
  await mock.timers.tick(0);
});

test("超时解除时重放此前排队的消息", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { handlers, sent, notified, pi } = createHarness();
  registerSubmitGate(pi);

  await emitInput(handlers, notified, "A"); // 放行
  const r = await emitInput(handlers, notified, "B"); // 排队
  assert.equal(r.action, "handled");

  mock.timers.tick(61_000); // 前奏失败，超时兜底
  await mock.timers.tick(0);
  assert.deepEqual(sent, ["B"]);
});
