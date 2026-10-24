/**
 * ProPresenter's local HTTP API (Preferences → Network → Enable Network). The
 * app never trusts an open port: a computer is "ProPresenter" only when
 * /version answers like ProPresenter.
 */
import { httpFetch, scanLan, scanLocalPorts } from "./platform";

export const DEFAULT_PORT = 50001;

export interface PpAddress {
  host: string;
  port: number;
}

export interface PpInfo extends PpAddress {
  version: string;
  name: string;
}

export interface Slide {
  presentationName: string;
  presentationUuid: string;
  slideIndex: number;
  text: string;
  label: string;
  groupName: string;
}

const base = (a: PpAddress) => `http://${a.host}:${a.port}/v1`;

export async function identify(a: PpAddress, timeoutMs = 1500): Promise<PpInfo | null> {
  const r = await probe(a, timeoutMs);
  return r.ok ? r.info : null;
}

export type ProbeResult = { ok: true; info: PpInfo } | { ok: false; reason: string };

/** Like identify, but says why it failed, for the manual-address screen. */
export async function probe(a: PpAddress, timeoutMs = 3000): Promise<ProbeResult> {
  const host = a.host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  const addr = { host: host || a.host, port: a.port };
  try {
    // ProPresenter's API: GET /version is at the root (not under /v1); everything else is /v1/…
    let r = await httpFetch(`http://${addr.host}:${addr.port}/version`, { timeoutMs });
    if (r.status === 404) {
      // Some builds answer only the /v1 routes: the slide index the old bridge polled is a fine fingerprint.
      const r2 = await httpFetch(`${base(addr)}/presentation/slide_index`, { timeoutMs });
      if (r2.ok) {
        try {
          const j2 = (await r2.json()) as Record<string, unknown>;
          if (j2 && typeof j2 === "object" && "presentation_index" in j2) {
            return { ok: true, info: { ...addr, version: "ProPresenter", name: addr.host } };
          }
        } catch {
          /* not JSON */
        }
      }
      r = r2;
    }
    if (!r.ok) return { ok: false, reason: `${addr.host}:${addr.port} answered, but not like ProPresenter (HTTP ${r.status}). Check the port in Preferences → Network.` };
    type Version = { host_description?: string; name?: string; api_version?: string };
    let j: Version | null = null;
    try {
      j = (await r.json()) as Version;
    } catch {
      return { ok: false, reason: `${addr.host}:${addr.port} answered, but it isn't ProPresenter's network API.` };
    }
    if (!j || typeof j !== "object" || !("api_version" in j || "host_description" in j)) {
      return { ok: false, reason: `${addr.host}:${addr.port} answered, but it isn't ProPresenter's network API.` };
    }
    return { ok: true, info: { ...addr, version: j.host_description ?? j.api_version ?? "", name: j.name ?? addr.host } };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/abort|timeout/i.test(msg)) return { ok: false, reason: `No answer from ${addr.host}:${addr.port} within ${Math.round(timeoutMs / 1000)} s. Is Enable Network on, and is this computer on the same network?` };
    if (/refused/i.test(msg)) return { ok: false, reason: `${addr.host}:${addr.port} refused the connection: nothing is listening on that port. Check the port in Preferences → Network.` };
    if (/scope|not allowed|forbidden/i.test(msg)) return { ok: false, reason: `The app isn't allowed to reach ${addr.host} (${msg}). Update the app.` };
    return { ok: false, reason: `Couldn't reach ${addr.host}:${addr.port}: ${msg}` };
  }
}

/**
 * This computer first, then the network. Reports progress so the screen can say
 * what it is doing. Resolves to the first confirmed ProPresenter or null.
 */
export async function discover(
  port: number,
  onProgress: (step: "local" | "lan") => void,
  saved?: PpAddress,
): Promise<PpInfo | null> {
  if (saved) {
    const hit = await identify(saved);
    if (hit) return hit;
  }
  onProgress("local");
  for (const host of ["localhost", "127.0.0.1"]) {
    const hit = await identify({ host, port });
    if (hit) return hit;
  }
  // Same computer, any port: ProPresenter picks its network port per install.
  const ports = (await scanLocalPorts()).filter((p) => p !== port && p !== 1420);
  for (const p of ports.slice(0, 200)) {
    const hit = await identify({ host: "127.0.0.1", port: p }, 700);
    if (hit) return hit;
  }
  onProgress("lan");
  const candidates = await scanLan(port);
  for (const c of candidates) {
    const hit = await identify(c, 1200);
    if (hit) return hit;
  }
  return null;
}

/** The slide ProPresenter is showing right now, or null when nothing is live. */
export async function currentSlide(a: PpAddress): Promise<Slide | null> {
  const [idxRes, activeRes] = await Promise.all([
    httpFetch(`${base(a)}/presentation/slide_index`, { timeoutMs: 2000 }),
    httpFetch(`${base(a)}/presentation/active`, { timeoutMs: 2000 }),
  ]);
  if (!idxRes.ok) return null;
  const idx = (await idxRes.json()) as { presentation_index?: { index: number; presentation_id?: { uuid: string; name: string } } };
  const pi = idx.presentation_index;
  if (!pi) return null;
  let text = "";
  let label = "";
  let groupName = "";
  if (activeRes.ok) {
    const active = (await activeRes.json()) as {
      presentation?: { groups?: { name: string; slides: { text?: string; label?: string }[] }[] };
    };
    const groups = active.presentation?.groups ?? [];
    let n = 0;
    for (const g of groups) {
      for (const s of g.slides) {
        if (n === pi.index) {
          text = s.text ?? "";
          label = s.label ?? "";
          groupName = g.name;
        }
        n++;
      }
    }
  }
  return {
    presentationName: pi.presentation_id?.name ?? "",
    presentationUuid: pi.presentation_id?.uuid ?? "",
    slideIndex: pi.index,
    text,
    label,
    groupName,
  };
}

/** Library, playlist and presentation lookups the server asks for (song import, preview sync). */
export async function query(a: PpAddress, path: string): Promise<unknown> {
  const r = await httpFetch(`${base(a)}${path}`, { timeoutMs: 5000 });
  if (!r.ok) throw new Error(`ProPresenter ${path} → ${r.status}`);
  return r.json();
}
