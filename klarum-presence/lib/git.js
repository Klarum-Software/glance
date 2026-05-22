"use strict";

const path = require("path");
const { run } = require("./util");

// Inspect a working directory. Returns null if cwd is missing, isn't a git
// repo, or git isn't available. Cheap shell-outs only — no heavy log walks.
async function gitContext(cwd) {
  if (!cwd) return null;
  const branch = (await run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!branch) return null;
  const top    = (await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).trim();
  const repo   = top ? path.basename(top) : null;
  const status = await run("git", ["-C", cwd, "status", "--porcelain"]);
  const dirty  = status ? status.split("\n").filter(Boolean).length : 0;
  return { repo, branch, dirty };
}

module.exports = { gitContext };
