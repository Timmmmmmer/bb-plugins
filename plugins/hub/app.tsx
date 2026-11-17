// bb-plugin-hub — the "Plugin hub" sidebar page.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PackageView, PluginFolder, rpcContract, Schedule, SyncReport, SyncResult } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mt-6 mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</h2>;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const minutesUntil = (ms: number) => Math.max(0, Math.ceil((ms - Date.now()) / 60_000));

/** Same math as the server: boundaries are multiples of the interval since the epoch (UTC). */
function ScheduleBanner({ schedule }: { schedule: Schedule }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const step = schedule.intervalMinutes * 60_000;
  const next = Math.floor(now / step) * step + step;
  const guaranteed = Math.floor((now + schedule.marginSeconds * 1000) / step) * step + step;
  return (
    <div className="mt-3 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <Icon name="Clock" className="size-4 text-muted-foreground" />
        <span>
          A change pushed now reaches <strong>every running hub by {time(guaranteed)}</strong>{" "}
          <span className="text-muted-foreground">(in {minutesUntil(guaranteed)} min)</span>
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        All hubs sync together every {schedule.intervalMinutes} min (next at {time(next)}). Only plugins whose folder
        changed are updated. Changes must be on GitHub {schedule.marginSeconds}s before a sync; hubs that are off catch
        up when they start.
        {schedule.lastSyncDurationMs === null ? "" : ` A sync took ${Math.round(schedule.lastSyncDurationMs / 1000)}s here last time.`}
      </p>
    </div>
  );
}

const PROBLEM: SyncResult["outcome"][] = ["failed", "other-source"];

function PackagesSection({ packages, lastSync }: { packages: PackageView[]; lastSync: SyncReport | null }) {
  const labels = packages.map((entry) => entry.label);
  const resultFor = (label: string) => lastSync?.results.find((result) => result.repo === label) ?? null;
  const self = lastSync?.results.find((result) => result.repo === "hub (self)") ?? null;
  const general = lastSync?.results.filter((result) => !labels.includes(result.repo) && result !== self) ?? [];
  return (
    <>
      <SectionTitle>Packages (packages.json)</SectionTitle>
      {packages.length === 0 ? (
        <EmptyState>No packages yet. Add a folder to packages.json and push.</EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
          {packages.map(({ label }) => {
            const result = resultFor(label);
            return (
              <li key={label} className="py-2.5 text-sm">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                  <span className={cn("text-xs", result !== null && PROBLEM.includes(result.outcome) ? "text-destructive" : "text-muted-foreground")}>
                    {result === null ? "not synced yet" : `${result.outcome}${result.version ? ` · ${result.version.slice(0, 12)}` : ""}`}
                  </span>
                </div>
                {result?.detail ? <p className="mt-1 text-xs text-muted-foreground">{result.detail}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
      {lastSync === null ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          Last sync {new Date(lastSync.at).toLocaleString()} ({lastSync.trigger}), list from {lastSync.packagesFrom}.
        </p>
      )}
      {self === null ? null : (
        <p className={cn("mt-1 text-xs", self.outcome === "failed" ? "text-destructive" : "text-muted-foreground")}>
          Hub itself: {self.outcome}
          {self.detail ? ` — ${self.detail}` : ""}
        </p>
      )}
      {general.map((result, index) => (
        <p key={index} className="mt-1 text-xs text-destructive">
          {result.repo}: {result.detail}
        </p>
      ))}
    </>
  );
}

function HubPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{
    repo: string;
    folders: PluginFolder[];
    packages: PackageView[];
    lastSync: SyncReport | null;
    schedule: Schedule;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const refetch = useCallback(() => {
    rpc.call("hub_list").then((result) => {
      setData(result);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("hub-changed", refetch);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {data === null ? "Loading…" : `Plugins from ${data.repo} (public, no tokens needed).`}
          </p>
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run("sync", () => rpc.call("hub_sync"))}>
            <Icon name="RefreshCw" className="size-4" />
            {busy === "sync" ? "Syncing…" : "Sync now"}
          </Button>
        </div>
        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        {data === null ? null : (
          <>
            <ScheduleBanner schedule={data.schedule} />
            <PackagesSection packages={data.packages} lastSync={data.lastSync} />
            <SectionTitle>Plugin folders in {data.repo}</SectionTitle>
            {data.folders.length === 0 ? (
              <EmptyState>No plugin folders found.</EmptyState>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
                {data.folders.map((folder) => (
                  <li key={folder.path} className="flex items-center gap-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {folder.name}
                        <span className="ml-2 text-xs text-muted-foreground">{folder.path}</span>
                        {folder.isPackage ? <span className="ml-2 text-xs text-muted-foreground">package</span> : null}
                      </div>
                      {folder.description ? <div className="truncate text-xs text-muted-foreground">{folder.description}</div> : null}
                    </div>
                    {folder.installed ? (
                      <span className="text-xs text-muted-foreground">Installed {folder.installedVersion?.slice(0, 12)}</span>
                    ) : null}
                    <Button
                      size="sm"
                      variant={folder.installed ? "ghost" : "default"}
                      disabled={busy !== null}
                      onClick={() => void run(`install:${folder.path}`, () => rpc.call("hub_install", { path: folder.path }))}
                    >
                      {busy === `install:${folder.path}` ? (folder.installed ? "Updating…" : "Installing…") : folder.installed ? "Update" : "Install"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "plugin-hub", title: "Plugin hub", icon: "Package", path: "plugin-hub", component: HubPage });
});
