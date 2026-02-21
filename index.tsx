import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { PwaToast } from './components/PwaToast';
import { initServiceWorker } from './services/pwaRegistration';

/* ── PWA service-worker registration ─────────────────────────────── */

type PwaState = { show: false } | { show: true; kind: 'update' | 'offline'; apply: () => void };

let pwaState: PwaState = { show: false };
let rerenderPwa: (() => void) | null = null;

function setPwa(next: PwaState) {
  pwaState = next;
  rerenderPwa?.();
}

const { applyUpdate } = initServiceWorker(
  /* onNeedRefresh */ () => setPwa({ show: true, kind: 'update', apply: applyUpdate }),
  /* onOfflineReady */ () => setPwa({ show: true, kind: 'offline', apply: () => {} }),
);

function PwaOverlay() {
  const [, forceUpdate] = React.useReducer((c: number) => c + 1, 0);
  React.useEffect(() => { rerenderPwa = forceUpdate; return () => { rerenderPwa = null; }; }, []);

  if (!pwaState.show) return null;
  return (
    <PwaToast
      kind={pwaState.kind}
      onAccept={() => { if (pwaState.show) pwaState.apply(); setPwa({ show: false }); }}
      onDismiss={() => setPwa({ show: false })}
    />
  );
}

/* ── Mount React ─────────────────────────────────────────────────── */

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
    <PwaOverlay />
  </React.StrictMode>
);
