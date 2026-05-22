// Formatting helpers shared between panel + dashboard render code.

export function fmtBytes(kb) {
  if (!Number.isFinite(kb) || kb <= 0) return "0";
  if (kb < 1024)        return `${kb} K`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(0)} M`;
  return `${(kb / 1024 / 1024).toFixed(1)} G`;
}

export function fmtUptime(s) {
  if (!s) return "—";
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

export function fmtAgo(input) {
  if (!input) return "—";
  const ms = typeof input === "number" ? input : Date.parse(input);
  const s = (Date.now() - ms) / 1000;
  if (!Number.isFinite(s)) return "—";
  if (s < 60)    return `${Math.round(s)}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtClock(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function today()    { return new Date().toISOString().slice(0, 10); }
export function tomorrow() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Shorten an absolute path for one-line rendering. Replaces $HOME with ~ and
// keeps at most the last two path segments.
export function shortPath(p) {
  if (!p || typeof p !== "string") return "";
  const segs = p.split("/").filter(Boolean);
  if (!segs.length) return p;
  const tail = segs.slice(-2).join("/");
  return tail;
}
