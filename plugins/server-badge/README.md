# bb-plugin-server-badge

Shows which bb server a window is connected to, and whether it is
**Development**, **Production**, or **Local**, as a small badge in the
bottom-right corner (red for Production, green for Development). Hover it for
the host, user, port, app URL, and why it chose that environment. Agents and
shells can run `bb server-badge` for the same information.

The name is the hostname of the server's `BB_APP_URL` (for example
`bb.example.com`), or `user@host:port` when it has none.

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
