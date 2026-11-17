// bb-plugin-hub — keeps the bb plugins listed in a public repository's
// packages.json installed and up to date, and updates itself.
//
// Layout of the packages repository (default Timmmmmmer/bb-plugins):
//   packages.json        which plugin folders every hub installs
//   plugins/<name>/      one bb plugin per folder (this hub is plugins/hub)
//
// No tokens: the repository is public. bb installs each plugin straight from
// GitHub (`git:https://github.com/<owner>/<repo>.git`, subdirectory
// plugins/<name>), and the hub keeps a local git mirror of the repository to
// read packages.json and to tell whether a plugin's own folder changed. A
// commit that touches only plugins/hello therefore updates hello and leaves
// every other plugin (and their reloads) alone.
//
// Every hub syncs at the same UTC-aligned moments (syncIntervalMinutes in
// packages.json), plus at startup, on settings changes, and on demand.
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cliCommand,
  defineCli,
  defineRpcContract,
  PluginCliError,
  type BbPluginApi,
  type ExperimentalPluginRpcHandlerContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const OWNER_PATTERN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/u;
const NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u;
const REF_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/^~<>=*|: +-]{1,100}$/u;
const PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._/-]{1,200}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const PLUGINS_FOLDER = "plugins";
const GIT_TIMEOUT_MS = 180_000;

// Shared schedule: every hub syncs at multiples of the interval since the
// Unix epoch, so all machines pick up a change at the same moment.
const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const PROPAGATION_MARGIN_MS = 60_000;
const SYNC_INTERVAL_KEY = "syncIntervalMinutes";
const LAST_SYNC_KEY = "lastSync";
const SELF_UPDATE_KEY = "selfUpdateAttempt";
const SELF_UPDATE_GRACE_MS = 10 * 60_000;
const SELF_UPDATE_DELAY_MS = 5_000;
const HUB_CHANGED = "hub-changed";

function nextBoundary(fromMs: number, intervalMinutes: number): number {
  const step = intervalMinutes * 60_000;
  return Math.floor(fromMs / step) * step + step;
}

// ---------------------------------------------------------------------------
// packages.json

const packageEntrySchema = z.object({
  /** The plugin's folder, e.g. "plugins/hello". */
  path: z.string().trim().min(1),
  /** Another public repository ("owner/name"); defaults to the packages repo. */
  repo: z.string().trim().min(1).optional(),
  /** Branch, tag, or "semver:[prefix:]range"; defaults to the default branch. */
  ref: z.string().trim().min(1).optional(),
});
const packagesFileSchema = z.object({
  syncIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  /** Folder patterns whose every subfolder is a package, e.g. "plugins/*". */
  include: z.array(z.string().trim().min(1)).max(20).optional(),
  /** Folders to leave out of `include`, e.g. "plugins/experimental". */
  exclude: z.array(z.string().trim().min(1)).max(200).optional(),
  plugins: z.array(packageEntrySchema).max(100).optional(),
});

interface RepoRef {
  owner: string;
  name: string;
}
interface PackageSpec extends RepoRef {
  path: string;
  ref: string | null;
}

function parseRepo(input: string): RepoRef {
  const [owner, name, ...rest] = input.trim().replace(/\.git$/iu, "").split("/");
  if (owner === undefined || name === undefined || rest.length > 0 || !OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) {
    throw new Error(`"${input}" is not a GitHub repository (expected owner/name).`);
  }
  return { owner, name };
}
const repoKey = (repo: RepoRef) => `${repo.owner}/${repo.name}`.toLowerCase();
const repoUrl = (repo: RepoRef) => `https://github.com/${repo.owner}/${repo.name}.git`;

/** bb's rule: final package-name component minus `bb-plugin-`, slugified. */
function pluginIdForPackageName(packageName: string): string {
  const last = packageName.slice(packageName.lastIndexOf("/") + 1);
  return (last.startsWith("bb-plugin-") ? last.slice("bb-plugin-".length) : last)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// ---------------------------------------------------------------------------
// RPC contract

const syncResultSchema = z.object({
  repo: z.string(),
  pluginId: z.string().nullable(),
  outcome: z.enum(["installed", "updated", "current", "pinned", "skipped", "other-source", "updating", "failed"]),
  detail: z.string().nullable(),
  version: z.string().nullable(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

const syncReportSchema = z.object({
  at: z.string(),
  trigger: z.string(),
  packagesFrom: z.string(),
  durationMs: z.number().optional(),
  results: z.array(syncResultSchema),
});
export type SyncReport = z.infer<typeof syncReportSchema>;

const scheduleSchema = z.object({
  intervalMinutes: z.number(),
  nextSyncAt: z.string(),
  guaranteedBy: z.string(),
  marginSeconds: z.number(),
  lastSyncDurationMs: z.number().nullable(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

const folderSchema = z.object({
  path: z.string(),
  pluginId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  installed: z.boolean(),
  installedVersion: z.string().nullable(),
  isPackage: z.boolean(),
});
export type PluginFolder = z.infer<typeof folderSchema>;

const packageViewSchema = z.object({ label: z.string(), path: z.string(), repo: z.string(), ref: z.string().nullable() });
export type PackageView = z.infer<typeof packageViewSchema>;

export const rpcContract = defineRpcContract({
  hub_list: {
    input: z.null(),
    output: z.object({
      repo: z.string(),
      folders: z.array(folderSchema),
      packages: z.array(packageViewSchema),
      lastSync: syncReportSchema.nullable(),
      schedule: scheduleSchema,
    }),
  },
  hub_install: {
    input: z.object({ path: z.string().min(1).max(200) }),
    output: syncResultSchema,
  },
  hub_sync: {
    input: z.null(),
    output: syncReportSchema,
  },
});

const packageJsonSchema = z.object({
  name: z.string().min(1),
  bb: z.object({ name: z.string().optional(), description: z.string().optional() }).optional(),
});

interface SelfUpdateAttempt {
  from: string;
  to: string;
  at: string;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    packagesRepo: {
      type: "string",
      label: "Packages repository",
      description: "Public owner/name of the repository with packages.json and the plugins/ folders.",
      default: "Timmmmmmer/bb-plugins",
    },
    hubPath: {
      type: "string",
      label: "Hub folder",
      description: "The hub's own folder in the packages repository (used to decide whether a commit changed the hub).",
      default: "plugins/hub",
    },
    selfUpdate: {
      type: "boolean",
      label: "Update the hub automatically",
      description: "At the end of every sync, update the hub itself when its folder has changed.",
      default: true,
    },
    mirrorsDir: {
      type: "string",
      label: "Mirrors folder",
      description:
        "Absolute path for the hub's git mirror. Leave empty to use bb's data directory, or the first writable of ~/.cache/bb-plugin-hub/mirrors and the temp folder (common on servers).",
      default: "",
    },
  });

  let syncIntervalMinutes = (await bb.storage.kv.get<number>(SYNC_INTERVAL_KEY)) ?? DEFAULT_SYNC_INTERVAL_MINUTES;

  async function readConfig() {
    const values = await settings.get();
    const hubPath = values.hubPath.trim();
    if (!PATH_PATTERN.test(hubPath)) throw new Error(`Invalid hubPath "${hubPath}".`);
    return { packagesRepo: parseRepo(values.packagesRepo), hubPath, selfUpdate: values.selfUpdate };
  }

  // -------------------------------------------------------------------------
  // Mirrors folder: first writable of mirrorsDir, bb's data dir, ~/.cache, tmp

  let activeMirrorRoot: string | null = null;
  function defaultMirrorRoot(): string | null {
    try {
      return path.join(bb.server.experimental_dataDir, "plugins", bb.pluginId, "mirrors");
    } catch {
      return null; // readable only once the server listens
    }
  }
  function fallbackMirrorRoots(): string[] {
    const cacheHome = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
    const user = typeof process.getuid === "function" ? String(process.getuid()) : os.userInfo().username;
    return [path.join(cacheHome, "bb-plugin-hub", "mirrors"), path.join(os.tmpdir(), `bb-plugin-hub-${user}`, "mirrors")];
  }
  async function isWritableDir(dir: string): Promise<boolean> {
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, fsConstants.R_OK | fsConstants.W_OK);
      const probe = path.join(dir, `.write-test-${process.pid}`);
      await writeFile(probe, "");
      await rm(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  async function ensureMirrorRoot(): Promise<string> {
    if (activeMirrorRoot !== null) return activeMirrorRoot;
    const configured = (await settings.get()).mirrorsDir.trim();
    const candidates = configured !== ""
      ? [path.resolve(configured)]
      : [defaultMirrorRoot(), ...fallbackMirrorRoots()].filter((dir): dir is string => dir !== null);
    for (const dir of candidates) {
      if (await isWritableDir(dir)) {
        activeMirrorRoot = dir;
        bb.log.info(`mirrors folder: ${dir}`);
        return dir;
      }
    }
    throw new Error(
      `No writable folder for the hub's mirror (tried ${candidates.join(", ")}). Set one with \`bb plugin config hub set mirrorsDir <path>\`.`,
    );
  }

  // -------------------------------------------------------------------------
  // git (anonymous: public repositories only)

  function git(args: string[], cwd?: string): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      // Never use the machine's stored GitHub credentials.
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: "",
    };
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const reason = String(stderr).trim().split("\n").slice(-2).join(" ") || error.message;
          reject(new Error(`git ${args[0]} failed: ${reason}`));
        } else {
          resolve(String(stdout));
        }
      });
    });
  }

  /** Clone or fetch the mirror of a public repository; once per sync round. */
  const fetchedThisRound = new Set<string>();
  async function syncMirror(repo: RepoRef): Promise<string> {
    const root = await ensureMirrorRoot();
    const dir = path.join(root, repo.owner.toLowerCase(), `${repo.name.toLowerCase()}.git`);
    if (fetchedThisRound.has(dir)) return dir;
    const exists = await access(path.join(dir, "HEAD")).then(() => true, () => false);
    try {
      if (exists) {
        await git(["remote", "update", "--prune"], dir);
      } else {
        await mkdir(path.dirname(dir), { recursive: true });
        await rm(dir, { recursive: true, force: true });
        await git(["clone", "--mirror", "--quiet", repoUrl(repo), dir]);
      }
    } catch (cause) {
      if (!exists) await rm(dir, { recursive: true, force: true });
      throw new Error(`Could not read ${repo.owner}/${repo.name} from GitHub (${errorMessage(cause)}). Is it public?`);
    }
    fetchedThisRound.add(dir);
    return dir;
  }

  async function readPackageJson(dir: string, folder: string, rev = "HEAD") {
    return packageJsonSchema.parse(JSON.parse(await git(["show", `${rev}:${folder}/package.json`], dir)));
  }

  /** Whether `folder` differs between two commits; unknown counts as changed. */
  async function folderChanged(dir: string, from: string, to: string, folder: string): Promise<boolean> {
    if (!COMMIT_PATTERN.test(from) || !COMMIT_PATTERN.test(to)) return true;
    try {
      const [before, after] = await Promise.all([
        git(["rev-parse", `${from}:${folder}`], dir),
        git(["rev-parse", `${to}:${folder}`], dir),
      ]);
      return before.trim() !== after.trim();
    } catch {
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // packages.json and the plugins folder

  async function loadPackages() {
    const { packagesRepo } = await readConfig();
    const dir = await syncMirror(packagesRepo);
    const file = packagesFileSchema.parse(JSON.parse(await git(["show", "HEAD:packages.json"], dir)));
    const specs: PackageSpec[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    // "include": every subfolder of "<dir>/*" that holds a bb plugin
    // (package.json with a "bb" section) is a package, except the hub itself
    // and anything in "exclude". Uploading a folder there is all it takes.
    const { hubPath } = await readConfig();
    const excluded = new Set((file.exclude ?? []).map((entry) => entry.replace(/\/+$/u, "")));
    for (const pattern of file.include ?? []) {
      const parent = pattern.replace(/\/\*$/u, "").replace(/\/+$/u, "");
      if (!pattern.endsWith("/*") || !PATH_PATTERN.test(parent)) {
        errors.push(`Unsupported include pattern "${pattern}" (use "<folder>/*").`);
        continue;
      }
      const tree = await git(["ls-tree", "-d", "--name-only", `HEAD:${parent}`], dir).catch(() => "");
      for (const name of tree.split("\n").map((line) => line.trim()).filter(Boolean)) {
        const folder = `${parent}/${name}`;
        if (folder === hubPath || excluded.has(folder)) continue;
        if (!PATH_PATTERN.test(folder)) {
          errors.push(`"${folder}" is not a usable folder name (letters, digits, ".", "_", "-" only); skipped.`);
          continue;
        }
        const manifest = await git(["show", `HEAD:${folder}/package.json`], dir)
          .then((text) => JSON.parse(text) as { bb?: unknown })
          .catch(() => null);
        if (manifest === null || typeof manifest.bb !== "object" || manifest.bb === null) {
          errors.push(`${folder} has no package.json with a "bb" section; skipped.`);
          continue;
        }
        const key = `${repoKey(packagesRepo)}|${folder}`;
        if (!seen.has(key)) {
          seen.add(key);
          specs.push({ ...packagesRepo, path: folder, ref: null });
        }
      }
    }
    for (const entry of file.plugins ?? []) {
      try {
        const repo = entry.repo === undefined ? packagesRepo : parseRepo(entry.repo);
        const folder = entry.path.replace(/\/+$/u, "");
        if (!PATH_PATTERN.test(folder)) throw new Error(`Invalid path "${entry.path}".`);
        if (entry.ref !== undefined && !REF_PATTERN.test(entry.ref)) throw new Error(`Invalid ref "${entry.ref}".`);
        const key = `${repoKey(repo)}|${folder}`;
        if (!seen.has(key)) {
          seen.add(key);
          specs.push({ ...repo, path: folder, ref: entry.ref ?? null });
        }
      } catch (cause) {
        errors.push(errorMessage(cause));
      }
    }
    const intervalMinutes = file.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES;
    if (intervalMinutes !== syncIntervalMinutes) {
      syncIntervalMinutes = intervalMinutes;
      await bb.storage.kv.set(SYNC_INTERVAL_KEY, intervalMinutes);
      bb.log.info(`sync interval is now ${intervalMinutes} min`);
    }
    return { from: `${packagesRepo.owner}/${packagesRepo.name}/packages.json`, packagesRepo, specs, errors };
  }

  const labelFor = (spec: PackageSpec, packagesRepo: RepoRef) =>
    `${repoKey(spec) === repoKey(packagesRepo) ? "" : `${spec.owner}/${spec.name}/`}${spec.path}${spec.ref ? `@${spec.ref}` : ""}`;
  const sourceFor = (spec: PackageSpec) => `git:${repoUrl(spec)}${spec.ref ? `@${spec.ref}` : ""}`;
  const isHubSource = (installedSource: string, spec: PackageSpec) => {
    const base = `git:${repoUrl(spec)}`.toLowerCase();
    const source = installedSource.toLowerCase();
    return source === base || source.startsWith(`${base}@`);
  };

  function scheduleView(lastSync: SyncReport | null): Schedule {
    const now = Date.now();
    return {
      intervalMinutes: syncIntervalMinutes,
      nextSyncAt: new Date(nextBoundary(now, syncIntervalMinutes)).toISOString(),
      guaranteedBy: new Date(nextBoundary(now + PROPAGATION_MARGIN_MS, syncIntervalMinutes)).toISOString(),
      marginSeconds: PROPAGATION_MARGIN_MS / 1000,
      lastSyncDurationMs: lastSync?.durationMs ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Install / update one package

  async function installOrUpdate(spec: PackageSpec, label: string): Promise<SyncResult> {
    const dir = await syncMirror(spec);
    const pluginId = pluginIdForPackageName((await readPackageJson(dir, spec.path)).name);
    if (pluginId === "") throw new Error(`${label} has an invalid package name.`);
    if (pluginId === bb.pluginId) {
      return { repo: label, pluginId, outcome: "skipped", detail: "The hub updates itself at the end of every sync.", version: null };
    }
    const installed = (await bb.sdk.plugins.list()).plugins.find((entry) => entry.id === pluginId);
    if (installed === undefined) {
      const result = await bb.sdk.plugins.install({ source: sourceFor(spec), subdirectory: spec.path });
      bb.log.info(`installed ${result.id}@${result.version} from ${label}`);
      return { repo: label, pluginId, outcome: "installed", detail: null, version: result.version };
    }
    if (!isHubSource(installed.source, spec)) {
      return {
        repo: label,
        pluginId,
        outcome: "other-source",
        detail: `Installed from ${installed.source}. Run \`bb hub adopt ${spec.path}\` to switch it to ${spec.owner}/${spec.name} (this deletes the plugin's settings and data).`,
        version: installed.version,
      };
    }
    return applyIfFolderChanged(pluginId, dir, spec.path, label, installed.version);
  }

  /** Apply bb's update only when the plugin's own folder changed. */
  async function applyIfFolderChanged(
    pluginId: string,
    dir: string,
    folder: string,
    label: string,
    installedVersion: string,
  ): Promise<SyncResult> {
    const [check] = await bb.sdk.plugins.checkUpdates({ pluginId });
    if (check === undefined || check.outcome === "current") {
      return { repo: label, pluginId, outcome: "current", detail: null, version: installedVersion };
    }
    if (check.outcome !== "update-available" || check.candidate === undefined) {
      return {
        repo: label,
        pluginId,
        outcome: check.outcome === "pinned" ? "pinned" : "skipped",
        detail: check.detail ?? check.outcome,
        version: installedVersion,
      };
    }
    if (!(await folderChanged(dir, check.installed.version, check.candidate.version, folder))) {
      return { repo: label, pluginId, outcome: "current", detail: `no changes in ${folder}`, version: installedVersion };
    }
    const applied = await bb.sdk.plugins.applyUpdate({ pluginId });
    if (applied.outcome === "rolled-back") {
      return { repo: label, pluginId, outcome: "failed", detail: applied.detail ?? "bb rolled the update back.", version: applied.from.version };
    }
    bb.log.info(`updated ${pluginId} ${applied.from.display} -> ${applied.to?.display ?? "?"}`);
    return {
      repo: label,
      pluginId,
      outcome: applied.applied ? "updated" : "current",
      detail: applied.applied ? `${applied.from.display} → ${applied.to?.display ?? "latest"}` : null,
      version: applied.to?.version ?? applied.from.version,
    };
  }

  // -------------------------------------------------------------------------
  // Self-update: started as a bb job after the sync, so the reload comes last

  let selfUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  bb.onDispose(() => clearTimeout(selfUpdateTimer));

  async function checkSelf(packagesDir: string, hubPath: string): Promise<{ result: SyncResult; start: boolean }> {
    const repo = "hub (self)";
    const pluginId = bb.pluginId;
    const [check] = await bb.sdk.plugins.checkUpdates({ pluginId });
    const version = check?.installed.version ?? null;
    if (check === undefined || check.outcome === "current") {
      return { result: { repo, pluginId, outcome: "current", detail: null, version }, start: false };
    }
    if (check.outcome !== "update-available" || check.candidate === undefined) {
      return {
        result: { repo, pluginId, outcome: check.outcome === "pinned" ? "pinned" : "skipped", detail: check.detail ?? check.outcome, version },
        start: false,
      };
    }
    if (!(await folderChanged(packagesDir, check.installed.version, check.candidate.version, hubPath))) {
      return { result: { repo, pluginId, outcome: "current", detail: `no changes in ${hubPath}`, version }, start: false };
    }
    const from = check.installed.display;
    const to = check.candidate.display;
    const attempt = await bb.storage.kv.get<SelfUpdateAttempt>(SELF_UPDATE_KEY);
    if (attempt !== undefined && attempt.from === from && attempt.to === to) {
      const inProgress = Date.now() - Date.parse(attempt.at) < SELF_UPDATE_GRACE_MS;
      return {
        result: {
          repo,
          pluginId,
          outcome: inProgress ? "updating" : "failed",
          detail: inProgress ? `${from} → ${to} is still being applied.` : `Updating ${from} → ${to} did not stick (bb rolled it back). Push a fix.`,
          version,
        },
        start: false,
      };
    }
    await bb.storage.kv.set(SELF_UPDATE_KEY, { from, to, at: new Date().toISOString() });
    return {
      result: { repo, pluginId, outcome: "updating", detail: `${from} → ${to}; the hub reloads when the update finishes.`, version },
      start: true,
    };
  }

  // -------------------------------------------------------------------------
  // Sync

  async function runSync(trigger: string): Promise<SyncReport> {
    const startedAt = Date.now();
    fetchedThisRound.clear();
    const results: SyncResult[] = [];
    let from = "—";
    let startSelfUpdate = false;
    let packagesDir: string | null = null;
    try {
      const packages = await loadPackages();
      from = packages.from;
      packagesDir = await syncMirror(packages.packagesRepo);
      for (const error of packages.errors) {
        results.push({ repo: "packages.json", pluginId: null, outcome: "failed", detail: error, version: null });
      }
      const folderForId = new Map<string, string>();
      for (const spec of packages.specs) {
        const label = labelFor(spec, packages.packagesRepo);
        try {
          // bb installs one plugin per id; a second folder with the same id
          // would fight the first, so it is reported instead of installed.
          const id = pluginIdForPackageName((await readPackageJson(await syncMirror(spec), spec.path)).name);
          const first = folderForId.get(id);
          if (first !== undefined) {
            results.push({ repo: label, pluginId: id, outcome: "failed", detail: `Same plugin id "${id}" as ${first}; rename one package.`, version: null });
            continue;
          }
          folderForId.set(id, label);
          results.push(await installOrUpdate(spec, label));
        } catch (cause) {
          results.push({ repo: label, pluginId: null, outcome: "failed", detail: errorMessage(cause), version: null });
        }
      }
    } catch (cause) {
      results.push({ repo: "*", pluginId: null, outcome: "failed", detail: errorMessage(cause), version: null });
    }
    const config = await readConfig().catch(() => null);
    if (config?.selfUpdate && packagesDir !== null) {
      try {
        const self = await checkSelf(packagesDir, config.hubPath);
        results.push(self.result);
        startSelfUpdate = self.start;
      } catch (cause) {
        results.push({ repo: "hub (self)", pluginId: bb.pluginId, outcome: "failed", detail: errorMessage(cause), version: null });
      }
    }
    const report: SyncReport = { at: new Date().toISOString(), trigger, packagesFrom: from, durationMs: Date.now() - startedAt, results };
    await bb.storage.kv.set(LAST_SYNC_KEY, report);
    for (const result of results) {
      if (result.outcome === "failed" || result.outcome === "other-source") {
        bb.log.warn(`sync ${result.repo}: ${result.outcome} — ${result.detail ?? ""}`);
      }
    }
    bb.realtime.publish(HUB_CHANGED, { sync: report.at });
    if (startSelfUpdate) {
      clearTimeout(selfUpdateTimer);
      selfUpdateTimer = setTimeout(() => {
        bb.sdk.plugins.experimental_startUpdate({ pluginId: bb.pluginId }).then(
          (job) => bb.log.info(`self-update started (job ${job.id})`),
          (cause) => bb.log.error(`self-update could not start: ${errorMessage(cause)}`),
        );
      }, SELF_UPDATE_DELAY_MS);
    }
    return report;
  }

  let chain: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task);
    chain = next.catch(() => undefined);
    return next;
  }
  let queuedSync: Promise<SyncReport> | null = null;
  function requestSync(trigger: string): Promise<SyncReport> {
    if (queuedSync !== null) return queuedSync;
    const next = serialize(() => {
      queuedSync = null;
      return runSync(trigger);
    });
    queuedSync = next;
    return next;
  }
  const syncInBackground = (trigger: string) => {
    requestSync(trigger).catch((cause) => bb.log.error(`sync (${trigger}) failed: ${errorMessage(cause)}`));
  };

  // -------------------------------------------------------------------------
  // Folders, one-off installs, adopt

  /** "hello" or "plugins/hello" → a folder in the packages repository. */
  async function resolveFolder(arg: string): Promise<PackageSpec> {
    const { packagesRepo } = await readConfig();
    const folder = (arg.includes("/") ? arg : `${PLUGINS_FOLDER}/${arg}`).replace(/\/+$/u, "");
    if (!PATH_PATTERN.test(folder)) throw new Error(`Invalid folder "${arg}".`);
    return { ...packagesRepo, path: folder, ref: null };
  }

  async function installFolder(arg: string): Promise<SyncResult> {
    const result = await serialize(async () => {
      fetchedThisRound.clear();
      const spec = await resolveFolder(arg);
      return installOrUpdate(spec, spec.path);
    });
    bb.realtime.publish(HUB_CHANGED, { repo: result.repo });
    if (result.outcome === "failed") throw new Error(result.detail ?? "Install failed.");
    return result;
  }

  async function adoptFolder(arg: string): Promise<SyncResult> {
    const result = await serialize(async () => {
      fetchedThisRound.clear();
      const spec = await resolveFolder(arg);
      const dir = await syncMirror(spec);
      const pluginId = pluginIdForPackageName((await readPackageJson(dir, spec.path)).name);
      if (pluginId === bb.pluginId) throw new Error("The hub cannot adopt itself; reinstall it as JOIN.md describes.");
      const installed = (await bb.sdk.plugins.list()).plugins.find((entry) => entry.id === pluginId);
      if (installed !== undefined && !isHubSource(installed.source, spec)) {
        await bb.sdk.plugins.remove({ pluginId });
        bb.log.info(`removed ${pluginId} (was ${installed.source}) to adopt it`);
      }
      return installOrUpdate(spec, spec.path);
    });
    bb.realtime.publish(HUB_CHANGED, { repo: result.repo });
    return result;
  }

  async function listHub() {
    const packages = await serialize(async () => {
      fetchedThisRound.clear();
      return loadPackages();
    });
    const dir = await syncMirror(packages.packagesRepo);
    const tree = await git(["ls-tree", "-d", "--name-only", `HEAD:${PLUGINS_FOLDER}`], dir).catch(() => "");
    const installed = new Map((await bb.sdk.plugins.list()).plugins.map((entry) => [entry.id, entry.version]));
    const packageFolders = new Set(
      packages.specs.filter((spec) => repoKey(spec) === repoKey(packages.packagesRepo)).map((spec) => spec.path),
    );
    const folders: PluginFolder[] = [];
    for (const name of tree.split("\n").map((line) => line.trim()).filter(Boolean)) {
      const folder = `${PLUGINS_FOLDER}/${name}`;
      const manifest = await readPackageJson(dir, folder).catch(() => null);
      if (manifest === null) continue;
      const pluginId = pluginIdForPackageName(manifest.name);
      folders.push({
        path: folder,
        pluginId,
        name: manifest.bb?.name ?? pluginId,
        description: manifest.bb?.description ?? null,
        installed: installed.has(pluginId),
        installedVersion: installed.get(pluginId) ?? null,
        isPackage: packageFolders.has(folder),
      });
    }
    return {
      repo: `${packages.packagesRepo.owner}/${packages.packagesRepo.name}`,
      folders,
      packages: packages.specs.map((spec) => ({
        label: labelFor(spec, packages.packagesRepo),
        path: spec.path,
        repo: `${spec.owner}/${spec.name}`,
        ref: spec.ref,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Triggers

  settings.onChange((next, prev) => {
    for (const key of ["packagesRepo", "hubPath", "selfUpdate", "mirrorsDir"] as const) {
      if (next[key] !== prev[key]) bb.log.warn(`setting ${key} changed from "${String(prev[key])}" to "${String(next[key])}"`);
    }
    if (next.mirrorsDir !== prev.mirrorsDir) activeMirrorRoot = null;
    syncInBackground("settings changed");
  });

  bb.background.service("aligned-sync", {
    async start(signal) {
      while (!signal.aborted) {
        const wait = nextBoundary(Date.now(), syncIntervalMinutes) - Date.now();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(wait, 1_000));
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (signal.aborted) break;
        await requestSync("schedule").catch((cause) => bb.log.error(`scheduled sync failed: ${errorMessage(cause)}`));
      }
    },
  });

  bb.background.service("initial-sync", {
    async start(signal) {
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      for (let attempt = 0; attempt < 30 && !signal.aborted; attempt += 1) {
        if (defaultMirrorRoot() !== null) break;
        await sleep(2_000);
      }
      if (!signal.aborted) syncInBackground("startup");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });

  // Other plugins can call any plugin's rpc methods; none of these are for
  // them (they would let another plugin install code through the hub).
  function clientOnly(context: ExperimentalPluginRpcHandlerContext, method: string): void {
    const caller = context.experimental_caller;
    if (caller.kind !== "client") {
      bb.log.warn(`refused ${method} from plugin "${caller.pluginId}"`);
      throw new Error(`The hub does not accept ${method} from other plugins.`);
    }
  }

  bb.rpc.register(rpcContract, {
    hub_list: async (_input, context) => {
      clientOnly(context, "hub_list");
      const lastSync = (await bb.storage.kv.get<SyncReport>(LAST_SYNC_KEY)) ?? null;
      return { ...(await listHub()), lastSync, schedule: scheduleView(lastSync) };
    },
    hub_install: ({ path: folder }, context) => {
      clientOnly(context, "hub_install");
      return installFolder(folder);
    },
    hub_sync: (_input, context) => {
      clientOnly(context, "hub_sync");
      return requestSync("manual");
    },
  });

  // -------------------------------------------------------------------------
  // CLI

  const formatResult = (result: SyncResult) =>
    `${result.outcome.padEnd(12)} ${result.repo}${result.version ? ` ${result.version}` : ""}${result.detail ? `  (${result.detail})` : ""}`;
  const formatTime = (iso: string) => {
    const at = new Date(iso);
    const minutes = Math.max(0, Math.ceil((at.getTime() - Date.now()) / 60_000));
    return `${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (${at.toISOString().slice(11, 16)} UTC, in ${minutes} min)`;
  };
  const toCliError = (cause: unknown) => new PluginCliError(errorMessage(cause));
  const jsonOption = { json: { type: "boolean", description: "Print JSON" } } as const;
  const folderPositional = [
    { name: "folder", description: 'A plugin folder in the packages repository: "hello" or "plugins/hello"', required: true },
  ] as const;

  bb.cli.register(
    defineCli({
      name: "hub",
      summary: "Keep the bb plugins in the shared public repository installed and up to date",
      commands: {
        list: cliCommand({
          summary: "List the plugin folders in the packages repository, with install and package status",
          options: jsonOption,
          async run({ options }) {
            const hub = await listHub().catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(hub) };
            return {
              exitCode: 0,
              stdout: hub.folders.length === 0
                ? `No plugin folders in ${hub.repo}.`
                : hub.folders
                    .map((folder) =>
                      `${folder.installed ? `[installed ${folder.installedVersion}]` : "[available]"}${folder.isPackage ? " [package]" : ""}  ${folder.path} — ${folder.name}${folder.description ? `: ${folder.description}` : ""}`,
                    )
                    .join("\n"),
            };
          },
        }),
        install: cliCommand({
          summary: "Install a plugin folder from the packages repository, or update it",
          positionals: folderPositional,
          options: jsonOption,
          async run({ positionals, options }) {
            const result = await installFolder(positionals.folder).catch((cause) => { throw toCliError(cause); });
            return { exitCode: 0, stdout: options.json ? JSON.stringify(result) : formatResult(result) };
          },
        }),
        adopt: cliCommand({
          summary: "Switch a plugin installed some other way to the packages repository (removes it first: its settings and data are deleted)",
          positionals: folderPositional,
          options: jsonOption,
          async run({ positionals, options }) {
            const result = await adoptFolder(positionals.folder).catch((cause) => { throw toCliError(cause); });
            return { exitCode: 0, stdout: options.json ? JSON.stringify(result) : formatResult(result) };
          },
        }),
        packages: cliCommand({
          summary: "Show packages.json: the plugins every hub keeps installed",
          options: jsonOption,
          async run({ options }) {
            const packages = await serialize(async () => {
              fetchedThisRound.clear();
              return loadPackages();
            }).catch((cause) => { throw toCliError(cause); });
            const view = { from: packages.from, plugins: packages.specs.map((spec) => labelFor(spec, packages.packagesRepo)), errors: packages.errors };
            return {
              exitCode: 0,
              stdout: options.json ? JSON.stringify(view) : [`From ${view.from}:`, ...view.plugins.map((p) => `  ${p}`), ...view.errors].join("\n"),
            };
          },
        }),
        sync: cliCommand({
          summary: "Install missing packages and apply updates to changed ones now",
          options: jsonOption,
          async run({ options }) {
            const report = await requestSync("cli");
            return {
              exitCode: report.results.some((result) => result.outcome === "failed") ? 1 : 0,
              stdout: options.json ? JSON.stringify(report) : [`Packages from ${report.packagesFrom}`, ...report.results.map(formatResult)].join("\n"),
            };
          },
        }),
        status: cliCommand({
          summary: "Show the shared sync schedule, when a change pushed now reaches every hub, and where the mirror lives",
          options: jsonOption,
          async run({ options }) {
            const lastSync = (await bb.storage.kv.get<SyncReport>(LAST_SYNC_KEY)) ?? null;
            const schedule = scheduleView(lastSync);
            const config = await readConfig().catch((cause) => { throw toCliError(cause); });
            const mirrors = await ensureMirrorRoot().catch((cause) => `unavailable: ${errorMessage(cause)}`);
            const view = { schedule, packagesRepo: `${config.packagesRepo.owner}/${config.packagesRepo.name}`, mirrors, lastSync: lastSync?.at ?? null };
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(view) };
            return {
              exitCode: 0,
              stdout: [
                `Packages repository: ${view.packagesRepo} (public, no tokens)`,
                `All hubs sync every ${schedule.intervalMinutes} min, on the same UTC-aligned times.`,
                `Next sync everywhere: ${formatTime(schedule.nextSyncAt)}`,
                `A change pushed now reaches every running hub by: ${formatTime(schedule.guaranteedBy)}`,
                `  (changes must be on GitHub ${schedule.marginSeconds}s before a sync; only plugins whose folder changed are updated;` +
                  `${schedule.lastSyncDurationMs === null ? "" : ` a sync took ${Math.round(schedule.lastSyncDurationMs / 1000)}s here last time;`} hubs that are off catch up when they start)`,
                `Mirror: ${mirrors}`,
                `Last sync here: ${lastSync === null ? "never" : `${new Date(lastSync.at).toLocaleString()} (${lastSync.trigger})`}`,
              ].join("\n"),
            };
          },
        }),
      },
    }),
  );
}
