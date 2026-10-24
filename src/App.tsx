import { useBridge } from "./lib/state";
import { Pair } from "./screens/Pair";
import { Status } from "./screens/Status";

export default function App() {
  const { state, actions } = useBridge();
  if (state.booting) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <span className="pulse">Starting…</span>
      </div>
    );
  }
  return (
    <div className="relative h-full overflow-hidden">
      {state.phase === "unpaired" ? <Pair state={state} /> : <Status state={state} actions={actions} />}
    </div>
  );
}
