import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { AppState } from "../lib/state";
import { openUrl, APP_URL } from "../lib/platform";

export function Confirm({ state, onPair, onCancel }: { state: AppState; onPair: () => void; onCancel: () => void }) {
  const g = state.grant!;
  return (
    <div className="flex h-full flex-col gap-6 p-7">
      <div className="flex flex-col gap-2">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold">WorshipFluent</div>
        <h1>Pair this computer with {g.churchName}?</h1>
        <p className="text-muted">
          ProPresenter slides from this computer will be sent to {g.churchName}'s services. You can unpair any time from the app or
          from Settings on the web.
        </p>
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        <div className="grid grid-cols-[112px_1fr] gap-y-1">
          <div className="text-muted">Church</div>
          <div className="font-semibold">{g.churchName}</div>
          <div className="text-muted">This computer</div>
          <div className="font-semibold">{deviceLabel()}</div>
          <div className="text-muted">Request from</div>
          <div className="font-semibold">app.worshipfluent.com, just now</div>
        </div>
      </div>
      {g.error && <p className="rounded-lg bg-bad-dim px-3 py-2 text-bad">{g.error}</p>}
      <div className="mt-auto flex items-center justify-end gap-2">
        <button className="rounded-lg border border-border px-4 py-2 font-semibold hover:bg-gold-dim" onClick={onCancel} disabled={g.busy}>
          Not now
        </button>
        <button className="rounded-lg bg-gold px-5 py-2 font-semibold text-bg hover:brightness-110 disabled:opacity-50" onClick={onPair} disabled={g.busy}>
          {g.busy ? "Pairing…" : "Pair"}
        </button>
      </div>
    </div>
  );
}

function deviceLabel() {
  const ua = navigator.userAgent;
  return /Windows/.test(ua) ? "This Windows PC" : /Mac/.test(ua) ? "This Mac" : "This computer";
}

export function Pair({ state }: { state: AppState }) {
  const p = state.pairing;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const minutesLeft = p ? Math.max(0, Math.ceil((p.expiresAt - now) / 60000)) : 0;

  return (
    <div className="flex h-full flex-col gap-5 p-7">
      <div className="flex flex-col gap-2">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold">WorshipFluent</div>
        <h1>Pair this computer</h1>
        {state.serverError ? (
          <p className="rounded-lg bg-bad-dim px-3 py-2 text-bad">{state.serverError}. Pair it again to continue.</p>
        ) : (
          <p className="text-muted">
            Sign in at <span className="text-text">app.worshipfluent.com</span> on any device, open{" "}
            <span className="text-text">Settings → ProPresenter</span>, and enter this code.
          </p>
        )}
      </div>

      {p?.error ? (
        <div className="rounded-xl border border-border bg-card p-5 text-warn">{p.error}</div>
      ) : (
        <div className="rounded-xl border border-dashed border-gold bg-card px-4 py-5 text-center">
          <div className="code text-text" aria-label={`Pairing code ${p?.code ?? ""}`}>
            {p?.code || "····-····"}
          </div>
          <div className="mt-1 text-xs text-muted">{p ? `New code in ${minutesLeft} min` : "Getting a code…"}</div>
        </div>
      )}

      <div className="flex items-center gap-5">
        <div className="rounded-lg bg-white p-2">
          {p?.approveUrl ? (
            <QRCodeSVG value={p.approveUrl} size={96} level="M" fgColor="#09090F" bgColor="#FFFFFF" />
          ) : (
            <div className="h-24 w-24" />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <button
            className="rounded-lg bg-gold px-4 py-2 font-semibold text-bg hover:brightness-110 disabled:opacity-50"
            disabled={!p?.approveUrl}
            onClick={() => openUrl(p?.approveUrl || `${APP_URL}/settings`)}
          >
            Open the pairing page
          </button>
          <p className="text-xs text-muted">Or scan the code with your phone. Setting up from another device works too.</p>
        </div>
      </div>

      <div className="mt-auto flex items-center gap-2 text-sm text-muted">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${p?.waiting ? "bg-warn pulse" : "bg-subtle"}`} />
        {p?.waiting ? "Waiting for approval…" : "Not connected"}
      </div>
    </div>
  );
}
