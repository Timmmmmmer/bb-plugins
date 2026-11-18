// bb-plugin-hub — the "Plugin hub" sidebar page.
//
// Order: packages, marketplace plugins, sync time, one box to add a plugin
// (drop a folder or .zip, or paste a URL), then search to add from a marketplace.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { BetaView, DevPlugin, PackageView, PluginFolder, rpcContract, Schedule, SyncReport, SyncResult } from "./server";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/glyph";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Run = (key: string, action: () => Promise<unknown>) => Promise<void>;
type GroupView = { id: string; name: string; path: string; subscribed: boolean; home: boolean; status: "ok" | "warning" | "error" };
type HubData = {
  repo: string;
  group: { id: string; name: string; path: string };
  groups: GroupView[];
  folders: PluginFolder[];
  packages: PackageView[];
  marketplace: MarketplaceView[];
  betas: BetaView[];
  devPlugins: DevPlugin[];
  lastSync: SyncReport | null;
  schedule: Schedule;
  hubVersion: string | null;
};
type MarketplaceView = {
  label: string;
  entry: string;
  info: {
    name: string;
    pluginId: string;
    description: string;
    marketplace: string;
    publisher: string;
    category: string | null;
    installs: number | null;
    compatible: boolean;
    incompatibleReason: string | null;
    source: string;
    repositoryUrl: string | null;
    installedVersion: string | null;
    installedFrom: string | null;
    enabled: boolean | null;
  } | null;
};

type Syncing = { trigger: string; startedAt: string } | null;

/** A small spinning indicator with a label. */
function Spinner({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <Glyph name="RefreshCw" className="size-3.5 animate-spin" />
      {children}
    </span>
  );
}

const PROBLEM: SyncResult["outcome"][] = ["failed", "other-source"];
/** Red for a failure, orange for a plugin installed from another source. */
const WARNING_TEXT = "text-orange-500";
const outcomeClass = (outcome: SyncResult["outcome"] | null) =>
  outcome === "failed" ? "text-destructive" : outcome === "other-source" ? WARNING_TEXT : "text-muted-foreground";
const groupClass = (status: GroupView["status"] | undefined) => (status === "error" ? "text-destructive" : status === "warning" ? WARNING_TEXT : undefined);
const isSubscribed = (data: HubData) => data.groups.find((group) => group.id === data.group.id)?.subscribed ?? true;
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
  statusText,
}: {
  name: string;
  result: SyncResult | null;
  action?: ReactNode;
  icon?: ReactNode;
  /** Shown in a panel that drops down under the row from the info button. */
  details?: ReactNode;
  /** Replaces the sync status, e.g. "not subscribed". */
  statusText?: string;
}) {
  const [open, setOpen] = useState(false);
  const status = statusText ?? (result === null ? "pending" : result.outcome === "current" ? "up to date" : result.outcome);
  return (
    <li className="text-sm">
      <div className="flex items-center gap-2 px-3 py-1.5" title={result?.detail ?? undefined}>
        {icon}
        <span className="flex min-w-0 flex-1 items-center gap-0.5">
          <span className="min-w-0 truncate">{name}</span>
          {details === undefined ? null : (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={`About ${name}`}
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              <Glyph name={open ? "ChevronUp" : "Info"} className="size-3.5" />
            </Button>
          )}
        </span>
        <span className={cn("shrink-0 text-xs", outcomeClass(result?.outcome ?? null))}>
          {status}
        </span>
        {action}
      </div>
      {open && details !== undefined ? <div className="border-t border-border bg-muted/40 px-3 py-2 text-xs">{details}</div> : null}
    </li>
  );
}

function InfoLines({ description, lines, link }: { description: string | null; lines: [string, ReactNode][]; link: string | null }) {
  return (
    <div>
      {description ? <p className="mb-1.5 text-foreground">{description}</p> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {lines.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {link === null ? null : (
        <a href={link} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-foreground underline underline-offset-2">
          <Glyph name="ExternalLink" className="size-3" />
          View source
        </a>
      )}
    </div>
  );
}

function MarketplaceDetails({ item, result }: { item: MarketplaceView; result: SyncResult | null }) {
  const info = item.info;
  if (info === null) return <p className="text-muted-foreground">This entry wasn't found in bb's marketplaces on this machine.</p>;
  const lines: [string, ReactNode][] = [
    ["Type", "Marketplace plugin (installed through bb's marketplace)"],
    ["Entry", <code key="entry">{item.entry}</code>],
    ["Plugin id", <code key="id">{info.pluginId}</code>],
    ["Marketplace", info.marketplace],
    ["Publisher", info.publisher],
  ];
  if (info.category) lines.push(["Category", info.category]);
  if (info.installs !== null) lines.push(["Installs", info.installs.toLocaleString()]);
  lines.push(["Installed", info.installedVersion === null ? "not installed here" : `${info.installedVersion}${info.enabled === false ? " (disabled)" : ""}`]);
  if (info.installedFrom) lines.push(["Installed from", info.installedFrom]);
  if (!info.compatible) lines.push(["Compatibility", info.incompatibleReason ?? "not compatible with this bb"]);
  if (result?.detail) lines.push(["Last sync", `${result.outcome}: ${result.detail}`]);
  return <InfoLines description={info.description} lines={lines} link={info.repositoryUrl} />;
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
  return <InfoLines description={info.description} lines={lines} link={info.webUrl} />;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}

// ---------------------------------------------------------------------------
// 0. Group selector

type GroupEdit = { mode: "add" } | { mode: "rename"; group: GroupView } | { mode: "remove"; group: GroupView };

function IconButton({ label, glyph, onClick, disabled }: { label: string; glyph: "Plus" | "Pencil" | "Trash2"; onClick: () => void; disabled?: boolean }) {
  return (
    <span title={label} className="inline-flex">
      <Button size="icon" variant="ghost" className="size-8 shrink-0 text-muted-foreground" aria-label={label} disabled={disabled} onClick={onClick}>
        <Glyph name={glyph} className="size-3.5" />
      </Button>
    </span>
  );
}

function GroupSelector({
  data,
  selected,
  onSelect,
  busy,
  rpc,
  run,
  loading,
  syncing,
  onSubscribed,
}: {
  data: HubData;
  selected: string;
  onSelect: (group: string) => void;
  busy: string | null;
  rpc: Rpc;
  run: Run;
  loading: boolean;
  syncing: Syncing;
  onSubscribed: (result: { group: string; subscribed: boolean }) => void;
}) {
  const current = data.groups.find((group) => group.id === selected) ?? data.groups[0];
  const subscribing = current !== undefined && busy === `subscribe:${current.id}`;
  const [edit, setEdit] = useState<GroupEdit | null>(null);
  const [name, setName] = useState("");
  const open = (next: GroupEdit) => {
    setName(next.mode === "rename" ? next.group.name : "");
    setEdit(next);
  };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const target = edit;
    const trimmed = name.trim();
    setEdit(null);
    if (target === null) return;
    if (target.mode === "add" && trimmed !== "") {
      void run("group:add", async () => onSelect((await rpc.call("hub_group_add", { name: trimmed })).id));
    } else if (target.mode === "rename" && trimmed !== "" && trimmed !== target.group.name) {
      void run(`group:rename:${target.group.id}`, () => rpc.call("hub_group_rename", { group: target.group.id, name: trimmed }));
    } else if (target.mode === "remove") {
      void run(`group:remove:${target.group.id}`, async () => {
        await rpc.call("hub_group_remove", { group: target.group.id });
        onSelect("home");
      });
    }
  };
  const empty = data.packages.length === 0 && data.marketplace.length === 0 && data.folders.length === 0;
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <Glyph name="Layers" className="size-4 shrink-0 text-muted-foreground" />
        <select
          value={current?.id}
          onChange={(event) => onSelect(event.target.value)}
          aria-label="Group"
          title={current?.status === "error" ? "Something in this group failed to install or update" : current?.status === "warning" ? "A plugin in this group is installed from another source" : undefined}
          className={cn("h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm", groupClass(current?.status))}
        >
          {data.groups.map((group) => (
            <option key={group.id} value={group.id} className={groupClass(group.status) ?? "text-foreground"}>
              {group.name}
              {group.home ? " (home)" : group.subscribed ? " ✓" : ""}
            </option>
          ))}
        </select>
        {current === undefined || current.home ? (
          <span className="shrink-0 text-xs text-muted-foreground">always subscribed</span>
        ) : (
          <Button
            size="sm"
            variant={current.subscribed ? "ghost" : "default"}
            className="h-8 shrink-0"
            disabled={busy !== null || loading}
            onClick={() =>
              void run(`subscribe:${current.id}`, async () =>
                onSubscribed(await rpc.call("hub_group_subscribe", { group: current.id, subscribed: !current.subscribed })),
              )
            }
          >
            {subscribing ? <Glyph name="RefreshCw" className="size-3.5 animate-spin" /> : null}
            {subscribing ? (current.subscribed ? "Unsubscribing…" : "Subscribing…") : current.subscribed ? "Unsubscribe" : "Subscribe"}
          </Button>
        )}
        <div className="flex shrink-0 items-center">
          {current === undefined ? null : (
            <IconButton label="Rename group" glyph="Pencil" disabled={busy !== null || loading} onClick={() => open({ mode: "rename", group: current })} />
          )}
          {current === undefined || current.home ? null : (
            <IconButton label="Remove group" glyph="Trash2" disabled={busy !== null || loading} onClick={() => open({ mode: "remove", group: current })} />
          )}
          <IconButton label="Add a group" glyph="Plus" disabled={busy !== null} onClick={() => open({ mode: "add" })} />
        </div>
      </div>
      {loading ? (
        <p className="mt-1">
          <Spinner>
            {syncing !== null ? `Loading ${current?.name ?? "the group"} once the sync running now finishes…` : `Loading ${current?.name ?? "the group"}…`}
          </Spinner>
        </p>
      ) : syncing !== null && !subscribing ? (
        <p className="mt-1">
          <Spinner>Syncing: installing and updating this machine's plugins…</Spinner>
        </p>
      ) : current !== undefined && !current.subscribed ? (
        <p className="mt-1 text-xs text-muted-foreground">
          This machine isn't subscribed to {current.name}, so it doesn't install these plugins. Subscribe to get them.
        </p>
      ) : null}
      <Dialog open={edit !== null} onOpenChange={(isOpen) => (isOpen ? null : setEdit(null))}>
        <DialogContent>
          {edit?.mode === "remove" ? (
            <>
              <DialogHeader>
                <DialogTitle>Remove {edit.group.name}?</DialogTitle>
                <DialogDescription>
                  {empty
                    ? "This removes the empty group from the shared repository. Machines subscribed to it stop seeing it at their next sync."
                    : `${edit.group.name} still has plugins. Move them to another group or delete them first, so no plugin or its data is lost.`}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setEdit(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" disabled={!empty || busy !== null} onClick={() => submit()}>
                  Remove group
                </Button>
              </DialogFooter>
            </>
          ) : edit !== null ? (
            <form onSubmit={submit}>
              <DialogHeader>
                <DialogTitle>{edit.mode === "add" ? "Add a group" : `Rename ${edit.group.name}`}</DialogTitle>
                <DialogDescription>
                  {edit.mode === "add"
                    ? "A new, empty group in the shared repository. Members subscribe to it to get its plugins."
                    : "Only the name changes. Subscriptions keep working."}
                </DialogDescription>
              </DialogHeader>
              <Input
                autoFocus
                className="my-3"
                value={name}
                maxLength={60}
                placeholder="Group name"
                aria-label="Group name"
                onChange={(event) => setName(event.target.value)}
              />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setEdit(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={name.trim() === "" || busy !== null}>
                  {edit.mode === "add" ? "Add group" : "Rename"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1-2. Packages and marketplace plugins

/** Local (folders in the shared repo) and remote (other public repos) plugins, in one list. */
type MoveTarget = { kind: "local" | "remote" | "marketplace"; ref: string; path?: string; name: string };

function MoveButton({ name, busy, onClick, disabled }: { name: string; busy: string | null; onClick: () => void; disabled?: boolean }) {
  return (
    <span title="Move to another group" className="inline-flex">
    <Button
      variant="ghost"
      size="icon"
      className="size-6 text-muted-foreground hover:text-foreground"
      aria-label={`Move ${name} to another group`}
      disabled={busy !== null || disabled}
      onClick={onClick}
    >
      <Glyph name="ArrowLeftRight" className="size-3.5" />
    </Button>
    </span>
  );
}

/** "Move to group": nothing is reinstalled for any kind of plugin. */
function MoveDialog({
  target,
  data,
  onClose,
  busy,
  rpc,
  run,
}: {
  target: MoveTarget | null;
  data: HubData;
  onClose: () => void;
  busy: string | null;
  rpc: Rpc;
  run: Run;
}) {
  const others = data.groups.filter((group) => group.id !== data.group.id);
  const [to, setTo] = useState<string>(others[0]?.id ?? "");
  useEffect(() => {
    if (target !== null && !others.some((group) => group.id === to)) setTo(others[0]?.id ?? "");
  }, [target, others, to]);
  const toName = others.find((group) => group.id === to)?.name ?? "";
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {target?.name} to another group</DialogTitle>
          <DialogDescription>
            {target?.kind === "local" ? (
              <>
                The group you pick takes it over; its folder stays where it is, so nothing is reinstalled and no data is
                lost. Machines subscribed only to {data.group.name} keep it, but it stops updating.
              </>
            ) : (
              <>
                Its entry moves from {data.group.name} to the group you pick. Nothing is reinstalled and no data is lost.
                Machines subscribed only to {data.group.name} keep it, but it stops updating.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <select
          value={to}
          onChange={(event) => setTo(event.target.value)}
          aria-label="Move to group"
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          {others.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            disabled={busy !== null || to === "" || target === null}
            onClick={() => {
              const move = target;
              onClose();
              if (move !== null) {
                void run(`move:${move.ref}`, () =>
                  rpc.call("hub_move", { kind: move.kind, ref: move.ref, ...(move.path ? { path: move.path } : {}), from: data.group.id, to }),
                );
              }
            }}
          >
            {`Move to ${toName}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Plugins({ data, busy, rpc, run }: { data: HubData; busy: string | null; rpc: Rpc; run: Run }) {
  const nameFor = (entry: PackageView) => entry.info?.name ?? entry.label;
  const [confirm, setConfirm] = useState<PackageView | null>(null);
  const [moving, setMoving] = useState<MoveTarget | null>(null);
  const canMove = data.groups.length > 1;
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
              statusText={isSubscribed(data) ? undefined : "not subscribed"}
              details={<Details entry={entry} result={resultFor(entry.label)} />}
              icon={
                <span title={entry.kind === "remote" ? "remote plugin" : "local plugin"} className="shrink-0 text-muted-foreground">
                  <Glyph name={entry.kind === "remote" ? "Link" : "Folder"} className="size-3.5" />
                </span>
              }
              action={
                <>
                {canMove ? (
                  <MoveButton
                    name={nameFor(entry)}
                    busy={busy}
                    onClick={() =>
                      setMoving(
                        entry.kind === "remote"
                          ? { kind: "remote", ref: entry.repo, ...(entry.path ? { path: entry.path } : {}), name: nameFor(entry) }
                          : { kind: "local", ref: entry.path, name: nameFor(entry) },
                      )
                    }
                  />
                ) : null}
                {entry.kind === "remote" ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${entry.label}`}
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`rremove:${entry.label}`, () =>
                        rpc.call("hub_remote_remove", { repo: entry.repo, ...(entry.path ? { path: entry.path } : {}), group: data.group.id }),
                      )
                    }
                  >
                    <Glyph name="X" className="size-3.5" />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${nameFor(entry)}`}
                    disabled={busy !== null}
                    onClick={() => setConfirm(entry)}
                  >
                    <Glyph name="Trash2" className="size-3.5" />
                  </Button>
                )}
                </>
              }
            />
          ))}
        </List>
      )}
      <MoveDialog target={moving} data={data} onClose={() => setMoving(null)} busy={busy} rpc={rpc} run={run} />
      <Dialog open={confirm !== null} onOpenChange={(open) => (open ? null : setConfirm(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {confirm === null ? "" : nameFor(confirm)}?</DialogTitle>
            <DialogDescription>
              This removes <code>{confirm?.path}</code> from the {data.group.name} group and uninstalls it from the bb
              of every member subscribed to it at the next sync. <strong>All of the plugin's data and settings will be lost on every machine.</strong>{" "}
              This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={() => {
                const entry = confirm;
                setConfirm(null);
                if (entry !== null) void run(`ldelete:${entry.label}`, () => rpc.call("hub_local_delete", { path: entry.path, group: data.group.id }));
              }}
            >
              Delete plugin and its data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MarketplacePlugins({ data, busy, rpc, run }: { data: HubData; busy: string | null; rpc: Rpc; run: Run }) {
  const resultFor = (label: string) => data.lastSync?.results.find((result) => result.repo === label) ?? null;
  const [moving, setMoving] = useState<MoveTarget | null>(null);
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
              name={item.info?.name ?? item.entry}
              result={resultFor(item.label)}
              statusText={isSubscribed(data) ? undefined : "not subscribed"}
              details={<MarketplaceDetails item={item} result={resultFor(item.label)} />}
              action={
                <>
                  {data.groups.length > 1 ? (
                    <MoveButton
                      name={item.info?.name ?? item.entry}
                      busy={busy}
                      onClick={() => setMoving({ kind: "marketplace", ref: item.entry, name: item.info?.name ?? item.entry })}
                    />
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${item.entry}`}
                    disabled={busy !== null}
                    onClick={() => void run(`mremove:${item.entry}`, () => rpc.call("hub_marketplace_remove", { entry: item.entry, group: data.group.id }))}
                  >
                    <Glyph name="X" className="size-3.5" />
                  </Button>
                </>
              }
            />
          ))}
        </List>
      )}
      <MoveDialog target={moving} data={data} onClose={() => setMoving(null)} busy={busy} rpc={rpc} run={run} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 3. Sync time

function SyncLine({ data, busy, rpc, run, syncing }: { data: HubData; busy: string | null; rpc: Rpc; run: Run; syncing: Syncing }) {
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
      <Glyph name="Clock" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {syncing !== null ? <strong className="text-foreground">Syncing now… </strong> : null}
        Next sync <strong className="text-foreground">{time(by)}</strong> (every {data.schedule.intervalMinutes} min, same time for everyone)
        {self !== null && PROBLEM.includes(self.outcome) ? <span className={outcomeClass(self.outcome)}> · hub: {self.outcome}</span> : null}
      </span>
      <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy !== null || syncing !== null} onClick={() => void run("sync", () => rpc.call("hub_sync"))}>
        <Glyph name="RefreshCw" className={cn("size-3.5", (busy === "sync" || syncing !== null) && "animate-spin")} />
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
// Betas and publishing

/** -1, 0 or 1, comparing dotted version numbers (a pre-release sorts before its release). */
function compareVersions(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const [mainA = "", preA] = a.split("-", 2);
  const [mainB = "", preB] = b.split("-", 2);
  const partsA = mainA.split(".").map(Number);
  const partsB = mainB.split(".").map(Number);
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const diff = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

function Betas({ data, busy, rpc, run }: { data: HubData; busy: string | null; rpc: Rpc; run: Run }) {
  const [confirmReset, setConfirmReset] = useState<BetaView | null>(null);
  if (data.betas.length === 0) return null;
  const toggle = (beta: BetaView, resetData = false) =>
    void run(`beta:${beta.pluginId}`, () => rpc.call("hub_beta", { pluginId: beta.pluginId, joined: !beta.joined, ...(resetData ? { resetData } : {}) }));
  return (
    <>
      <Title>Betas</Title>
      <List>
        {data.betas.map((beta) => (
          <li key={beta.path} className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <span className="shrink-0 rounded bg-muted px-1 text-xs font-medium text-muted-foreground" title="Beta copy">β</span>
            <span className="min-w-0 flex-1 truncate" title={beta.path}>
              {beta.name}{" "}
              <span className="text-xs text-muted-foreground">
                {beta.version ?? "?"} (stable {beta.stableVersion ?? "none"}){beta.running ? " · running here" : beta.joined ? " · switching…" : ""}
              </span>
            </span>
            <Button
              size="sm"
              variant={beta.joined ? "ghost" : "default"}
              className="h-7 shrink-0"
              disabled={busy !== null || !isSubscribed(data)}
              onClick={() => (!beta.joined && beta.needsReset ? setConfirmReset(beta) : toggle(beta))}
            >
              {busy === `beta:${beta.pluginId}` ? "…" : beta.joined ? "Leave beta" : "Join beta"}
            </Button>
            <span title="Make this beta the stable copy for everyone" className="inline-flex">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 text-muted-foreground"
                disabled={busy !== null}
                onClick={() => void run(`promote:${beta.pluginId}`, () => rpc.call("hub_promote", { plugin: beta.pluginId, group: data.group.id }))}
              >
                {busy === `promote:${beta.pluginId}` ? "…" : "Promote"}
              </Button>
            </span>
          </li>
        ))}
      </List>
      <Dialog open={confirmReset !== null} onOpenChange={(open) => (open ? null : setConfirmReset(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Join the {confirmReset?.name} beta?</DialogTitle>
            <DialogDescription>
              {confirmReset?.name} was installed on this machine before betas existed, so joining reinstalls it once.{" "}
              <strong>Its settings and data on this machine will be reset.</strong> After that, switching between the beta and the stable copy
              keeps them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmReset(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const beta = confirmReset;
                setConfirmReset(null);
                if (beta !== null) toggle(beta, true);
              }}
            >
              Reset and join
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type PublishTarget = { plugin: DevPlugin; beta: boolean };

function DevPlugins({ data, busy, rpc, run }: { data: HubData; busy: string | null; rpc: Rpc; run: Run }) {
  const [target, setTarget] = useState<PublishTarget | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const blocker = (plugin: DevPlugin, beta: boolean): string | null => {
    const published = beta ? plugin.betaVersion : plugin.stableVersion;
    if (published !== null && compareVersions(plugin.version, published) <= 0) return `Bump the version: ${plugin.version ?? "?"} isn't newer than the published ${published}.`;
    if (beta && plugin.stableVersion !== null && compareVersions(plugin.version, plugin.stableVersion) <= 0) return `A beta must be newer than the stable ${plugin.stableVersion}.`;
    return null;
  };
  const published = target === null ? null : target.beta ? target.plugin.betaVersion : target.plugin.stableVersion;
  return (
    <>
      <Title>Your local plugins</Title>
      {data.devPlugins.length === 0 ? (
        <Empty>
          Plugins you develop in a folder on this machine show up here, with buttons to publish them. Enter a plugin folder below to run it
          from there on this machine only (or run <code>bb plugin install .</code> in it).
        </Empty>
      ) : null}
      <List>
        {data.devPlugins.map((plugin) => (
          <li key={plugin.pluginId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <Glyph name="Folder" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={plugin.dir}>
              {plugin.name} <span className="text-xs text-muted-foreground">{plugin.version ?? "?"} here</span>
              <span className="block truncate text-xs text-muted-foreground">
                {data.group.name}: {plugin.stableVersion === null ? "not published" : `stable ${plugin.stableVersion}`}
                {plugin.betaVersion === null ? "" : ` · beta ${plugin.betaVersion}`}
              </span>
            </span>
            {(
              [
                [false, "Publish"],
                [true, "Publish beta"],
              ] as const
            ).map(([beta, label]) => (
              <span key={label} title={blocker(plugin, beta) ?? `${label} ${plugin.version ?? ""} to ${data.group.name}`} className="inline-flex">
                <Button
                  size="sm"
                  variant={beta ? "ghost" : "default"}
                  className="h-7 shrink-0"
                  disabled={busy !== null || blocker(plugin, beta) !== null}
                  onClick={() => setTarget({ plugin, beta })}
                >
                  {beta ? null : <Glyph name="Upload" className="size-3.5" />}
                  {busy === `publish:${plugin.pluginId}:${beta}` ? "…" : label}
                </Button>
              </span>
            ))}
            {plugin.stablePath === null ? null : (
              <span title="Stop developing: go back to the published copy (keeps its settings and data)" className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground"
                  aria-label={`Stop developing ${plugin.name}`}
                  disabled={busy !== null}
                  onClick={() => void run(`devstop:${plugin.pluginId}`, () => rpc.call("hub_dev_stop", { pluginId: plugin.pluginId }))}
                >
                  <Glyph name="X" className="size-3.5" />
                </Button>
              </span>
            )}
          </li>
        ))}
      </List>
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const dir = folder.trim();
          if (dir === "") return;
          setDone(null);
          void run("devstart", async () => {
            const started = await rpc.call("hub_dev_start", { dir });
            setFolder("");
            setDone(`Running ${started.pluginId} ${started.version} from ${started.dir} on this machine${started.tookOver ? " (switched from the installed copy; its settings stay)" : ""}.`);
          });
        }}
      >
        <Input
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          placeholder="Plugin folder on this machine, e.g. ~/code/my-plugin"
          aria-label="Plugin folder to develop"
          className="h-8 min-w-0 flex-1 text-sm"
        />
        <Button type="submit" size="sm" className="h-8 shrink-0" disabled={busy !== null || folder.trim() === ""}>
          {busy === "devstart" ? "…" : "Develop"}
        </Button>
      </form>
      {done === null ? null : <p className="mt-1 text-xs text-muted-foreground">{done}</p>}
      <Dialog open={target !== null} onOpenChange={(open) => (open ? null : setTarget(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Publish {target?.plugin.name} {target?.plugin.version}
              {target?.beta ? " as a beta" : ""}?
            </DialogTitle>
            <DialogDescription>
              {target?.beta
                ? `Copies ${target.plugin.dir} into ${data.group.name}'s beta. Only machines that joined its beta get it, at the next sync, and they keep their data.`
                : `Copies ${target?.plugin.dir ?? ""} into ${data.group.name} for everyone subscribed to it, at the next sync. They keep their data.`}{" "}
              {published === null ? "This is its first release there." : `It replaces ${published}.`} Your machine keeps running your folder.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const chosen = target;
                setTarget(null);
                if (chosen === null) return;
                setDone(null);
                void run(`publish:${chosen.plugin.pluginId}:${chosen.beta}`, async () => {
                  const result = await rpc.call("hub_publish", { dir: chosen.plugin.dir, group: data.group.id, beta: chosen.beta });
                  setDone(
                    result.commit === null
                      ? `${result.folder} is unchanged.`
                      : `Published ${result.pluginId} ${result.to}${result.beta ? " (beta)" : ""}: ${result.changes.at(-1) ?? "no file changes"}. Everyone ${result.beta ? "on the beta " : ""}has it by ${time(Date.parse(result.guaranteedBy))}.`,
                  );
                });
              }}
            >
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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

function AddPlugin({ busy, rpc, run, group }: { busy: string | null; rpc: Rpc; run: Run; group: { id: string; name: string } }) {
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const add = (input: Parameters<Rpc["call"]>[1] & object) =>
    run("add", async () => {
      setMessage(null);
      const added = await rpc.call("hub_add_plugin", { ...(input as object), group: group.id } as never);
      setUrl("");
      setMessage(
        added.unchanged
          ? `${added.folder} is unchanged.`
          : `${added.kind === "followed" ? "Following" : added.kind === "remote" ? "Now pointing to" : "Copied in"} ${added.folder}. Everyone has it by ${time(Date.parse(added.guaranteedBy))}.`,
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
      <Title>Add a plugin to {group.name}</Title>
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
            <Glyph name="Paperclip" className="size-4" />
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
      <Title>Add from the marketplace to {data.group.name}</Title>
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
                    onClick={() => void run(`madd:${result.entry}`, () => rpc.call("hub_marketplace_add", { entry: result.entry, group: data.group.id }))}
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

const GROUP_STORAGE_KEY = "bb-plugin-hub:group";

function HubPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<HubData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The selected group is remembered per browser.
  const [group, setGroup] = useState<string>(() => {
    try {
      return window.localStorage.getItem(GROUP_STORAGE_KEY) ?? "home";
    } catch {
      return "home";
    }
  });
  const selectGroup = (next: string) => {
    setGroup(next);
    try {
      window.localStorage.setItem(GROUP_STORAGE_KEY, next);
    } catch {
      // storage unavailable: the choice lasts until the page reloads
    }
  };

  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  // A running sync on this machine (hub_status answers at once; hub_list waits for the sync).
  const [syncing, setSyncing] = useState<Syncing>(null);
  // The hub updating itself (it reloads; calls fail for a moment while it restarts).
  const [updating, setUpdating] = useState(false);
  const refreshStatus = useCallback(() => {
    rpc.call("hub_status", null).then(
      (status) => {
        setSyncing(status.syncing);
        setUpdating(status.updating !== null);
      },
      () => undefined,
    );
  }, [rpc]);
  // Only the newest hub_list answer counts (switching groups quickly).
  const latest = useRef(0);
  const updatingRef = useRef(false);
  updatingRef.current = updating;
  const refetch = useCallback(() => {
    refreshStatus();
    const request = ++latest.current;
    rpc.call("hub_list", { group }).then(
      (result) => {
        if (request !== latest.current) return;
        setData(result);
        setError(null);
      },
      (cause: unknown) => {
        if (request !== latest.current) return;
        // While the hub restarts after updating itself, keep waiting instead of showing an error.
        if (updatingRef.current) return;
        // A remembered group that no longer exists falls back to home.
        if (group !== "home" && String(cause).includes("no group")) selectGroup("home");
        else report(cause);
      },
    );
  }, [rpc, report, group, refreshStatus]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  const loading = data !== null && data.group.id !== group;
  // While updating (or still loading), check every few seconds; reload the data once the update is done.
  const wasUpdating = useRef(false);
  useEffect(() => {
    if (wasUpdating.current && !updating) refetch();
    wasUpdating.current = updating;
    if (!updating && data !== null) return;
    const timer = setInterval(() => {
      refreshStatus();
      if (data === null) refetch();
    }, 3_000);
    return () => clearInterval(timer);
  }, [updating, data === null, refreshStatus, refetch]);
  // Show a (un)subscribe at once; the group list catches up after the sync it starts.
  const onSubscribed = ({ group: id, subscribed }: { group: string; subscribed: boolean }) => {
    setData((previous) =>
      previous === null ? previous : { ...previous, groups: previous.groups.map((entry) => (entry.id === id ? { ...entry, subscribed } : entry)) },
    );
    refreshStatus();
  };
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
        {updating && data !== null ? (
          <p className="mt-3">
            <Spinner>Updating the hub… the page refreshes when it's done.</Spinner>
          </p>
        ) : null}
        {data === null ? (
          <p className="mt-4">
            <Spinner>{updating ? "Updating the hub…" : "Loading…"}</Spinner>
          </p>
        ) : (
          <>
            <GroupSelector data={data} selected={group} onSelect={selectGroup} busy={busy} rpc={rpc} run={run} loading={loading} syncing={syncing} onSubscribed={onSubscribed} />
            <div className={cn("transition-opacity", loading && "pointer-events-none opacity-40")} aria-busy={loading}>
              <Plugins data={data} busy={busy} rpc={rpc} run={run} />
              <Betas data={data} busy={busy} rpc={rpc} run={run} />
              <MarketplacePlugins data={data} busy={busy} rpc={rpc} run={run} />
              <DevPlugins data={data} busy={busy} rpc={rpc} run={run} />
              <SyncLine data={data} busy={busy} rpc={rpc} run={run} syncing={syncing} />
              <AddPlugin busy={busy} rpc={rpc} run={run} group={data.group} />
              <AddFromMarketplace data={data} busy={busy} rpc={rpc} run={run} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "plugin-hub", title: "Plugin hub", icon: "Package", path: "plugin-hub", component: HubPage });
});
