# bb-plugin-server-badge

Shows whether a window is connected to the **Development** or **Production**
bb server, as a small badge in the bottom-right corner. On a personal machine
(no public app URL) it shows `user:machine:port` instead. Hover it for the
server's name, host, user, port, app URL, and why it chose that environment.
Agents and shells can run `bb server-badge` for the same information.

## How the environment is decided

Never from the URL. In this order:

1. The plugin's **Environment** setting, if not Auto
   (`bb plugin config server-badge set environment production`).
2. The server's `BB_ENVIRONMENT` variable (`development`, `staging`,
   `production`, …). Set it in the server's systemd unit with
   `Environment=BB_ENVIRONMENT=production`.
3. The server's Unix user and its systemd service name: if either contains
   the word `dev`, `development`, `staging`, or `test` (for example user
   `bb-dev` or `ew-bb-server-dev.service`), it's **Development**; otherwise
   **Production**.
4. A bb with no public app URL (a personal machine) is **Local**.
