// Server Badge frontend: a small fixed pill in the bottom-right corner.
import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, ServerInfo } from "./server";

function ServerBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const [info, setInfo] = useState<ServerInfo | null>(null);

  useEffect(() => {
    let live = true;
    rpc.call("info").then((i) => live && setInfo(i)).catch(() => {});
    return () => {
      live = false;
    };
  }, [rpc]);

  if (!info) return null;
  return (
    <div
      title={`host: ${info.hostname}\nuser: ${info.user}\nport: ${info.port}\napp url: ${info.appUrl ?? "(none)"}`}
      style={{
        position: "fixed",
        right: 8,
        bottom: 8,
        zIndex: 40,
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 14,
        lineHeight: "22px",
        fontFamily: "ui-monospace, monospace",
        background: "var(--muted, rgba(127,127,127,0.15))",
        color: "var(--muted-foreground, inherit)",
        border: "1px solid var(--border, rgba(127,127,127,0.3))",
        opacity: 0.85,
        userSelect: "text",
      }}
    >
      {info.label}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "server-badge", component: ServerBadge });
});
