"use client";

import { useState } from "react";
import { getApiMode, getLloydApi } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";

export function SettingsView() {
  const api = getLloydApi();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = getApiMode() === "http";

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="font-serif text-[26px] text-navy">Settings</h1>
        <p className="text-sm text-muted">Workstation connection. Credentials stay on the server; this browser never stores them.</p>
      </div>
      <Panel title="Connection">
        <p className="text-sm">
          Submissions: <span className="font-medium">{live ? "Live Lloyd API" : "Offline fixtures"}</span>
        </p>
        <p className="mt-1 text-[12.5px] text-muted">
          The dashboard reads the case store through a same-origin proxy. Raw camera preview still requires a direct pairing with the RDK X5.
        </p>
      </Panel>
      {live ? (
        <Panel title="Schema">
          <p className="text-sm text-muted">Reload Federato schema mappings without changing stored cases.</p>
          <Button
            className="mt-3"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMessage(null);
              try {
                await api.resetDemo();
                setMessage("Schema mappings reloaded.");
              } catch (error) {
                setMessage(error instanceof Error ? error.message : "Reload failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Reload schema
          </Button>
          {message ? <p className="mt-2 text-sm text-emerald">{message}</p> : null}
        </Panel>
      ) : null}
    </div>
  );
}
