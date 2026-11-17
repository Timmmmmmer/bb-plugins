// Server Badge frontend: a small fixed pill in the bottom-right corner that
// says Development or Production, or user:machine:port on a personal machine.
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
  // Just the environment; a personal machine (Local) shows user:machine:port.
  const text = info.environment === "Local" ? `${info.user}:${info.hostname}:${info.port}` : info.environment;
  return (
    <div
      title={`${info.environment} (${info.environmentReason})\n${info.label}\nhost: ${info.hostname}\nuser: ${info.user}\nport: ${info.port}\napp url: ${info.appUrl ?? "(none)"}`}
      // Sized as a fixed share of the window width (vw), so the badge keeps the
      // same proportion of the canvas at any window size: 1.2vw text is about
      // 17px on a 1440px-wide window and 23px on a 1920px one.
      style={{
        position: "fixed",
        right: "0.6vw",
        bottom: "0.6vw",
        zIndex: 40,
        padding: "0.25em 0.8em",
        borderRadius: 999,
        fontSize: "1.2vw",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        fontFamily: "ui-monospace, monospace",
        background: "var(--muted, rgba(127,127,127,0.15))",
        color: "var(--muted-foreground, inherit)",
        border: "1px solid var(--border, rgba(127,127,127,0.3))",
        opacity: 0.85,
        userSelect: "text",
      }}
    >
      {text}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "server-badge", component: ServerBadge });
});
