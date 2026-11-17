#!/usr/bin/env node
// Build marketplace.json (a bb plugin marketplace) from this repository:
// every local plugin folder (packages.json "include", minus "exclude") and
// every remote plugin on GitHub. bb lists it under Settings → Plugin
// marketplaces once added (the hub adds it on every member's machine).
//
//   node scripts/build-marketplace.mjs          write marketplace.json
//   node scripts/build-marketplace.mjs --check  exit 1 if it is out of date
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

const packages = readJson(path.join(ROOT, "packages.json"));
const repo = thisRepo();
const repoUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
const branch = process.env.MARKETPLACE_REF || defaultBranch(repoUrl);
const exclude = new Set((packages.exclude ?? []).map((entry) => entry.replace(/\/+$/u, "")));
const plugins = [];
const seen = new Set();
const add = (entry, where) => {
  if (entry === null) return console.warn(`skipped ${where}: invalid plugin id`);
  if (seen.has(entry.id)) return console.warn(`skipped ${where}: plugin id "${entry.id}" is already listed`);
  seen.add(entry.id);
  plugins.push(entry);
};

// Local plugins: folders in this repository (the hub included, so it can be
// installed from Settings too).
for (const pattern of packages.include ?? []) {
  if (!pattern.endsWith("/*")) continue;
  const parent = pattern.slice(0, -2).replace(/\/+$/u, "");
  const dir = path.join(ROOT, parent);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir).sort()) {
    const folder = `${parent}/${name}`;
    const manifestFile = path.join(ROOT, folder, "package.json");
    if (exclude.has(folder) || !existsSync(manifestFile)) continue;
    const manifest = readJson(manifestFile);
    if (typeof manifest.bb !== "object" || manifest.bb === null) continue;
    add(entryFor(manifest, { url: repoUrl, subdir: folder, ref: branch, owner: repo.owner, iconBase: `./${folder}` }), folder);
  }
}

// Remote plugins on GitHub: read their package.json from the repository.
for (const remote of [...(packages.remote ?? []), ...(packages.plugins ?? [])]) {
  const match = String(remote.repo ?? "").match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/u);
  if (!match) {
    console.warn(`skipped remote ${remote.repo}: only GitHub repositories are listed in the marketplace`);
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
    console.warn(`skipped remote ${owner}/${name}: ${error.message}`);
  }
}

const marketplace = {
  $schema: "https://getbb.app/schemas/marketplace.schema.json",
  schemaVersion: 1,
  name: MARKETPLACE_NAME,
  displayName: `Team plugins (${repo.owner}/${repo.name})`,
  description: `The shared bb plugins from github.com/${repo.owner}/${repo.name}. Generated from packages.json by scripts/build-marketplace.mjs; don't edit by hand.`,
  plugins,
};
const text = `${JSON.stringify(marketplace, null, 2)}\n`;
const file = path.join(ROOT, "marketplace.json");
const current = existsSync(file) ? readFileSync(file, "utf8") : "";
if (process.argv.includes("--check")) {
  if (current !== text) {
    console.error("marketplace.json is out of date; run node scripts/build-marketplace.mjs");
    process.exit(1);
  }
  console.log("marketplace.json is up to date");
} else if (current !== text) {
  writeFileSync(file, text);
  console.log(`wrote marketplace.json with ${plugins.length} plugin(s): ${plugins.map((entry) => entry.id).join(", ")}`);
} else {
  console.log("marketplace.json is already up to date");
}
