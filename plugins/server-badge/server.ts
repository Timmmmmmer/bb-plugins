// Server Badge backend: tells the frontend which bb server it is talking to.
import os from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const infoSchema = z.object({
  label: z.string(),
  appUrl: z.string().nullable(),
  hostname: z.string(),
  user: z.string(),
  port: z.string(),
});
export type ServerInfo = z.infer<typeof infoSchema>;

export const rpcContract = defineRpcContract({
  info: { input: z.null(), output: infoSchema },
});

function readInfo(bb: BbPluginApi): ServerInfo {
  const appUrl = bb.server.experimental_appUrl;
  const hostname = os.hostname();
  const user = os.userInfo().username;
  // loopbackBaseUrl is bind-gated, so it is read here (in the handler), never at load.
  const port = new URL(bb.server.loopbackBaseUrl).port;
  // Prefer the public hostname (e.g. bb.example.com): it is
  // what tells servers on one box apart. Without one, user@host:port does.
  const label = appUrl ? new URL(appUrl).hostname : `${user}@${hostname}:${port}`;
  return { label, appUrl, hostname, user, port };
}

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    info: () => readInfo(bb),
  });

  bb.cli.register({
    name: "server-badge",
    summary: "Print which bb server this is",
    commands: [],
    run() {
      const i = readInfo(bb);
      return {
        exitCode: 0,
        stdout: `${i.label}\nhost: ${i.hostname}  user: ${i.user}  port: ${i.port}\napp url: ${i.appUrl ?? "(none)"}\n`,
      };
    },
  });
}
