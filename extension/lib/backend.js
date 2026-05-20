// Backend lifecycle — spawn / stop the Node.js server, expose /api/health
// readiness check. Used by extension.js on enable()/disable().

import GLib from "gi://GLib";
import Gio  from "gi://Gio";

export class Backend {
  constructor({ nodePath, serverPath, port, host = "127.0.0.1" }) {
    this._node    = nodePath;
    this._server  = serverPath;
    this._port    = port;
    this._host    = host;
    this._proc    = null;
    this._started = false;
  }

  get url()  { return `http://${this._host}:${this._port}`; }
  get isRunning() { return this._started && this._proc !== null; }

  start(onExit) {
    if (this._proc) return;
    const launcher = new Gio.SubprocessLauncher({
      flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
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
      return;
    }
    this._proc.wait_async(null, (p, res) => {
      try { p.wait_finish(res); } catch (_) {}
      this._started = false;
      this._proc = null;
      if (onExit) onExit();
    });
  }

  stop() {
    if (!this._proc) return;
    try { this._proc.send_signal(15); } catch (_) {}
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
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

// Find node — try `which node`, then common paths.
export function resolveNodePath() {
  const candidates = ["/usr/bin/node", "/usr/local/bin/node", "/snap/bin/node"];
  // try $PATH lookup
  try {
    const [ok, out] = GLib.spawn_command_line_sync("which node");
    if (ok && out) {
      const path = new TextDecoder().decode(out).trim();
      if (path) return path;
    }
  } catch (_) {}
  for (const p of candidates) {
    if (GLib.file_test(p, GLib.FileTest.EXISTS)) return p;
  }
  return "node"; // last resort: hope $PATH resolves it in the subprocess
}
