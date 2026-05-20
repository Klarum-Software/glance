#!/usr/bin/env node
// Smoke test — boots the server on an ephemeral port, hits /api/health and
// /api/state, prints summary, exits 0 on success.

const http     = require("http");
const path     = require("path");
const { spawn } = require("child_process");

const PORT = 5199;
const HOST = "127.0.0.1";

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: p, timeout: 5000 }, r => {
      const chunks = [];
      r.on("data", c => chunks.push(c));
      r.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: r.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: r.statusCode, body }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const server = path.join(__dirname, "..", "server", "server.js");
  const child  = spawn("node", [server], {
    env: { ...process.env, GLANCE_PORT: String(PORT), GLANCE_HOST: HOST },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = false;
  child.stdout.on("data", d => {
    process.stdout.write("[server] " + d);
    if (/glance/.test(d.toString())) ready = true;
  });
  child.stderr.on("data", d => process.stderr.write("[server-err] " + d));

  for (let i = 0; i < 40 && !ready; i++) await sleep(100);
  if (!ready) {
    console.error("server failed to start");
    child.kill();
    process.exit(1);
  }

  let failed = 0;
  try {
    const h = await get("/api/health");
    console.log("health:", h.status, JSON.stringify(h.json || h.body).slice(0, 100));
    if (h.status !== 200 || !h.json?.ok) failed++;

    const s = await get("/api/state");
    console.log("state: ", s.status, "platform=" + (s.json?.platform || "?"),
                "services=" + JSON.stringify(s.json?.services || {}),
                "sessions=" + (s.json?.sessions?.length ?? "?"),
                "drafts=" + (s.json?.drafts?.length ?? "?"),
                "linear=" + (s.json?.linear?.total ?? "?"));
    if (s.status !== 200) failed++;
  } catch (e) {
    console.error("test error:", e.message);
    failed++;
  }
  child.kill("SIGTERM");
  await sleep(200);
  process.exit(failed ? 1 : 0);
}

main();
