// Server Badge frontend: a small fixed pill in the bottom-right corner that
// says Dev server or Prod server, or user:machine:port on a personal machine.
//
// It never gets in the way: it ignores the mouse entirely (clicks go to
// whatever is behind it) and fades out while the cursor is near it.
import { useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, ServerInfo } from "./server";

/** How close the cursor may come before the badge hides: 3% of the window width. */
const NEAR_FRACTION_OF_WIDTH = 0.03;

function ServerBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [near, setNear] = useState(false);
  const badge = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    rpc.call("info").then((i) => live && setInfo(i)).catch(() => {});
    return () => {
      live = false;
    };
  }, [rpc]);

  // Hide while the cursor is within the margin around the badge. The badge
  // has pointer-events: none, so this listens on the window instead.
  useEffect(() => {
    let frame = 0;
    let last: { x: number; y: number } | null = null;
    const check = () => {
      frame = 0;
      const rect = badge.current?.getBoundingClientRect();
      if (!rect || last === null) return;
      const margin = window.innerWidth * NEAR_FRACTION_OF_WIDTH;
      const dx = Math.max(rect.left - last.x, 0, last.x - rect.right);
      const dy = Math.max(rect.top - last.y, 0, last.y - rect.bottom);
      setNear(Math.hypot(dx, dy) <= margin);
    };
    const onMove = (event: PointerEvent) => {
      last = { x: event.clientX, y: event.clientY };
      if (frame === 0) frame = requestAnimationFrame(check);
    };
    const onLeave = () => {
      last = null;
      setNear(false);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, []);

  if (!info) return null;
  // Just the environment; a personal machine (Local) shows user:machine:port.
  const text =
    info.environment === "Local" ? `${info.user}:${info.hostname}:${info.port}` : info.environment === "Development" ? "Dev server" : "Prod server";
  return (
    <div
      ref={badge}
      aria-label={`${info.environment} bb server: ${info.label}`}
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
        // Click-through: the badge never receives the mouse.
        pointerEvents: "none",
        userSelect: "none",
        opacity: near ? 0 : 0.85,
        transition: "opacity 120ms ease",
      }}
    >
      {text}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "server-badge", component: ServerBadge });
});
