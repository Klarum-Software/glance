#!/usr/bin/env node
// Quick smoke test for klarum-presence. Loads the snapshot once, then boots
// the agent on a random port and curls /presence to confirm the round-trip.

"use strict";

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const { snapshot } = require(path.join(__dirname, "..", "lib", "presence"));

async function inProcess() {
  const snap = await snapshot();
  assertShape(snap);
  console.log("in-process snapshot OK");
  console.log("  name=" + snap.name + " load_1m=" + snap.load_1m.toFixed(2) +
              " mem_pct=" + snap.mem_pct + " claude_procs=" + snap.claude_procs +
              " agents=" + snap.agents.length +
              " tmux=" + (snap.active_tmux ? "yes" : "no"));
}

function assertShape(s) {
  const required = ["schema", "agent_version", "name", "uptime_s",
                    "load_1m", "mem_pct", "claude_procs", "agents", "active_tmux"];
  for (const k of required) {
    if (!(k in s)) throw new Error("missing field: " + k);
  }
  if (s.schema !== "klarum-presence/1") throw new Error("schema mismatch: " + s.schema);
  if (!Array.isArray(s.agents)) throw new Error("agents must be array");
}

async function endToEnd() {
  const port = 5176 + Math.floor(Math.random() * 1000);
  const env = { ...process.env, KLARUM_PRESENCE_PORT: String(port), KLARUM_PRESENCE_HOST: "127.0.0.1" };
  const bin = path.join(__dirname, "..", "bin", "klarum-presence");
  const child = spawn(process.execPath, [bin], { env, stdio: ["ignore", "pipe", "pipe"] });

  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("timeout waiting for listen line")), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening on")) { clearTimeout(to); resolve(); }
    });
    child.on("exit", (code) => reject(new Error("child exited early: " + code)));
  });

  const body = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/presence`, (r) => {
      const chunks = [];
      r.on("data", c => chunks.push(c));
      r.on("end",  () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    });
    req.on("error", reject);
  });
  assertShape(body);
  console.log("e2e /presence OK on port " + port);

  child.kill("SIGTERM");
  await new Promise(r => setTimeout(r, 200));
}

(async () => {
  try {
    await inProcess();
    await endToEnd();
    console.log("OK");
    process.exit(0);
  } catch (e) {
    console.error("FAIL: " + e.message);
    process.exit(1);
  }
})();
