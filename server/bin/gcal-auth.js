#!/usr/bin/env node
// Deprecated. The OAuth helper now lives in google-auth.js and supports both
// Calendar and Gmail scopes. This shim delegates to google-auth.js --calendar
// so existing docs/scripts keep working.

const path = require("path");
const { spawn } = require("child_process");

console.error("gcal-auth.js is deprecated; use server/bin/google-auth.js instead.\n");

const next = path.join(__dirname, "google-auth.js");
const child = spawn(process.execPath, [next, "--calendar"], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
