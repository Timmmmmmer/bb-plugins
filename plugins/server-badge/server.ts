// Server Badge backend: tells the frontend which bb server it is talking to,
// and whether that server is Development or Production.
//
// The environment is worked out from the server process itself, never from
// its URL (and no hostnames live in this code), in this order:
//   1. the plugin's "environment" setting, if not "auto";
//   2. the BB_ENVIRONMENT variable of the server process (set it in the
//      server's systemd unit, e.g. Environment=BB_ENVIRONMENT=production);
//   3. the server's Unix user and its systemd service name: a name containing
//      the word dev, development, staging, or test means Development, e.g.
//      user "bb-dev" or "ew-bb-server-dev.service"; any other name means
//      Production;
//   4. a bb without a public app URL (a personal machine) is "Local"; only
//      whether an app URL is set is checked, never what it is.
import { readFileSync } from "node:fs";
import os from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const environmentSchema = z.enum(["Development", "Production", "Local"]);
export type Environment = z.infer<typeof environmentSchema>;

const infoSchema = z.object({
  label: z.string(),
  appUrl: z.string().nullable(),
  hostname: z.string(),
  user: z.string(),
  port: z.string(),
  environment: environmentSchema,
  /** How the environment was decided, shown on hover. */
  environmentReason: z.string(),
});
export type ServerInfo = z.infer<typeof infoSchema>;

export const rpcContract = defineRpcContract({
  info: { input: z.null(), output: infoSchema },
});

const DEV_WORD = /(?:^|[^a-z0-9])(dev|development|staging|stage|test|testing)(?:[^a-z0-9]|$)/iu;
const PROD_WORD = /^(prod|production|live|main)$/iu;
const DEV_VALUE = /^(dev|development|staging|stage|test|testing)$/iu;

/** The systemd service this process runs in (Linux), e.g. "ew-bb-server-dev.service". */
function systemdUnit(): string | null {
  try {
    const cgroup = readFileSync("/proc/self/cgroup", "utf8");
    const units = cgroup.match(/[A-Za-z0-9@._-]+\.service/gu);
    return units?.at(-1) ?? null;
  } catch {
    return null;
  }
}

function detectEnvironment(setting: string, user: string, hasAppUrl: boolean): { environment: Environment; reason: string } {
  if (setting === "development") return { environment: "Development", reason: "set in the Server Badge settings" };
  if (setting === "production") return { environment: "Production", reason: "set in the Server Badge settings" };
  const variable = process.env.BB_ENVIRONMENT?.trim();
  if (variable) {
    if (DEV_VALUE.test(variable)) return { environment: "Development", reason: "from BB_ENVIRONMENT" };
    if (PROD_WORD.test(variable)) return { environment: "Production", reason: "from BB_ENVIRONMENT" };
  }
  const unit = systemdUnit();
  if (unit !== null && DEV_WORD.test(unit.replace(/\.service$/u, ""))) {
    return { environment: "Development", reason: "from the server's service name" };
  }
  if (DEV_WORD.test(user)) return { environment: "Development", reason: "from the server's user" };
  if (!hasAppUrl) return { environment: "Local", reason: "no public app URL, so a personal machine" };
  return { environment: "Production", reason: "no development signs in the server's user or service name" };
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    environment: {
      type: "select",
      label: "Environment",
      description:
        "Auto works it out from BB_ENVIRONMENT, the server's user, and its systemd service name (never from the URL). Override it here if auto gets it wrong.",
      options: ["auto", "development", "production"],
      experimental_optionLabels: { auto: "Auto-detect", development: "Development", production: "Production" },
      default: "auto",
    },
  });

  async function readInfo(): Promise<ServerInfo> {
    const appUrl = bb.server.experimental_appUrl;
    const hostname = os.hostname();
    const user = os.userInfo().username;
    // loopbackBaseUrl is bind-gated, so it is read here (in the handler), never at load.
    const port = new URL(bb.server.loopbackBaseUrl).port;
    // Prefer the public hostname: it is what tells servers on one box apart.
    // Without one, user@host:port does.
    const label = appUrl ? new URL(appUrl).hostname : `${user}@${hostname}:${port}`;
    const { environment, reason } = detectEnvironment((await settings.get()).environment, user, appUrl !== null);
    return { label, appUrl, hostname, user, port, environment, environmentReason: reason };
  }

  bb.rpc.register(rpcContract, {
    info: () => readInfo(),
  });

  bb.cli.register({
    name: "server-badge",
    summary: "Print which bb server this is, and whether it is Development or Production",
    commands: [],
    async run() {
      const i = await readInfo();
      return {
        exitCode: 0,
        stdout: `${i.environment}: ${i.label}  (${i.environmentReason})\nhost: ${i.hostname}  user: ${i.user}  port: ${i.port}\napp url: ${i.appUrl ?? "(none)"}\n`,
      };
    },
  });
}
