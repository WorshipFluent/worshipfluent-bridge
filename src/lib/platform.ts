/**
 * Everything that touches Tauri goes through here, so the same screens run in a
 * plain browser (`npm run dev`, screenshots, `?mock=live`) with fakes in place.
 */

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const mockParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
export const mockState = mockParams?.get("mock") ?? null;

export interface Settings {
  token?: string;
  churchId?: number;
  churchName?: string;
  deviceName?: string;
  ppHost?: string;
  ppPort?: number;
  manualPp?: boolean;
  autostart?: boolean;
  paused?: boolean;
}

const memory: Record<string, unknown> = {};

export async function loadSettings(): Promise<Settings> {
  if (!isTauri) return (memory.settings as Settings) ?? {};
  const { load } = await import("@tauri-apps/plugin-store");
  const store = await load("settings.json", { autoSave: true, defaults: {} });
  return ((await store.get<Settings>("settings")) ?? {}) as Settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  if (!isTauri) {
    memory.settings = next;
    return next;
  }
  const { load } = await import("@tauri-apps/plugin-store");
  const store = await load("settings.json", { autoSave: true, defaults: {} });
  await store.set("settings", next);
  await store.save();
  return next;
}

/** The pairing code from a worshipfluent://pair?code=… link, if the app was opened by one. */
export function codeFromLink(urls: string[] | null | undefined): string | null {
  for (const u of urls ?? []) {
    try {
      const url = new URL(u);
      if (url.protocol === "worshipfluent:" && (url.hostname === "pair" || url.pathname.replace(/^\/+/, "") === "pair")) {
        const code = url.searchParams.get("code");
        if (code) return code.toUpperCase();
      }
    } catch {
      /* not a URL */
    }
  }
  return null;
}

/** Links that opened the app (start-up) and links that arrive while it runs. */
export async function onPairLink(handler: (code: string) => void): Promise<() => void> {
  if (!isTauri) {
    const code = mockParams?.get("code");
    if (code) setTimeout(() => handler(code.toUpperCase()), 0);
    return () => undefined;
  }
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const initial = codeFromLink(await getCurrent());
  if (initial) handler(initial);
  return onOpenUrl((urls) => {
    const code = codeFromLink(urls);
    if (code) handler(code);
  });
}

export async function scanLan(port: number): Promise<{ host: string; port: number }[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ host: string; port: number }[]>("scan_lan", { port });
}

/** Ports listening on this computer; ProPresenter is confirmed by its API afterwards. */
export async function scanLocalPorts(): Promise<number[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number[]>("scan_local_ports");
}

export async function setTray(state: "unpaired" | "searching" | "ready" | "live", title: string) {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_tray", { state, title });
}

/** HTTP that reaches localhost and the LAN without the webview's CORS rules. */
export async function httpFetch(input: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 4000);
  try {
    if (isTauri) {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      return await tauriFetch(input, { ...init, signal: controller.signal });
    }
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface Socket {
  send(data: unknown): Promise<void>;
  close(): Promise<void>;
}

/** A WebSocket with one JSON message handler. In Tauri the plugin's socket; in a browser the native one. */
export async function openSocket(
  url: string,
  onMessage: (msg: Record<string, unknown>) => void,
  onClose: (code?: number, reason?: string) => void,
): Promise<Socket> {
  if (isTauri) {
    const WebSocketPlugin = (await import("@tauri-apps/plugin-websocket")).default;
    const ws = await WebSocketPlugin.connect(url);
    ws.addListener((m) => {
      if (m.type === "Text") {
        try {
          onMessage(JSON.parse(m.data as string));
        } catch {
          /* not JSON */
        }
      } else if (m.type === "Close") {
        const d = m.data as { code?: number; reason?: string } | null;
        onClose(d?.code, d?.reason);
      }
    });
    return {
      send: (data) => ws.send(JSON.stringify(data)),
      close: () => ws.disconnect().catch(() => undefined),
    };
  }
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket failed"));
  });
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch {
      /* not JSON */
    }
  };
  ws.onclose = (e) => onClose(e.code, e.reason);
  return {
    send: async (data) => ws.send(JSON.stringify(data)),
    close: async () => ws.close(),
  };
}

export async function openUrl(url: string) {
  if (!isTauri) {
    window.open(url, "_blank");
    return;
  }
  const { openUrl: open } = await import("@tauri-apps/plugin-opener");
  await open(url);
}

export async function autostart(enabled?: boolean): Promise<boolean> {
  if (!isTauri) {
    if (enabled !== undefined) memory.autostart = enabled;
    return (memory.autostart as boolean) ?? true;
  }
  const api = await import("@tauri-apps/plugin-autostart");
  if (enabled === true) await api.enable();
  if (enabled === false) await api.disable();
  return api.isEnabled();
}

export async function onTogglePause(handler: () => void): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen("toggle-pause", handler);
}

export async function checkForUpdate(): Promise<{ version: string; install: () => Promise<void> } | null> {
  if (!isTauri) return mockState === "update" ? { version: "2.1.0", install: async () => undefined } : null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      install: async () => {
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  } catch {
    return null;
  }
}

export const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION as string) || "2.0.0";
export const BACKEND_URL = "https://api.worshipfluent.com";
export const APP_URL = "https://app.worshipfluent.com";
