// bb-plugin-sidebar-text — a sidebar page that shows the configured message.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

function MessagePage() {
  const rpc = useRpc<typeof rpcContract>();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("message_get").then(
      (result) => {
        setMessage(result.message);
        setError(null);
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("message-changed", refetch);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <div className="rounded-lg border border-border bg-card px-5 py-6 text-base whitespace-pre-wrap">
            {message ?? "Loading…"}
          </div>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sidebar-text",
    title: "Sidebar text",
    icon: "MessageSquare",
    path: "sidebar-text",
    component: MessagePage,
  });
});
