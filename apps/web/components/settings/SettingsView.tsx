"use client";

import { useState } from "react";
import { getApiMode, getLloydApi } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";

export function SettingsView() {
  const api = getLloydApi();
  const [latency, setLatency] = useState(api.getLatency());
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="font-serif text-[26px] text-navy">Settings</h1>
        <p className="text-sm text-muted">Demo controls only. No credentials are stored in the browser.</p>
      </div>
      <Panel title="API mode">
        <p className="text-sm">
          Active client: <span className="font-medium">{getApiMode()}</span>
        </p>
        <p className="mt-1 text-[12.5px] text-muted">
          Switch with <code>NEXT_PUBLIC_LLOYD_API_MODE=http</code>, <code>NEXT_PUBLIC_LLOYD_API_URL</code>, and{" "}
          <code>NEXT_PUBLIC_LLOYD_EDGE_URL</code>. See INTEGRATION.md.
        </p>
      </Panel>
      <Panel title="Mock latency">
        <label className="block text-sm">
          {latency} ms
          <input
            type="range"
            min={0}
            max={800}
            step={20}
            value={latency}
            onChange={(event) => {
              const value = Number(event.target.value);
              setLatency(value);
              api.setLatency(value);
            }}
            className="mt-2 block w-full"
          />
        </label>
      </Panel>
      <Panel title="Demo rehearsal">
        <p className="text-sm text-muted">Restore seeded queue, intake, and analytics without a backend reset.</p>
        <Button
          className="mt-3"
          onClick={async () => {
            await api.resetDemo();
            setMessage("Seeded demo restored.");
          }}
        >
          Reset demo fixtures
        </Button>
        {message ? <p className="mt-2 text-sm text-emerald">{message}</p> : null}
      </Panel>
    </div>
  );
}
