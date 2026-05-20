// Soup3 HTTP client for talking to the glance backend.
// All requests are 127.0.0.1; no external network.

import Soup from "gi://Soup";
import GLib from "gi://GLib";

const session = new Soup.Session();
session.timeout = 5;

export function get(url, cancellable = null) {
  return new Promise((resolve, reject) => {
    const msg = Soup.Message.new("GET", url);
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
      try {
        const bytes = s.send_and_read_finish(res);
        if (msg.status_code < 200 || msg.status_code >= 300) {
          return reject(new Error(`${url} → ${msg.status_code}`));
        }
        const text = new TextDecoder().decode(bytes.get_data());
        try { resolve(JSON.parse(text)); }
        catch (_) { resolve(text); }
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function post(url, body = null, cancellable = null) {
  return new Promise((resolve, reject) => {
    const msg = Soup.Message.new("POST", url);
    if (body != null) {
      const payload = JSON.stringify(body);
      msg.set_request_body_from_bytes("application/json", new GLib.Bytes(new TextEncoder().encode(payload)));
    }
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
      try {
        const bytes = s.send_and_read_finish(res);
        if (msg.status_code < 200 || msg.status_code >= 300) {
          return reject(new Error(`${url} → ${msg.status_code}`));
        }
        const text = new TextDecoder().decode(bytes.get_data());
        try { resolve(JSON.parse(text)); }
        catch (_) { resolve(text); }
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Poll /api/health until it returns 200 or timeout.
export async function waitForHealth(baseUrl, timeoutMs = 5000, intervalMs = 250, cancellable = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cancellable && cancellable.is_cancelled()) return false;
    try {
      const h = await get(`${baseUrl}/api/health`, cancellable);
      if (h && h.ok) return true;
    } catch (_) { /* keep polling */ }
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => { r(); return GLib.SOURCE_REMOVE; }));
  }
  return false;
}
