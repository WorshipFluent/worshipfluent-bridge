/**
 * ProPresenter's local HTTP API (Preferences → Network → Enable Network). The
 * app never trusts an open port: a computer is "ProPresenter" only when
 * /version answers like ProPresenter.
 */
import { httpFetch, scanLan } from "./platform";

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
  try {
    const r = await httpFetch(`${base(a)}/version`, { timeoutMs });
    if (!r.ok) return null;
    const j = (await r.json()) as { host_description?: string; name?: string; api_version?: string };
    if (!j || typeof j !== "object" || !("api_version" in j || "host_description" in j)) return null;
    return { ...a, version: j.host_description ?? j.api_version ?? "", name: j.name ?? a.host };
  } catch {
    return null;
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
