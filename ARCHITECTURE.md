# Architecture

How the shared plugin repository, the **hub** plugin, and bb fit together.
Everything is public and token-free: hubs read anonymously, and the only
writes are pushes made with a member's own git login.

## Overview

```mermaid
flowchart LR
  subgraph GitHub["GitHub (public)"]
    Repo["Timmmmmmer/bb-plugins<br/>packages.json, plugins/, groups/*/"]
    Action["GitHub Action<br/>scripts/build-marketplace.mjs"]
    Remote["Other public repos<br/>remote and followed plugins"]
  end
  Catalog["bb marketplaces<br/>bb-community, bb-official"]

  subgraph Machine["Each member's machine (bb server)"]
    subgraph Hub["Hub plugin"]
      Sync["Sync loop<br/>every 15 min, UTC-aligned"]
      Edit["Edits<br/>add, move, delete, publish, groups"]
      UI["Plugin hub page<br/>+ sidebar footer Publish panel"]
      CLI["bb hub CLI"]
    end
    Disk["Hub folders<br/>mirrors/ (read-only clones)<br/>work/ (clone for edits)<br/>follow/ (checkouts that bb installs from)<br/>tools/ (bun when needed)"]
    BB["bb plugin manager<br/>install, build, update, reload"]
    Plugins["Installed plugins"]
  end

  Repo -- "anonymous fetch" --> Sync
  Remote -- "anonymous fetch" --> Sync
  Sync --> Disk
  Sync -- "install / update / move" --> BB
  Catalog --> BB
  BB --> Plugins
  UI --> Edit
  CLI --> Edit
  Edit -- "push with the machine's git login" --> Repo
  Repo -- "on every push" --> Action
  Action -- "commits marketplace.json" --> Repo
  Repo -. "marketplace.json registered in Settings" .-> BB
```

## The repository

```mermaid
flowchart TB
  Root["packages.json (Home group)<br/>groups, include/exclude, local, remote,<br/>follow, marketplace, uninstall, syncIntervalMinutes"]
  Root --> HomePlugins["plugins/*<br/>stable copies"]
  Root --> HomeBeta["beta/*<br/>beta copies"]
  Root --> Hub["plugins/hub<br/>the hub itself"]
  Root --> G1["groups/&lt;id&gt;/packages.json"]
  G1 --> G1Plugins["groups/&lt;id&gt;/plugins/*"]
  G1 --> G1Beta["groups/&lt;id&gt;/beta/*"]
  Root --> MP["marketplace.json per group<br/>generated, never hand-edited"]
```

Each group lists what its subscribers install:

| Kind | Where it lives | How bb installs it |
|---|---|---|
| **Local** | A folder in this repo (`plugins/<name>`, or `local` for one owned by reference) | Path install from the hub's checkout of this repo |
| **Beta** | `beta/<name>` in a group | Same, only on machines that joined that plugin's beta |
| **Remote** | Another public repo (`remote`) | bb's own git install (`git:<url>[@ref]`) |
| **Followed** | Every plugin folder in another public repo (`follow`) | Path install from the hub's checkout, after installing workspace dependencies |
| **Marketplace** | An entry in a bb marketplace (`marketplace`) | bb's catalog install |

## One sync

```mermaid
sequenceDiagram
  participant T as Timer / page / CLI
  participant H as Hub
  participant G as GitHub
  participant D as Hub folders
  participant B as bb

  T->>H: sync (every 15 min, or on request)
  H->>G: fetch mirrors (anonymous)
  H->>H: read packages.json of Home + subscribed groups
  H->>H: pick one copy per plugin id<br/>(joined beta, else newest version)
  loop each plugin
    alt local, beta or followed
      H->>D: update checkout to the new commit
      H->>D: install dependencies (bun / pnpm / yarn / npm)
      H->>B: path install (rebuilds in place, keeps settings)
    else remote
      H->>B: git install, or update when its folder changed
    else marketplace
      H->>B: catalog install job, or update
    end
  end
  H->>B: uninstall plugins deleted from the repo
  H->>H: dry-run push: can this machine write?
  H->>B: update the hub itself if plugins/hub changed
```

Installs run as bb install jobs, so builds that take minutes don't time out;
a sync waits up to a minute, then shows the plugin as "installing".

## One change

```mermaid
sequenceDiagram
  participant U as Member (page or CLI)
  participant H as Hub on their machine
  participant W as work/ clone
  participant G as GitHub
  participant A as GitHub Action
  participant O as Every other hub

  U->>H: publish, add, move, delete, group change
  H->>W: reset to origin, edit folders and packages.json
  H->>G: commit and push (the member's own git login)
  G->>A: push event
  A->>G: regenerate and commit marketplace.json
  H->>H: sync now (this machine)
  O->>G: next shared sync fetches the change
```

If the member's git can't push, the page says why and greys out the buttons
that change the repository.

## Switching copies without losing data

Plugins from this repo and from followed repos are path installs from the
hub's checkouts. Moving a path install to another folder keeps its settings
and data, which makes these switches lossless:

```mermaid
flowchart LR
  Stable["plugins/x<br/>stable"] <-- "join / leave beta" --> Beta["beta/x<br/>beta"]
  Stable <-- "newest version in another group" --> Other["groups/g/plugins/x"]
  Dev["Your own folder<br/>bb hub dev"] <-- "Develop / stop developing" --> Stable
  Beta -- "promote" --> Stable
```

A plugin installed from git before this (or from a marketplace) can't move
to a folder without a reinstall, which resets its data; the hub asks first.
