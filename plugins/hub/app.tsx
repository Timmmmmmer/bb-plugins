// bb-plugin-hub — the "Plugin hub" sidebar page.
//
// Order: packages, marketplace plugins, sync time, one box to add a plugin
// (drop a folder or .zip, or paste a URL), then search to add from a marketplace.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PackageView, PluginFolder, rpcContract, Schedule, SyncReport, SyncResult } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Run = (key: string, action: () => Promise<unknown>) => Promise<void>;
type HubData = {
  repo: string;
  folders: PluginFolder[];
  packages: PackageView[];
  marketplace: { label: string; entry: string }[];
  lastSync: SyncReport | null;
  schedule: Schedule;
  hubVersion: string | null;
};

const PROBLEM: SyncResult["outcome"][] = ["failed", "other-source"];
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Title({ children }: { children: ReactNode }) {
  return <h2 className="mt-5 mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</h2>;
}

function List({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">{children}</ul>;
}

/** One concise row: name, status, optional action. Details show on hover. */
function Row({
  name,
  result,
  action,
  icon,
  details,
}: {
  name: string;
  result: SyncResult | null;
  action?: ReactNode;
  icon?: ReactNode;
  /** Shown in a panel that drops down under the row from the info button. */
  details?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const status = result === null ? "pending" : result.outcome === "current" ? "up to date" : result.outcome;
  return (
    <li className="text-sm">
      <div className="flex items-center gap-2 px-3 py-1.5" title={result?.detail ?? undefined}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className={cn("shrink-0 text-xs", result !== null && PROBLEM.includes(result.outcome) ? "text-destructive" : "text-muted-foreground")}>
          {status}
        </span>
        {action}
        {details === undefined ? null : (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            aria-label={`About ${name}`}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? "ChevronUp" : "Info"} className="size-3.5" />
          </Button>
        )}
      </div>
      {open && details !== undefined ? <div className="border-t border-border bg-muted/40 px-3 py-2 text-xs">{details}</div> : null}
    </li>
  );
}

/** Label/value lines for a plugin's info panel. */
function Details({ entry, result }: { entry: PackageView; result: SyncResult | null }) {
  const info = entry.info;
  if (info === null) return <p className="text-muted-foreground">Couldn't read this plugin's details from its repository.</p>;
  const lines: [string, ReactNode][] = [
    ["Type", entry.kind === "remote" ? "Remote plugin (installed from its own repository)" : "Local plugin (a folder in the shared repository)"],
    ["Plugin id", <code key="id">{info.pluginId}</code>],
    ["Location", <code key="loc">{entry.kind === "local" ? entry.path : `${entry.repo}${entry.path ? `/${entry.path}` : ""}${entry.ref ? `@${entry.ref}` : ""}`}</code>],
    ["Installed", info.installedVersion === null ? "not installed here" : `${info.installedVersion}${info.enabled === false ? " (disabled)" : ""}`],
    ["Latest", info.latestVersion ?? "unknown"],
  ];
  if (info.updatedAt !== null) lines.push(["Last updated", new Date(info.updatedAt).toLocaleString()]);
  if (result?.detail) lines.push(["Last sync", `${result.outcome}: ${result.detail}`]);
  return (
    <div>
      {info.description ? <p className="mb-1.5 text-foreground">{info.description}</p> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {lines.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <a href={info.webUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-foreground underline underline-offset-2">
        <Icon name="ExternalLink" className="size-3" />
        View source
      </a>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}

// ---------------------------------------------------------------------------
// 1-2. Packages and marketplace plugins

/** Local (folders in the shared repo) and remote (other public repos) plugins, in one list. */
function Plugins({ data, busy, rpc, run }: { data: HubData; busy: string | null; rpc: Rpc; run: Run }) {
  const nameFor = (entry: PackageView) => entry.info?.name ?? entry.label;
  const resultFor = (label: string) => data.lastSync?.results.find((result) => result.repo === label) ?? null;
  return (
    <>
      <Title>Plugins</Title>
      {data.packages.length === 0 ? (
        <Empty>None yet. Add one below.</Empty>
      ) : (
        <List>
          {data.packages.map((entry) => (
            <Row
              key={entry.label}
              name={nameFor(entry)}
              result={resultFor(entry.label)}
              details={<Details entry={entry} result={resultFor(entry.label)} />}
              icon={
                <span title={entry.kind === "remote" ? "remote plugin" : "local plugin"} className="shrink-0 text-muted-foreground">
                  <Icon name={entry.kind === "remote" ? "Link" : "Folder"} className="size-3.5" />
                </span>
              }
              action={
                entry.kind === "remote" ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${entry.label}`}
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`rremove:${entry.label}`, () =>
                        rpc.call("hub_remote_remove", { repo: entry.repo, ...(entry.path ? { path: entry.path } : {}) }),
                      )
                    }
                  >
                    <Icon name="X" className="size-3.5" />
                  </Button>
                ) : (
                  <span className="size-6 shrink-0" />
                )
              }
            />
          ))}
        </List>
      )}
    </>
  );
}

function MarketplacePlugins({ data, busy, rpc, run }: { data: HubData; busy: string | null; rpc: Rpc; run: Run }) {
  const resultFor = (label: string) => data.lastSync?.results.find((result) => result.repo === label) ?? null;
  return (
    <>
      <Title>Marketplace plugins</Title>
      {data.marketplace.length === 0 ? (
        <Empty>None yet. Add one below.</Empty>
      ) : (
        <List>
          {data.marketplace.map((item) => (
            <Row
              key={item.entry}
              name={item.entry}
              result={resultFor(item.label)}
              action={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${item.entry}`}
                  disabled={busy !== null}
                  onClick={() => void run(`mremove:${item.entry}`, () => rpc.call("hub_marketplace_remove", { entry: item.entry }))}
                >
                  <Icon name="X" className="size-3.5" />
                </Button>
              }
            />
          ))}
        </List>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 3. Sync time

function SyncLine({ data, busy, rpc, run }: { data: HubData; busy: string | null; rpc: Rpc; run: Run }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const step = data.schedule.intervalMinutes * 60_000;
  const by = Math.floor((now + data.schedule.marginSeconds * 1000) / step) * step + step;
  const self = data.lastSync?.results.find((result) => result.repo === "hub (self)") ?? null;
  return (
    <div className="mt-5">
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Icon name="Clock" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        Next sync <strong className="text-foreground">{time(by)}</strong> (every {data.schedule.intervalMinutes} min, same time for everyone)
        {self !== null && PROBLEM.includes(self.outcome) ? <span className="text-destructive"> · hub: {self.outcome}</span> : null}
      </span>
      <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy !== null} onClick={() => void run("sync", () => rpc.call("hub_sync"))}>
        <Icon name="RefreshCw" className={cn("size-3.5", busy === "sync" && "animate-spin")} />
        Sync now
      </Button>
    </div>
    <p className="mt-0.5 pl-5.5 text-xs text-muted-foreground">
      Hub {data.hubVersion ?? "version unknown"}
      {self === null ? "" : self.outcome === "updating" ? " · updating…" : self.outcome === "current" ? " · up to date" : ` · ${self.outcome}`}
    </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Add a plugin: drop a folder or .zip, or paste a URL

const SKIPPED = new Set(["node_modules", "dist", ".git", ".claude"]);
const isSkipped = (segment: string) => SKIPPED.has(segment) || segment === ".env" || segment.startsWith(".env.");
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ARCHIVE = /\.(zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/iu;

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

type Entry = { isFile: boolean; isDirectory: boolean; name: string; fullPath: string };
type FileEntry = Entry & { file: (ok: (file: File) => void, fail: (error: unknown) => void) => void };
type DirEntry = Entry & { createReader: () => { readEntries: (ok: (entries: Entry[]) => void, fail: (error: unknown) => void) => void } };

/** Every file in a dropped folder, with its path relative to the drop, skipping junk. */
async function readDroppedFolder(root: DirEntry): Promise<{ path: string; file: File }[]> {
  const out: { path: string; file: File }[] = [];
  const walk = async (entry: Entry, prefix: string): Promise<void> => {
    if (isSkipped(entry.name)) return;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isFile) {
      out.push({ path: relative, file: await new Promise<File>((ok, fail) => (entry as FileEntry).file(ok, fail)) });
    } else if (entry.isDirectory) {
      const reader = (entry as DirEntry).createReader();
      for (;;) {
        const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, relative);
      }
    }
  };
  await walk(root, "");
  return out;
}

function AddPlugin({ busy, rpc, run }: { busy: string | null; rpc: Rpc; run: Run }) {
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const add = (input: Parameters<Rpc["call"]>[1] & object) =>
    run("add", async () => {
      setMessage(null);
      const added = await rpc.call("hub_add_plugin", input as never);
      setUrl("");
      setMessage(
        added.unchanged
          ? `${added.folder} is unchanged.`
          : `${added.kind === "remote" ? "Now pointing to" : "Copied in"} ${added.folder}. Everyone has it by ${time(Date.parse(added.guaranteedBy))}.`,
      );
    });

  const addFiles = async (files: { path: string; file: File }[]) => {
    const size = files.reduce((total, item) => total + item.file.size, 0);
    if (files.length === 0) return setMessage("That folder has no files to add.");
    if (size > MAX_UPLOAD_BYTES) return setMessage(`Too large (${Math.round(size / 1024 / 1024)} MB without node_modules); the limit is 8 MB.`);
    await add({ files: await Promise.all(files.map(async (item) => ({ path: item.path, data: await toBase64(item.file) }))) });
  };
  const addArchive = async (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) return setMessage(`${file.name} is over 8 MB.`);
    await add({ archive: { name: file.name, data: await toBase64(file) } });
  };

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    if (busy !== null) return;
    const item = event.dataTransfer.items[0];
    const entry = (item?.webkitGetAsEntry?.() ?? null) as unknown as Entry | null;
    if (entry?.isDirectory) return addFiles(await readDroppedFolder(entry as unknown as DirEntry));
    const file = event.dataTransfer.files[0];
    if (file !== undefined && ARCHIVE.test(file.name)) return addArchive(file);
    const text = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (text.trim() !== "") return add({ source: text.trim() });
    setMessage("Drop a plugin folder, a .zip, or a link.");
  };

  return (
    <>
      <Title>Add a plugin</Title>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => void onDrop(event)}
        className={cn(
          "rounded-lg border border-dashed px-3 py-3 transition-colors",
          over ? "border-foreground bg-state-hover" : "border-border bg-card",
        )}
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (url.trim() !== "" && busy === null) void add({ source: url.trim() });
          }}
        >
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Drop a folder or .zip, or paste a public repo link"
            aria-label="Plugin link"
            className="h-8"
          />
          <Button type="submit" size="sm" disabled={busy !== null || url.trim() === ""}>
            {busy === "add" ? "Adding…" : "Add"}
          </Button>
          <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label="Choose a .zip" onClick={() => picker.current?.click()}>
            <Icon name="Paperclip" className="size-4" />
          </Button>
          <input
            ref={picker}
            type="file"
            accept=".zip,.tar,.tgz,.gz,.bz2,.xz"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) void addArchive(file);
            }}
          />
        </form>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Repos are pointed to (they must be public); folders and zips are copied in.
        </p>
        {message === null ? null : <p className="mt-1 text-xs">{message}</p>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 5. Add from the marketplace

type SearchResult = { entry: string; displayName: string; description: string; installed: boolean; compatible: boolean };

function AddFromMarketplace({ data, busy, rpc, run }: { data: HubData; busy: string | null; rpc: Rpc; run: Run }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const listed = new Set(data.marketplace.map((item) => item.entry));
  return (
    <>
      <Title>Add from the marketplace</Title>
      <form
        className="flex items-center gap-2"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (query.trim() !== "") void run("search", async () => setResults(await rpc.call("hub_marketplace_search", { query: query.trim() })));
        }}
      >
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search the marketplace" className="h-8" />
        <Button type="submit" size="sm" variant="outline" disabled={busy !== null || query.trim() === ""}>
          {busy === "search" ? "…" : "Search"}
        </Button>
      </form>
      {results === null ? null : results.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No matches.</p>
      ) : (
        <div className="mt-2">
          <List>
            {results.slice(0, 10).map((result) => (
              <li key={result.entry} className="flex items-center gap-2 px-3 py-1.5 text-sm" title={result.description}>
                <span className="min-w-0 flex-1 truncate">{result.displayName}</span>
                {listed.has(result.entry) ? (
                  <span className="text-xs text-muted-foreground">added</span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2"
                    disabled={busy !== null || !result.compatible}
                    onClick={() => void run(`madd:${result.entry}`, () => rpc.call("hub_marketplace_add", { entry: result.entry }))}
                  >
                    {busy === `madd:${result.entry}` ? "Adding…" : result.compatible ? "Add" : "Incompatible"}
                  </Button>
                )}
              </li>
            ))}
          </List>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function HubPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<HubData | null>(null);
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

  const run: Run = async (key, action) => {
    setBusy(key);
    setError(null);
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
      <div className="mx-auto box-border w-full max-w-2xl px-4 pb-6 pt-1 md:px-5">
        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        {data === null ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <Plugins data={data} busy={busy} rpc={rpc} run={run} />
            <MarketplacePlugins data={data} busy={busy} rpc={rpc} run={run} />
            <SyncLine data={data} busy={busy} rpc={rpc} run={run} />
            <AddPlugin busy={busy} rpc={rpc} run={run} />
            <AddFromMarketplace data={data} busy={busy} rpc={rpc} run={run} />
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "plugin-hub", title: "Plugin hub", icon: "Package", path: "plugin-hub", component: HubPage });
});
