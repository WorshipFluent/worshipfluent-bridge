/**
 * The WorshipFluent server: pairing, and the socket that carries slides up and
 * lookups down. The token travels in the first socket message, never in a URL.
 */
import { BACKEND_URL, httpFetch, openSocket, Socket, mockState } from "./platform";
import { PpAddress, PpInfo, Slide, query } from "./propresenter";

export interface PairStart {
  code: string;
  secret: string;
  expires_in: number;
  poll_interval: number;
  approve_url: string;
}

export interface Paired {
  token: string;
  church_id: number;
  church_name: string;
  device_id: string;
  device_name: string;
}

export async function pairStart(): Promise<PairStart> {
  if (mockState) {
    return {
      code: "K7PR-4Q2M",
      secret: "mock",
      expires_in: 600,
      poll_interval: 3,
      approve_url: "https://app.worshipfluent.com/settings?pair=K7PR-4Q2M",
    };
  }
  const r = await httpFetch(`${BACKEND_URL}/api/propresenter/pair/start`, { method: "POST", timeoutMs: 8000 });
  if (!r.ok) throw new Error(`pair/start → ${r.status}`);
  return r.json();
}

export type PollResult =
  | { status: "pending" | "unknown" | "expired" | "used" }
  | ({ status: "approved" } & Paired);

export async function pairPoll(code: string, secret?: string, deviceName?: string): Promise<PollResult> {
  if (mockState) return { status: "pending" };
  const q = new URLSearchParams({ code });
  if (secret) q.set("secret", secret);
  if (deviceName) q.set("device_name", deviceName);
  const r = await httpFetch(`${BACKEND_URL}/api/propresenter/pair/poll?${q}`, { timeoutMs: 8000 });
  if (r.status === 403) return { status: "unknown" };
  if (!r.ok) throw new Error(`pair/poll → ${r.status}`);
  return r.json();
}

/** A friendly name for this computer, for the Settings card. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "PC" : /Mac/.test(ua) ? "Mac" : "computer";
  return `ProPresenter ${os}`;
}

export interface LinkEvents {
  onConnected(info: { church_name?: string; device_name?: string; live: boolean }): void;
  onLive(live: boolean): void;
  onError(code: string, message: string): void;
  onClosed(): void;
}

/**
 * The live link: one socket per app, reconnecting on its own. Slides go up as
 * presentation_changed / slide_changed; the server's lookups (get_playlists…)
 * are answered from ProPresenter.
 */
export class ServerLink {
  private socket: Socket | null = null;
  private stopped = false;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private lastKey = "";
  pp: PpAddress | null = null;
  ppInfo: PpInfo | null = null;
  paused = false;

  constructor(
    private token: string,
    private churchId: number,
    private events: LinkEvents,
  ) {}

  async start() {
    this.stopped = false;
    await this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    await this.socket?.close();
    this.socket = null;
  }

  private async connect() {
    if (this.stopped) return;
    const url = `${BACKEND_URL.replace(/^http/, "ws")}/api/propresenter/ws/propresenter/${this.churchId}`;
    try {
      this.socket = await openSocket(
        url,
        (m) => this.onMessage(m),
        () => this.onClose(),
      );
      await this.socket.send({
        type: "auth",
        token: this.token,
        propresenter: this.ppInfo ? { version: this.ppInfo.version } : undefined,
      });
      if (this.statusTimer) clearInterval(this.statusTimer);
      this.statusTimer = setInterval(() => this.socket?.send({ type: "status" }).catch(() => undefined), 10_000);
    } catch {
      this.scheduleReconnect();
    }
  }

  private onClose() {
    this.socket = null;
    this.events.onClosed();
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    setTimeout(() => this.connect(), 3000);
  }

  private async onMessage(m: Record<string, unknown>) {
    switch (m.type) {
      case "connected":
        this.events.onConnected({
          church_name: m.church_name as string | undefined,
          device_name: m.device_name as string | undefined,
          live: Boolean(m.live),
        });
        this.lastKey = ""; // resend the current slide on a fresh socket
        break;
      case "status":
        this.events.onLive(Boolean(m.live));
        break;
      case "error":
        this.events.onError((m.code as string) || "error", (m.error as string) || "The server refused the connection");
        if (m.code === "unpaired") this.stopped = true; // no point retrying; the screen asks to pair again
        break;
      case "ping":
        await this.socket?.send({ type: "pong" });
        break;
      case "get_active":
      case "get_libraries":
      case "get_library":
      case "get_playlists":
      case "get_playlist":
      case "get_presentation":
        await this.answerLookup(m);
        break;
      default:
        break;
    }
  }

  private async answerLookup(m: Record<string, unknown>) {
    const reply = (type: string, body: Record<string, unknown>) =>
      this.socket?.send({ type, request_id: m.request_id, ...body });
    if (!this.pp) {
      await reply("query_reply", { error: "ProPresenter not connected" });
      return;
    }
    try {
      switch (m.type) {
        case "get_libraries":
          await reply("libraries_reply", { libraries: await query(this.pp, "/libraries") });
          break;
        case "get_library":
          await reply("library_reply", { library: await query(this.pp, `/library/${m.uuid}`) });
          break;
        case "get_playlists":
          await reply("playlists_reply", { playlists: await query(this.pp, "/playlists") });
          break;
        case "get_playlist":
          await reply("playlist_reply", { playlist: await query(this.pp, `/playlist/${m.uuid}`) });
          break;
        case "get_presentation":
          await reply("presentation_reply", { presentation: await query(this.pp, `/presentation/${m.uuid}`) });
          break;
        case "get_active":
          await reply("query_reply", { active: await query(this.pp, "/presentation/active") });
          break;
      }
    } catch (e) {
      await reply("query_reply", { error: String(e) });
    }
  }

  /** Called by the poller about once a second with ProPresenter's current slide. */
  async report(slide: Slide | null) {
    if (!this.socket || this.paused) return;
    if (!slide) {
      if (this.lastKey !== "clear") {
        this.lastKey = "clear";
        await this.socket.send({ type: "presentation_changed", name: "", uuid: "", slide_index: -1, slide_text: "" });
      }
      return;
    }
    const key = `${slide.presentationUuid}:${slide.slideIndex}`;
    if (key === this.lastKey) return;
    const presentationChanged = !this.lastKey.startsWith(`${slide.presentationUuid}:`);
    this.lastKey = key;
    await this.socket.send({
      type: presentationChanged ? "presentation_changed" : "slide_changed",
      name: slide.presentationName,
      uuid: slide.presentationUuid,
      slide_index: slide.slideIndex,
      index: slide.slideIndex,
      slide_text: slide.text,
      slide_label: slide.label,
      group_name: slide.groupName,
    });
  }
}
