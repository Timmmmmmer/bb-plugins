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
import { access, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_PLUGIN_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_CHARS = 12 * 1024 * 1024; // base64 characters across all uploaded files

function nextBoundary(fromMs: number, intervalMinutes: number): number {
  const step = intervalMinutes * 60_000;
  return Math.floor(fromMs / step) * step + step;
}

// ---------------------------------------------------------------------------
// packages.json

const packageEntrySchema = z.object({
  /** The plugin's folder, e.g. "plugins/hello"; omitted = the repository root. */
  path: z.string().trim().optional(),
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
  /** Older name for "remote"; still read. */
  plugins: z.array(packageEntrySchema).max(100).optional(),
  /** Remote plugins: other public repositories, installed straight from there. */
  remote: z.array(packageEntrySchema).max(100).optional(),
  /** Plugins from bb's marketplaces (bb-community, bb-official, or a third-party one). */
  marketplace: z.array(z.object({
    /** The catalog entry id, as in `bb plugin install <id>@<marketplace>`. */
    id: z.string().trim().min(1),
    /** The marketplace name; omitted means "the only marketplace that has it". */
    marketplace: z.string().trim().min(1).optional(),
    /** For a third-party marketplace: where to add it from on machines that don't have it. */
    source: z.string().trim().min(1).optional(),
    subdirectory: z.string().trim().min(1).optional(),
  })).max(100).optional(),
});

const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
const MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const BUILT_IN_MARKETPLACES = new Set(["bb-official", "bb-community"]);
interface MarketplaceSpec {
  id: string;
  marketplace: string | null;
  source: string | null;
  subdirectory: string | null;
}
const marketplaceLabel = (entry: { id: string; marketplace: string | null }) =>
  `marketplace:${entry.id}${entry.marketplace ? `@${entry.marketplace}` : ""}`;

/** "thread-hover-cards" or "thread-hover-cards@bb-community". */
function parseEntryArg(arg: string): { id: string; marketplace: string | null } {
  const [id, marketplace, ...rest] = arg.trim().split("@");
  if (id === undefined || !ENTRY_ID_PATTERN.test(id) || rest.length > 0 || (marketplace !== undefined && !MARKETPLACE_NAME_PATTERN.test(marketplace))) {
    throw new Error(`"${arg}" is not a marketplace entry (expected <id> or <id>@<marketplace>).`);
  }
  return { id, marketplace: marketplace ?? null };
}

interface RepoRef {
  /** GitHub owner, or "<host>/<path>" for other hosts. */
  owner: string;
  name: string;
  /** The anonymous https clone URL. */
  url: string;
}
interface PackageSpec extends RepoRef {
  /** The plugin's folder in the repository; "" is the repository root. */
  path: string;
  ref: string | null;
}

/**
 * A public git repository: "owner/name" (GitHub), or an https URL. GitHub
 * links to a folder (`…/tree/<branch>/<folder>`) also give the folder and
 * branch. SSH URLs are refused: the hub only reads public repositories.
 */
function parseRepoInput(input: string): { repo: RepoRef; path: string | null; ref: string | null } {
  const text = input.trim().replace(/\/+$/u, "");
  if (/^(git@|ssh:\/\/)/iu.test(text)) {
    throw new Error(`"${input}" is an SSH URL. Use the https URL; the hub only reads public repositories.`);
  }
  if (!/^https?:\/\//iu.test(text)) {
    const [owner, name, ...rest] = text.replace(/\.git$/iu, "").split("/");
    if (owner === undefined || name === undefined || rest.length > 0 || !OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) {
      throw new Error(`"${input}" is not a repository (expected owner/name or an https git URL).`);
    }
    return { repo: { owner, name, url: `https://github.com/${owner}/${name}.git` }, path: null, ref: null };
  }
  const url = new URL(text);
  if (url.protocol !== "https:") throw new Error(`"${input}" must be an https URL.`);
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (url.hostname.toLowerCase() === "github.com") {
    const [owner, rawName, kind, ref, ...rest] = parts;
    const name = rawName?.replace(/\.git$/iu, "");
    if (owner === undefined || name === undefined || !OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) {
      throw new Error(`"${input}" is not a GitHub repository URL.`);
    }
    const isFolderLink = (kind === "tree" || kind === "blob") && ref !== undefined;
    return {
      repo: { owner, name, url: `https://github.com/${owner}/${name}.git` },
      path: isFolderLink && rest.length > 0 ? rest.join("/") : null,
      ref: isFolderLink ? ref : null,
    };
  }
  const name = parts.at(-1)?.replace(/\.git$/iu, "");
  if (name === undefined || !NAME_PATTERN.test(name) || parts.slice(0, -1).some((part) => !NAME_PATTERN.test(part))) {
    throw new Error(`"${input}" is not a git repository URL.`);
  }
  const owner = [url.host.toLowerCase(), ...parts.slice(0, -1)].join("/");
  return { repo: { owner, name, url: `https://${url.host}${url.pathname.replace(/\/+$/u, "")}` }, path: null, ref: null };
}
const parseRepo = (input: string): RepoRef => parseRepoInput(input).repo;
const repoKey = (repo: RepoRef) => repo.url.toLowerCase().replace(/\.git$/u, "");
const repoUrl = (repo: RepoRef) => repo.url;
const repoDisplay = (repo: RepoRef) =>
  repo.url.toLowerCase().startsWith("https://github.com/") ? `${repo.owner}/${repo.name}` : repo.url;
/** A file inside a plugin folder ("" = repository root), for `git show`. */
const inFolder = (folder: string, file: string) => (folder === "" ? file : `${folder}/${file}`);

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

const packageViewSchema = z.object({
  label: z.string(),
  path: z.string(),
  repo: z.string(),
  ref: z.string().nullable(),
  /** local: a folder in the shared repository; remote: another public repository. */
  kind: z.enum(["local", "remote"]),
});
export type PackageView = z.infer<typeof packageViewSchema>;

export const rpcContract = defineRpcContract({
  hub_list: {
    input: z.null(),
    output: z.object({
      repo: z.string(),
      folders: z.array(folderSchema),
      packages: z.array(packageViewSchema),
      marketplace: z.array(z.object({ label: z.string(), entry: z.string() })),
      lastSync: syncReportSchema.nullable(),
      schedule: scheduleSchema,
      hubVersion: z.string().nullable(),
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
  hub_marketplace_search: {
    input: z.object({ query: z.string().trim().min(1).max(200) }),
    output: z.array(z.object({
      entry: z.string(),
      pluginId: z.string(),
      displayName: z.string(),
      description: z.string(),
      marketplace: z.string(),
      installed: z.boolean(),
      compatible: z.boolean(),
    })),
  },
  hub_marketplace_add: {
    input: z.object({ entry: z.string().trim().min(1).max(200) }),
    output: z.object({
      entry: z.string(),
      pluginId: z.string(),
      displayName: z.string(),
      commit: z.string().nullable(),
      compatible: z.boolean(),
      incompatibleReason: z.string().nullable(),
      guaranteedBy: z.string(),
      sync: syncResultSchema.nullable(),
    }),
  },
  hub_marketplace_remove: {
    input: z.object({ entry: z.string().trim().min(1).max(200) }),
    output: z.object({ removed: z.array(z.string()), commit: z.string().nullable(), guaranteedBy: z.string() }),
  },
  hub_add_plugin: {
    input: z
      .object({
        source: z.string().trim().min(1).max(2000).optional(),
        files: z.array(z.object({ path: z.string().min(1).max(500), data: z.string() })).max(5000).optional(),
        archive: z.object({ name: z.string().min(1).max(200), data: z.string() }).optional(),
        name: z.string().trim().max(64).optional(),
        subdir: z.string().trim().max(200).optional(),
        force: z.boolean().optional(),
      })
      .refine((input) => [input.source, input.files, input.archive].filter((value) => value !== undefined).length === 1, {
        message: "give exactly one of source, files, or archive",
      })
      .refine(
        (input) =>
          (input.files ?? []).reduce((total, file) => total + file.data.length, 0) + (input.archive?.data.length ?? 0) <= MAX_UPLOAD_CHARS,
        { message: "the upload is too large (about 8 MB at most; leave out node_modules and dist)" },
      ),
    output: z.object({
      folder: z.string(),
      pluginId: z.string(),
      commit: z.string().nullable(),
      warning: z.string().nullable(),
      unchanged: z.boolean(),
      kind: z.enum(["local", "remote"]),
      guaranteedBy: z.string(),
      sync: syncResultSchema.nullable(),
    }),
  },
  hub_remote_remove: {
    input: z.object({ repo: z.string().trim().min(1).max(500), path: z.string().trim().max(200).optional() }),
    output: z.object({ removed: z.array(z.string()), commit: z.string().nullable(), guaranteedBy: z.string() }),
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
      throw new Error(`Can't read ${repoDisplay(repo)}: it's private or doesn't exist. Only public repositories work.`);
    }
    fetchedThisRound.add(dir);
    return dir;
  }

  async function readPackageJson(dir: string, folder: string, rev = "HEAD") {
    return packageJsonSchema.parse(JSON.parse(await git(["show", `${rev}:${inFolder(folder, "package.json")}`], dir)));
  }

  /** Whether `folder` differs between two commits; unknown counts as changed. */
  async function folderChanged(dir: string, from: string, to: string, folder: string): Promise<boolean> {
    if (!COMMIT_PATTERN.test(from) || !COMMIT_PATTERN.test(to)) return true;
    try {
      const [before, after] = await Promise.all([
        git(["rev-parse", folder === "" ? `${from}^{tree}` : `${from}:${folder}`], dir),
        git(["rev-parse", folder === "" ? `${to}^{tree}` : `${to}:${folder}`], dir),
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
    for (const entry of [...(file.remote ?? []), ...(file.plugins ?? [])]) {
      try {
        const repo = entry.repo === undefined ? packagesRepo : parseRepo(entry.repo);
        const folder = (entry.path ?? "").replace(/^\/+|\/+$/gu, "");
        if (folder !== "" && !PATH_PATTERN.test(folder)) throw new Error(`Invalid path "${entry.path}".`);
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
    const marketplace: MarketplaceSpec[] = [];
    for (const entry of file.marketplace ?? []) {
      if (!ENTRY_ID_PATTERN.test(entry.id) || (entry.marketplace !== undefined && !MARKETPLACE_NAME_PATTERN.test(entry.marketplace))) {
        errors.push(`Invalid marketplace entry "${entry.id}${entry.marketplace ? `@${entry.marketplace}` : ""}".`);
        continue;
      }
      marketplace.push({ id: entry.id, marketplace: entry.marketplace ?? null, source: entry.source ?? null, subdirectory: entry.subdirectory ?? null });
    }
    return { from: `${repoDisplay(packagesRepo)}/packages.json`, packagesRepo, specs, marketplace, errors };
  }

  const isLocal = (spec: PackageSpec, packagesRepo: RepoRef) => repoKey(spec) === repoKey(packagesRepo);
  const labelFor = (spec: PackageSpec, packagesRepo: RepoRef) =>
    isLocal(spec, packagesRepo)
      ? `${spec.path}${spec.ref ? `@${spec.ref}` : ""}`
      : `${repoDisplay(spec)}${spec.path ? `/${spec.path}` : ""}${spec.ref ? `@${spec.ref}` : ""}`;
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
      const result = await bb.sdk.plugins.install({ source: sourceFor(spec), ...(spec.path ? { subdirectory: spec.path } : {}) });
      bb.log.info(`installed ${result.id}@${result.version} from ${label}`);
      return { repo: label, pluginId, outcome: "installed", detail: null, version: result.version };
    }
    if (!isHubSource(installed.source, spec)) {
      return {
        repo: label,
        pluginId,
        outcome: "other-source",
        detail: `Installed from ${installed.source}. Run \`bb hub adopt ${spec.path || repoDisplay(spec)}\` to switch it to ${repoDisplay(spec)} (this deletes the plugin's settings and data).`,
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
  // Marketplace plugins: installed through bb's own catalog (with bb's checks
  // and its exact resolved source), then kept updated with bb's update check.

  /** Register a third-party marketplace on this machine if it's missing. */
  async function ensureMarketplace(entry: MarketplaceSpec): Promise<void> {
    if (entry.marketplace === null || BUILT_IN_MARKETPLACES.has(entry.marketplace) || entry.source === null) return;
    const known = await bb.sdk.plugins.marketplaces.list();
    if (known.some((marketplace) => marketplace.name === entry.marketplace)) return;
    const added = await bb.sdk.plugins.marketplaces.add({
      source: entry.source,
      ...(entry.subdirectory ? { subdirectory: entry.subdirectory } : {}),
    });
    bb.log.info(`added marketplace ${added.name} from ${entry.source}`);
  }

  async function syncMarketplaceEntry(entry: MarketplaceSpec): Promise<SyncResult> {
    const label = marketplaceLabel(entry);
    await ensureMarketplace(entry);
    const plan = await bb.sdk.plugins.catalog.installPlan({
      entryId: entry.id,
      ...(entry.marketplace ? { marketplace: entry.marketplace } : {}),
    });
    const pluginId = plan.pluginId;
    if (pluginId === bb.pluginId) {
      return { repo: label, pluginId, outcome: "skipped", detail: "That is the hub itself.", version: null };
    }
    const installed = (await bb.sdk.plugins.list()).plugins.find((plugin) => plugin.id === pluginId);
    if (installed === undefined) {
      if (!plan.compatible) {
        return { repo: label, pluginId, outcome: "failed", detail: plan.incompatibleReason ?? "Not compatible with this bb.", version: null };
      }
      const result = await bb.sdk.plugins.catalog.install({
        entryId: entry.id,
        ...(plan.kind === "marketplace"
          ? { marketplace: plan.marketplace, confirmedSource: plan.resolvedSource }
          : entry.marketplace
            ? { marketplace: entry.marketplace }
            : {}),
      });
      bb.log.info(`installed ${result.id}@${result.version} from ${label}`);
      return { repo: label, pluginId, outcome: "installed", detail: null, version: result.version };
    }
    const elsewhere = installed.catalogEntryId !== entry.id ? `installed from ${installed.sourceDisplay}, not from the marketplace` : null;
    const [check] = await bb.sdk.plugins.checkUpdates({ pluginId });
    if (check === undefined || check.outcome === "current") {
      return { repo: label, pluginId, outcome: "current", detail: elsewhere, version: installed.version };
    }
    if (check.outcome !== "update-available") {
      return { repo: label, pluginId, outcome: check.outcome === "pinned" ? "pinned" : "skipped", detail: elsewhere ?? check.detail ?? check.outcome, version: installed.version };
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
      detail: applied.applied ? `${applied.from.version} → ${applied.to?.version ?? "latest"}` : elsewhere,
      version: applied.to?.version ?? applied.from.version,
    };
  }

  /** Change packages.json in the shared repository with one commit, pushed with this machine's git. */
  async function editPackagesJson(
    mutate: (document: Record<string, unknown>) => Record<string, unknown>,
    message: string,
  ): Promise<string | null> {
    const { packagesRepo } = await readConfig();
    const work = await workingClone(packagesRepo);
    const file = path.join(work, "packages.json");
    const document = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(file, "utf8")));
    const next = mutate(document);
    packagesFileSchema.parse(next);
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return commitAndPush(work, ["packages.json"], message, packagesRepo);
  }

  async function addMarketplacePlugin(arg: string) {
    const wanted = parseEntryArg(arg);
    const outcome = await serialize(async () => {
      // Resolve it now, so a typo or an incompatible entry fails before any commit.
      const plan = await bb.sdk.plugins.catalog.installPlan({
        entryId: wanted.id,
        ...(wanted.marketplace ? { marketplace: wanted.marketplace } : {}),
      });
      if (plan.pluginId === bb.pluginId) throw new Error("That is the hub itself.");
      const marketplace = plan.kind === "marketplace" ? plan.marketplace : wanted.marketplace ?? "bb-official";
      const entry: Record<string, string> = { id: plan.entryId, marketplace };
      if (!BUILT_IN_MARKETPLACES.has(marketplace)) {
        const known = (await bb.sdk.plugins.marketplaces.list()).find((item) => item.name === marketplace);
        if (known !== undefined) {
          entry.source = known.source;
          if (known.subdirectory) entry.subdirectory = known.subdirectory;
        }
      }
      const commit = await editPackagesJson((document) => {
        const list = z.array(z.record(z.string(), z.unknown())).catch([]).parse(document.marketplace ?? []);
        if (list.some((item) => item.id === entry.id && (item.marketplace ?? marketplace) === marketplace)) {
          throw new Error(`${entry.id}@${marketplace} is already in packages.json.`);
        }
        return { ...document, marketplace: [...list, entry] };
      }, `Add ${entry.id}@${marketplace} from the marketplace to hub packages`);
      return { entry: `${entry.id}@${marketplace}`, pluginId: plan.pluginId, displayName: plan.displayName, commit, compatible: plan.compatible, incompatibleReason: plan.incompatibleReason };
    });
    const report = await requestSync("marketplace plugin added");
    const sync = report.results.find((result) => result.pluginId === outcome.pluginId) ?? null;
    bb.realtime.publish(HUB_CHANGED, { added: outcome.entry });
    return { ...outcome, guaranteedBy: scheduleView(null).guaranteedBy, sync };
  }

  async function removeMarketplacePlugin(arg: string) {
    const wanted = parseEntryArg(arg);
    const outcome = await serialize(async () => {
      let removed: string[] = [];
      const commit = await editPackagesJson((document) => {
        const list = z.array(z.record(z.string(), z.unknown())).catch([]).parse(document.marketplace ?? []);
        const keep = list.filter((item) => !(item.id === wanted.id && (wanted.marketplace === null || item.marketplace === wanted.marketplace)));
        removed = list.filter((item) => !keep.includes(item)).map((item) => `${String(item.id)}@${String(item.marketplace ?? "any")}`);
        if (removed.length === 0) throw new Error(`${arg} is not in packages.json's marketplace list.`);
        return { ...document, marketplace: keep };
      }, `Remove ${arg} from the marketplace hub packages`);
      return { removed, commit };
    });
    bb.realtime.publish(HUB_CHANGED, { removed: outcome.removed });
    return { ...outcome, guaranteedBy: scheduleView(null).guaranteedBy };
  }

  async function searchMarketplace(query: string) {
    const response = await bb.sdk.plugins.catalog.search({ query });
    return response.results.slice(0, 50).map((result) => ({
      entry: `${result.entryId}@${result.marketplace}`,
      pluginId: result.pluginId,
      displayName: result.displayName,
      description: result.description,
      marketplace: result.marketplaceDisplayName,
      installed: result.installed,
      compatible: result.compatible,
    }));
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
      for (const entry of packages.marketplace) {
        try {
          results.push(await syncMarketplaceEntry(entry));
        } catch (cause) {
          results.push({ repo: marketplaceLabel(entry), pluginId: null, outcome: "failed", detail: errorMessage(cause), version: null });
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
      repo: repoDisplay(packages.packagesRepo),
      folders,
      packages: packages.specs.map((spec) => ({
        label: labelFor(spec, packages.packagesRepo),
        path: spec.path,
        repo: repoDisplay(spec),
        ref: spec.ref,
        kind: isLocal(spec, packages.packagesRepo) ? ("local" as const) : ("remote" as const),
      })),
      marketplace: packages.marketplace.map((entry) => ({
        label: marketplaceLabel(entry),
        entry: `${entry.id}${entry.marketplace ? `@${entry.marketplace}` : ""}`,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Adding a plugin: from a git repository, an archive, a local folder, or an
  // upload from the Plugin hub page. The plugin is copied into a working
  // clone of the packages repository, checked, committed, and pushed with
  // this machine's own git credentials (the hub stores none). Every running
  // hub then installs it at the next sync, since packages.json includes
  // plugins/*.

  const ARCHIVE_PATTERN = /\.(zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/iu;
  const SKIP_NAMES = new Set(["node_modules", "dist", ".git", ".claude"]);
  const isSkippedName = (name: string) => SKIP_NAMES.has(name) || name === ".env" || name.startsWith(".env.");
  const FOLDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

  /** git using this machine's own credentials (only for pushing). */
  function gitWithMachineCredentials(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr).trim().split("\n").slice(-2).join(" ") || error.message));
        else resolve(String(stdout));
      });
    });
  }

  async function scratchDir(): Promise<string> {
    const root = path.join(path.dirname(await ensureMirrorRoot()), "tmp");
    await mkdir(root, { recursive: true });
    return mkdtemp(path.join(root, "add-"));
  }

  async function extractArchive(file: string, into: string): Promise<string> {
    await mkdir(into, { recursive: true });
    const run = (command: string, args: string[]) =>
      new Promise<void>((resolve, reject) =>
        execFile(command, args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, _out, stderr) =>
          error ? reject(new Error(`${command} failed: ${String(stderr).trim() || error.message}`)) : resolve(),
        ),
      );
    // unzip and tar both refuse absolute and "../" entries.
    if (/\.zip$/iu.test(file)) await run("unzip", ["-q", file, "-d", into]);
    else await run("tar", ["-xf", file, "-C", into]);
    // Archives often wrap everything in one top-level folder.
    const entries = await readdir(into, { withFileTypes: true });
    return entries.length === 1 && entries[0]?.isDirectory() ? path.join(into, entries[0].name) : into;
  }

  type UploadedFile = { path: string; data: string };
  type AddSource =
    | { kind: "text"; source: string; cwd?: string }
    | { kind: "files"; files: UploadedFile[] }
    | { kind: "archive"; name: string; data: string };

  /** Put the source in a scratch folder; returns that folder and a description. */
  async function materialize(source: AddSource, scratch: string): Promise<{ dir: string; description: string }> {
    if (source.kind === "files") {
      const root = path.join(scratch, "upload");
      for (const file of source.files) {
        const parts = file.path.replace(/\\/gu, "/").split("/").filter((part) => part !== "" && part !== ".");
        if (parts.length === 0 || parts.some((part) => part === ".." || isSkippedName(part))) continue;
        const target = path.join(root, ...parts);
        if (path.relative(root, target).startsWith("..")) continue;
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(file.data, "base64"));
      }
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const dir = entries.length === 1 && entries[0]?.isDirectory() ? path.join(root, entries[0].name) : root;
      return { dir, description: `uploaded folder ${path.basename(dir)}` };
    }
    if (source.kind === "archive") {
      if (!ARCHIVE_PATTERN.test(source.name)) throw new Error(`"${source.name}" is not a .zip or .tar archive.`);
      const file = path.join(scratch, `upload-${path.basename(source.name)}`);
      await writeFile(file, Buffer.from(source.data, "base64"));
      return { dir: await extractArchive(file, path.join(scratch, "extract")), description: `uploaded ${path.basename(source.name)}` };
    }
    const text = source.source.trim();
    if (ARCHIVE_PATTERN.test(text.split(/[?#]/u)[0] ?? "")) {
      const name = path.basename(text.split(/[?#]/u)[0] ?? "archive.zip");
      const file = path.join(scratch, `download-${name}`);
      if (/^https?:\/\//iu.test(text)) {
        const response = await fetch(text, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`Downloading ${text} failed: ${response.status} ${response.statusText}.`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(`${text} is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
        await writeFile(file, bytes);
      } else {
        await cp(path.resolve(source.cwd ?? process.cwd(), text), file);
      }
      return { dir: await extractArchive(file, path.join(scratch, "extract")), description: `archive ${name}` };
    }
    if (/^(https?:\/\/|git@|ssh:\/\/)/iu.test(text) || text.endsWith(".git")) {
      const dir = path.join(scratch, "repo");
      await git(["clone", "--quiet", "--depth", "1", text, dir]).catch((cause) => {
        throw new Error(`Could not clone ${text} (${errorMessage(cause)}). Only public repositories work.`);
      });
      const commit = (await git(["rev-parse", "--short", "HEAD"], dir)).trim();
      return { dir, description: `${text}@${commit}` };
    }
    const dir = path.resolve(source.cwd ?? process.cwd(), text);
    const info = await stat(dir).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new Error(`"${text}" is not a folder, git URL, or .zip/.tar archive on the machine running bb.`);
    }
    return { dir, description: `folder ${path.basename(dir)}` };
  }

  async function isPluginDir(dir: string): Promise<boolean> {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { bb?: unknown };
      return typeof manifest.bb === "object" && manifest.bb !== null;
    } catch {
      return false;
    }
  }

  /** The plugin folder in the source: `subdir`, the root, or the only plugin within 4 levels. */
  async function findPluginDir(base: string, subdir: string | undefined): Promise<string> {
    let root = base;
    if (subdir !== undefined && subdir.trim() !== "") {
      if (!PATH_PATTERN.test(subdir.trim())) throw new Error(`Invalid subdir "${subdir}".`);
      root = path.join(base, subdir.trim());
    }
    if (await isPluginDir(root)) return root;
    const found: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || found.length > 20) return;
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || isSkippedName(entry.name)) continue;
        const child = path.join(dir, entry.name);
        if (await isPluginDir(child)) found.push(child);
        else await walk(child, depth + 1);
      }
    };
    await walk(root, 1);
    if (found.length === 0) throw new Error('No bb plugin found (a package.json with a "bb" section).');
    if (found.length > 1) {
      throw new Error(`The source holds several plugins; pick one with subdir: ${found.map((dir) => path.relative(base, dir)).join(", ")}`);
    }
    return found[0] as string;
  }

  /** Validate the manifest; returns the plugin id and a warning, if any. */
  async function checkManifest(dir: string): Promise<{ pluginId: string; warning: string | null }> {
    const manifest = z
      .object({
        name: z.string().min(1),
        engines: z.object({ bb: z.string().optional() }).passthrough().optional(),
        bb: z.object({
          name: z.string().min(1),
          description: z.string().min(1),
          server: z.string().min(1),
          branding: z.object({ icon: z.string().optional(), logo: z.unknown().optional() }).passthrough(),
        }).passthrough(),
      })
      .passthrough()
      .safeParse(JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")));
    if (!manifest.success) {
      throw new Error(`Not a valid bb plugin: ${manifest.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
    }
    if (!manifest.data.bb.branding.icon && !manifest.data.bb.branding.logo) throw new Error("Not a valid bb plugin: bb.branding.icon is missing.");
    const server = path.resolve(dir, manifest.data.bb.server);
    if (path.relative(dir, server).startsWith("..") || !(await stat(server).then((s) => s.isFile(), () => false))) {
      throw new Error(`Not a valid bb plugin: bb.server file ${manifest.data.bb.server} does not exist.`);
    }
    const pluginId = pluginIdForPackageName(manifest.data.name);
    if (pluginId === "") throw new Error("Not a valid bb plugin: invalid package name.");
    const min = manifest.data.engines?.bb?.match(/(\d+)\.(\d+)(?:\.(\d+))?/u);
    let warning: string | null = null;
    if (min) {
      const [major, minor, patch] = [Number(min[1]), Number(min[2]), Number(min[3] ?? 0)];
      if (major > 0 || minor > 47 || (minor === 47 && patch > 1)) {
        warning = `engines.bb is "${manifest.data.engines?.bb}"; machines on older bb (e.g. 0.47.1) will refuse it. Lower it if the plugin doesn't need it.`;
      }
    }
    return { pluginId, warning };
  }

  /** Copy a plugin folder, leaving out build output, secrets, and symlinks. */
  async function copyPlugin(from: string, to: string): Promise<number> {
    let bytes = 0;
    await cp(from, to, {
      recursive: true,
      filter: async (source) => {
        if (source !== from && isSkippedName(path.basename(source))) return false;
        const info = await lstat(source);
        if (info.isSymbolicLink()) return false;
        if (info.isFile()) bytes += info.size;
        return true;
      },
    });
    if (bytes > MAX_PLUGIN_BYTES) throw new Error(`The plugin is ${Math.round(bytes / 1024 / 1024)} MB; the limit is ${MAX_PLUGIN_BYTES / 1024 / 1024} MB.`);
    return bytes;
  }

  /** A working (non-bare) clone of the packages repository, reset to GitHub's latest. */
  async function workingClone(repo: RepoRef): Promise<string> {
    const dir = path.join(path.dirname(await ensureMirrorRoot()), "work", repo.owner.toLowerCase(), repo.name.toLowerCase());
    if (await access(path.join(dir, ".git")).then(() => true, () => false)) {
      await git(["fetch", "--quiet", "origin"], dir);
      await git(["reset", "--quiet", "--hard", "origin/HEAD"], dir);
      await git(["clean", "-fdxq"], dir);
    } else {
      await rm(dir, { recursive: true, force: true });
      await mkdir(path.dirname(dir), { recursive: true });
      await git(["clone", "--quiet", repoUrl(repo), dir]);
    }
    return dir;
  }

  /** Commit `paths` in the working clone and push with this machine's credentials; null if nothing changed. */
  async function commitAndPush(work: string, paths: string[], message: string, repo: RepoRef): Promise<string | null> {
    await git(["add", "-A", "--", ...paths], work);
    const staged = await git(["diff", "--cached", "--name-only", "--", ...paths], work);
    if (staged.trim() === "") return null;
    const identity = (await gitWithMachineCredentials(["config", "user.name"], work).catch(() => "")).trim()
      ? []
      : ["-c", "user.name=bb hub", "-c", "user.email=bb-hub@users.noreply.github.com"];
    await git([...identity, "commit", "--quiet", "-m", message, "--", ...paths], work);
    const pushFailed = (cause: unknown) =>
      new Error(
        `Pushing to ${repo.owner}/${repo.name} failed: ${errorMessage(cause)}. Changing the shared repository needs this machine's git to have write access to it (for example \`gh auth setup-git\`).`,
      );
    try {
      await gitWithMachineCredentials(["push", "--quiet", "origin", "HEAD"], work);
    } catch (first) {
      // Someone pushed meanwhile: rebase once and retry.
      await gitWithMachineCredentials(["pull", "--quiet", "--rebase", "origin", "HEAD"], work).catch(() => {
        throw pushFailed(first);
      });
      await gitWithMachineCredentials(["push", "--quiet", "origin", "HEAD"], work).catch((cause) => {
        throw pushFailed(cause);
      });
    }
    return (await git(["rev-parse", "--short", "HEAD"], work)).trim();
  }

  /** Whether a typed source names a git repository (rather than a folder or archive). */
  async function isRepoSource(text: string, cwd: string | undefined): Promise<boolean> {
    const trimmed = text.trim();
    if (ARCHIVE_PATTERN.test(trimmed.split(/[?#]/u)[0] ?? "")) return false;
    if (/^(https?:\/\/|git@|ssh:\/\/)/iu.test(trimmed)) return true;
    // "owner/name" means GitHub, unless it is an existing folder on this machine.
    if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(trimmed)) {
      return !(await stat(path.resolve(cwd ?? process.cwd(), trimmed)).then((info) => info.isDirectory(), () => false));
    }
    return false;
  }

  /**
   * Point to a plugin in another public repository: nothing is copied, a
   * "remote" entry goes into packages.json, and every hub installs it from
   * that repository. Private repositories can't be added.
   */
  async function addRemotePlugin(text: string, options: { subdir?: string }) {
    const result = await serialize(async () => {
      const { packagesRepo } = await readConfig();
      const parsed = parseRepoInput(text);
      if (repoKey(parsed.repo) === repoKey(packagesRepo)) {
        throw new Error("That is the shared repository itself; its plugins/ folders are already local plugins.");
      }
      await git(["ls-remote", "--heads", parsed.repo.url]).catch(() => {
        throw new Error(`Can't read ${repoDisplay(parsed.repo)}: it's private or doesn't exist. Only public repositories can be added.`);
      });
      const scratch = await scratchDir();
      try {
        const clone = path.join(scratch, "repo");
        await git(["clone", "--quiet", "--depth", "1", ...(parsed.ref ? ["--branch", parsed.ref] : []), parsed.repo.url, clone]);
        const subdir = options.subdir?.trim() || parsed.path || undefined;
        const pluginDir = await findPluginDir(clone, subdir);
        const { pluginId, warning } = await checkManifest(pluginDir);
        if (pluginId === bb.pluginId) throw new Error("That is the hub itself.");
        const folder = path.relative(clone, pluginDir).split(path.sep).join("/");
        const spec: PackageSpec = { ...parsed.repo, path: folder, ref: parsed.ref };
        const label = labelFor(spec, packagesRepo);
        // bb installs one plugin per id, so the id must be new.
        fetchedThisRound.clear();
        const packages = await loadPackages();
        for (const other of packages.specs) {
          if (repoKey(other) === repoKey(spec) && other.path === folder) throw new Error(`${label} is already a remote plugin.`);
          const otherId = await readPackageJson(await syncMirror(other), other.path).then((manifest) => pluginIdForPackageName(manifest.name), () => null);
          if (otherId === pluginId) throw new Error(`Plugin id "${pluginId}" is already used by ${labelFor(other, packagesRepo)}.`);
        }
        for (const entry of packages.marketplace) {
          const plan = await bb.sdk.plugins.catalog
            .installPlan({ entryId: entry.id, ...(entry.marketplace ? { marketplace: entry.marketplace } : {}) })
            .catch(() => null);
          if (plan?.pluginId === pluginId) {
            throw new Error(`Plugin id "${pluginId}" is already a marketplace plugin (${entry.id}${entry.marketplace ? `@${entry.marketplace}` : ""}).`);
          }
        }
        const entry: Record<string, string> = { repo: repoDisplay(parsed.repo) };
        if (folder !== "") entry.path = folder;
        if (parsed.ref) entry.ref = parsed.ref;
        const commit = await editPackagesJson((document) => {
          const list = z.array(z.record(z.string(), z.unknown())).catch([]).parse(document.remote ?? []);
          return { ...document, remote: [...list, entry] };
        }, `Add remote plugin ${label}`);
        bb.log.info(`added remote plugin ${label} (${pluginId}) as ${commit ?? "?"}`);
        return { folder: label, pluginId, commit, warning, unchanged: false, kind: "remote" as const };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
    const report = await requestSync("plugin added");
    const sync = report.results.find((entry) => entry.pluginId === result.pluginId) ?? null;
    bb.realtime.publish(HUB_CHANGED, { added: result.folder });
    return { ...result, guaranteedBy: scheduleView(null).guaranteedBy, sync };
  }

  /** Stop pointing to a remote plugin (machines keep it installed). */
  async function removeRemotePlugin(text: string, pathFilter?: string) {
    const outcome = await serialize(async () => {
      const parsed = parseRepoInput(text);
      const folder = (pathFilter ?? parsed.path ?? "").replace(/^\/+|\/+$/gu, "");
      let removed: string[] = [];
      const matches = (item: Record<string, unknown>) => {
        try {
          return repoKey(parseRepo(String(item.repo ?? ""))) === repoKey(parsed.repo) && (folder === "" || String(item.path ?? "") === folder);
        } catch {
          return false;
        }
      };
      const commit = await editPackagesJson((document) => {
        const next = { ...document };
        for (const key of ["remote", "plugins"] as const) {
          const list = z.array(z.record(z.string(), z.unknown())).catch([]).parse(document[key] ?? []);
          removed = [...removed, ...list.filter(matches).map((item) => `${String(item.repo)}${item.path ? `/${String(item.path)}` : ""}`)];
          if (document[key] !== undefined) next[key] = list.filter((item) => !matches(item));
        }
        if (removed.length === 0) throw new Error(`${text} is not a remote plugin.`);
        return next;
      }, `Remove remote plugin ${repoDisplay(parsed.repo)}${folder ? `/${folder}` : ""}`);
      return { removed, commit };
    });
    bb.realtime.publish(HUB_CHANGED, { removed: outcome.removed });
    return { ...outcome, guaranteedBy: scheduleView(null).guaranteedBy };
  }

  async function addPlugin(
    source: AddSource,
    options: { name?: string; subdir?: string; force?: boolean },
  ) {
    if (source.kind === "text" && (await isRepoSource(source.source, source.cwd))) {
      return addRemotePlugin(source.source, { subdir: options.subdir });
    }
    const result = await serialize(async () => {
      const { packagesRepo, hubPath } = await readConfig();
      const scratch = await scratchDir();
      try {
        const { dir: base, description } = await materialize(source, scratch);
        const pluginDir = await findPluginDir(base, options.subdir);
        const { pluginId, warning } = await checkManifest(pluginDir);
        const folderName = (options.name?.trim() || pluginId).toLowerCase();
        if (!FOLDER_NAME_PATTERN.test(folderName)) throw new Error(`Folder name "${folderName}" must use lowercase letters, digits, ".", "_", "-".`);
        const folder = `${PLUGINS_FOLDER}/${folderName}`;
        if (folder === hubPath || pluginId === bb.pluginId) throw new Error("That is the hub itself; push changes to it directly.");

        const work = await workingClone(packagesRepo);
        const dest = path.join(work, PLUGINS_FOLDER, folderName);
        // bb installs one plugin per id, so two folders can't share one.
        for (const entry of await readdir(path.join(work, PLUGINS_FOLDER), { withFileTypes: true }).catch(() => [])) {
          if (!entry.isDirectory() || entry.name === folderName) continue;
          const other = await readFile(path.join(work, PLUGINS_FOLDER, entry.name, "package.json"), "utf8")
            .then((text) => pluginIdForPackageName((JSON.parse(text) as { name?: string }).name ?? ""), () => null);
          if (other === pluginId) throw new Error(`Plugin id "${pluginId}" is already used by ${PLUGINS_FOLDER}/${entry.name}.`);
        }
        if (await access(dest).then(() => true, () => false)) {
          if (!options.force) throw new Error(`${folder} already exists (use force to replace it).`);
          await rm(dest, { recursive: true, force: true });
        }
        await copyPlugin(pluginDir, dest);
        if (!(await access(path.join(dest, ".gitignore")).then(() => true, () => false))) {
          await writeFile(path.join(dest, ".gitignore"), "node_modules/\ndist/\n");
        }
        const commit = await commitAndPush(work, [folder], `Add plugin ${folderName} (from ${description})`, packagesRepo);
        if (commit === null) return { folder, pluginId, commit: null, warning, unchanged: true, kind: "local" as const };
        bb.log.info(`added ${folder} (${pluginId}) from ${description} as ${commit}`);
        return { folder, pluginId, commit, warning, unchanged: false, kind: "local" as const };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
    // Install it here right away; other hubs follow at the next shared sync.
    const report = await requestSync("plugin added");
    const sync = report.results.find((entry) => entry.pluginId === result.pluginId) ?? null;
    bb.realtime.publish(HUB_CHANGED, { added: result.folder });
    return { ...result, guaranteedBy: scheduleView(null).guaranteedBy, sync };
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
      const self = (await bb.sdk.plugins.list()).plugins.find((plugin) => plugin.id === bb.pluginId);
      return { ...(await listHub()), lastSync, schedule: scheduleView(lastSync), hubVersion: self?.version ?? null };
    },
    hub_install: ({ path: folder }, context) => {
      clientOnly(context, "hub_install");
      return installFolder(folder);
    },
    hub_sync: (_input, context) => {
      clientOnly(context, "hub_sync");
      return requestSync("manual");
    },
    hub_marketplace_search: ({ query }, context) => {
      clientOnly(context, "hub_marketplace_search");
      return searchMarketplace(query);
    },
    hub_marketplace_add: ({ entry }, context) => {
      clientOnly(context, "hub_marketplace_add");
      return addMarketplacePlugin(entry);
    },
    hub_marketplace_remove: ({ entry }, context) => {
      clientOnly(context, "hub_marketplace_remove");
      return removeMarketplacePlugin(entry);
    },
    hub_remote_remove: ({ repo, path: folder }, context) => {
      clientOnly(context, "hub_remote_remove");
      return removeRemotePlugin(repo, folder);
    },
    hub_add_plugin: (input, context) => {
      clientOnly(context, "hub_add_plugin");
      const source: AddSource =
        input.files !== undefined
          ? { kind: "files", files: input.files }
          : input.archive !== undefined
            ? { kind: "archive", name: input.archive.name, data: input.archive.data }
            : { kind: "text", source: input.source ?? "" };
      return addPlugin(source, { name: input.name, subdir: input.subdir, force: input.force });
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
                      `${folder.installed ? `[installed ${folder.installedVersion}]` : "[available]"}${folder.isPackage ? " [local plugin]" : ""}  ${folder.path} — ${folder.name}${folder.description ? `: ${folder.description}` : ""}`,
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
          summary: "Show what every hub installs: local plugins (plugins/ folders) and remote plugins (other public repos)",
          options: jsonOption,
          async run({ options }) {
            const packages = await serialize(async () => {
              fetchedThisRound.clear();
              return loadPackages();
            }).catch((cause) => { throw toCliError(cause); });
            const local = packages.specs.filter((spec) => isLocal(spec, packages.packagesRepo)).map((spec) => labelFor(spec, packages.packagesRepo));
            const remote = packages.specs.filter((spec) => !isLocal(spec, packages.packagesRepo)).map((spec) => labelFor(spec, packages.packagesRepo));
            const market = packages.marketplace.map((entry) => `${entry.id}${entry.marketplace ? `@${entry.marketplace}` : ""}`);
            const view = { from: packages.from, local, remote, marketplace: market, errors: packages.errors };
            const section = (title: string, items: string[]) => [`${title}:`, ...(items.length === 0 ? ["  (none)"] : items.map((item) => `  ${item}`))];
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(view)
                : [
                    `From ${view.from}`,
                    ...section("Local plugins", local),
                    ...section("Remote plugins", remote),
                    ...section("Marketplace plugins", market),
                    ...view.errors,
                  ].join("\n"),
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
        marketplace: cliCommand({
          summary: "Show the marketplace plugins every hub keeps installed (packages.json \"marketplace\")",
          options: jsonOption,
          async run({ options }) {
            const packages = await serialize(async () => {
              fetchedThisRound.clear();
              return loadPackages();
            }).catch((cause) => { throw toCliError(cause); });
            const entries = packages.marketplace.map((entry) => `${entry.id}${entry.marketplace ? `@${entry.marketplace}` : ""}`);
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(entries)
                : entries.length === 0
                  ? "No marketplace plugins. Find one with `bb hub marketplace search <query>`, then `bb hub marketplace add <entry>`."
                  : entries.join("\n"),
            };
          },
        }),
        "marketplace search": cliCommand({
          summary: "Search bb's marketplaces for a plugin to add",
          positionals: [{ name: "query", description: "Words to search for (name, description, category, tag)", required: true, variadic: true }],
          options: jsonOption,
          async run({ positionals, options }) {
            const results = await searchMarketplace(positionals.query.join(" ")).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(results) };
            return {
              exitCode: 0,
              stdout: results.length === 0
                ? "No matches."
                : results
                    .map((result) => {
                      const description = result.description.length > 90 ? `${result.description.slice(0, 89)}…` : result.description;
                      return `${result.entry}${result.installed ? " [installed]" : ""}${result.compatible ? "" : " [incompatible]"} — ${result.displayName}: ${description}`;
                    })
                    .join("\n"),
            };
          },
        }),
        "marketplace add": cliCommand({
          summary: "Add a marketplace plugin to packages.json (commits and pushes) so every hub installs it",
          description: "Pushes with the git credentials of the machine running bb. Use the entry from `bb hub marketplace search`.",
          positionals: [{ name: "entry", description: "<id> or <id>@<marketplace>, e.g. thread-hover-cards@bb-community", required: true }],
          options: jsonOption,
          async run({ positionals, options }) {
            const added = await addMarketplacePlugin(positionals.entry).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(added) };
            return {
              exitCode: added.sync?.outcome === "failed" ? 1 : 0,
              stdout: [
                `Added ${added.entry} (${added.displayName}) to packages.json${added.commit ? ` and pushed commit ${added.commit}` : ""}.`,
                ...(added.compatible ? [] : [`Note: not compatible with this bb: ${added.incompatibleReason ?? "unknown reason"}.`]),
                ...(added.sync ? [`This machine: ${formatResult(added.sync)}`] : []),
                `Every running hub has it by ${formatTime(added.guaranteedBy)}; hubs that are off get it when they start.`,
              ].join("\n"),
            };
          },
        }),
        "marketplace remove": cliCommand({
          summary: "Remove a marketplace plugin from packages.json (commits and pushes); machines keep it installed",
          positionals: [{ name: "entry", description: "<id> or <id>@<marketplace>", required: true }],
          options: jsonOption,
          async run({ positionals, options }) {
            const removed = await removeMarketplacePlugin(positionals.entry).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(removed) };
            return {
              exitCode: 0,
              stdout: [
                `Removed ${removed.removed.join(", ")} from packages.json${removed.commit ? ` (commit ${removed.commit})` : ""}.`,
                "Machines keep it installed but stop updating it; uninstall it with `bb plugin remove <id>` where it's no longer wanted.",
                `Every running hub stops managing it by ${formatTime(removed.guaranteedBy)}.`,
              ].join("\n"),
            };
          },
        }),
        "plugin remove": cliCommand({
          summary: "Stop pointing to a remote plugin (commits and pushes); machines keep it installed",
          description: "Local plugins (folders in plugins/) are removed by deleting their folder in the shared repository.",
          positionals: [{ name: "repo", description: "The remote plugin's repo: owner/name, https URL, or GitHub folder link", required: true }],
          options: {
            path: { type: "string", placeholder: "folder", description: "Only the entry for this folder in that repo" },
            ...jsonOption,
          },
          async run({ positionals, options }) {
            const removed = await removeRemotePlugin(positionals.repo, options.path).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(removed) };
            return {
              exitCode: 0,
              stdout: [
                `Removed remote plugin ${removed.removed.join(", ")}${removed.commit ? ` (commit ${removed.commit})` : ""}.`,
                "Machines keep it installed but stop updating it; uninstall it with `bb plugin remove <id>` where it's no longer wanted.",
              ].join("\n"),
            };
          },
        }),
        "plugin add": cliCommand({
          summary: "Add a plugin for everyone: a public git repo is pointed to (remote plugin); a folder or .zip/.tar is copied into plugins/ (local plugin)",
          description:
            "A git repository (owner/name, an https URL, or a GitHub folder link) must be public; it is recorded in packages.json and installed from there. Folders and archives are copied into the shared repository. Pushes with the git credentials of the machine running bb (the hub stores none). Local paths are on that machine. Every running hub installs the plugin at the next shared sync.",
          positionals: [
            { name: "source", description: "Public git repo (owner/name or https URL), folder path, or .zip/.tar(.gz) file or URL", required: true },
          ],
          options: {
            name: { type: "string", placeholder: "folder", description: "For copied plugins: folder name under plugins/ (default: the plugin id)" },
            subdir: { type: "string", placeholder: "path", description: "The plugin's folder inside the source, when it holds several" },
            force: { type: "boolean", description: "Replace plugins/<folder> if it already exists" },
            ...jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const added = await addPlugin(
              { kind: "text", source: positionals.source, cwd: ctx.cwd },
              { name: options.name, subdir: options.subdir, force: options.force },
            ).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(added) };
            return {
              exitCode: added.sync?.outcome === "failed" ? 1 : 0,
              stdout: [
                added.unchanged
                  ? `${added.folder} is unchanged; nothing to commit.`
                  : added.kind === "remote"
                    ? `Added remote plugin ${added.folder} (plugin id ${added.pluginId}); nothing copied. Pushed commit ${added.commit}.`
                    : `Copied into ${added.folder} as a local plugin (plugin id ${added.pluginId}) and pushed commit ${added.commit}.`,
                ...(added.warning ? [`Note: ${added.warning}`] : []),
                ...(added.sync ? [`This machine: ${formatResult(added.sync)}`] : []),
                `Every running hub has it by ${formatTime(added.guaranteedBy)}; hubs that are off get it when they start.`,
              ].join("\n"),
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
