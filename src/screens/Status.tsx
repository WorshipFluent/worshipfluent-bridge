import { useState } from "react";
import { AppState } from "../lib/state";

type Actions = {
  openManual: () => void;
  closeManual: () => void;
  useManualAddress: (host: string, port: number) => Promise<void>;
  retryDiscovery: () => void;
  changeProPresenter: () => Promise<void>;
  togglePause: () => Promise<void>;
  setAutostart: (on: boolean) => Promise<void>;
  unpair: () => Promise<void>;
};

function Dot({ tone }: { tone: "good" | "warn" | "bad" | "off"; pulse?: boolean }) {
  const cls = { good: "bg-good", warn: "bg-warn pulse", bad: "bg-bad", off: "bg-subtle" }[tone];
  return <span className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} />;
}

function Row({ tone, label, children }: { tone: "good" | "warn" | "bad" | "off"; label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_112px_1fr] items-start gap-x-3 gap-y-0.5">
      <Dot tone={tone} />
      <div className="font-semibold">{label}</div>
      <div className="min-w-0 text-muted">{children}</div>
    </div>
  );
}

function ago(ts?: number) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

export function Status({ state, actions }: { state: AppState; actions: Actions }) {
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const title =
    state.phase === "live" ? "Live" : state.phase === "ready" ? "Ready" : state.ppSearch === "none" ? "Can't find ProPresenter" : "Looking for ProPresenter";

  const serverTone = state.server === "connected" ? "good" : state.server === "refused" ? "bad" : "warn";
  const serverText =
    state.server === "connected"
      ? `Paired as ${state.deviceName ?? "this computer"}`
      : state.server === "refused"
        ? state.serverError
        : "Connecting…";

  const ppTone = state.pp ? "good" : state.ppSearch === "none" ? "bad" : "warn";
  const ppText = state.pp
    ? `${state.pp.host === "localhost" || state.pp.host === "127.0.0.1" ? "On this computer" : `At ${state.pp.host}`} · ${state.pp.version || "ProPresenter"}`
    : state.ppSearch === "none"
      ? "Not found on this computer or the network"
      : state.ppSearch === "lan"
        ? "Checking the local network…"
        : "Checking this computer…";

  const serviceTone = state.phase === "live" ? "good" : "off";

  return (
    <div className="flex h-full flex-col gap-5 p-7">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold">{state.churchName ?? "WorshipFluent"}</div>
          <h1>{title}</h1>
        </div>
        {state.paused && <span className="rounded-full bg-warn-dim px-3 py-1 text-xs font-semibold text-warn">Cues paused</span>}
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        <Row tone={serverTone} label="WorshipFluent">
          {serverText}
          {state.server === "connected" && (
            <>
              {" · "}
              <button className="text-muted underline-offset-2 hover:text-text hover:underline" onClick={() => setConfirmUnpair(true)}>
                Unpair
              </button>
            </>
          )}
        </Row>
        <Row tone={ppTone} label="ProPresenter">
          {ppText}
          {state.pp && (
            <>
              {" · "}
              <button className="text-muted underline-offset-2 hover:text-text hover:underline" onClick={actions.changeProPresenter}>
                Change
              </button>
            </>
          )}
        </Row>
        <Row tone={serviceTone} label="Service">
          {state.phase === "live" ? (
            <span className="text-text">
              Live · cues flowing{state.lastCueAt ? ` · last cue ${ago(state.lastCueAt)}` : ""}
            </span>
          ) : state.pp ? (
            "No service running. Cues start flowing when someone presses Start service."
          ) : (
            "—"
          )}
        </Row>
      </div>

      {state.phase === "live" && state.slide && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">Now showing</div>
          <div className="mt-1 text-lg font-semibold">
            {state.slide.presentationName || "Untitled"} <span className="font-normal text-muted">· slide {state.slide.slideIndex + 1}</span>
          </div>
          {state.slide.text && <div className="mt-1 line-clamp-2 text-muted">{state.slide.text}</div>}
        </div>
      )}

      {!state.pp && state.ppSearch === "none" && !state.manual && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
          <p>
            In ProPresenter open <b>Preferences → Network</b>, turn on <b>Enable Network</b>, and set the port to <b>50001</b>. We'll
            connect the moment it answers.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-lg bg-gold px-3 py-1.5 font-semibold text-bg hover:brightness-110" onClick={actions.retryDiscovery}>
              Look again
            </button>
            <button className="rounded-lg border border-border px-3 py-1.5 font-semibold hover:bg-gold-dim" onClick={actions.openManual}>
              ProPresenter is on another computer
            </button>
          </div>
        </div>
      )}

      {state.manual && <ManualAddress state={state} actions={actions} />}

      {state.update && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-gold/40 bg-gold-dim px-4 py-3">
          <div>
            <div className="font-semibold">Update available</div>
            <div className="text-xs text-muted">Version {state.update.version} · installs in a few seconds</div>
          </div>
          <button className="rounded-lg bg-gold px-3 py-1.5 font-semibold text-bg hover:brightness-110" onClick={() => state.update?.install()}>
            Install
          </button>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input id="autostart" type="checkbox" className="accent-gold" checked={state.autostart} onChange={(e) => actions.setAutostart(e.target.checked)} />
          Start when this computer starts
        </label>
        <div className="flex items-center justify-between text-xs text-muted">
          <span>Closing this window keeps the bridge running in the tray.</span>
          <span>v{state.version}</span>
        </div>
      </div>

      {confirmUnpair && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/80 p-7">
          <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-5">
            <div className="font-semibold">Unpair this computer?</div>
            <p className="text-muted">Slides stop reaching {state.churchName ?? "the church"} until a computer is paired again.</p>
            <div className="flex justify-end gap-2">
              <button className="rounded-lg border border-border px-3 py-1.5 font-semibold" onClick={() => setConfirmUnpair(false)}>
                Keep
              </button>
              <button
                className="rounded-lg bg-bad px-3 py-1.5 font-semibold text-bg"
                onClick={() => {
                  setConfirmUnpair(false);
                  void actions.unpair();
                }}
              >
                Unpair
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ManualAddress({ state, actions }: { state: AppState; actions: Actions }) {
  const [host, setHost] = useState(state.manual?.host ?? "");
  const [port, setPort] = useState(String(state.manual?.port ?? 50001));
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await actions.useManualAddress(host, Number(port) || 50001);
        setBusy(false);
      }}
    >
      <div className="font-semibold">Where is ProPresenter?</div>
      <p className="text-muted">
        On the ProPresenter computer, open <b>Preferences → Network</b>. The address and port are shown there.
      </p>
      <div className="flex gap-2">
        <input
          id="pp-host"
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-gold"
          placeholder="192.168.1.20"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          autoFocus
        />
        <input
          id="pp-port"
          className="w-24 rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-gold"
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
        />
      </div>
      {state.manual?.error && <div className="text-sm text-bad">{state.manual.error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-lg border border-border px-3 py-1.5 font-semibold" onClick={actions.closeManual}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !host} className="rounded-lg bg-gold px-3 py-1.5 font-semibold text-bg disabled:opacity-50">
          {busy ? "Checking…" : "Connect"}
        </button>
      </div>
    </form>
  );
}
