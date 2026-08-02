import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkspacePeerIdentity, discoverWorkspacePeers } from "./src/extension/workspace-peers.ts";
import { MonitorOverlay } from "./src/tui/monitor-overlay.ts";

// 模拟 monitorSessionRows：本地无代理 + 5 个远端 owner
const identity = createWorkspacePeerIdentity("D:/pi-maestro-flow", { ownerId: "3a6aa287f82ba9d3d7daef192a27d7d2", ownerNonce: "0".repeat(32) });
const { peers } = await discoverWorkspacePeers(identity, { now: Date.now() });
console.log("remote peers:", peers.map(p => p.ownerId.slice(0,8)).join(","));

const windowRowStatus = (statuses) => statuses.length === 0 ? "idle" : statuses.some(s => s === "running" || s === "retrying") ? "running" : "sleeping";
const sessions = [];
sessions.push({ correlationId: "local", displayName: "本窗口", agentRole: "window · 0 agents", status: "idle", idleSeconds: 0, bound: false, source: "local", kind: "window", ownerId: "local" });
for (const owner of peers) {
  sessions.push({ correlationId: `owner:${owner.ownerId}`, displayName: owner.sessionName ?? `window:${owner.ownerId.slice(0,6)}`, agentRole: `window · ${owner.agents.length} agents`, status: windowRowStatus(owner.agents.map(a=>a.status)), idleSeconds: 0, bound: false, source: owner.sessionName ?? `remote:${owner.ownerId.slice(0,6)}`, kind: "window", ownerId: owner.ownerId });
  for (const agent of owner.agents) {
    sessions.push({ correlationId: `${owner.ownerId}:${agent.correlationId}`, displayName: agent.name ?? agent.correlationId.slice(0,8), agentRole: agent.agent, status: agent.status, idleSeconds: 1, bound: false, source: owner.sessionName ?? `remote:${owner.ownerId.slice(0,6)}`, kind: "agent", ownerId: owner.ownerId, depth: agent.depth, parentCorrelationId: agent.parentCorrelationId });
  }
}
console.log("sessions:", sessions.length);

let closed = null;
const overlay = new MonitorOverlay({ getSessions: () => sessions, close: (v) => { closed = v; } });
overlay.setRequestRender(() => {});
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// 逐个按 ↓ 找到第一个代理行并 Space
const rowOf = (pred) => { for (let i = 0; i < sessions.length; i++) if (pred(sessions[i])) return i; return -1; };
console.log("first agent index:", rowOf(s => s.kind === "agent"));
// 移动光标到第一个代理
for (let i = 0; i < rowOf(s => s.kind === "agent"); i++) overlay.handleInput("\x1b[B");
console.log("--- view at first agent (stripped) ---");
console.log(strip(overlay.render(100).join("\n")));
overlay.handleInput(" ");
console.log("--- after Space on agent (stripped) ---");
console.log(strip(overlay.render(100).join("\n")));
overlay.handleInput("\r");
console.log("closed:", JSON.stringify(closed));
