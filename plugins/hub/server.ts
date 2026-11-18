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
/** Each group's folder of beta copies: <group>/beta/<name>. */
const BETA_FOLDER = "beta";
/** kv: a plugin whose (git) install may be reset once to join its beta. */
const BETA_RESET_KEY = "betaResetAllowed";
const GIT_TIMEOUT_MS = 180_000;

// Shared schedule: every hub syncs at multiples of the interval since the
// Unix epoch, so all machines pick up a change at the same moment.
const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const PROPAGATION_MARGIN_MS = 60_000;
const SYNC_INTERVAL_KEY = "syncIntervalMinutes";
const LAST_SYNC_KEY = "lastSync";
const SELF_UPDATE_KEY = "selfUpdateAttempt";
const MARKETPLACE_REFRESHED_KEY = "teamMarketplaceRefreshedAt";
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
const groupEntrySchema = z.object({
  /** Lowercase id, e.g. "lean-software-developers". */
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  /** The group's folder in the repository, e.g. "groups/lean-software-developers". */
  path: z.string().trim().min(1),
});
const packagesFileSchema = z.object({
  /** The group's display name. */
  name: z.string().trim().min(1).optional(),
  /** Only in the repository root (the home group): the other groups members can subscribe to. */
  groups: z.array(groupEntrySchema).max(50).optional(),
  syncIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  /** Folder patterns whose every subfolder is a package, e.g. "plugins/*". */
  include: z.array(z.string().trim().min(1)).max(20).optional(),
  /** Folders to leave out of `include`, e.g. "plugins/experimental". */
  exclude: z.array(z.string().trim().min(1)).max(200).optional(),
  /**
   * Plugin ids every hub uninstalls (deleting their data). Filled when a local
   * plugin is deleted; an id leaves the list when a plugin with it is added again.
   */
  uninstall: z.array(z.string().trim().min(1)).max(200).optional(),
  /**
   * Local plugin folders elsewhere in this repository that this group owns,
   * e.g. a plugin moved here from another group (its folder stays put, so
   * installed copies keep their data). The group whose plugins/ holds the
   * folder lists it in "exclude".
   */
  local: z.array(z.object({ path: z.string().trim().min(1) })).max(200).optional(),
  /** Older name for "remote"; still read. */
  plugins: z.array(packageEntrySchema).max(100).optional(),
  /** Remote plugins: other public repositories, installed straight from there. */
  remote: z.array(packageEntrySchema).max(100).optional(),
  /**
   * Followed repositories: every bb plugin in another public repository
   * (found again at each sync, so new ones are picked up), built on each
   * machine from a checkout of the whole repository with its workspace
   * dependencies installed, so plugins that use sibling packages build.
   * include: only these plugin folders; exclude: all but these.
   */
  follow: z.array(z.object({
    repo: z.string().trim().min(1),
    ref: z.string().trim().min(1).optional(),
    include: z.array(z.string().trim().min(1)).max(100).optional(),
    exclude: z.array(z.string().trim().min(1)).max(100).optional(),
  })).max(50).optional(),
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
  /** The group that lists it (filled in by loadPackages). */
  group?: string;
  /** From a followed repository: built from the hub's checkout, installed from that path. */
  follow?: boolean;
  /** A beta copy (a group's beta/<name> folder), installed only on machines that joined its beta. */
  beta?: boolean;
}

/** A group of plugins: the repository root (home) or a folder under groups/. */
interface Group {
  id: string;
  name: string;
  /** "" for the home group (the repository root). */
  path: string;
}
const HOME_GROUP = "home";
const GROUP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** A file inside a group's folder. */
const inGroup = (group: Group, file: string) => (group.path === "" ? file : `${group.path}/${file}`);

/** Compare two versions like "1.2.3" or "1.2.3-beta.1"; a missing version is oldest. */
function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const parse = (value: string | null | undefined) => {
    const match = value?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u);
    return match ? { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null } : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return left === null ? (right === null ? 0 : -1) : 1;
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1; // a release is newer than its prerelease
  if (right.pre === null) return -1;
  return left.pre.localeCompare(right.pre, undefined, { numeric: true });
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
  outcome: z.enum(["installed", "installing", "updated", "current", "pinned", "skipped", "other-source", "updating", "removed", "failed"]),
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
  /** Details for the info panel; null when the plugin's manifest can't be read. */
  info: z
    .object({
      name: z.string(),
      pluginId: z.string(),
      description: z.string().nullable(),
      latestVersion: z.string().nullable(),
      installedVersion: z.string().nullable(),
      installedFrom: z.string().nullable(),
      updatedAt: z.string().nullable(),
      enabled: z.boolean().nullable(),
      webUrl: z.string(),
    })
    .nullable(),
});
export type PackageView = z.infer<typeof packageViewSchema>;

const betaViewSchema = z.object({
  pluginId: z.string(),
  name: z.string(),
  path: z.string(),
  version: z.string().nullable(),
  stablePath: z.string().nullable(),
  stableVersion: z.string().nullable(),
  joined: z.boolean(),
  /** Joining needs a one-time reinstall (installed from git before betas existed), which resets its data. */
  needsReset: z.boolean(),
  installedVersion: z.string().nullable(),
  /** This machine runs the beta copy right now. */
  running: z.boolean(),
});
export type BetaView = z.infer<typeof betaViewSchema>;
const devPluginSchema = z.object({
  pluginId: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  dir: z.string(),
  stablePath: z.string().nullable(),
  stableVersion: z.string().nullable(),
  betaPath: z.string().nullable(),
  betaVersion: z.string().nullable(),
});
export type DevPlugin = z.infer<typeof devPluginSchema>;
const publishOutputSchema = z.object({
  pluginId: z.string(),
  folder: z.string(),
  beta: z.boolean(),
  from: z.string().nullable(),
  to: z.string(),
  commit: z.string().nullable(),
  /** What changed, from git diff --stat. */
  changes: z.array(z.string()),
  guaranteedBy: z.string(),
  sync: syncResultSchema.nullable(),
});

export const rpcContract = defineRpcContract({
  hub_list: {
    input: z.object({ group: z.string().trim().max(64).optional() }).nullable(),
    output: z.object({
      repo: z.string(),
      group: z.object({ id: z.string(), name: z.string(), path: z.string() }),
      groups: z.array(z.object({ id: z.string(), name: z.string(), path: z.string(), subscribed: z.boolean(), home: z.boolean() })),
      folders: z.array(folderSchema),
      packages: z.array(packageViewSchema),
      marketplace: z.array(z.object({
        label: z.string(),
        entry: z.string(),
        /** Details for the info panel, from bb's catalog; null when the entry can't be found. */
        info: z
          .object({
            name: z.string(),
            pluginId: z.string(),
            description: z.string(),
            marketplace: z.string(),
            publisher: z.string(),
            category: z.string().nullable(),
            installs: z.number().nullable(),
            compatible: z.boolean(),
            incompatibleReason: z.string().nullable(),
            source: z.string(),
            repositoryUrl: z.string().nullable(),
            installedVersion: z.string().nullable(),
            installedFrom: z.string().nullable(),
            enabled: z.boolean().nullable(),
          })
          .nullable(),
      })),
      /** Beta copies in this group, and whether this machine runs them. */
      betas: z.array(betaViewSchema),
      /** Plugins this machine runs from its own folders (being developed), with what the group has published. */
      devPlugins: z.array(devPluginSchema),
      lastSync: syncReportSchema.nullable(),
      schedule: scheduleSchema,
      hubVersion: z.string().nullable(),
    }),
  },
  /** Answers at once, even during a sync (hub_list waits for a running sync). */
  hub_status: {
    input: z.null(),
    /** The sync running right now on this machine (what started it, and when), or null. */
    output: z.object({ syncing: z.object({ trigger: z.string(), startedAt: z.string() }).nullable() }),
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
  hub_move: {
    input: z.object({
      kind: z.enum(["local", "remote", "marketplace"]),
      /** local: the folder path; remote: the repo; marketplace: id@marketplace. */
      ref: z.string().trim().min(1).max(500),
      path: z.string().trim().max(200).optional(),
      from: z.string().trim().max(64).optional(),
      to: z.string().trim().min(1).max(64),
    }),
    output: z.object({ kind: z.string(), label: z.string(), from: z.string(), to: z.string(), commit: z.string().nullable(), guaranteedBy: z.string(), results: z.number() }),
  },
  hub_group_subscribe: {
    input: z.object({ group: z.string().trim().min(1).max(64), subscribed: z.boolean() }),
    output: z.object({ group: z.string(), name: z.string(), subscribed: z.boolean(), guaranteedBy: z.string() }),
  },
  hub_publish: {
    input: z.object({ dir: z.string().trim().min(1).max(1000), group: z.string().trim().max(64).optional(), beta: z.boolean().optional() }),
    output: publishOutputSchema,
  },
  hub_promote: {
    input: z.object({ plugin: z.string().trim().min(1).max(200), group: z.string().trim().max(64).optional() }),
    output: z.object({ pluginId: z.string(), from: z.string(), to: z.string(), version: z.string().nullable(), commit: z.string().nullable(), guaranteedBy: z.string() }),
  },
  hub_beta: {
    input: z.object({ pluginId: z.string().trim().min(1).max(128), joined: z.boolean(), resetData: z.boolean().optional() }),
    output: z.object({ pluginId: z.string(), joined: z.boolean(), beta: z.array(z.string()) }),
  },
  hub_group_add: {
    input: z.object({ name: z.string().trim().min(1).max(60), id: z.string().trim().max(64).optional() }),
    output: z.object({ id: z.string(), name: z.string(), path: z.string(), commit: z.string().nullable() }),
  },
  hub_group_rename: {
    input: z.object({ group: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(60) }),
    output: z.object({ id: z.string(), from: z.string(), name: z.string(), commit: z.string().nullable() }),
  },
  hub_group_remove: {
    input: z.object({ group: z.string().trim().min(1).max(64) }),
    output: z.object({ id: z.string(), name: z.string(), commit: z.string().nullable(), guaranteedBy: z.string() }),
  },
  hub_marketplace_add: {
    input: z.object({ entry: z.string().trim().min(1).max(200), group: z.string().trim().max(64).optional() }),
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
    input: z.object({ entry: z.string().trim().min(1).max(200), group: z.string().trim().max(64).optional() }),
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
        group: z.string().trim().max(64).optional(),
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
      /** followed: a repository with several plugins, followed (built from a checkout). */
      kind: z.enum(["local", "remote", "followed"]),
      guaranteedBy: z.string(),
      sync: syncResultSchema.nullable(),
    }),
  },
  hub_local_delete: {
    input: z.object({ path: z.string().trim().min(1).max(200), group: z.string().trim().max(64).optional() }),
    output: z.object({ folder: z.string(), pluginId: z.string(), commit: z.string().nullable(), removedHere: z.boolean(), guaranteedBy: z.string() }),
  },
  hub_remote_remove: {
    input: z.object({ repo: z.string().trim().min(1).max(500), path: z.string().trim().max(200).optional(), group: z.string().trim().max(64).optional() }),
    output: z.object({ removed: z.array(z.string()), commit: z.string().nullable(), guaranteedBy: z.string() }),
  },
});

const packageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
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
    groups: {
      type: "string",
      label: "Subscribed groups",
      description:
        "Comma-separated ids of the groups this machine installs, in addition to the home group (always on). Manage with `bb hub group subscribe/unsubscribe <id>` or the selector on the Plugin hub page.",
      default: "",
    },
    beta: {
      type: "string",
      label: "Beta plugins",
      description:
        "Comma-separated ids of the plugins this machine runs the beta copy of (\"*\" for every plugin with one). Manage with `bb hub beta join/leave <id>` or the β toggles on the Plugin hub page.",
      default: "",
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
    registerMarketplace: {
      type: "boolean",
      label: "Show the team marketplace in Settings",
      description:
        "Add the shared repository's marketplace.json to Settings → Plugin marketplaces on this machine, and refresh it when the repository changes.",
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
    const subscribed = values.groups
      .split(/[\s,]+/u)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => GROUP_ID_PATTERN.test(entry) && entry !== HOME_GROUP);
    const beta = [...new Set(values.beta.split(/[\s,]+/u).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry === "*" || ENTRY_ID_PATTERN.test(entry)))];
    return { packagesRepo: parseRepo(values.packagesRepo), hubPath, selfUpdate: values.selfUpdate, subscribed: [...new Set(subscribed)], beta };
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

  /** Every group in the repository: home (the root) plus the root packages.json "groups". */
  async function listGroups(): Promise<Group[]> {
    const { packagesRepo } = await readConfig();
    const dir = await syncMirror(packagesRepo);
    const root = packagesFileSchema.parse(JSON.parse(await git(["show", "HEAD:packages.json"], dir)));
    const groups: Group[] = [{ id: HOME_GROUP, name: root.name ?? "Home", path: "" }];
    for (const entry of root.groups ?? []) {
      const id = entry.id.toLowerCase();
      const folder = entry.path.replace(/^\/+|\/+$/gu, "");
      if (!GROUP_ID_PATTERN.test(id) || id === HOME_GROUP || !PATH_PATTERN.test(folder) || groups.some((group) => group.id === id)) continue;
      groups.push({ id, name: entry.name ?? id, path: folder });
    }
    return groups;
  }

  async function findGroup(groupId: string | undefined): Promise<Group> {
    const wanted = (groupId ?? HOME_GROUP).trim().toLowerCase() || HOME_GROUP;
    const group = (await listGroups()).find((candidate) => candidate.id === wanted);
    if (group === undefined) throw new Error(`There is no group "${wanted}". Run \`bb hub group\` to list them.`);
    return group;
  }

  /** The home group and the groups this machine subscribes to, home first. */
  async function subscribedGroups(): Promise<Group[]> {
    const { subscribed } = await readConfig();
    const groups = await listGroups();
    return groups.filter((group) => group.id === HOME_GROUP || subscribed.includes(group.id));
  }

  async function loadPackages(groupId?: string) {
    const { packagesRepo } = await readConfig();
    const group = await findGroup(groupId);
    const dir = await syncMirror(packagesRepo);
    const fileText = await git(["show", `HEAD:${inGroup(group, "packages.json")}`], dir).catch(() => null);
    if (fileText === null) throw new Error(`Group ${group.id} has no ${inGroup(group, "packages.json")}.`);
    const file = packagesFileSchema.parse(JSON.parse(fileText));
    const specs: PackageSpec[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    // "include": every subfolder of "<dir>/*" that holds a bb plugin
    // (package.json with a "bb" section) is a package, except the hub itself
    // and anything in "exclude". Uploading a folder there is all it takes.
    const { hubPath } = await readConfig();
    // include/exclude paths are relative to the group's folder.
    const excluded = new Set((file.exclude ?? []).map((entry) => inGroup(group, entry.replace(/\/+$/u, ""))));
    for (const pattern of file.include ?? []) {
      const parent = inGroup(group, pattern.replace(/\/\*$/u, "").replace(/\/+$/u, ""));
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
          specs.push({ ...packagesRepo, path: folder, ref: null, group: group.id });
        }
      }
    }
    // Beta copies: every <group>/beta/<name> that holds a bb plugin.
    const betas: PackageSpec[] = [];
    const betaParent = inGroup(group, BETA_FOLDER);
    for (const name of (await git(["ls-tree", "-d", "--name-only", `HEAD:${betaParent}`], dir).catch(() => "")).split("\n").map((line) => line.trim()).filter(Boolean)) {
      const folder = `${betaParent}/${name}`;
      if (!PATH_PATTERN.test(folder)) continue;
      const manifest = await git(["show", `HEAD:${folder}/package.json`], dir).then((text) => JSON.parse(text) as { bb?: unknown }, () => null);
      if (manifest !== null && typeof manifest.bb === "object" && manifest.bb !== null) betas.push({ ...packagesRepo, path: folder, ref: null, group: group.id, beta: true });
    }
    for (const entry of file.local ?? []) {
      const folder = entry.path.replace(/^\/+|\/+$/gu, "");
      if (!PATH_PATTERN.test(folder) || folder === hubPath) {
        errors.push(`Invalid local entry "${entry.path}".`);
        continue;
      }
      const key = `${repoKey(packagesRepo)}|${folder}`;
      if (!seen.has(key)) {
        seen.add(key);
        specs.push({ ...packagesRepo, path: folder, ref: null, group: group.id });
      }
    }
    for (const entry of file.follow ?? []) {
      try {
        const repo = parseRepo(entry.repo);
        if (repoKey(repo) === repoKey(packagesRepo)) throw new Error("The shared repository can't be followed; its plugins/ folders are local plugins.");
        if (entry.ref !== undefined && !REF_PATTERN.test(entry.ref)) throw new Error(`Invalid ref "${entry.ref}".`);
        const clean = (folder: string) => folder.replace(/^\/+|\/+$/gu, "");
        const include = entry.include?.map(clean);
        const exclude = new Set((entry.exclude ?? []).map(clean));
        const folders = (await pluginFoldersAt(await syncMirror(repo), entry.ref ?? "HEAD")).filter(
          (folder) => (include === undefined || include.includes(folder)) && !exclude.has(folder),
        );
        if (folders.length === 0) errors.push(`${repoDisplay(repo)} has no bb plugins to follow.`);
        for (const folder of folders) {
          const key = `${repoKey(repo)}|${folder}`;
          if (!seen.has(key)) {
            seen.add(key);
            specs.push({ ...repo, path: folder, ref: entry.ref ?? null, group: group.id, follow: true });
          }
        }
      } catch (cause) {
        errors.push(errorMessage(cause));
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
          specs.push({ ...repo, path: folder, ref: entry.ref ?? null, group: group.id });
        }
      } catch (cause) {
        errors.push(errorMessage(cause));
      }
    }
    // The shared schedule comes from the home group only.
    const intervalMinutes = file.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES;
    if (group.id === HOME_GROUP && intervalMinutes !== syncIntervalMinutes) {
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
    const uninstall = [...new Set((file.uninstall ?? []).map((id) => id.toLowerCase()).filter((id) => ENTRY_ID_PATTERN.test(id)))];
    return { from: `${repoDisplay(packagesRepo)}/${inGroup(group, "packages.json")}`, packagesRepo, group, specs, betas, marketplace, uninstall, errors };
  }

  const isLocal = (spec: PackageSpec, packagesRepo: RepoRef) => repoKey(spec) === repoKey(packagesRepo);
  const labelFor = (spec: PackageSpec, packagesRepo: RepoRef) =>
    isLocal(spec, packagesRepo)
      ? `${spec.path}${spec.ref ? `@${spec.ref}` : ""}${spec.beta ? " (beta)" : ""}`
      : `${repoDisplay(spec)}${spec.path ? `/${spec.path}` : ""}${spec.ref ? `@${spec.ref}` : ""}${spec.follow ? " (followed)" : ""}`;
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

  /** The folder (inside its repository) an installed git plugin came from, read from bb's cache path. */
  function installedFolder(plugin: { rootDir: string }): string | null {
    const match = plugin.rootDir.split(path.sep).join("/").match(/\/[0-9a-f]{40}(?:\/(.+))?$/u);
    return match ? (match[1] ?? "") : null;
  }
  /** Which group's area (plugins/ folder) a folder of the shared repository is in. */
  function groupOfFolder(folder: string, groups: Group[]): string {
    const owner = groups.filter((group) => group.path !== "" && (folder === group.path || folder.startsWith(`${group.path}/`)));
    return owner.sort((a, b) => b.path.length - a.path.length)[0]?.id ?? HOME_GROUP;
  }

  /**
   * Which group owns a local plugin folder, reading packages.json files in a
   * working clone: a group that lists it under "local" (it was moved there),
   * otherwise the group whose area holds it.
   */
  async function folderOwner(work: string, folder: string, groups: Group[]): Promise<{ owner: Group; area: Group }> {
    const area = groups.find((group) => group.id === groupOfFolder(folder, groups)) as Group;
    for (const group of groups) {
      const document = await readFile(path.join(work, inGroup(group, "packages.json")), "utf8")
        .then((text) => packagesFileSchema.safeParse(JSON.parse(text)).data)
        .catch(() => undefined);
      if (document?.local?.some((entry) => entry.path.replace(/^\/+|\/+$/gu, "") === folder)) return { owner: group, area };
    }
    return { owner: area, area };
  }

  // -------------------------------------------------------------------------
  // Installs run as bb install jobs: a plugin that has to be built (npm install
  // and a build) can take minutes, and a plain install request gives up after
  // 75 seconds. A sync waits a while for the job; a longer one keeps running
  // in bb, and the next sync finds it (it never starts a second one).

  type InstallJob = Awaited<ReturnType<BbPluginApi["sdk"]["plugins"]["startInstall"]>>;
  type InstallTarget = InstallJob["target"];
  const INSTALL_WAIT_MS = 60_000;

  class InstallStillRunning extends Error {}

  const sameTarget = (a: InstallTarget, b: InstallTarget) =>
    a.kind === "catalog" && b.kind === "catalog"
      ? a.entryId === b.entryId && a.marketplace === b.marketplace
      : a.kind === "source" && b.kind === "source"
        ? a.source === b.source && JSON.stringify(a.selection) === JSON.stringify(b.selection)
        : false;
  const jobRunning = (job: InstallJob) => job.state === "queued" || job.state === "running" || job.state === "cancelling";

  /** Start an install job (or join one already running for the same target) and wait for it. */
  async function installWithJob(target: InstallTarget | null, start: () => Promise<InstallJob>): Promise<{ id: string; version: string }> {
    const running = target === null ? undefined : (await bb.sdk.plugins.installJobs.list().catch(() => [])).find((job) => jobRunning(job) && sameTarget(job.target, target));
    let job = running ?? (await start());
    const deadline = Date.now() + INSTALL_WAIT_MS;
    while (jobRunning(job)) {
      if (Date.now() > deadline) throw new InstallStillRunning(`bb is still installing ${job.displayName} (it has to be built); it finishes in the background.`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      job = await bb.sdk.plugins.installJobs.get({ jobId: job.id });
    }
    if (job.state === "succeeded") return job.plugin;
    if (job.state === "failed") throw new Error(job.error);
    throw new Error(`The install of ${job.displayName} was cancelled.`);
  }

  /** Install from a git source and subfolder as a job. */
  const installSource = (source: string, subdirectory: string | undefined) =>
    installWithJob(
      { kind: "source", source, selection: subdirectory ? { kind: "subdirectory", path: subdirectory } : { kind: "root" } },
      () => bb.sdk.plugins.startInstall({ source, ...(subdirectory ? { subdirectory } : {}) }),
    );

  /** A sync result for an install that is still running in bb. */
  const stillInstalling = (cause: unknown, repo: string, pluginId: string | null): SyncResult | null =>
    cause instanceof InstallStillRunning ? { repo, pluginId, outcome: "installing", detail: cause.message, version: null } : null;

  // -------------------------------------------------------------------------
  // Followed repositories: a checkout of the whole repository per machine
  // (next to the mirrors, in follow/), its workspace dependencies installed
  // with the repository's own package manager, each plugin's dependencies
  // installed, then bb installs the plugin from that folder (a path install,
  // which bb builds). A new commit that touches a plugin, the sibling
  // packages it uses, or the root dependency files rebuilds it in place
  // (its settings and data stay).

  const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".github", "e2e", "spikes", "test", "tests", "fixtures", "examples"]);
  const FOLLOW_TIMEOUT_MS = 15 * 60_000;
  const ROOT_FILES = ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock"];

  /** Every folder of a repository revision that holds a bb plugin (package.json with a "bb" section). */
  async function pluginFoldersAt(mirror: string, rev: string): Promise<string[]> {
    const files = (await git(["ls-tree", "-r", "--name-only", rev], mirror)).split("\n").filter((file) => file === "package.json" || file.endsWith("/package.json"));
    const folders: string[] = [];
    for (const file of files) {
      const folder = file === "package.json" ? "" : file.slice(0, -"/package.json".length);
      const parts = folder === "" ? [] : folder.split("/");
      if (parts.length > 4 || parts.some((part) => SKIP_DIRS.has(part) || part.startsWith("."))) continue;
      if (folder !== "" && !PATH_PATTERN.test(folder)) continue;
      const manifest = await git(["show", `${rev}:${file}`], mirror).then((text) => JSON.parse(text) as { bb?: unknown }, () => null);
      if (manifest !== null && typeof manifest.bb === "object" && manifest.bb !== null) folders.push(folder);
      if (folders.length >= 100) break;
    }
    return folders;
  }

  /** Run a program for a followed repository's build; rejects with the tail of its output. */
  function runTool(command: string, args: string[], cwd: string): Promise<void> {
    const bin = path.dirname(process.execPath);
    // bb's server runs with NODE_ENV=production, which makes package managers skip devDependencies (builds need them).
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", npm_config_production: "false", CI: "1", PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, npm_config_audit: "false", npm_config_fund: "false" };
    return new Promise((resolve, reject) => {
      execFile(command, args, { cwd, env, timeout: FOLLOW_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const tail = `${String(stderr)}\n${String(stdout)}`.trim().split("\n").filter(Boolean).slice(-4).join(" ").slice(0, 600);
          reject(new Error(`${path.basename(command)} ${args.join(" ")} failed in ${path.basename(cwd)}: ${tail || error.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  /** npm: the one next to bb's node, else the one on PATH. */
  let npmPath: string | null = null;
  async function npm(): Promise<string> {
    if (npmPath !== null) return npmPath;
    const beside = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
    npmPath = (await access(beside).then(() => true, () => false)) ? beside : "npm";
    return npmPath;
  }

  /** bun: the one on PATH, else bun's own npm package installed into the hub's tools folder. */
  let bunPath: Promise<string> | null = null;
  function bun(): Promise<string> {
    bunPath ??= (async () => {
      const onPath = await new Promise<boolean>((resolve) => execFile("bun", ["--version"], { timeout: 10_000 }, (error) => resolve(!error)));
      if (onPath) return "bun";
      const arch = process.arch === "arm64" ? "aarch64" : "x64";
      const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
      const pkg = `@oven/bun-${os}-${arch}`;
      const tools = path.join(path.dirname(await ensureMirrorRoot()), "tools");
      const binary = path.join(tools, "node_modules", ...pkg.split("/"), "bin", os === "windows" ? "bun.exe" : "bun");
      if (!(await access(binary).then(() => true, () => false))) {
        await mkdir(tools, { recursive: true });
        await runTool(await npm(), ["install", "--prefix", tools, "--no-save", "--no-package-lock", "--ignore-scripts", `${pkg}@1`], tools);
        bb.log.info(`installed bun (${pkg}) into ${tools}`);
      }
      return binary;
    })().catch((cause) => {
      bunPath = null;
      throw cause;
    });
    return bunPath;
  }

  const exists = (file: string) => access(file).then(() => true, () => false);

  /** Install a folder's dependencies with the package manager its lockfile names (lifecycle scripts off, like bb's own installs). */
  async function installDependencies(folder: string): Promise<void> {
    if (await exists(path.join(folder, "bun.lock")) || await exists(path.join(folder, "bun.lockb"))) {
      await runTool(await bun(), ["install", "--ignore-scripts"], folder);
    } else if (await exists(path.join(folder, "pnpm-lock.yaml"))) {
      await runTool(await npm(), ["exec", "--yes", "--", "pnpm@9", "install", "--ignore-scripts", "--frozen-lockfile"], folder);
    } else if (await exists(path.join(folder, "yarn.lock"))) {
      await runTool(await npm(), ["exec", "--yes", "--", "yarn@1", "install", "--ignore-scripts", "--frozen-lockfile"], folder);
    } else if (await exists(path.join(folder, "package-lock.json"))) {
      await runTool(await npm(), ["ci", "--ignore-scripts", "--include=dev"], folder);
    } else {
      await runTool(await npm(), ["install", "--ignore-scripts", "--include=dev", "--no-package-lock"], folder);
    }
  }

  type WorkspaceInfo = { patterns: string[]; byName: Map<string, string> };
  /** The root package.json "workspaces" (patterns, and package name → folder). */
  async function readWorkspaces(dir: string): Promise<WorkspaceInfo> {
    const root = await readFile(path.join(dir, "package.json"), "utf8").then((text) => JSON.parse(text) as { workspaces?: unknown }, () => null);
    const raw = root?.workspaces;
    const patterns = (Array.isArray(raw) ? raw : z.object({ packages: z.array(z.string()) }).safeParse(raw).data?.packages ?? [])
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.replace(/^\.\//u, "").replace(/\/+$/u, ""));
    const byName = new Map<string, string>();
    for (const pattern of patterns) {
      const folders = pattern.endsWith("/*")
        ? (await readdir(path.join(dir, pattern.slice(0, -2)), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => `${pattern.slice(0, -2)}/${entry.name}`)
        : [pattern];
      for (const folder of folders) {
        const name = await readFile(path.join(dir, folder, "package.json"), "utf8").then((text) => (JSON.parse(text) as { name?: unknown }).name, () => null);
        if (typeof name === "string") byName.set(name, folder);
      }
    }
    return { patterns, byName };
  }
  const inWorkspaces = (folder: string, info: WorkspaceInfo) =>
    info.patterns.some((pattern) => (pattern.endsWith("/*") ? path.posix.dirname(folder) === pattern.slice(0, -2) : folder === pattern));

  /** A plugin folder plus every sibling package it uses (file:/link: dependencies and workspace packages, transitively). */
  async function watchedFolders(dir: string, folder: string, info: WorkspaceInfo): Promise<string[]> {
    const found = new Set<string>([folder]);
    const queue = [folder];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const manifest = await readFile(path.join(dir, current, "package.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => null);
      if (manifest === null) continue;
      for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [name, spec] of Object.entries(z.record(z.string(), z.string()).catch({}).parse(manifest[key] ?? {}))) {
          let target: string | null = null;
          const local = spec.match(/^(?:file|link):(.+)$/u)?.[1];
          if (local !== undefined) target = path.posix.normalize(path.posix.join(current, local)).replace(/\/+$/u, "");
          else if (info.byName.has(name)) target = info.byName.get(name) as string;
          if (target !== null && !target.startsWith("..") && !found.has(target)) {
            found.add(target);
            queue.push(target);
          }
        }
      }
    }
    return [...found];
  }

  /** Where the hub keeps its checkout of a repository (followed, or the shared one). */
  async function checkoutDir(spec: RepoRef & { ref?: string | null }): Promise<string> {
    return path.join(path.dirname(await ensureMirrorRoot()), "follow", spec.owner.toLowerCase(), `${spec.name.toLowerCase()}${spec.ref ? `@${spec.ref.replace(/[^A-Za-z0-9._-]+/gu, "_")}` : ""}`);
  }
  /** Whether a plugin folder is inside one of the hub's checkouts. */
  async function inHubCheckout(dir: string): Promise<boolean> {
    const root = path.join(path.dirname(await ensureMirrorRoot()), "follow");
    return path.resolve(dir).startsWith(`${root}${path.sep}`);
  }

  type Prepared = { dir: string; head: string; workspaces: WorkspaceInfo };
  const preparedThisRound = new Map<string, Promise<Prepared>>();
  const followKey = (spec: PackageSpec) => `${repoKey(spec)}${spec.ref ? `@${spec.ref}` : ""}`;

  /** The machine's checkout of a followed repository at its newest commit, with the root workspace dependencies installed; once per sync round. */
  function prepareFollowed(spec: PackageSpec): Promise<Prepared> {
    const key = followKey(spec);
    const existing = preparedThisRound.get(key);
    if (existing !== undefined) return existing;
    const work = (async () => {
      const mirror = await syncMirror(spec);
      const head = (await git(["rev-parse", `${spec.ref ?? "HEAD"}^{commit}`], mirror)).trim();
      const dir = await checkoutDir(spec);
      if (!(await exists(path.join(dir, ".git")))) {
        await mkdir(path.dirname(dir), { recursive: true });
        await rm(dir, { recursive: true, force: true });
        await git(["clone", "--quiet", "--no-checkout", mirror, dir]);
      } else {
        await git(["fetch", "--quiet", "origin"], dir);
      }
      // Always (a fresh --no-checkout clone already points at the commit but has no files).
      await git(["checkout", "--quiet", "--force", "--detach", head], dir);
      const workspaces = await readWorkspaces(dir);
      const rootKey = `follow-root:${key}`;
      const rootAt = (await bb.storage.kv.get<string>(rootKey)) ?? null;
      const rootChanged = rootAt === null || !(await exists(path.join(dir, "node_modules"))) || (await anyChanged(dir, rootAt, head, ROOT_FILES));
      if (workspaces.patterns.length > 0 && rootChanged) {
        bb.log.info(`installing the workspace dependencies of ${repoDisplay(spec)} at ${head.slice(0, 12)}`);
        await installDependencies(dir);
      }
      await bb.storage.kv.set(rootKey, head);
      return { dir, head, workspaces };
    })();
    preparedThisRound.set(key, work);
    return work;
  }

  /** Whether any of these paths differs between two commits of a checkout; unknown counts as changed. */
  async function anyChanged(dir: string, from: string, to: string, paths: string[]): Promise<boolean> {
    if (from === to) return false;
    if (!COMMIT_PATTERN.test(from)) return true;
    const out = await git(["diff", "--name-only", from, to, "--", ...paths.map((entry) => (entry === "" ? "." : entry))], dir).catch(() => null);
    return out === null || out.trim() !== "";
  }

  /** Install or rebuild a plugin of a followed repository from the hub's checkout. */
  async function installFollowed(spec: PackageSpec, label: string, pluginId: string): Promise<SyncResult> {
    const prepared = await prepareFollowed(spec);
    const pluginDir = path.join(prepared.dir, ...spec.path.split("/").filter(Boolean));
    const installed = (await bb.sdk.plugins.list()).plugins.find((entry) => entry.id === pluginId);
    const here = installed !== undefined && path.resolve(installed.rootDir) === path.resolve(pluginDir);
    if (installed !== undefined && !here && !(await inHubCheckout(installed.rootDir))) {
      return {
        repo: label,
        pluginId,
        outcome: "other-source",
        detail: installed.source.startsWith("path:")
          ? `Installed from your own folder ${installed.rootDir}, so the hub leaves it alone. Publish it with \`bb hub plugin publish ${installed.rootDir}\`.`
          : `Installed from ${installed.source}. To install it from the hub instead, run \`bb plugin remove ${pluginId}\` (this deletes its settings and data) and \`bb hub sync\`.`,
        version: installed.version,
      };
    }
    const builtKey = `follow-built:${followKey(spec)}|${spec.path}`;
    const builtAt = (await bb.storage.kv.get<string>(builtKey)) ?? null;
    const watched = [...(await watchedFolders(prepared.dir, spec.path, prepared.workspaces)), ...ROOT_FILES];
    if (here && builtAt !== null && !(await anyChanged(prepared.dir, builtAt, prepared.head, watched))) {
      return { repo: label, pluginId, outcome: "current", detail: null, version: installed.version };
    }
    // Its own dependencies, unless the root workspace install covered it.
    const manifest = JSON.parse(await readFile(path.join(pluginDir, "package.json"), "utf8")) as Record<string, unknown>;
    const hasDependencies = ["dependencies", "devDependencies"].some((key) => Object.keys(z.record(z.string(), z.unknown()).catch({}).parse(manifest[key] ?? {})).length > 0);
    // Sibling packages it uses that no workspace install covers get theirs too.
    for (const folder of watched.filter((entry) => entry !== spec.path && !ROOT_FILES.includes(entry))) {
      if (inWorkspaces(folder, prepared.workspaces) || (await exists(path.join(prepared.dir, folder, "node_modules")))) continue;
      const sibling = await readFile(path.join(prepared.dir, folder, "package.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => null);
      if (sibling !== null && ["dependencies", "devDependencies"].some((key) => Object.keys(z.record(z.string(), z.unknown()).catch({}).parse(sibling[key] ?? {})).length > 0)) {
        await installDependencies(path.join(prepared.dir, folder));
      }
    }
    if (hasDependencies && !inWorkspaces(spec.path, prepared.workspaces)) await installDependencies(pluginDir);
    // A path install builds the plugin in place; for an installed one it rebuilds and reloads it, keeping its settings and data.
    const source = `path:${pluginDir}`;
    let result: { id: string; version: string };
    try {
      result = await installWithJob({ kind: "source", source, selection: { kind: "root" } }, () => bb.sdk.plugins.startInstall({ source }));
    } catch (cause) {
      const pending = stillInstalling(cause, label, pluginId);
      if (pending !== null) return pending;
      throw cause;
    }
    await bb.storage.kv.set(builtKey, prepared.head);
    bb.log.info(`${installed === undefined ? "installed" : "rebuilt"} ${result.id}@${result.version} from ${label} at ${prepared.head.slice(0, 12)}`);
    return {
      repo: label,
      pluginId,
      outcome: installed === undefined ? "installed" : "updated",
      detail: installed === undefined ? `built from ${prepared.head.slice(0, 12)}` : here ? `rebuilt at ${prepared.head.slice(0, 12)}` : `moved from ${installed.source}; settings kept`,
      version: result.version,
    };
  }

  async function installOrUpdate(spec: PackageSpec, label: string): Promise<SyncResult> {
    const dir = await syncMirror(spec);
    const pluginId = pluginIdForPackageName((await readPackageJson(dir, spec.path)).name);
    if (pluginId === "") throw new Error(`${label} has an invalid package name.`);
    if (pluginId === bb.pluginId) {
      return { repo: label, pluginId, outcome: "skipped", detail: "The hub updates itself at the end of every sync.", version: null };
    }
    if (spec.follow) return installFollowed(spec, label, pluginId);
    const installed = (await bb.sdk.plugins.list()).plugins.find((entry) => entry.id === pluginId);
    // Shared-repository plugins install from the hub's checkout (a path
    // install), so switching between copies (stable/beta, another group's)
    // moves the plugin and keeps its settings and data. Plugins installed
    // from git before that keep their git install.
    if (isLocal(spec, await readConfig().then((config) => config.packagesRepo))) {
      if (installed === undefined || (await inHubCheckout(installed.rootDir))) return installFollowed(spec, label, pluginId);
      if (spec.beta && isHubSource(installed.source, spec)) {
        const resetKey = `${BETA_RESET_KEY}:${pluginId}`;
        if ((await bb.storage.kv.get<boolean>(resetKey)) === true) {
          await bb.sdk.plugins.remove({ pluginId });
          await bb.storage.kv.delete(resetKey);
          bb.log.info(`reinstalling ${pluginId} from the checkout to join its beta (its settings and data were reset)`);
          return installFollowed(spec, label, pluginId);
        }
        return {
          repo: label,
          pluginId,
          outcome: "skipped",
          detail: `Joining the beta needs a one-time reinstall of ${pluginId} (it was installed before betas existed), which resets its settings and data. Run \`bb hub beta join ${pluginId} --reset-data\` or confirm on the Plugin hub page.`,
          version: installed.version,
        };
      }
    }
    if (installed === undefined) {
      let result: { id: string; version: string };
      try {
        result = await installSource(sourceFor(spec), spec.path || undefined);
      } catch (cause) {
        const pending = stillInstalling(cause, label, pluginId);
        if (pending !== null) return pending;
        throw cause;
      }
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
    // Same repository, but another folder (e.g. another group's copy). Switching
    // means reinstalling, which resets the plugin's data, so it is never automatic.
    const from = installedFolder(installed);
    if (from !== null && from !== spec.path) {
      // The folder it was installed from is gone (the plugin was moved to
      // another group): reinstall from the new folder, or it can never update
      // again. This resets its settings and data; moving says so up front.
      const stillThere = await git(["cat-file", "-e", `HEAD:${inFolder(from, "package.json")}`], dir).then(() => true, () => false);
      if (!stillThere) {
        await bb.sdk.plugins.remove({ pluginId });
        let result: { id: string; version: string };
        try {
          result = await installSource(sourceFor(spec), spec.path || undefined);
        } catch (cause) {
          const pending = stillInstalling(cause, label, pluginId);
          if (pending !== null) return pending;
          throw cause;
        }
        bb.log.info(`reinstalled ${pluginId} from ${spec.path}: it moved from ${from}`);
        return {
          repo: label,
          pluginId,
          outcome: "installed",
          detail: `moved from ${from}; reinstalled from its new folder (its settings and data were reset)`,
          version: result.version,
        };
      }
      return {
        repo: label,
        pluginId,
        outcome: "other-source",
        detail: `Installed from ${from}. Run \`bb hub adopt ${spec.path}\` to switch to this copy (version ${(await readPackageJson(dir, spec.path).catch(() => null))?.version ?? "?"}; this resets the plugin's settings and data).`,
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
      const args = {
        entryId: entry.id,
        ...(plan.kind === "marketplace"
          ? { marketplace: plan.marketplace, confirmedSource: plan.resolvedSource }
          : entry.marketplace
            ? { marketplace: entry.marketplace }
            : {}),
      };
      let result: { id: string; version: string };
      try {
        result = await installWithJob(
          plan.kind === "marketplace" ? { kind: "catalog", entryId: entry.id, marketplace: plan.marketplace } : null,
          () => bb.sdk.plugins.catalog.startInstall(args),
        );
      } catch (cause) {
        const pending = stillInstalling(cause, label, pluginId);
        if (pending !== null) return pending;
        throw cause;
      }
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
    groupId?: string,
  ): Promise<string | null> {
    const { packagesRepo } = await readConfig();
    const group = await findGroup(groupId);
    const work = await workingClone(packagesRepo);
    const relative = inGroup(group, "packages.json");
    const file = path.join(work, relative);
    const document = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(file, "utf8")));
    const next = mutate(document);
    packagesFileSchema.parse(next);
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return commitAndPush(work, [relative], group.id === HOME_GROUP ? message : `${group.name}: ${message}`, packagesRepo);
  }

  /** packages.json with `pluginId` taken off the uninstall list (it's wanted again). */
  const withoutUninstall = (document: Record<string, unknown>, pluginId: string): Record<string, unknown> => {
    if (!Array.isArray(document.uninstall)) return document;
    return { ...document, uninstall: (document.uninstall as unknown[]).filter((id) => String(id).toLowerCase() !== pluginId.toLowerCase()) };
  };

  /**
   * Delete a local plugin: remove its folder from the shared repository and
   * put its id on the uninstall list, so every hub uninstalls it (deleting
   * its data) at the next sync. This machine uninstalls it right away.
   */
  async function deleteLocalPlugin(arg: string, groupId?: string) {
    const outcome = await serialize(async () => {
      const { packagesRepo, hubPath } = await readConfig();
      const allGroups = await listGroups();
      const work = await workingClone(packagesRepo);
      const ref = arg.replace(/^\/+|\/+$/gu, "");
      let folder: string;
      let group: Group;
      if (ref.includes("/")) {
        folder = ref;
        group = (await folderOwner(work, folder, allGroups)).owner;
      } else {
        group = await findGroup(groupId);
        const groupDoc = await readJsonFile(path.join(work, inGroup(group, "packages.json")));
        const owned = entries(groupDoc, "local").map((entry) => String(entry.path ?? "").replace(/^\/+|\/+$/gu, ""));
        folder = owned.find((candidate) => candidate.split("/").at(-1) === ref) ?? `${inGroup(group, PLUGINS_FOLDER)}/${ref}`;
      }
      if (!PATH_PATTERN.test(folder)) throw new Error(`"${arg}" is not a local plugin folder.`);
      if (folder === hubPath) throw new Error("The hub can't delete itself.");
      const manifestText = await readFile(path.join(work, folder, "package.json"), "utf8").catch(() => null);
      if (manifestText === null) throw new Error(`${folder} doesn't exist in the shared repository.`);
      const { owner, area } = await folderOwner(work, folder, allGroups);
      if (owner.id !== group.id) throw new Error(`${folder} belongs to ${owner.name}, not ${group.name}.`);
      const pluginId = pluginIdForPackageName(packageJsonSchema.parse(JSON.parse(manifestText)).name);
      await rm(path.join(work, folder), { recursive: true, force: true });
      const paths = [folder];
      // The owner: drop the folder from "local" and "exclude", put the id on "uninstall".
      const ownerFile = path.join(work, inGroup(owner, "packages.json"));
      const ownerDoc = await readJsonFile(ownerFile);
      const notThisFolder = (entry: unknown) => inGroup(owner, String(entry).replace(/\/+$/u, "")) !== folder;
      const next: Record<string, unknown> = {
        ...ownerDoc,
        uninstall: [...new Set([...z.array(z.string()).catch([]).parse(ownerDoc.uninstall ?? []), pluginId])],
      };
      if (Array.isArray(ownerDoc.exclude)) next.exclude = (ownerDoc.exclude as unknown[]).filter(notThisFolder);
      if (Array.isArray(ownerDoc.local)) next.local = entries(ownerDoc, "local").filter((entry) => String(entry.path ?? "").replace(/^\/+|\/+$/gu, "") !== folder);
      await writeJsonFile(ownerFile, next);
      paths.push(inGroup(owner, "packages.json"));
      // The area group (if it's another group) listed it in "exclude"; tidy that up.
      if (area.id !== owner.id) {
        const areaFile = path.join(work, inGroup(area, "packages.json"));
        const areaDoc = await readJsonFile(areaFile);
        if (Array.isArray(areaDoc.exclude)) {
          areaDoc.exclude = (areaDoc.exclude as unknown[]).filter((entry) => inGroup(area, String(entry).replace(/\/+$/u, "")) !== folder);
          await writeJsonFile(areaFile, areaDoc);
          paths.push(inGroup(area, "packages.json"));
        }
      }
      const commit = await commitAndPush(work, paths, `Delete local plugin ${folder} (${pluginId}) and uninstall it everywhere`, packagesRepo);
      bb.log.info(`deleted ${folder} (${pluginId}) as ${commit ?? "?"}`);
      return { folder, pluginId, commit };
    });
    const report = await requestSync("plugin deleted");
    const removedHere = report.results.some((result) => result.pluginId === outcome.pluginId && result.outcome === "removed");
    bb.realtime.publish(HUB_CHANGED, { deleted: outcome.folder });
    return { ...outcome, removedHere, guaranteedBy: scheduleView(null).guaranteedBy };
  }

  // -------------------------------------------------------------------------
  // Moving plugins between groups

  type MoveKind = "local" | "remote" | "marketplace";
  const readJsonFile = async (file: string) => z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(file, "utf8")));
  const writeJsonFile = async (file: string, document: Record<string, unknown>) => {
    packagesFileSchema.parse(document);
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  };
  const entries = (document: Record<string, unknown>, key: string) =>
    z.array(z.record(z.string(), z.unknown())).catch([]).parse(document[key] ?? []);

  /**
   * Move a plugin from one group to another in one commit. Nothing is
   * reinstalled and no data is lost:
   * - local: the folder stays where it is; the new group lists it under
   *   "local", and the old group stops listing it ("exclude" for its own
   *   area, or off its "local" list). Moving it back to the group whose
   *   plugins/ holds it just un-excludes it.
   * - remote / marketplace: the packages.json entry moves.
   * Machines subscribed only to the old group keep the plugin, but it stops
   * updating (like a removal).
   */
  async function movePlugin(kind: MoveKind, ref: string, fromId: string | undefined, toId: string, options: { path?: string } = {}) {
    const outcome = await serialize(async () => {
      const { packagesRepo, hubPath } = await readConfig();
      const allGroups = await listGroups();
      const to = await findGroup(toId);
      const work = await workingClone(packagesRepo);
      const localRef = ref.replace(/^\/+|\/+$/gu, "");
      // A local folder path names its own (owning) group; otherwise --from (default home).
      const from =
        kind === "local" && localRef.includes("/")
          ? (await folderOwner(work, localRef, allGroups)).owner
          : await findGroup(fromId);
      if (from.id === to.id) throw new Error(`It is already in ${to.name}.`);
      const docs = new Map<string, Record<string, unknown>>();
      const docOf = async (group: Group) => {
        const existing = docs.get(group.id);
        if (existing) return existing;
        const document = await readJsonFile(path.join(work, inGroup(group, "packages.json")));
        docs.set(group.id, document);
        return document;
      };
      const fromDoc = await docOf(from);
      const toDoc = await docOf(to);
      let label: string;
      let pluginId: string | null = null;

      if (kind === "local") {
        // Which folder: a path, or a name in the old group (its area or its "local" list).
        const owned = entries(fromDoc, "local").map((entry) => String(entry.path ?? "").replace(/^\/+|\/+$/gu, ""));
        const folder = localRef.includes("/")
          ? localRef
          : owned.find((candidate) => candidate.split("/").at(-1) === localRef) ?? `${inGroup(from, PLUGINS_FOLDER)}/${localRef}`;
        if (!PATH_PATTERN.test(folder)) throw new Error(`"${ref}" is not a local plugin folder.`);
        if (folder === hubPath) throw new Error("The hub can't be moved.");
        const manifestText = await readFile(path.join(work, folder, "package.json"), "utf8").catch(() => null);
        if (manifestText === null) throw new Error(`${folder} doesn't exist.`);
        const { owner, area } = await folderOwner(work, folder, allGroups);
        if (owner.id !== from.id) throw new Error(`${folder} belongs to ${owner.name}, not ${from.name}.`);
        pluginId = pluginIdForPackageName(packageJsonSchema.parse(JSON.parse(manifestText)).name);
        const sameFolder = (entry: unknown, group: Group) => inGroup(group, String(entry).replace(/\/+$/u, "")) === folder;
        // The old group stops listing it.
        if (from.id === area.id) {
          const exclude = Array.isArray(fromDoc.exclude) ? (fromDoc.exclude as unknown[]) : [];
          const relative = from.path === "" ? folder : folder.slice(from.path.length + 1);
          if (!exclude.some((entry) => sameFolder(entry, from))) fromDoc.exclude = [...exclude, relative];
        } else {
          fromDoc.local = entries(fromDoc, "local").filter((entry) => String(entry.path ?? "").replace(/^\/+|\/+$/gu, "") !== folder);
        }
        // The new group lists it.
        if (to.id === area.id) {
          if (Array.isArray(toDoc.exclude)) toDoc.exclude = (toDoc.exclude as unknown[]).filter((entry) => !sameFolder(entry, to));
        } else {
          const local = entries(toDoc, "local");
          if (!local.some((entry) => String(entry.path ?? "").replace(/^\/+|\/+$/gu, "") === folder)) toDoc.local = [...local, { path: folder }];
          // And the area group must not list it either.
          if (area.id !== from.id) {
            const areaDoc = await docOf(area);
            const exclude = Array.isArray(areaDoc.exclude) ? (areaDoc.exclude as unknown[]) : [];
            const relative = area.path === "" ? folder : folder.slice(area.path.length + 1);
            if (!exclude.some((entry) => sameFolder(entry, area))) areaDoc.exclude = [...exclude, relative];
          }
        }
        label = folder;
      } else if (kind === "remote") {
        const parsed = parseRepoInput(ref);
        const folder = (options.path ?? parsed.path ?? "").replace(/^\/+|\/+$/gu, "");
        const matches = (item: Record<string, unknown>) => {
          try {
            return repoKey(parseRepo(String(item.repo ?? ""))) === repoKey(parsed.repo) && (folder === "" || String(item.path ?? "") === folder);
          } catch {
            return false;
          }
        };
        const moved: Record<string, unknown>[] = [];
        for (const key of ["remote", "plugins"] as const) {
          if (fromDoc[key] === undefined) continue;
          const list = entries(fromDoc, key);
          moved.push(...list.filter(matches));
          fromDoc[key] = list.filter((item) => !matches(item));
        }
        if (moved.length === 0) throw new Error(`${ref} is not a remote plugin of ${from.name}.`);
        const existing = [...entries(toDoc, "remote"), ...entries(toDoc, "plugins")];
        toDoc.remote = [...entries(toDoc, "remote"), ...moved.filter((item) => !existing.some((other) => matches(other) && String(other.path ?? "") === String(item.path ?? "")))];
        label = `${repoDisplay(parsed.repo)}${folder ? `/${folder}` : ""}`;
      } else {
        const wanted = parseEntryArg(ref);
        const matches = (item: Record<string, unknown>) => item.id === wanted.id && (wanted.marketplace === null || item.marketplace === wanted.marketplace);
        const list = entries(fromDoc, "marketplace");
        const moved = list.filter(matches);
        if (moved.length === 0) throw new Error(`${ref} is not a marketplace plugin of ${from.name}.`);
        fromDoc.marketplace = list.filter((item) => !matches(item));
        const existing = entries(toDoc, "marketplace");
        toDoc.marketplace = [...existing, ...moved.filter((item) => !existing.some((other) => other.id === item.id && other.marketplace === item.marketplace))];
        label = moved.map((item) => `${String(item.id)}@${String(item.marketplace ?? "any")}`).join(", ");
      }
      // A plugin moved in is wanted there: take it off that group's uninstall list.
      if (pluginId !== null) docs.set(to.id, withoutUninstall(toDoc, pluginId));
      const paths: string[] = [];
      for (const [groupId, document] of docs) {
        const group = allGroups.find((candidate) => candidate.id === groupId) as Group;
        await writeJsonFile(path.join(work, inGroup(group, "packages.json")), document);
        paths.push(inGroup(group, "packages.json"));
      }
      const commit = await commitAndPush(work, paths, `Move ${kind} plugin ${label} from ${from.name} to ${to.name}`, packagesRepo);
      bb.log.info(`moved ${kind} plugin ${label} from ${from.id} to ${to.id} (${commit ?? "no change"})`);
      return { kind, label, from: from.name, to: to.name, commit };
    });
    const report = await requestSync("plugin moved");
    bb.realtime.publish(HUB_CHANGED, { moved: outcome.label });
    return { ...outcome, guaranteedBy: scheduleView(null).guaranteedBy, results: report.results.length };
  }

  // -------------------------------------------------------------------------
  // Publishing from a development folder, betas, promoting

  type Installed = Awaited<ReturnType<BbPluginApi["sdk"]["plugins"]["list"]>>["plugins"][number];

  /** A group's stable and beta copies of a plugin id, in a working clone (or the mirror). */
  async function copiesIn(read: (folder: string) => Promise<string | null>, list: (folder: string) => Promise<string[]>, group: Group, ownedLocal: string[], pluginId: string) {
    const idAt = async (folder: string) => {
      const text = await read(`${folder}/package.json`);
      if (text === null) return null;
      try {
        const manifest = JSON.parse(text) as { name?: string; version?: string };
        return { id: pluginIdForPackageName(manifest.name ?? ""), version: manifest.version ?? null };
      } catch {
        return null;
      }
    };
    let stable: { path: string; version: string | null } | null = null;
    let beta: { path: string; version: string | null } | null = null;
    const stableFolders = [...(await list(inGroup(group, PLUGINS_FOLDER))).map((name) => `${inGroup(group, PLUGINS_FOLDER)}/${name}`), ...ownedLocal];
    for (const folder of stableFolders) {
      const found = await idAt(folder);
      if (found?.id === pluginId) { stable = { path: folder, version: found.version }; break; }
    }
    for (const name of await list(inGroup(group, BETA_FOLDER))) {
      const folder = `${inGroup(group, BETA_FOLDER)}/${name}`;
      const found = await idAt(folder);
      if (found?.id === pluginId) { beta = { path: folder, version: found.version }; break; }
    }
    return { stable, beta };
  }

  /** Copies of a plugin id in a group, read from a working clone. */
  async function copiesInWork(work: string, group: Group, pluginId: string) {
    const document = await readJsonFile(path.join(work, inGroup(group, "packages.json"))).catch(() => ({}) as Record<string, unknown>);
    const owned = entries(document, "local").map((entry) => String(entry.path ?? "").replace(/^\/+|\/+$/gu, "")).filter(Boolean);
    return copiesIn(
      (file) => readFile(path.join(work, file), "utf8").catch(() => null),
      async (folder) => (await readdir(path.join(work, folder), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      group,
      owned,
      pluginId,
    );
  }

  /**
   * Publish a plugin from a development folder to a group: its stable copy
   * (plugins/<name>), or with beta its beta copy (beta/<name>). The version
   * must be newer than the copy it replaces (and, for a beta, than the stable
   * copy). One commit; every hub picks it up at the next sync.
   */
  async function publishPlugin(dir: string, options: { group?: string; beta?: boolean }) {
    const beta = options.beta === true;
    const outcome = await serialize(async () => {
      fetchedThisRound.clear(); // see the repository as it is now (e.g. a group added a moment ago)
      const source = path.resolve(dir);
      if (!(await isPluginDir(source))) throw new Error(`${source} is not a bb plugin folder (a package.json with a "bb" section).`);
      const { pluginId } = await checkManifest(source);
      if (pluginId === bb.pluginId) throw new Error("That is the hub itself; push changes to it directly.");
      const version = z.object({ version: z.string().min(1) }).parse(JSON.parse(await readFile(path.join(source, "package.json"), "utf8"))).version;
      const { packagesRepo } = await readConfig();
      const group = await findGroup(options.group);
      const work = await workingClone(packagesRepo);
      const { stable, beta: betaCopy } = await copiesInWork(work, group, pluginId);
      const target = beta
        ? betaCopy?.path ?? `${inGroup(group, BETA_FOLDER)}/${path.posix.basename(stable?.path ?? pluginId)}`
        : stable?.path ?? `${inGroup(group, PLUGINS_FOLDER)}/${pluginId}`;
      const replaced = beta ? betaCopy : stable;
      if (replaced !== null && compareVersions(version, replaced.version) <= 0) {
        throw new Error(`${pluginId} ${version} isn't newer than the published ${beta ? "beta" : "stable"} copy (${replaced.version ?? "no version"}). Bump "version" in package.json first.`);
      }
      if (beta && stable !== null && compareVersions(version, stable.version) <= 0) {
        throw new Error(`A beta must be newer than the stable copy (${stable.version ?? "no version"}). Bump "version" in package.json first.`);
      }
      const dest = path.join(work, ...target.split("/"));
      await rm(dest, { recursive: true, force: true });
      await copyPlugin(source, dest);
      if (!(await exists(path.join(dest, ".gitignore")))) await writeFile(path.join(dest, ".gitignore"), "node_modules/\ndist/\n");
      const packagesRelative = inGroup(group, "packages.json");
      const packagesDoc = await readJsonFile(path.join(work, packagesRelative));
      const cleaned = withoutUninstall(packagesDoc, pluginId);
      if (cleaned !== packagesDoc) await writeJsonFile(path.join(work, packagesRelative), cleaned);
      await git(["add", "-A", "--", target], work);
      const changes = (await git(["diff", "--cached", "--stat=100", "--", target], work)).split("\n").map((line) => line.trim()).filter(Boolean).slice(-40);
      const commit = await commitAndPush(work, [target, packagesRelative], `${group.id === HOME_GROUP ? "" : `${group.name}: `}Publish ${pluginId} ${version}${beta ? " (beta)" : ""}`, packagesRepo);
      bb.log.info(`published ${pluginId} ${version}${beta ? " (beta)" : ""} to ${target} (${commit ?? "no change"})`);
      return { pluginId, folder: target, beta, from: replaced?.version ?? null, to: version, commit, changes };
    });
    const report = await requestSync("plugin published");
    const sync = report.results.find((entry) => entry.pluginId === outcome.pluginId) ?? null;
    bb.realtime.publish(HUB_CHANGED, { published: outcome.pluginId });
    return { ...outcome, guaranteedBy: scheduleView(null).guaranteedBy, sync };
  }

  /** Make a group's beta copy of a plugin its stable copy (the beta folder goes). Machines on the beta move to it without a reinstall. */
  async function promoteBeta(plugin: string, groupId?: string) {
    const outcome = await serialize(async () => {
      fetchedThisRound.clear(); // see the repository as it is now (e.g. a group added a moment ago)
      const { packagesRepo } = await readConfig();
      const group = await findGroup(groupId);
      const work = await workingClone(packagesRepo);
      // A plugin id, or a beta folder name.
      let pluginId = plugin.trim().toLowerCase();
      const byName = path.join(work, inGroup(group, BETA_FOLDER), pluginId, "package.json");
      if (await exists(byName)) pluginId = pluginIdForPackageName((JSON.parse(await readFile(byName, "utf8")) as { name?: string }).name ?? "");
      const { stable, beta } = await copiesInWork(work, group, pluginId);
      if (beta === null) throw new Error(`${group.name} has no beta copy of ${plugin}.`);
      const target = stable?.path ?? `${inGroup(group, PLUGINS_FOLDER)}/${path.posix.basename(beta.path)}`;
      await rm(path.join(work, ...target.split("/")), { recursive: true, force: true });
      await cp(path.join(work, ...beta.path.split("/")), path.join(work, ...target.split("/")), { recursive: true });
      await rm(path.join(work, ...beta.path.split("/")), { recursive: true, force: true });
      const commit = await commitAndPush(work, [target, beta.path], `${group.id === HOME_GROUP ? "" : `${group.name}: `}Promote the ${pluginId} beta (${beta.version ?? "?"}) to stable`, packagesRepo);
      bb.log.info(`promoted ${beta.path} to ${target} (${commit ?? "no change"})`);
      return { pluginId, from: beta.path, to: target, version: beta.version, commit };
    });
    await requestSync("beta promoted");
    bb.realtime.publish(HUB_CHANGED, { promoted: outcome.pluginId });
    return { ...outcome, guaranteedBy: scheduleView(null).guaranteedBy };
  }

  /** Join or leave a plugin's beta on this machine (the "beta" setting). */
  async function setBeta(pluginId: string, joined: boolean, resetData = false) {
    const id = pluginId.trim().toLowerCase();
    if (!ENTRY_ID_PATTERN.test(id)) throw new Error(`"${pluginId}" is not a plugin id.`);
    const { beta } = await readConfig();
    if (!joined && beta.includes("*")) throw new Error('This machine runs every beta ("*" in the beta setting); change it with `bb plugin config hub set beta <ids>`.');
    const next = joined ? [...new Set([...beta, id])] : beta.filter((entry) => entry !== id);
    const resetKey = `${BETA_RESET_KEY}:${id}`;
    if (joined && resetData) await bb.storage.kv.set(resetKey, true);
    if (!joined) await bb.storage.kv.delete(resetKey);
    // The settings change starts a sync, which switches the plugin.
    await settings.experimental_set({ beta: next.join(",") });
    bb.log.info(`${joined ? "joined" : "left"} the beta of ${id}`);
    bb.realtime.publish(HUB_CHANGED, { beta: id });
    return { pluginId: id, joined, beta: next };
  }

  /** The page's beta and development-folder views for a group. */
  async function betaAndDevViews(packages: Awaited<ReturnType<typeof loadPackages>>, installedPlugins: Installed[]) {
    const { beta: betaIds, packagesRepo } = await readConfig();
    const mirror = await syncMirror(packagesRepo);
    const fileText = await git(["show", `HEAD:${inGroup(packages.group, "packages.json")}`], mirror).catch(() => "{}");
    const owned = entries(z.record(z.string(), z.unknown()).catch({}).parse(JSON.parse(fileText)), "local").map((entry) => String(entry.path ?? "").replace(/^\/+|\/+$/gu, "")).filter(Boolean);
    const copies = (pluginId: string) =>
      copiesIn(
        (file) => git(["show", `HEAD:${file}`], mirror).catch(() => null),
        async (folder) => (await git(["ls-tree", "-d", "--name-only", `HEAD:${folder}`], mirror).catch(() => "")).split("\n").map((line) => line.trim()).filter(Boolean),
        packages.group,
        owned,
        pluginId,
      );
    const sharedCheckout = await checkoutDir(packagesRepo);
    const betas: BetaView[] = [];
    for (const spec of packages.betas) {
      const manifest = await readPackageJson(mirror, spec.path).catch(() => null);
      if (manifest === null) continue;
      const pluginId = pluginIdForPackageName(manifest.name);
      const { stable } = await copies(pluginId);
      const plugin = installedPlugins.find((entry) => entry.id === pluginId);
      betas.push({
        pluginId,
        name: manifest.bb?.name ?? pluginId,
        path: spec.path,
        version: manifest.version ?? null,
        stablePath: stable?.path ?? null,
        stableVersion: stable?.version ?? null,
        joined: betaIds.includes("*") || betaIds.includes(pluginId),
        needsReset: plugin !== undefined && isHubSource(plugin.source, spec),
        installedVersion: plugin?.version ?? null,
        running: plugin !== undefined && path.resolve(plugin.rootDir) === path.resolve(sharedCheckout, ...spec.path.split("/")),
      });
    }
    const devPlugins: DevPlugin[] = [];
    for (const plugin of installedPlugins) {
      if (!plugin.source.startsWith("path:") || plugin.id === bb.pluginId || (await inHubCheckout(plugin.rootDir))) continue;
      const manifest = await readFile(path.join(plugin.rootDir, "package.json"), "utf8").then((text) => JSON.parse(text) as { version?: string; bb?: { name?: string } }, () => null);
      const { stable, beta } = await copies(plugin.id);
      devPlugins.push({
        pluginId: plugin.id,
        name: manifest?.bb?.name ?? plugin.id,
        version: manifest?.version ?? plugin.version ?? null,
        dir: plugin.rootDir,
        stablePath: stable?.path ?? null,
        stableVersion: stable?.version ?? null,
        betaPath: beta?.path ?? null,
        betaVersion: beta?.version ?? null,
      });
    }
    return { betas, devPlugins };
  }

  // -------------------------------------------------------------------------
  // Managing groups. A group's id and folder never change (machines subscribe
  // by id, and its marketplace is named after it); renaming changes only its
  // display name.

  const groupIdFromName = (name: string) =>
    name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64).replace(/-+$/u, "");
  const cleanGroupName = (name: string) => {
    const trimmed = name.replace(/\s+/gu, " ").trim();
    if (trimmed === "" || trimmed.length > 60) throw new Error("A group name must be 1 to 60 characters.");
    return trimmed;
  };
  const groupComment = (name: string, id: string) =>
    `The ${name} group. Same format as the root packages.json: include/exclude are relative to this folder, and local plugins go in ./plugins/<name>. Machines that run \`bb hub group subscribe ${id}\` install these.`;
  const nameTaken = (groups: Group[], name: string, except?: string) =>
    groups.some((group) => group.id !== except && group.name.toLowerCase() === name.toLowerCase());

  /** Add an empty group: a folder groups/<id> with its packages.json, listed in the root packages.json. */
  async function addGroup(rawName: string, rawId?: string) {
    const outcome = await serialize(async () => {
      fetchedThisRound.clear(); // see the repository as it is now (e.g. a group added a moment ago)
      const name = cleanGroupName(rawName);
      const id = (rawId?.trim().toLowerCase() || groupIdFromName(name));
      if (!GROUP_ID_PATTERN.test(id)) {
        throw new Error(`"${id}" can't be a group id: use lowercase letters, digits and dashes${rawId ? "" : " (give one with --id)"}.`);
      }
      if (id === HOME_GROUP) throw new Error(`"${HOME_GROUP}" is the home group's id.`);
      const { packagesRepo } = await readConfig();
      const work = await workingClone(packagesRepo);
      const groups = await listGroups();
      if (groups.some((group) => group.id === id)) throw new Error(`There is already a group with the id "${id}".`);
      if (nameTaken(groups, name)) throw new Error(`There is already a group called ${name}.`);
      const folder = `groups/${id}`;
      if (await access(path.join(work, folder)).then(() => true, () => false)) {
        throw new Error(`${folder} already exists in the repository; pick another id.`);
      }
      const root = await readJsonFile(path.join(work, "packages.json"));
      root.groups = [...entries(root, "groups"), { id, name, path: folder }];
      await mkdir(path.join(work, folder), { recursive: true });
      await writeJsonFile(path.join(work, folder, "packages.json"), {
        $comment: groupComment(name, id),
        name,
        include: [`${PLUGINS_FOLDER}/*`],
        exclude: [],
        remote: [],
        uninstall: [],
        marketplace: [],
      });
      await writeJsonFile(path.join(work, "packages.json"), root);
      const commit = await commitAndPush(work, [folder, "packages.json"], `Add group ${name} (${id})`, packagesRepo);
      bb.log.info(`added group ${id} (${commit ?? "no change"})`);
      return { id, name, path: folder, commit };
    });
    bb.realtime.publish(HUB_CHANGED, { group: outcome.id });
    return outcome;
  }

  /** Rename a group (its display name only; the id and folder stay). The home group can be renamed too. */
  async function renameGroup(groupId: string, rawName: string) {
    const outcome = await serialize(async () => {
      fetchedThisRound.clear(); // see the repository as it is now (e.g. a group added a moment ago)
      const name = cleanGroupName(rawName);
      const { packagesRepo } = await readConfig();
      const work = await workingClone(packagesRepo);
      const groups = await listGroups();
      const group = await findGroup(groupId);
      if (group.name === name) return { id: group.id, from: group.name, name, commit: null };
      if (nameTaken(groups, name, group.id)) throw new Error(`There is already a group called ${name}.`);
      const root = await readJsonFile(path.join(work, "packages.json"));
      const paths = ["packages.json"];
      if (group.id === HOME_GROUP) {
        root.name = name;
      } else {
        root.groups = entries(root, "groups").map((entry) => (String(entry.id ?? "").toLowerCase() === group.id ? { ...entry, name } : entry));
        const file = path.join(work, inGroup(group, "packages.json"));
        const document = await readJsonFile(file).catch(() => null);
        if (document !== null) {
          document.name = name;
          if (typeof document.$comment === "string") document.$comment = groupComment(name, group.id);
          await writeJsonFile(file, document);
          paths.push(inGroup(group, "packages.json"));
        }
      }
      await writeJsonFile(path.join(work, "packages.json"), root);
      const commit = await commitAndPush(work, paths, `Rename group ${group.name} to ${name}`, packagesRepo);
      bb.log.info(`renamed group ${group.id} to ${name} (${commit ?? "no change"})`);
      return { id: group.id, from: group.name, name, commit };
    });
    bb.realtime.publish(HUB_CHANGED, { group: outcome.id });
    return outcome;
  }

  /**
   * Remove a group. Only an empty one: it must have no plugin folders and no
   * local, remote or marketplace plugins, so removing it can't lose a plugin
   * or its data. Move or delete them first.
   */
  async function removeGroup(groupId: string) {
    const outcome = await serialize(async () => {
      fetchedThisRound.clear(); // see the repository as it is now (e.g. a group added a moment ago)
      const group = await findGroup(groupId);
      if (group.id === HOME_GROUP) throw new Error("The home group can't be removed.");
      const { packagesRepo } = await readConfig();
      const work = await workingClone(packagesRepo);
      const document = (await readJsonFile(path.join(work, inGroup(group, "packages.json"))).catch(() => null)) ?? {};
      const folders = (await readdir(path.join(work, inGroup(group, PLUGINS_FOLDER)), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory())
        .map((entry) => inGroup(group, `${PLUGINS_FOLDER}/${entry.name}`));
      const contents = [
        ...folders,
        ...entries(document, "local").map((entry) => String(entry.path ?? "")),
        ...[...entries(document, "remote"), ...entries(document, "plugins")].map((entry) => `${String(entry.repo ?? "")}${entry.path ? `/${String(entry.path)}` : ""}`),
        ...entries(document, "marketplace").map((entry) => `${String(entry.id ?? "")}${entry.marketplace ? `@${String(entry.marketplace)}` : ""}`),
      ];
      if (contents.length > 0) {
        throw new Error(
          `${group.name} still has plugins: ${contents.join(", ")}. Move them to another group or delete them first, so no plugin or its data is lost.`,
        );
      }
      const root = await readJsonFile(path.join(work, "packages.json"));
      root.groups = entries(root, "groups").filter((entry) => String(entry.id ?? "").toLowerCase() !== group.id);
      await writeJsonFile(path.join(work, "packages.json"), root);
      await rm(path.join(work, group.path), { recursive: true, force: true });
      const commit = await commitAndPush(work, [group.path, "packages.json"], `Remove group ${group.name} (${group.id})`, packagesRepo);
      bb.log.info(`removed group ${group.id} (${commit ?? "no change"})`);
      return { id: group.id, name: group.name, commit };
    });
    // This machine forgets it now; other machines drop its marketplace at their next sync.
    await forgetRemovedGroup(outcome.id);
    const { subscribed } = await readConfig();
    if (subscribed.includes(outcome.id)) await settings.experimental_set({ groups: subscribed.filter((id) => id !== outcome.id).join(",") });
    bb.realtime.publish(HUB_CHANGED, { group: outcome.id });
    return { ...outcome, guaranteedBy: scheduleView(null).guaranteedBy };
  }

  /** Take a removed group's marketplace out of Settings → Plugin marketplaces, if the hub added it. */
  async function forgetRemovedGroup(groupId: string) {
    const key = `${MARKETPLACE_REFRESHED_KEY}:${groupId}`;
    if ((await bb.storage.kv.get<string>(key)) == null) return;
    await bb.sdk.plugins.marketplaces.remove({ name: `bb-plugins-${groupId}` }).catch(() => undefined);
    await bb.storage.kv.delete(key);
    bb.log.info(`group ${groupId} was removed; took its marketplace out of Settings`);
  }

  async function addMarketplacePlugin(arg: string, groupId?: string) {
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
        return { ...withoutUninstall(document, plan.pluginId), marketplace: [...list, entry] };
      }, `Add ${entry.id}@${marketplace} from the marketplace to hub packages`, groupId);
      return { entry: `${entry.id}@${marketplace}`, pluginId: plan.pluginId, displayName: plan.displayName, commit, compatible: plan.compatible, incompatibleReason: plan.incompatibleReason };
    });
    const report = await requestSync("marketplace plugin added");
    const sync = report.results.find((result) => result.pluginId === outcome.pluginId) ?? null;
    bb.realtime.publish(HUB_CHANGED, { added: outcome.entry });
    return { ...outcome, guaranteedBy: scheduleView(null).guaranteedBy, sync };
  }

  async function removeMarketplacePlugin(arg: string, groupId?: string) {
    const wanted = parseEntryArg(arg);
    const outcome = await serialize(async () => {
      let removed: string[] = [];
      const commit = await editPackagesJson((document) => {
        const list = z.array(z.record(z.string(), z.unknown())).catch([]).parse(document.marketplace ?? []);
        const keep = list.filter((item) => !(item.id === wanted.id && (wanted.marketplace === null || item.marketplace === wanted.marketplace)));
        removed = list.filter((item) => !keep.includes(item)).map((item) => `${String(item.id)}@${String(item.marketplace ?? "any")}`);
        if (removed.length === 0) throw new Error(`${arg} is not in packages.json's marketplace list.`);
        return { ...document, marketplace: keep };
      }, `Remove ${arg} from the marketplace hub packages`, groupId);
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

  /**
   * Register the shared repository's marketplace.json with bb (Settings →
   * Plugin marketplaces) if this machine doesn't have it yet, and refresh it
   * when the repository has a new commit. Returns a result only on a change
   * or a failure.
   */
  async function ensureTeamMarketplace(packagesRepo: RepoRef, dir: string, group: Group): Promise<SyncResult | null> {
    if (!(await settings.get()).registerMarketplace) return null;
    const text = await git(["show", `HEAD:${inGroup(group, "marketplace.json")}`], dir).catch(() => null);
    if (text === null) return null;
    const label = `marketplace: ${group.name}`;
    const refreshedKey = `${MARKETPLACE_REFRESHED_KEY}:${group.id}`;
    try {
      const name = z.object({ name: z.string().min(1) }).parse(JSON.parse(text)).name;
      const head = (await git(["rev-parse", "HEAD"], dir)).trim();
      const known = (await bb.sdk.plugins.marketplaces.list()).find((marketplace) => marketplace.name === name);
      if (known === undefined) {
        await bb.sdk.plugins.marketplaces.add({ source: `git:${repoUrl(packagesRepo)}`, ...(group.path ? { subdirectory: group.path } : {}) });
        await bb.storage.kv.set(refreshedKey, head);
        bb.log.info(`added the ${name} marketplace from ${repoDisplay(packagesRepo)}`);
        return { repo: label, pluginId: null, outcome: "installed", detail: `"${name}" added to Settings → Plugin marketplaces`, version: null };
      }
      if ((await bb.storage.kv.get<string>(refreshedKey)) !== head) {
        await bb.sdk.plugins.marketplaces.refresh({ name });
        await bb.storage.kv.set(refreshedKey, head);
      }
      return null;
    } catch (cause) {
      return { repo: label, pluginId: null, outcome: "failed", detail: errorMessage(cause), version: null };
    }
  }

  async function runSync(trigger: string): Promise<SyncReport> {
    syncing = { trigger, startedAt: new Date().toISOString() };
    bb.realtime.publish(HUB_CHANGED, { syncing: trigger });
    try {
      return await runSyncSteps(trigger);
    } finally {
      syncing = null;
      bb.realtime.publish(HUB_CHANGED, { syncing: null });
    }
  }

  async function runSyncSteps(trigger: string): Promise<SyncReport> {
    const startedAt = Date.now();
    fetchedThisRound.clear();
    preparedThisRound.clear();
    const results: SyncResult[] = [];
    let from = "—";
    let startSelfUpdate = false;
    let packagesDir: string | null = null;
    try {
      const { packagesRepo, subscribed, beta: betaIds } = await readConfig();
      const groups = await subscribedGroups();
      const allGroups = await listGroups();
      packagesDir = await syncMirror(packagesRepo);
      // A subscribed group that was removed from the repository: drop its marketplace.
      for (const id of subscribed.filter((candidate) => !allGroups.some((group) => group.id === candidate))) {
        await forgetRemovedGroup(id).catch(() => undefined);
      }
      const loaded: Awaited<ReturnType<typeof loadPackages>>[] = [];
      for (const group of groups) {
        try {
          loaded.push(await loadPackages(group.id));
        } catch (cause) {
          results.push({ repo: `${group.id}: packages.json`, pluginId: null, outcome: "failed", detail: errorMessage(cause), version: null });
        }
        const marketplaceResult = await ensureTeamMarketplace(packagesRepo, packagesDir, group);
        if (marketplaceResult !== null) results.push(marketplaceResult);
      }
      from = loaded.map((packages) => packages.from).join(", ");
      for (const packages of loaded) {
        for (const error of packages.errors) {
          results.push({ repo: `${packages.group.id}: packages.json`, pluginId: null, outcome: "failed", detail: error, version: null });
        }
      }

      // Every candidate across the subscribed groups, with its plugin id and
      // version. The same repository folder listed twice counts once.
      type Candidate = { spec: PackageSpec; label: string; group: Group; order: number; version: string | null };
      const byId = new Map<string, Candidate[]>();
      const seenSpecs = new Set<string>();
      let order = 0;
      for (const packages of loaded) {
        for (const spec of packages.specs) {
          const key = `${repoKey(spec)}|${spec.path}`;
          if (seenSpecs.has(key)) continue;
          seenSpecs.add(key);
          const label = labelFor(spec, packagesRepo);
          try {
            const manifest = await readPackageJson(await syncMirror(spec), spec.path);
            const id = pluginIdForPackageName(manifest.name);
            byId.set(id, [...(byId.get(id) ?? []), { spec, label, group: packages.group, order: order++, version: manifest.version ?? null }]);
          } catch (cause) {
            results.push({ repo: label, pluginId: null, outcome: "failed", detail: errorMessage(cause), version: null });
          }
        }
      }
      // Beta copies, for the plugins this machine joined the beta of.
      const joined = (id: string) => betaIds.includes("*") || betaIds.includes(id);
      const betaById = new Map<string, Candidate>();
      for (const packages of loaded) {
        for (const spec of packages.betas) {
          try {
            const manifest = await readPackageJson(await syncMirror(spec), spec.path);
            const id = pluginIdForPackageName(manifest.name);
            if (!joined(id)) continue;
            const candidate = { spec, label: labelFor(spec, packagesRepo), group: packages.group, order: order++, version: manifest.version ?? null };
            const best = betaById.get(id);
            if (best === undefined || compareVersions(candidate.version, best.version) > 0) betaById.set(id, candidate);
          } catch (cause) {
            results.push({ repo: labelFor(spec, packagesRepo), pluginId: null, outcome: "failed", detail: errorMessage(cause), version: null });
          }
        }
      }
      for (const id of betaById.keys()) if (!byId.has(id)) byId.set(id, []);
      // A clash (one plugin id in several places) goes to the newest version;
      // on a tie, the home group, then group order. A joined beta wins unless
      // the stable copy is newer (the beta is out of date).
      const folderForId = new Map<string, string>();
      for (const [id, candidates] of byId) {
        const ranked = [...candidates].sort((a, b) => compareVersions(b.version, a.version) || a.order - b.order);
        const stable = ranked[0];
        const betaCandidate = betaById.get(id);
        const winner = (betaCandidate !== undefined && (stable === undefined || compareVersions(betaCandidate.version, stable.version) >= 0) ? betaCandidate : stable) as Candidate;
        folderForId.set(id, winner.label);
        for (const loser of ranked.filter((candidate) => candidate !== winner && candidate !== stable)) {
          results.push({
            repo: loser.label,
            pluginId: id,
            outcome: "skipped",
            detail: `${compareVersions(winner.version, loser.version) > 0 ? "newer" : "same"} version ${winner.version ?? "?"} in ${winner.label} (${winner.group.name}) wins`,
            version: loser.version,
          });
        }
        try {
          results.push(await installOrUpdate(winner.spec, winner.label));
        } catch (cause) {
          results.push({ repo: winner.label, pluginId: id, outcome: "failed", detail: errorMessage(cause), version: null });
        }
      }
      const seenEntries = new Set<string>();
      for (const packages of loaded) {
        for (const entry of packages.marketplace) {
          const key = `${entry.id}@${entry.marketplace ?? ""}`;
          if (seenEntries.has(key)) continue;
          seenEntries.add(key);
          try {
            results.push(await syncMarketplaceEntry(entry));
          } catch (cause) {
            results.push({ repo: marketplaceLabel(entry), pluginId: null, outcome: "failed", detail: errorMessage(cause), version: null });
          }
        }
      }
      // Deleted local plugins: uninstall them (this deletes their data), but
      // only when this hub installed them from that group's own folders in the
      // shared repository, and never while a package with that id is listed.
      const listedIds = new Set([...folderForId.keys(), ...results.map((result) => result.pluginId).filter((id): id is string => id !== null)]);
      const installedNow = (await bb.sdk.plugins.list()).plugins;
      const sharedSource = `git:${repoUrl(packagesRepo)}`.toLowerCase();
      for (const packages of loaded) {
        for (const id of packages.uninstall) {
          if (id === bb.pluginId || listedIds.has(id)) continue;
          const plugin = installedNow.find((entry) => entry.id === id);
          if (plugin === undefined) continue;
          const source = plugin.source.toLowerCase();
          const sharedCheckout = await checkoutDir(packagesRepo);
          const fromCheckout = path.resolve(plugin.rootDir).startsWith(`${sharedCheckout}${path.sep}`);
          if (source !== sharedSource && !source.startsWith(`${sharedSource}@`) && !fromCheckout) continue;
          // Only when the folder it was installed from is gone (it was deleted):
          // a folder that still exists belongs to another group's copy.
          const folder = fromCheckout ? path.relative(sharedCheckout, plugin.rootDir).split(path.sep).join("/") : installedFolder(plugin);
          if (folder !== null && (await git(["cat-file", "-e", `HEAD:${inFolder(folder, "package.json")}`], packagesDir).then(() => true, () => false))) continue;
          try {
            await bb.sdk.plugins.remove({ pluginId: id });
            bb.log.info(`uninstalled ${id}: it was deleted from group ${packages.group.id}`);
            results.push({ repo: `deleted:${id}`, pluginId: id, outcome: "removed", detail: `deleted from ${packages.group.name}; uninstalled with its data`, version: plugin.version });
          } catch (cause) {
            results.push({ repo: `deleted:${id}`, pluginId: id, outcome: "failed", detail: `could not uninstall: ${errorMessage(cause)}`, version: plugin.version });
          }
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

  let syncing: { trigger: string; startedAt: string } | null = null;
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
    let folder = arg.replace(/^\/+|\/+$/gu, "");
    if (!folder.includes("/")) {
      // A bare name: the first group (home first) that has plugins/<name>.
      const dir = await syncMirror(packagesRepo);
      let found: string | null = null;
      for (const group of await listGroups()) {
        const candidate = `${inGroup(group, PLUGINS_FOLDER)}/${folder}`;
        if (await git(["cat-file", "-e", `HEAD:${candidate}/package.json`], dir).then(() => true, () => false)) {
          found = candidate;
          break;
        }
      }
      folder = found ?? `${PLUGINS_FOLDER}/${folder}`;
    }
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
      const fromFolder = installed === undefined ? null : installedFolder(installed);
      if (installed !== undefined && (!isHubSource(installed.source, spec) || (fromFolder !== null && fromFolder !== spec.path))) {
        await bb.sdk.plugins.remove({ pluginId });
        bb.log.info(`removed ${pluginId} (was ${installed.source}) to adopt it`);
      }
      return installOrUpdate(spec, spec.path);
    });
    bb.realtime.publish(HUB_CHANGED, { repo: result.repo });
    return result;
  }

  /** Subscribe this machine to a group (it installs the group's plugins), or unsubscribe. */
  async function setSubscribed(groupId: string, on: boolean) {
    const group = await findGroup(groupId);
    if (group.id === HOME_GROUP) throw new Error("The home group is always subscribed.");
    const { subscribed, packagesRepo } = await readConfig();
    const next = on ? [...new Set([...subscribed, group.id])] : subscribed.filter((id) => id !== group.id);
    if (!on) {
      // Its plugins stay installed (like a removal), but its marketplace leaves Settings.
      const text = await git(["show", `HEAD:${inGroup(group, "marketplace.json")}`], await syncMirror(packagesRepo)).catch(() => null);
      const name = text === null ? null : z.object({ name: z.string() }).safeParse(JSON.parse(text)).data?.name ?? null;
      if (name !== null) await bb.sdk.plugins.marketplaces.remove({ name }).catch(() => undefined);
      await bb.storage.kv.delete(`${MARKETPLACE_REFRESHED_KEY}:${group.id}`);
    }
    // The settings change starts a sync, which installs a newly subscribed group's plugins.
    await settings.experimental_set({ groups: next.join(",") });
    bb.log.info(`${on ? "subscribed to" : "unsubscribed from"} group ${group.id}`);
    bb.realtime.publish(HUB_CHANGED, { group: group.id });
    return { group: group.id, name: group.name, subscribed: on, guaranteedBy: scheduleView(null).guaranteedBy };
  }

  async function listHub(groupId?: string) {
    const packages = await serialize(async () => {
      fetchedThisRound.clear();
      return loadPackages(groupId);
    });
    const { subscribed } = await readConfig();
    const groups = (await listGroups()).map((group) => ({
      ...group,
      subscribed: group.id === HOME_GROUP || subscribed.includes(group.id),
      home: group.id === HOME_GROUP,
    }));
    const pluginsDir = inGroup(packages.group, PLUGINS_FOLDER);
    const dir = await syncMirror(packages.packagesRepo);
    const tree = await git(["ls-tree", "-d", "--name-only", `HEAD:${pluginsDir}`], dir).catch(() => "");
    const installedPlugins = (await bb.sdk.plugins.list()).plugins;
    const installed = new Map(installedPlugins.map((entry) => [entry.id, entry.version]));
    const packageFolders = new Set(
      packages.specs.filter((spec) => repoKey(spec) === repoKey(packages.packagesRepo)).map((spec) => spec.path),
    );
    const folders: PluginFolder[] = [];
    for (const name of tree.split("\n").map((line) => line.trim()).filter(Boolean)) {
      const folder = `${pluginsDir}/${name}`;
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
      group: { id: packages.group.id, name: packages.group.name, path: packages.group.path },
      groups,
      folders,
      ...(await betaAndDevViews(packages, installedPlugins)),
      packages: await Promise.all(
        packages.specs.map(async (spec) => {
          const manifest = await syncMirror(spec)
            .then((mirror) => readPackageJson(mirror, spec.path))
            .catch(() => null);
          const pluginId = manifest === null ? null : pluginIdForPackageName(manifest.name);
          const plugin = pluginId === null ? undefined : installedPlugins.find((entry) => entry.id === pluginId);
          const web = spec.url.replace(/\.git$/u, "");
          const webUrl = web.startsWith("https://github.com/")
            ? `${web}/tree/${spec.ref ?? "HEAD"}${spec.path ? `/${spec.path}` : ""}`
            : web;
          return {
            label: labelFor(spec, packages.packagesRepo),
            path: spec.path,
            repo: repoDisplay(spec),
            ref: spec.ref,
            kind: isLocal(spec, packages.packagesRepo) ? ("local" as const) : ("remote" as const),
            info:
              manifest === null || pluginId === null
                ? null
                : {
                    name: manifest.bb?.name ?? pluginId,
                    pluginId,
                    description: manifest.bb?.description ?? null,
                    latestVersion: manifest.version ?? null,
                    installedVersion: plugin?.version ?? null,
                    installedFrom: plugin?.sourceDisplay ?? null,
                    updatedAt: plugin?.updatedAt ?? null,
                    enabled: plugin?.enabled ?? null,
                    webUrl,
                  },
          };
        }),
      ),
      marketplace: await Promise.all(
        packages.marketplace.map(async (entry) => {
          const found = await bb.sdk.plugins.catalog
            .search({ query: entry.id })
            .then((response) => response.results.find((result) => result.entryId === entry.id && (entry.marketplace === null || result.marketplace === entry.marketplace)))
            .catch(() => undefined);
          const plugin = found === undefined ? undefined : installedPlugins.find((item) => item.id === found.pluginId);
          return {
            label: marketplaceLabel(entry),
            entry: `${entry.id}${entry.marketplace ? `@${entry.marketplace}` : ""}`,
            info:
              found === undefined
                ? null
                : {
                    name: found.displayName,
                    pluginId: found.pluginId,
                    description: found.description,
                    marketplace: found.marketplaceDisplayName,
                    publisher: found.publisherLabel,
                    category: found.category ?? null,
                    installs: found.installs ?? null,
                    compatible: found.compatible,
                    incompatibleReason: found.incompatibleReason,
                    source: found.source,
                    repositoryUrl: found.repositoryUrl ?? null,
                    installedVersion: plugin?.version ?? null,
                    installedFrom: plugin?.sourceDisplay ?? null,
                    enabled: plugin?.enabled ?? null,
                  },
          };
        }),
      ),
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
  async function addRemotePlugin(text: string, options: { subdir?: string; group?: string }) {
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
        const subdir = options.subdir?.trim().replace(/^\/+|\/+$/gu, "") || parsed.path || undefined;
        // A repository with several plugins (its root isn't one): follow it,
        // so every plugin in it (or the one folder given) is built from a
        // checkout of the whole repository, sibling packages included.
        if (!(await isPluginDir(clone))) return await addFollow(clone, parsed.repo, parsed.ref, subdir, options.group);
        const pluginDir = await findPluginDir(clone, subdir);
        const { pluginId, warning } = await checkManifest(pluginDir);
        if (pluginId === bb.pluginId) throw new Error("That is the hub itself.");
        const folder = path.relative(clone, pluginDir).split(path.sep).join("/");
        const spec: PackageSpec = { ...parsed.repo, path: folder, ref: parsed.ref };
        const label = labelFor(spec, packagesRepo);
        // bb installs one plugin per id, so the id must be new.
        fetchedThisRound.clear();
        const packages = await loadPackages(options.group);
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
          return { ...withoutUninstall(document, pluginId), remote: [...list, entry] };
        }, `Add remote plugin ${label}`, options.group);
        bb.log.info(`added remote plugin ${label} (${pluginId}) as ${commit ?? "?"}`);
        return { folder: label, pluginId, commit, warning, unchanged: false, kind: "remote" as "remote" | "followed" };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
    const report = await requestSync("plugin added");
    const ids = result.pluginId.split(", ");
    const sync = report.results.find((entry) => entry.pluginId !== null && ids.includes(entry.pluginId) && entry.outcome === "failed")
      ?? report.results.find((entry) => entry.pluginId !== null && ids.includes(entry.pluginId)) ?? null;
    bb.realtime.publish(HUB_CHANGED, { added: result.folder });
    return { ...result, guaranteedBy: scheduleView(null).guaranteedBy, sync };
  }

  /**
   * Follow a repository with several plugins: a "follow" entry (one per
   * repository; a folder given adds just that plugin to its "include").
   * Remote entries for the same repository are dropped (the follow replaces them).
   */
  async function addFollow(clone: string, repo: RepoRef, ref: string | null, subdir: string | undefined, groupId?: string) {
    const folders: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || folders.length >= 100) return;
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        const child = path.join(dir, entry.name);
        if (await isPluginDir(child)) folders.push(path.relative(clone, child).split(path.sep).join("/"));
        else await walk(child, depth + 1);
      }
    };
    await walk(clone, 1);
    if (folders.length === 0) throw new Error('No bb plugin found in the repository (a package.json with a "bb" section).');
    if (subdir !== undefined && !folders.includes(subdir)) {
      throw new Error(`${subdir} isn't a bb plugin folder of ${repoDisplay(repo)}. Its plugins: ${folders.join(", ")}.`);
    }
    const chosen = subdir === undefined ? folders : [subdir];
    const ids: string[] = [];
    for (const folder of chosen) {
      const name = await readFile(path.join(clone, folder, "package.json"), "utf8").then((text) => (JSON.parse(text) as { name?: unknown }).name, () => null);
      const pluginId = typeof name === "string" ? pluginIdForPackageName(name) : "";
      if (pluginId !== "" && pluginId !== bb.pluginId) ids.push(pluginId);
    }
    const same = (item: Record<string, unknown>) => {
      try {
        return repoKey(parseRepo(String(item.repo ?? ""))) === repoKey(repo);
      } catch {
        return false;
      }
    };
    let replaced = 0;
    const commit = await editPackagesJson((document) => {
      let next: Record<string, unknown> = { ...document };
      const follow = entries(document, "follow");
      const existing = follow.find(same);
      if (existing === undefined) {
        follow.push({ repo: repoDisplay(repo), ...(ref ? { ref } : {}), ...(subdir !== undefined ? { include: [subdir] } : {}) });
      } else if (subdir === undefined) {
        delete existing.include;
        delete existing.exclude;
      } else if (Array.isArray(existing.include)) {
        existing.include = [...new Set([...(existing.include as string[]), subdir])];
      } else if (Array.isArray(existing.exclude)) {
        existing.exclude = (existing.exclude as string[]).filter((folder) => folder !== subdir);
      }
      next.follow = follow;
      for (const key of ["remote", "plugins"] as const) {
        if (!Array.isArray(document[key])) continue;
        const list = entries(document, key);
        replaced += list.filter(same).length;
        next[key] = list.filter((item) => !same(item));
      }
      for (const id of ids) next = withoutUninstall(next, id);
      return next;
    }, `Follow ${repoDisplay(repo)}${subdir !== undefined ? ` (${subdir})` : ""}: ${chosen.join(", ")}`, groupId);
    bb.log.info(`following ${repoDisplay(repo)}: ${chosen.join(", ")} (${commit ?? "no change"})`);
    return {
      folder: `${repoDisplay(repo)} (followed): ${chosen.join(", ")}`,
      pluginId: ids.join(", "),
      commit,
      warning: replaced > 0 ? `It replaces ${replaced} remote entr${replaced === 1 ? "y" : "ies"} for the same repository.` : null,
      unchanged: commit === null,
      kind: "followed" as "remote" | "followed",
    };
  }

  /** Stop pointing to a remote plugin (machines keep it installed). */
  async function removeRemotePlugin(text: string, pathFilter?: string, groupId?: string) {
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
        // A followed repository: a folder leaves it (exclude / include), or the whole follow goes.
        if (Array.isArray(document.follow)) {
          const follow: Record<string, unknown>[] = [];
          for (const item of entries(document, "follow")) {
            let sameRepo = false;
            try {
              sameRepo = repoKey(parseRepo(String(item.repo ?? ""))) === repoKey(parsed.repo);
            } catch {
              sameRepo = false;
            }
            if (!sameRepo) {
              follow.push(item);
            } else if (folder === "") {
              removed.push(`${String(item.repo)} (followed)`);
            } else {
              removed.push(`${String(item.repo)}/${folder} (followed)`);
              if (Array.isArray(item.include)) {
                const include = (item.include as string[]).filter((entry) => entry.replace(/^\/+|\/+$/gu, "") !== folder);
                if (include.length > 0) follow.push({ ...item, include });
              } else {
                follow.push({ ...item, exclude: [...new Set([...((item.exclude as string[] | undefined) ?? []), folder])] });
              }
            }
          }
          next.follow = follow;
        }
        if (removed.length === 0) throw new Error(`${text} is not a remote plugin.`);
        return next;
      }, `Remove remote plugin ${repoDisplay(parsed.repo)}${folder ? `/${folder}` : ""}`, groupId);
      return { removed, commit };
    });
    bb.realtime.publish(HUB_CHANGED, { removed: outcome.removed });
    return { ...outcome, guaranteedBy: scheduleView(null).guaranteedBy };
  }

  async function addPlugin(
    source: AddSource,
    options: { name?: string; subdir?: string; force?: boolean; group?: string },
  ) {
    if (source.kind === "text" && (await isRepoSource(source.source, source.cwd))) {
      return addRemotePlugin(source.source, { subdir: options.subdir, group: options.group });
    }
    const result = await serialize(async () => {
      const { packagesRepo, hubPath } = await readConfig();
      const group = await findGroup(options.group);
      const pluginsDir = inGroup(group, PLUGINS_FOLDER);
      const scratch = await scratchDir();
      try {
        const { dir: base, description } = await materialize(source, scratch);
        const pluginDir = await findPluginDir(base, options.subdir);
        const { pluginId, warning } = await checkManifest(pluginDir);
        const folderName = (options.name?.trim() || pluginId).toLowerCase();
        if (!FOLDER_NAME_PATTERN.test(folderName)) throw new Error(`Folder name "${folderName}" must use lowercase letters, digits, ".", "_", "-".`);
        const folder = `${pluginsDir}/${folderName}`;
        if (folder === hubPath || pluginId === bb.pluginId) throw new Error("That is the hub itself; push changes to it directly.");

        const work = await workingClone(packagesRepo);
        const dest = path.join(work, pluginsDir, folderName);
        // Within one group, two folders can't share a plugin id. (Across groups
        // they can: the newest version wins.)
        for (const entry of await readdir(path.join(work, pluginsDir), { withFileTypes: true }).catch(() => [])) {
          if (!entry.isDirectory() || entry.name === folderName) continue;
          const other = await readFile(path.join(work, pluginsDir, entry.name, "package.json"), "utf8")
            .then((text) => pluginIdForPackageName((JSON.parse(text) as { name?: string }).name ?? ""), () => null);
          if (other === pluginId) throw new Error(`Plugin id "${pluginId}" is already used by ${pluginsDir}/${entry.name}.`);
        }
        if (await access(dest).then(() => true, () => false)) {
          if (!options.force) throw new Error(`${folder} already exists (use force to replace it).`);
          await rm(dest, { recursive: true, force: true });
        }
        await copyPlugin(pluginDir, dest);
        if (!(await access(path.join(dest, ".gitignore")).then(() => true, () => false))) {
          await writeFile(path.join(dest, ".gitignore"), "node_modules/\ndist/\n");
        }
        const packagesRelative = inGroup(group, "packages.json");
        const packagesFile = path.join(work, packagesRelative);
        const packagesDoc = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(packagesFile, "utf8")));
        const cleaned = withoutUninstall(packagesDoc, pluginId);
        if (cleaned !== packagesDoc) await writeFile(packagesFile, `${JSON.stringify(cleaned, null, 2)}\n`);
        const commit = await commitAndPush(work, [folder, packagesRelative], `${group.id === HOME_GROUP ? "" : `${group.name}: `}Add plugin ${folderName} (from ${description})`, packagesRepo);
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
        // Don't wait for the sync: a sync can't be cancelled, and the service
        // must stop promptly when the hub reloads (e.g. for a self-update).
        syncInBackground("schedule");
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
    hub_list: async (input, context) => {
      clientOnly(context, "hub_list");
      const lastSync = (await bb.storage.kv.get<SyncReport>(LAST_SYNC_KEY)) ?? null;
      const self = (await bb.sdk.plugins.list()).plugins.find((plugin) => plugin.id === bb.pluginId);
      return { ...(await listHub(input?.group)), lastSync, schedule: scheduleView(lastSync), hubVersion: self?.version ?? null };
    },
    hub_status: (_input, context) => {
      clientOnly(context, "hub_status");
      return { syncing };
    },
    hub_move: ({ kind, ref, path: folder, from, to }, context) => {
      clientOnly(context, "hub_move");
      return movePlugin(kind, ref, from, to, { path: folder });
    },
    hub_group_subscribe: ({ group, subscribed }, context) => {
      clientOnly(context, "hub_group_subscribe");
      return setSubscribed(group, subscribed);
    },
    hub_publish: ({ dir, group, beta }, context) => {
      clientOnly(context, "hub_publish");
      return publishPlugin(dir, { group, beta });
    },
    hub_promote: ({ plugin, group }, context) => {
      clientOnly(context, "hub_promote");
      return promoteBeta(plugin, group);
    },
    hub_beta: ({ pluginId, joined, resetData }, context) => {
      clientOnly(context, "hub_beta");
      return setBeta(pluginId, joined, resetData);
    },
    hub_group_add: ({ name, id }, context) => {
      clientOnly(context, "hub_group_add");
      return addGroup(name, id);
    },
    hub_group_rename: ({ group, name }, context) => {
      clientOnly(context, "hub_group_rename");
      return renameGroup(group, name);
    },
    hub_group_remove: ({ group }, context) => {
      clientOnly(context, "hub_group_remove");
      return removeGroup(group);
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
    hub_marketplace_add: ({ entry, group }, context) => {
      clientOnly(context, "hub_marketplace_add");
      return addMarketplacePlugin(entry, group);
    },
    hub_marketplace_remove: ({ entry, group }, context) => {
      clientOnly(context, "hub_marketplace_remove");
      return removeMarketplacePlugin(entry, group);
    },
    hub_local_delete: ({ path: folder, group }, context) => {
      clientOnly(context, "hub_local_delete");
      return deleteLocalPlugin(folder, group);
    },
    hub_remote_remove: ({ repo, path: folder, group }, context) => {
      clientOnly(context, "hub_remote_remove");
      return removeRemotePlugin(repo, folder, group);
    },
    hub_add_plugin: (input, context) => {
      clientOnly(context, "hub_add_plugin");
      const source: AddSource =
        input.files !== undefined
          ? { kind: "files", files: input.files }
          : input.archive !== undefined
            ? { kind: "archive", name: input.archive.name, data: input.archive.data }
            : { kind: "text", source: input.source ?? "" };
      return addPlugin(source, { name: input.name, subdir: input.subdir, force: input.force, group: input.group });
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
  const groupOption = {
    group: { type: "string", placeholder: "id", description: "The group to change (default: home). `bb hub group` lists them." },
  } as const;
  const folderPositional = [
    { name: "folder", description: 'A plugin folder in the packages repository: "hello" or "plugins/hello"', required: true },
  ] as const;

  bb.cli.register(
    defineCli({
      name: "hub",
      summary: "Keep the bb plugins in the shared public repository installed and up to date",
      commands: {
        list: cliCommand({
          summary: "List a group's plugin folders, with install and package status",
          options: { ...groupOption, ...jsonOption },
          async run({ options }) {
            const hub = await listHub(options.group).catch((cause) => { throw toCliError(cause); });
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
          summary: "Show what this machine installs from each subscribed group (or one group with --group)",
          options: { group: { type: "string", placeholder: "id", description: "Only this group" }, ...jsonOption },
          async run({ options }) {
            const views = await serialize(async () => {
              fetchedThisRound.clear();
              const groups = options.group ? [await findGroup(options.group)] : await subscribedGroups();
              const out = [];
              for (const group of groups) {
                const packages = await loadPackages(group.id);
                out.push({
                  group: group.id,
                  name: group.name,
                  from: packages.from,
                  local: packages.specs.filter((spec) => isLocal(spec, packages.packagesRepo)).map((spec) => labelFor(spec, packages.packagesRepo)),
                  remote: packages.specs.filter((spec) => !isLocal(spec, packages.packagesRepo)).map((spec) => labelFor(spec, packages.packagesRepo)),
                  marketplace: packages.marketplace.map((entry) => `${entry.id}${entry.marketplace ? `@${entry.marketplace}` : ""}`),
                  errors: packages.errors,
                });
              }
              return out;
            }).catch((cause) => { throw toCliError(cause); });
            const section = (title: string, items: string[]) => [`  ${title}:`, ...(items.length === 0 ? ["    (none)"] : items.map((item) => `    ${item}`))];
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(views)
                : views
                    .flatMap((view) => [
                      `${view.name} (${view.group}) — ${view.from}`,
                      ...section("Local plugins", view.local),
                      ...section("Remote plugins", view.remote),
                      ...section("Marketplace plugins", view.marketplace),
                      ...view.errors.map((error) => `  ${error}`),
                    ])
                    .join("\n"),
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
        group: cliCommand({
          summary: "List the groups in the shared repository and which ones this machine subscribes to",
          options: jsonOption,
          async run({ options }) {
            const { subscribed } = await readConfig();
            const groups = (await listGroups().catch((cause) => { throw toCliError(cause); })).map((group) => ({
              ...group,
              subscribed: group.id === HOME_GROUP || subscribed.includes(group.id),
            }));
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(groups) };
            return {
              exitCode: 0,
              stdout: groups
                .map((group) => `${group.subscribed ? "[subscribed]" : "[         ]"}  ${group.id}${group.id === HOME_GROUP ? " (always)" : ""} — ${group.name}  ${group.path || "(repository root)"}`)
                .join("\n"),
            };
          },
        }),
        "group subscribe": cliCommand({
          summary: "Subscribe this machine to a group: it installs and updates the group's plugins",
          positionals: [{ name: "group", description: "The group id (see `bb hub group`)", required: true }],
          async run({ positionals }) {
            const result = await setSubscribed(positionals.group, true).catch((cause) => { throw toCliError(cause); });
            const report = await requestSync("group subscribed");
            const installed = report.results.filter((entry) => entry.outcome === "installed").map((entry) => entry.repo);
            return {
              exitCode: 0,
              stdout: `Subscribed to ${result.name} (${result.group}).${installed.length > 0 ? ` Installed: ${installed.join(", ")}.` : ""}`,
            };
          },
        }),
        "group unsubscribe": cliCommand({
          summary: "Unsubscribe this machine from a group (its plugins stay installed but stop updating)",
          positionals: [{ name: "group", description: "The group id", required: true }],
          async run({ positionals }) {
            const result = await setSubscribed(positionals.group, false).catch((cause) => { throw toCliError(cause); });
            return {
              exitCode: 0,
              stdout: `Unsubscribed from ${result.name} (${result.group}). Its plugins stay installed but stop updating; remove them with \`bb plugin remove <id>\` if you don't want them.`,
            };
          },
        }),
        "plugin publish": cliCommand({
          summary: "Publish a plugin you develop in your own folder to everyone in a group (or, with --beta, to its beta testers)",
          description:
            "Copies the folder into the group's plugins/<name> (or beta/<name> with --beta) and pushes, like `plugin add --force`, but refuses unless package.json's version is newer than the published copy (and, for a beta, than the stable copy), and lists what changed. Your own machine keeps running your folder.",
          positionals: [{ name: "folder", description: "Your plugin folder, e.g. ~/code/my-plugin or .", required: true }],
          options: {
            beta: { type: "boolean", description: "Publish to the group's beta copy instead of the stable one" },
            ...groupOption,
            ...jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const published = await publishPlugin(path.resolve(ctx.cwd ?? process.cwd(), positionals.folder), { group: options.group, beta: options.beta }).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(published) };
            return {
              exitCode: published.sync?.outcome === "failed" ? 1 : 0,
              stdout: [
                published.commit === null
                  ? `${published.folder} is unchanged; nothing to publish.`
                  : `Published ${published.pluginId} ${published.from === null ? "" : `${published.from} → `}${published.to}${published.beta ? " (beta)" : ""} to ${published.folder}, commit ${published.commit}.`,
                ...published.changes.map((line) => `  ${line}`),
                `Every running hub ${published.beta ? "that joined the beta " : ""}has it by ${formatTime(published.guaranteedBy)}.`,
              ].join("\n"),
            };
          },
        }),
        "plugin promote": cliCommand({
          summary: "Make a group's beta copy of a plugin its stable copy (everyone gets it; beta testers keep their data)",
          positionals: [{ name: "plugin", description: "The plugin id or its beta folder name", required: true }],
          options: { ...groupOption, ...jsonOption },
          async run({ positionals, options }) {
            const promoted = await promoteBeta(positionals.plugin, options.group).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(promoted) };
            return {
              exitCode: 0,
              stdout: `Promoted ${promoted.pluginId} ${promoted.version ?? ""} from ${promoted.from} to ${promoted.to}${promoted.commit ? `, commit ${promoted.commit}` : ""}. Every running hub has it by ${formatTime(promoted.guaranteedBy)}.`,
            };
          },
        }),
        beta: cliCommand({
          summary: "List the beta copies in your subscribed groups and which ones this machine runs",
          options: jsonOption,
          async run({ options }) {
            const views = await serialize(async () => {
              fetchedThisRound.clear();
              const installed = (await bb.sdk.plugins.list()).plugins;
              const out: (BetaView & { group: string })[] = [];
              for (const group of await subscribedGroups()) {
                const packages = await loadPackages(group.id);
                out.push(...(await betaAndDevViews(packages, installed)).betas.map((view) => ({ ...view, group: group.name })));
              }
              return out;
            }).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(views) };
            return {
              exitCode: 0,
              stdout: views.length === 0
                ? "No beta copies in your groups. Publish one with `bb hub plugin publish <folder> --beta`."
                : views
                    .map((view) => `${view.joined ? "[joined]" : "[      ]"}  ${view.pluginId} beta ${view.version ?? "?"} (stable ${view.stableVersion ?? "none"}) — ${view.group}${view.running ? ", running here" : ""}${view.needsReset && !view.running ? ", joining resets its data once" : ""}`)
                    .join("\n"),
            };
          },
        }),
        "beta join": cliCommand({
          summary: "Run a plugin's beta copy on this machine (switching keeps its settings and data)",
          positionals: [{ name: "plugin", description: "The plugin id", required: true }],
          options: {
            "reset-data": { type: "boolean", description: "Allow the one-time reinstall a plugin installed before betas existed needs (resets its settings and data)" },
          },
          async run({ positionals, options }) {
            const result = await setBeta(positionals.plugin, true, options["reset-data"] === true).catch((cause) => { throw toCliError(cause); });
            return { exitCode: 0, stdout: `Joined the beta of ${result.pluginId}; the hub switches it now. Check with \`bb hub beta\`.` };
          },
        }),
        "beta leave": cliCommand({
          summary: "Go back to a plugin's stable copy on this machine (keeps its settings and data)",
          positionals: [{ name: "plugin", description: "The plugin id", required: true }],
          async run({ positionals }) {
            const result = await setBeta(positionals.plugin, false).catch((cause) => { throw toCliError(cause); });
            return { exitCode: 0, stdout: `Left the beta of ${result.pluginId}; the hub switches it back to the stable copy now.` };
          },
        }),
        "group add": cliCommand({
          summary: "Add an empty group to the shared repository (commits and pushes)",
          description: "Creates groups/<id> with its packages.json and lists it in the root packages.json. The id comes from the name unless --id is given; it never changes afterwards.",
          positionals: [{ name: "name", description: 'The display name, e.g. "Lean Software Designers"', required: true, variadic: true }],
          options: { id: { type: "string", placeholder: "id", description: "The group id (lowercase letters, digits, dashes); default: from the name" }, ...jsonOption },
          async run({ positionals, options }) {
            const added = await addGroup(positionals.name.join(" "), options.id).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(added) };
            return {
              exitCode: 0,
              stdout: `Added group ${added.name} (${added.id}) in ${added.path}${added.commit ? `, commit ${added.commit}` : ""}. Subscribe a machine with \`bb hub group subscribe ${added.id}\`.`,
            };
          },
        }),
        "group rename": cliCommand({
          summary: "Rename a group (its display name; the id and folder stay, so subscriptions keep working)",
          positionals: [
            { name: "group", description: "The group id (see `bb hub group`)", required: true },
            { name: "name", description: "The new display name", required: true, variadic: true },
          ],
          options: jsonOption,
          async run({ positionals, options }) {
            const renamed = await renameGroup(positionals.group, positionals.name.join(" ")).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(renamed) };
            return {
              exitCode: 0,
              stdout: renamed.commit === null ? `${renamed.id} is already called ${renamed.name}.` : `Renamed ${renamed.from} to ${renamed.name} (${renamed.id}), commit ${renamed.commit}.`,
            };
          },
        }),
        "group remove": cliCommand({
          summary: "Remove an empty group from the shared repository (move or delete its plugins first)",
          positionals: [{ name: "group", description: "The group id", required: true }],
          options: jsonOption,
          async run({ positionals, options }) {
            const removed = await removeGroup(positionals.group).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(removed) };
            return {
              exitCode: 0,
              stdout: `Removed group ${removed.name} (${removed.id})${removed.commit ? `, commit ${removed.commit}` : ""}. Subscribed hubs drop it by ${formatTime(removed.guaranteedBy)}.`,
            };
          },
        }),
        marketplace: cliCommand({
          summary: "Show a group's marketplace plugins (packages.json \"marketplace\")",
          options: { ...groupOption, ...jsonOption },
          async run({ options }) {
            const packages = await serialize(async () => {
              fetchedThisRound.clear();
              return loadPackages(options.group);
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
          options: { ...groupOption, ...jsonOption },
          async run({ positionals, options }) {
            const added = await addMarketplacePlugin(positionals.entry, options.group).catch((cause) => { throw toCliError(cause); });
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
          options: { ...groupOption, ...jsonOption },
          async run({ positionals, options }) {
            const removed = await removeMarketplacePlugin(positionals.entry, options.group).catch((cause) => { throw toCliError(cause); });
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
        "plugin move": cliCommand({
          summary: "Move a local or remote plugin to another group; nothing is reinstalled and no data is lost",
          positionals: [{ name: "plugin", description: 'A local folder ("hello" or "groups/x/plugins/hello") or a remote plugin\'s repo (owner/name or URL)', required: true }],
          options: {
            to: { type: "string", placeholder: "group", required: true, description: "The group to move it to" },
            from: { type: "string", placeholder: "group", description: "The group it is in now (default: home; a full folder path says it)" },
            path: { type: "string", placeholder: "folder", description: "For a remote plugin: only the entry for this folder in its repo" },
            ...jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const local = !(await isRepoSource(positionals.plugin, ctx.cwd));
            const moved = await movePlugin(local ? "local" : "remote", positionals.plugin, options.from, options.to, { path: options.path }).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(moved) };
            return {
              exitCode: 0,
              stdout: [
                `Moved ${moved.kind} plugin ${moved.label} from ${moved.from} to ${moved.to}${moved.commit ? ` (commit ${moved.commit})` : ""}.`,
                `Every running hub picks it up by ${formatTime(moved.guaranteedBy)}.`,
              ].join("\n"),
            };
          },
        }),
        "marketplace move": cliCommand({
          summary: "Move a marketplace plugin's entry to another group (nothing is reinstalled)",
          positionals: [{ name: "entry", description: "<id> or <id>@<marketplace>", required: true }],
          options: {
            to: { type: "string", placeholder: "group", required: true, description: "The group to move it to" },
            from: { type: "string", placeholder: "group", description: "The group it is in now (default: home)" },
            ...jsonOption,
          },
          async run({ positionals, options }) {
            const moved = await movePlugin("marketplace", positionals.entry, options.from, options.to).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(moved) };
            return {
              exitCode: 0,
              stdout: `Moved ${moved.label} from ${moved.from} to ${moved.to}${moved.commit ? ` (commit ${moved.commit})` : ""}. Every running hub picks it up by ${formatTime(moved.guaranteedBy)}.`,
            };
          },
        }),
        "plugin delete": cliCommand({
          summary: "Delete a local plugin from the shared repository and uninstall it on every hub (its data is lost everywhere)",
          positionals: [{ name: "folder", description: 'The local plugin: "hello" or "plugins/hello"', required: true }],
          options: {
            yes: { type: "boolean", description: "Confirm: every member loses this plugin and all its data and settings" },
            ...groupOption,
            ...jsonOption,
          },
          async run({ positionals, options }) {
            if (!options.yes) {
              throw new PluginCliError(
                `Deleting ${positionals.folder} removes it from the shared repository and uninstalls it from every member's bb at the next sync. All of its data and settings will be lost on every machine. Re-run with --yes to confirm.`,
              );
            }
            const deleted = await deleteLocalPlugin(positionals.folder, options.group).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(deleted) };
            return {
              exitCode: 0,
              stdout: [
                `Deleted ${deleted.folder} (plugin id ${deleted.pluginId})${deleted.commit ? ` in commit ${deleted.commit}` : ""}.`,
                deleted.removedHere ? "Uninstalled on this machine." : "It wasn't installed from the shared repository on this machine.",
                `Every running hub uninstalls it by ${formatTime(deleted.guaranteedBy)}.`,
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
            ...groupOption,
            ...jsonOption,
          },
          async run({ positionals, options }) {
            const removed = await removeRemotePlugin(positionals.repo, options.path, options.group).catch((cause) => { throw toCliError(cause); });
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
            ...groupOption,
            ...jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const added = await addPlugin(
              { kind: "text", source: positionals.source, cwd: ctx.cwd },
              { name: options.name, subdir: options.subdir, force: options.force, group: options.group },
            ).catch((cause) => { throw toCliError(cause); });
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(added) };
            return {
              exitCode: added.sync?.outcome === "failed" ? 1 : 0,
              stdout: [
                added.unchanged
                  ? `${added.folder} is unchanged; nothing to commit.`
                  : added.kind === "followed"
                    ? `Following ${added.folder}; every hub builds them from a checkout of the repository (sibling packages included). Pushed commit ${added.commit}.`
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
