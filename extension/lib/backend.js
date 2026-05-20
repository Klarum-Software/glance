// Backend lifecycle — spawn / stop the Node.js server, expose /api/health
// readiness check. Used by extension.js on enable()/disable().

import GLib from "gi://GLib";
import Gio  from "gi://Gio";

export class Backend {
  constructor({ nodePath, serverPath, port, host = "127.0.0.1" }) {
    this._node       = nodePath;
    this._server     = serverPath;
    this._port       = port;
    this._host       = host;
    this._proc       = null;
    this._started    = false;
    this._killTimer  = 0;
  }

  get url()  { return `http://${this._host}:${this._port}`; }
  get isRunning() { return this._started && this._proc !== null; }

  start(onExit) {
    if (this._proc) return;
    const launcher = new Gio.SubprocessLauncher({
      flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.setenv("GLANCE_PORT", String(this._port), true);
    launcher.setenv("GLANCE_HOST", this._host, true);
    try {
      this._proc = launcher.spawnv([this._node, this._server]);
      this._started = true;
    } catch (e) {
      log(`[glance] backend spawn failed: ${e.message}`);
      this._proc = null;
      this._started = false;
      if (onExit) onExit({ fastExit: true, status: -1, stderr: e.message });
      return;
    }
    const spawnedAt = GLib.get_monotonic_time();
    const proc = this._proc;
    this._firstStderrLine = "";
    this._startStderrDrain(proc);
    proc.wait_async(null, (p, res) => {
      let status = 0;
      try { p.wait_finish(res); } catch (_) {}
      try { status = p.get_exit_status(); } catch (_) {}
      const fastExit = (GLib.get_monotonic_time() - spawnedAt) < 1_000_000;
      const stderr = this._firstStderrLine;
      log(`[glance] backend exited (status=${status}${fastExit ? ", fast" : ""})${stderr ? ": " + stderr : ""}`);
      this._started = false;
      this._proc = null;
      if (this._killTimer) {
        GLib.Source.remove(this._killTimer);
        this._killTimer = 0;
      }
      if (onExit) onExit({ fastExit, status, stderr });
    });
  }

  // Continuously drain stderr so the pipe buffer never fills (which would
  // block the child on write and prevent wait_async from firing).
  // Capture the first non-empty line for diagnostics.
  _startStderrDrain(proc) {
    const stream = proc.get_stderr_pipe();
    if (!stream) return;
    const data = new Gio.DataInputStream({ base_stream: stream });
    const readNext = () => {
      data.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
        let bytes = null;
        try { [bytes] = s.read_line_finish(res); } catch (_) { return; }
        if (bytes === null) {
          try { stream.close(null); } catch (_) {}
          return;
        }
        const line = new TextDecoder().decode(bytes).trim();
        if (line && !this._firstStderrLine) this._firstStderrLine = line;
        readNext();
      });
    };
    readNext();
  }

  stop() {
    if (!this._proc) return;
    try { this._proc.send_signal(15); } catch (_) {}
    this._killTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
      this._killTimer = 0;
      if (this._proc) {
        try { this._proc.force_exit(); } catch (_) {}
      }
      return GLib.SOURCE_REMOVE;
    });
  }
}

// Resolve the server.js path: explicit setting > common install locations.
export function resolveServerPath(explicit, extensionDir) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  candidates.push(GLib.build_filenamev([extensionDir, "..", "server", "server.js"]));
  candidates.push(GLib.build_filenamev([extensionDir, "server", "server.js"]));
  candidates.push(GLib.build_filenamev([GLib.get_home_dir(), "repos", "glance", "server", "server.js"]));
  candidates.push(GLib.build_filenamev([GLib.get_home_dir(), ".local", "share", "glance", "server", "server.js"]));
  for (const p of candidates) {
    if (GLib.file_test(p, GLib.FileTest.EXISTS)) return p;
  }
  return null;
}

// Find node — checks common install paths, then falls back to bare "node"
// (resolved via $PATH by the subprocess launcher). The previous version
// shelled out to `which node` synchronously, which freezes the compositor
// on a cold PATH or slow filesystem.
export function resolveNodePath() {
  const candidates = [
    "/usr/bin/node",
    "/usr/local/bin/node",
    "/snap/bin/node",
    "/opt/homebrew/bin/node",
    GLib.build_filenamev([GLib.get_home_dir(), ".nvm", "current", "bin", "node"]),
    GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin", "node"]),
  ];
  for (const p of candidates) {
    if (GLib.file_test(p, GLib.FileTest.EXISTS)) return p;
  }
  return "node";
}
