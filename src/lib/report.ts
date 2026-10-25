/**
 * The app's own errors go to the issues archive (api/issues.py, POST /api/events)
 * so a broken bridge is known about without the church calling. Never shown to
 * the church; a pattern across churches is what surfaces it. Throttled to five
 * reports a minute, repeats collapsed.
 */
import { APP_VERSION, BACKEND_URL, httpFetch, loadSettings } from "./platform";

let installed = false;
let sent = 0;
let windowStart = 0;
const seen = new Set<string>();

export async function reportError(message: string, context: Record<string, unknown> = {}) {
  const now = Date.now();
  if (now - windowStart > 60000) {
    windowStart = now;
    sent = 0;
    seen.clear();
  }
  const key = message.slice(0, 120);
  if (sent >= 5 || seen.has(key)) return;
  sent++;
  seen.add(key);
  try {
    const s = await loadSettings();
    await httpFetch(`${BACKEND_URL}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(s.token ? { Authorization: `Bearer ${s.token}` } : {}) },
      body: JSON.stringify({ source: "bridge", message: message.slice(0, 500), context: { ...context, church_id: s.churchId }, app_version: APP_VERSION }),
      timeoutMs: 5000,
    });
  } catch {
    /* reporting never raises */
  }
}

export function installErrorReporting() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    const err = e.error as Error | undefined;
    void reportError(err?.message || e.message || "Unknown error", { stack: (err?.stack || "").slice(0, 1500), file: e.filename, line: e.lineno });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as Error | string | undefined;
    const msg = r instanceof Error ? r.message : String(r ?? "Unhandled rejection");
    if (/abort|timeout|refused|ECONNREFUSED/i.test(msg)) return; // ProPresenter probes failing is normal
    void reportError(msg, { stack: r instanceof Error ? (r.stack || "").slice(0, 1500) : undefined, kind: "unhandledrejection" });
  });
}
