"use strict";

const { run } = require("./util");

// Seconds since last keyboard/mouse input. Best-effort, returns null when the
// platform-specific source isn't available.
async function idleSeconds() {
  if (process.platform === "linux") return idleLinux();
  if (process.platform === "darwin") return idleMac();
  return null;
}

async function idleLinux() {
  // loginctl is the modern systemd path. The hint is a microsecond timestamp
  // of the moment idleness began ("IdleSinceHint=...") — subtract from now.
  const session = process.env.XDG_SESSION_ID;
  if (!session) {
    // Try the special "self" alias supported by systemd 247+.
    const text = await run("loginctl", ["show-session", "self", "-p", "IdleSinceHint", "-p", "IdleHint"]);
    return parseLoginctl(text);
  }
  const text = await run("loginctl", ["show-session", session, "-p", "IdleSinceHint", "-p", "IdleHint"]);
  return parseLoginctl(text);
}

function parseLoginctl(text) {
  if (!text) return null;
  const since = text.match(/IdleSinceHint=(\d+)/);
  if (!since) return null;
  const idleUs = Number(since[1]);
  if (!idleUs) return 0;
  const nowUs = Date.now() * 1000;
  const diffUs = nowUs - idleUs;
  if (diffUs < 0) return 0;
  return Math.floor(diffUs / 1_000_000);
}

async function idleMac() {
  const text = await run("ioreg", ["-c", "IOHIDSystem"]);
  if (!text) return null;
  const m = text.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!m) return null;
  // HIDIdleTime is in nanoseconds.
  return Math.floor(Number(m[1]) / 1_000_000_000);
}

module.exports = { idleSeconds };
