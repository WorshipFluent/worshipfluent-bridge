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

// ---------------------------------------------------------------------------
// Library / playlist / presentation lookups the server asks for (the Songs →
// Sync from ProPresenter page). Shapes mirror the old Python bridge exactly:
// the server reads these field names (api/propresenter.py).
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idOf = (item: Rec): { uuid: string; name: string } => {
  const id = rec(item.id);
  return { uuid: str(id.uuid) || str(item.uuid), name: str(id.name) || str(item.name) };
};

/** [{id, name}] for every library. */
export async function libraries(a: PpAddress): Promise<{ id: string; name: string }[]> {
  const data = await query(a, "/libraries");
  const items = Array.isArray(data) ? data : (rec(data).libraries as unknown[]) ?? [];
  return items.map((it) => {
    const { uuid, name } = idOf(rec(it));
    return { id: uuid, name };
  });
}

/** [{name, uuid}] for the presentations in one library. */
export async function libraryItems(a: PpAddress, libId: string): Promise<{ name: string; uuid: string }[]> {
  const data = await query(a, `/library/${encodeURIComponent(libId)}`);
  const items = Array.isArray(data) ? data : (rec(data).items as unknown[]) ?? [];
  return items.map((it) => ({ name: str(rec(it).name), uuid: str(rec(it).uuid) }));
}

/**
 * [{id, name}] for every playlist. ProPresenter nests playlists in folders
 * ("group" items with children); the old bridge listed only the top level,
 * which hid anything in a folder. Folders are walked here and shown as
 * "Folder / Playlist".
 */
export async function playlists(a: PpAddress): Promise<{ id: string; name: string }[]> {
  const data = await query(a, "/playlists");
  const items = Array.isArray(data) ? data : (rec(data).playlists as unknown[]) ?? [];
  const out: { id: string; name: string }[] = [];
  const walk = (list: unknown[], prefix: string) => {
    for (const raw of list) {
      const it = rec(raw);
      const { uuid, name } = idOf(it);
      const children = it.children as unknown[] | undefined;
      if (str(it.field_type ?? it.type) === "group" || (Array.isArray(children) && children.length)) {
        walk(Array.isArray(children) ? children : [], prefix ? `${prefix} / ${name}` : name);
        continue;
      }
      if (uuid) out.push({ id: uuid, name: prefix ? `${prefix} / ${name}` : name });
    }
  };
  walk(items, "");
  return out;
}

/** [{name, uuid}] for the presentations in one playlist (uuid = the presentation's, not the item's). */
export async function playlistItems(a: PpAddress, playlistId: string): Promise<{ name: string; uuid: string }[]> {
  const data = await query(a, `/playlist/${encodeURIComponent(playlistId)}`);
  const items = Array.isArray(data) ? data : (rec(data).items as unknown[]) ?? [];
  const out: { name: string; uuid: string }[] = [];
  for (const raw of items) {
    const it = rec(raw);
    if (str(it.type) !== "presentation") continue;
    const { uuid: itemUuid, name } = idOf(it);
    const info = rec(it.presentation_info);
    const uuid = str(info.presentation_uuid) || str(it.target_uuid) || itemUuid;
    if (uuid && name) out.push({ name, uuid });
  }
  return out;
}

/** The slide text of one presentation, grouped, header-stripped, empty slides dropped. */
export async function presentation(a: PpAddress, uuid: string): Promise<{ presentation_path: string; groups: { name: string; slides: { text: string }[] }[] } | null> {
  const data = await query(a, `/presentation/${encodeURIComponent(uuid)}`);
  const pres = rec(rec(data).presentation);
  if (!Object.keys(pres).length) return null;
  const groups: { name: string; slides: { text: string }[] }[] = [];
  for (const g of (pres.groups as unknown[]) ?? []) {
    const group = rec(g);
    const slides = ((group.slides as unknown[]) ?? [])
      .map((s) => ({ text: cleanSlideText(str(rec(s).text)) }))
      .filter((s) => s.text.trim());
    if (slides.length) groups.push({ name: str(group.name), slides });
  }
  return { presentation_path: str(pres.presentation_path), groups };
}

/** ProPresenter's Bible module puts a header before \r ("Genesis 2:1-3\r1Thus…"); drop it. */
export function cleanSlideText(text: string): string {
  const i = text.indexOf("\r");
  return i >= 0 ? text.slice(i + 1) : text;
}
