/**
 * The app's one state machine. Four states a volunteer understands:
 *   unpaired   → this computer isn't paired with a church yet
 *   searching  → paired; looking for ProPresenter
 *   ready      → ProPresenter found, server connected, no service live
 *   live       → a service is running; cues are flowing
 * plus the facts each screen shows. In a browser with ?mock=<state> the machine
 * is frozen in that state with sample facts, for screenshots and design review.
 */
import { useEffect, useRef, useState } from "react";
import { ServerLink, deviceName, pairPoll, pairStart } from "./backend";
import {
  APP_VERSION,
  Settings,
  autostart,
  checkForUpdate,
  installerCode,
  loadSettings,
  mockState,
  onTogglePause,
  saveSettings,
  setTray,
} from "./platform";
import { DEFAULT_PORT, PpAddress, PpInfo, Slide, currentSlide, discover, identify } from "./propresenter";

export type Phase = "unpaired" | "searching" | "ready" | "live";

export interface AppState {
  phase: Phase;
  /** A deep link (worshipfluent://pair?code=…) arrived: confirm before pairing. */
  grant?: { code: string; churchName: string; busy?: boolean; error?: string } | null;
  booting: boolean;
  churchName?: string;
  deviceName?: string;
  pairing?: { code: string; approveUrl: string; expiresAt: number; waiting: boolean; error?: string };
  pp?: PpInfo | null;
  ppSearch?: "saved" | "local" | "lan" | "none";
  server: "offline" | "connecting" | "connected" | "refused";
  serverError?: string;
  slide?: Slide | null;
  lastCueAt?: number;
  paused: boolean;
  autostart: boolean;
  update?: { version: string; install: () => Promise<void> } | null;
  manual?: { host: string; port: number; error?: string } | null;
  version: string;
}

const MOCKS: Record<string, Partial<AppState>> = {
  confirm: { phase: "unpaired", grant: { code: "K7PR4Q2MAB", churchName: "SCC Pasadena" } },
  pair: {
    phase: "unpaired",
    pairing: { code: "K7PR-4Q2M", approveUrl: "https://app.worshipfluent.com/settings?pair=K7PR-4Q2M", expiresAt: Date.now() + 540_000, waiting: true },
  },
  searching: { phase: "searching", churchName: "SCC Pasadena", deviceName: "Sanctuary PC", server: "connected", ppSearch: "lan" },
  notfound: { phase: "searching", churchName: "SCC Pasadena", deviceName: "Sanctuary PC", server: "connected", ppSearch: "none" },
  manual: {
    phase: "searching",
    churchName: "SCC Pasadena",
    deviceName: "Sanctuary PC",
    server: "connected",
    ppSearch: "none",
    manual: { host: "192.168.1.", port: 50001 },
  },
  ready: {
    phase: "ready",
    churchName: "SCC Pasadena",
    deviceName: "Sanctuary PC",
    server: "connected",
    pp: { host: "localhost", port: 50001, version: "ProPresenter 7.16.2", name: "SANCTUARY-PC" },
  },
  live: {
    phase: "live",
    churchName: "SCC Pasadena",
    deviceName: "Sanctuary PC",
    server: "connected",
    pp: { host: "localhost", port: 50001, version: "ProPresenter 7.16.2", name: "SANCTUARY-PC" },
    slide: { presentationName: "Way Maker", presentationUuid: "x", slideIndex: 2, text: "You are here, moving in our midst", label: "Verse 1", groupName: "Verse 1" },
    lastCueAt: Date.now() - 2000,
  },
  unpaired_again: {
    phase: "unpaired",
    churchName: "SCC Pasadena",
    serverError: "This computer is no longer paired with the church",
    pairing: { code: "M8TW-2HQ7", approveUrl: "https://app.worshipfluent.com/settings?pair=M8TW-2HQ7", expiresAt: Date.now() + 590_000, waiting: true },
  },
  update: {
    phase: "ready",
    churchName: "SCC Pasadena",
    deviceName: "Sanctuary PC",
    server: "connected",
    pp: { host: "localhost", port: 50001, version: "ProPresenter 7.16.2", name: "SANCTUARY-PC" },
    update: { version: "2.1.0", install: async () => undefined },
  },
};

const initial: AppState = { phase: "unpaired", booting: true, server: "offline", paused: false, autostart: true, version: APP_VERSION };

export function useBridge() {
  const [state, setState] = useState<AppState>(() =>
    mockState && MOCKS[mockState] ? { ...initial, booting: false, ...MOCKS[mockState] } : initial,
  );
  const link = useRef<ServerLink | null>(null);
  const settings = useRef<Settings>({});
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const patch = (p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) =>
    setState((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));

  // Tray mirrors the phase.
  useEffect(() => {
    const title =
      state.phase === "live"
        ? `Live · ${state.slide?.presentationName || "service"}`
        : state.phase === "ready"
          ? `Ready · ${state.churchName ?? ""}`
          : state.phase === "searching"
            ? "Looking for ProPresenter"
            : "Not paired";
    void setTray(state.phase, title);
  }, [state.phase, state.slide?.presentationName, state.churchName]);

  useEffect(() => {
    if (mockState) return;
    let cancelled = false;
    (async () => {
      settings.current = await loadSettings();
      const auto = await autostart();
      patch({ autostart: auto, paused: Boolean(settings.current.paused) });
      void checkForUpdate().then((u) => patch({ update: u }));
      await onTogglePause(() => togglePause());
      if (settings.current.token && settings.current.churchId) {
        await becomePaired();
      } else {
        const code = await installerCode();
        if (code) {
          const r = await pairPoll(code, undefined, deviceName()).catch(() => ({ status: "unknown" as const }));
          if (r.status === "approved") {
            settings.current = await saveSettings({
              token: r.token,
              churchId: r.church_id,
              churchName: r.church_name,
              deviceName: r.device_name,
            });
            await becomePaired();
            return;
          }
        }
        if (!cancelled) await startPairing();
      }
      patch({ booting: false });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startPairing() {
    patch({ phase: "unpaired", booting: false, pairing: undefined });
    try {
      const s = await pairStart();
      const expiresAt = Date.now() + s.expires_in * 1000;
      patch({ pairing: { code: s.code, approveUrl: s.approve_url, expiresAt, waiting: true } });
      const tick = async () => {
        if (Date.now() > expiresAt) {
          await startPairing(); // a fresh code
          return false;
        }
        const r = await pairPoll(s.code, s.secret, deviceName()).catch(() => ({ status: "pending" as const }));
        if (r.status === "approved") {
          settings.current = await saveSettings({
            token: r.token,
            churchId: r.church_id,
            churchName: r.church_name,
            deviceName: r.device_name,
          });
          await becomePaired();
          return false;
        }
        if (r.status === "expired" || r.status === "used" || r.status === "unknown") {
          await startPairing();
          return false;
        }
        return true;
      };
      const loop = async () => {
        if (await tick()) setTimeout(loop, s.poll_interval * 1000);
      };
      setTimeout(loop, s.poll_interval * 1000);
    } catch (e) {
      patch({ pairing: { code: "", approveUrl: "", expiresAt: 0, waiting: false, error: "Can't reach WorshipFluent. Check the internet connection." } });
      setTimeout(startPairing, 10_000);
    }
  }

  async function becomePaired() {
    const s = settings.current;
    patch({
      phase: "searching",
      booting: false,
      churchName: s.churchName,
      deviceName: s.deviceName,
      server: "connecting",
      serverError: undefined,
      pairing: undefined,
    });
    await link.current?.stop();
    const l = new ServerLink(s.token!, s.churchId!, {
      onConnected: (info) => {
        patch((st) => ({
          server: "connected",
          churchName: info.church_name ?? st.churchName,
          deviceName: info.device_name ?? st.deviceName,
          phase: st.pp ? (info.live ? "live" : "ready") : "searching",
        }));
      },
      onLive: (live) => patch((st) => ({ phase: st.pp ? (live ? "live" : "ready") : "searching" })),
      onError: async (code, message) => {
        if (code === "unpaired") {
          await link.current?.stop();
          settings.current = await saveSettings({ token: undefined, churchId: undefined });
          patch({ server: "refused", serverError: message });
          await startPairing();
        } else {
          patch({ server: "refused", serverError: message });
        }
      },
      onClosed: () => patch((st) => (st.server === "refused" ? {} : { server: "connecting" })),
    });
    link.current = l;
    l.paused = Boolean(s.paused);
    await l.start();
    await findProPresenter();
  }

  async function findProPresenter() {
    const s = settings.current;
    patch({ pp: undefined, ppSearch: s.ppHost ? "saved" : "local", phase: "searching" });
    const saved = s.ppHost ? { host: s.ppHost, port: s.ppPort ?? DEFAULT_PORT } : undefined;
    const port = s.ppPort ?? DEFAULT_PORT;
    const hit = await discover(port, (step) => patch({ ppSearch: step }), saved);
    if (hit) await adopt(hit);
    else {
      patch({ pp: null, ppSearch: "none" });
      setTimeout(() => {
        if (!link.current) return;
        void findProPresenter();
      }, 15_000);
    }
  }

  async function adopt(pp: PpInfo) {
    settings.current = await saveSettings({ ppHost: pp.host, ppPort: pp.port });
    if (link.current) {
      link.current.pp = pp;
      link.current.ppInfo = pp;
    }
    patch((st) => ({ pp, ppSearch: undefined, manual: null, phase: st.server === "connected" ? "ready" : "searching" }));
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(pollSlide, 1000);
  }

  let misses = 0;
  async function pollSlide() {
    const pp = link.current?.pp;
    if (!pp) return;
    try {
      const slide = await currentSlide(pp);
      misses = 0;
      patch((st) => ({ slide, lastCueAt: slide && slide.presentationUuid !== st.slide?.presentationUuid ? Date.now() : st.lastCueAt }));
      await link.current?.report(slide);
    } catch {
      if (++misses >= 5) {
        // ProPresenter went away (closed, or the computer slept): look again.
        if (pollTimer.current) clearInterval(pollTimer.current);
        if (link.current) link.current.pp = null;
        void findProPresenter();
      }
    }
  }

  async function useManualAddress(host: string, port: number) {
    const a: PpAddress = { host: host.trim(), port };
    patch({ manual: { host: a.host, port } });
    const hit = await identify(a, 3000);
    if (hit) await adopt(hit);
    else patch({ manual: { host: a.host, port, error: `Nothing answered at ${a.host}:${port}. Is ProPresenter's network setting on?` } });
  }

  async function togglePause() {
    const paused = !(link.current?.paused ?? false);
    if (link.current) link.current.paused = paused;
    settings.current = await saveSettings({ paused });
    patch({ paused });
  }

  async function setAutostart(on: boolean) {
    patch({ autostart: await autostart(on) });
  }

  async function unpair() {
    await link.current?.stop();
    link.current = null;
    if (pollTimer.current) clearInterval(pollTimer.current);
    settings.current = await saveSettings({ token: undefined, churchId: undefined, churchName: undefined, deviceName: undefined });
    await startPairing();
  }

  async function acceptGrant() {
    const g = state.grant;
    if (!g) return;
    patch({ grant: { ...g, busy: true } });
    const r = await pairPoll(g.code, undefined, deviceName()).catch(() => ({ status: "unknown" as const }));
    if (r.status === "approved") {
      settings.current = await saveSettings({ token: r.token, churchId: r.church_id, churchName: r.church_name, deviceName: r.device_name });
      patch({ grant: null });
      await becomePaired();
    } else {
      patch({ grant: { ...g, busy: false, error: "That link has expired. Click Finish setup on the web again." } });
    }
  }

  return {
    state,
    actions: {
      acceptGrant,
      declineGrant: () => patch({ grant: null }),
      startPairing,
      useManualAddress,
      openManual: () => patch((st) => ({ manual: { host: "", port: st.pp?.port ?? DEFAULT_PORT } })),
      closeManual: () => patch({ manual: null }),
      retryDiscovery: () => void findProPresenter(),
      changeProPresenter: async () => {
        settings.current = await saveSettings({ ppHost: undefined, ppPort: undefined });
        patch((st) => ({ manual: { host: "", port: st.pp?.port ?? DEFAULT_PORT } }));
      },
      togglePause,
      setAutostart,
      unpair,
    },
  };
}
