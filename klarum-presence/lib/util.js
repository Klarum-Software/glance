"use strict";

const { execFile } = require("child_process");

// Run a binary, capture stdout. Resolves to the stdout string on exit 0.
// Resolves to "" on any non-zero exit, error, or timeout — callers treat
// "no data" the same as a missing tool. Bounded so a hung subprocess never
// stalls the snapshot.
function run(cmd, args = [], { timeoutMs = 1500, env } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const child = execFile(cmd, args, {
      timeout: timeoutMs,
      env: env || process.env,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => {
      if (done) return;
      done = true;
      if (err) return resolve("");
      resolve(stdout || "");
    });
    child.on("error", () => {
      if (done) return;
      done = true;
      resolve("");
    });
  });
}

function safe(fn) {
  return async (...a) => {
    try { return await fn(...a); } catch { return null; }
  };
}

module.exports = { run, safe };
