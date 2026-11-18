#!/usr/bin/env node
// Build a marketplace.json (a bb plugin marketplace) for every group in this
// repository: the home group (repository root) and each group listed in the
// root packages.json "groups", in its own folder. Each lists the group's local
// plugin folders (its "include", minus "exclude") and its remote plugins on
// GitHub. bb lists them under Settings → Plugin marketplaces (the hub adds the
// ones a machine subscribes to).
//
//   node scripts/build-marketplace.mjs          write every marketplace.json
//   node scripts/build-marketplace.mjs --check  exit 1 if any is out of date
//
// Runs on every push through .github/workflows/marketplace.yml, so it stays in
// sync however plugins are added. Needs only node and git; no dependencies.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MARKETPLACE_NAME = "bb-plugins";
const HOST_ICON = /^[A-Za-z][A-Za-z0-9]*$/u;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/u;
const ID = /^[a-z0-9][a-z0-9-]*$/u;

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** bb's rule: final package-name component minus `bb-plugin-`, slugified. */
function pluginId(packageName) {
  const last = packageName.slice(packageName.lastIndexOf("/") + 1);
  return (last.startsWith("bb-plugin-") ? last.slice(10) : last).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/** "owner/name" from this checkout's origin (GitHub). */
function thisRepo() {
  const url = git("remote", "get-url", "origin");
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/u);
  if (!match) throw new Error(`origin ${url} is not a GitHub repository`);
  return { owner: match[1], name: match[2] };
}

/** The default branch of a public repository, e.g. "main". */
function defaultBranch(url) {
  const out = execFileSync("git", ["ls-remote", "--symref", url, "HEAD"], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const match = out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/mu);
  if (!match) throw new Error(`could not find the default branch of ${url}`);
  return match[1];
}

function entryFor(manifest, { url, subdir, ref, owner, iconBase }) {
  const id = pluginId(manifest.name);
  if (!ID.test(id)) return null;
  const branding = manifest.bb?.branding ?? {};
  let icon = "Package";
  if (typeof branding.icon === "string" && HOST_ICON.test(branding.icon)) icon = branding.icon;
  else if (typeof branding.icon === "string" && branding.icon.startsWith("./") && branding.icon.endsWith(".svg") && iconBase) {
    icon = { url: `${iconBase}/${branding.icon.slice(2)}` };
  }
  const author = { name: owner, ...(GITHUB_LOGIN.test(owner) ? { github: owner } : {}) };
  return {
    id,
    displayName: manifest.bb?.name || id,
    description: manifest.bb?.description || manifest.description || `The ${id} plugin.`,
    icon,
    author,
    source: { git: { url, ...(subdir ? { subdir } : {}), ref } },
  };
}

const repo = thisRepo();
const repoUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
const branch = process.env.MARKETPLACE_REF || defaultBranch(repoUrl);
const rootPackages = readJson(path.join(ROOT, "packages.json"));

// The home group is the repository root; the others are listed in the root
// packages.json "groups". Each gets its own marketplace.json in its folder.
const groups = [
  { id: "home", name: rootPackages.name ?? "Home", path: "", marketplaceName: MARKETPLACE_NAME },
  ...(rootPackages.groups ?? []).map((group) => ({
    id: group.id,
    name: group.name ?? group.id,
    path: group.path.replace(/^\/+|\/+$/gu, ""),
    marketplaceName: `${MARKETPLACE_NAME}-${group.id}`,
  })),
];

async function buildGroup(group) {
  const at = (file) => (group.path ? `${group.path}/${file}` : file);
  const packagesFile = path.join(ROOT, at("packages.json"));
  if (!existsSync(packagesFile)) {
    console.warn(`skipped group ${group.id}: ${at("packages.json")} doesn't exist`);
    return null;
  }
  const packages = readJson(packagesFile);
  const exclude = new Set((packages.exclude ?? []).map((entry) => at(entry.replace(/\/+$/u, ""))));
  const plugins = [];
  const seen = new Set();
  const add = (entry, where) => {
    if (entry === null) return console.warn(`[${group.id}] skipped ${where}: invalid plugin id`);
    if (seen.has(entry.id)) return console.warn(`[${group.id}] skipped ${where}: plugin id "${entry.id}" is already listed`);
    seen.add(entry.id);
    plugins.push(entry);
  };

  // Local plugins: folders of this group (the hub included in the home group,
  // so it can be installed from Settings too).
  for (const pattern of packages.include ?? []) {
    if (!pattern.endsWith("/*")) continue;
    const parent = at(pattern.slice(0, -2).replace(/\/+$/u, ""));
    const dir = path.join(ROOT, parent);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const folder = `${parent}/${name}`;
      const manifestFile = path.join(ROOT, folder, "package.json");
      if (exclude.has(folder) || !existsSync(manifestFile)) continue;
      const manifest = readJson(manifestFile);
      if (typeof manifest.bb !== "object" || manifest.bb === null) continue;
      // subdir is relative to the repository root; icons to this marketplace.json.
      const iconBase = `./${group.path ? path.posix.relative(group.path, folder) : folder}`;
      add(entryFor(manifest, { url: repoUrl, subdir: folder, ref: branch, owner: repo.owner, iconBase }), folder);
    }
  }

  // Local plugins moved here from another group: their folder stays where it
  // is ("local" entries, paths from the repository root).
  for (const entry of packages.local ?? []) {
    const folder = String(entry.path ?? "").replace(/^\/+|\/+$/gu, "");
    const manifestFile = path.join(ROOT, folder, "package.json");
    if (!folder || !existsSync(manifestFile)) {
      console.warn(`[${group.id}] skipped local ${folder}: no package.json`);
      continue;
    }
    const manifest = readJson(manifestFile);
    if (typeof manifest.bb !== "object" || manifest.bb === null) continue;
    const relative = path.posix.relative(group.path || ".", folder);
    add(entryFor(manifest, { url: repoUrl, subdir: folder, ref: branch, owner: repo.owner, iconBase: relative.startsWith("..") ? null : `./${relative}` }), folder);
  }

  // Remote plugins on GitHub: read their package.json from the repository.
  for (const remote of [...(packages.remote ?? []), ...(packages.plugins ?? [])]) {
    const match = String(remote.repo ?? "").match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/u);
    if (!match) {
      console.warn(`[${group.id}] skipped remote ${remote.repo}: only GitHub repositories are listed in the marketplace`);
      continue;
    }
    const [, owner, name] = match;
    const url = `https://github.com/${owner}/${name}.git`;
    const subdir = (remote.path ?? "").replace(/^\/+|\/+$/gu, "");
    try {
      const ref = remote.ref && !String(remote.ref).includes(":") ? remote.ref : defaultBranch(url);
      const raw = `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${subdir ? `${subdir}/` : ""}package.json`;
      const response = await fetch(raw);
      if (!response.ok) throw new Error(`${raw} returned ${response.status}`);
      add(entryFor(await response.json(), { url, subdir, ref, owner, iconBase: null }), `${owner}/${name}${subdir ? `/${subdir}` : ""}`);
    } catch (error) {
      console.warn(`[${group.id}] skipped remote ${owner}/${name}: ${error.message}`);
    }
  }

  const marketplace = {
    $schema: "https://getbb.app/schemas/marketplace.schema.json",
    schemaVersion: 1,
    name: group.marketplaceName,
    displayName: `${group.id === "home" ? "Team plugins" : group.name} (${repo.owner}/${repo.name})`,
    description: `${group.id === "home" ? "The shared" : `The ${group.name}`} bb plugins from github.com/${repo.owner}/${repo.name}${group.path ? `/${group.path}` : ""}. Generated by scripts/build-marketplace.mjs; don't edit by hand.`,
    plugins,
  };
  return { file: path.join(ROOT, at("marketplace.json")), relative: at("marketplace.json"), text: `${JSON.stringify(marketplace, null, 2)}\n`, plugins };
}

let outdated = false;
for (const group of groups) {
  const built = await buildGroup(group);
  if (built === null) continue;
  const current = existsSync(built.file) ? readFileSync(built.file, "utf8") : "";
  if (current === built.text) {
    console.log(`${built.relative} is up to date (${built.plugins.length} plugin(s))`);
    continue;
  }
  if (process.argv.includes("--check")) {
    console.error(`${built.relative} is out of date; run node scripts/build-marketplace.mjs`);
    outdated = true;
    continue;
  }
  writeFileSync(built.file, built.text);
  console.log(`wrote ${built.relative} with ${built.plugins.length} plugin(s): ${built.plugins.map((entry) => entry.id).join(", ") || "(none)"}`);
}
if (outdated) process.exit(1);
