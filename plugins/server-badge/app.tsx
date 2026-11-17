// Server Badge frontend: a small fixed pill in the bottom-right corner that
// says Development, Production, or Local, followed by the server's name.
import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { Environment, rpcContract, ServerInfo } from "./server";

// Production stands out (red), Development reads as safe (green), Local is neutral.
const TINT: Record<Environment, { dot: string; background: string; border: string }> = {
  Production: { dot: "#dc2626", background: "rgba(220, 38, 38, 0.14)", border: "rgba(220, 38, 38, 0.45)" },
  Development: { dot: "#16a34a", background: "rgba(22, 163, 74, 0.14)", border: "rgba(22, 163, 74, 0.45)" },
  Local: { dot: "#6b7280", background: "var(--muted, rgba(127,127,127,0.15))", border: "var(--border, rgba(127,127,127,0.3))" },
};

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
  const tint = TINT[info.environment];
  return (
    <div
      title={`${info.environment} (${info.environmentReason})\nhost: ${info.hostname}\nuser: ${info.user}\nport: ${info.port}\napp url: ${info.appUrl ?? "(none)"}`}
      style={{
        position: "fixed",
        right: 8,
        bottom: 8,
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 14,
        lineHeight: "22px",
        fontFamily: "ui-monospace, monospace",
        background: tint.background,
        color: "var(--foreground, inherit)",
        border: `1px solid ${tint.border}`,
        opacity: 0.9,
        userSelect: "text",
      }}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: tint.dot, flexShrink: 0 }} />
      <strong style={{ fontWeight: 600 }}>{info.environment}</strong>
      <span style={{ opacity: 0.75 }}>{info.label}</span>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "server-badge", component: ServerBadge });
});
