// bb-plugin-sidebar-text — shows a short message on its own sidebar page.
// The message is a setting, editable in Settings or with
// `bb plugin config sidebar-text set message "..."`.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  message_get: {
    input: z.null(),
    output: z.object({ message: z.string() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    message: {
      type: "string",
      label: "Message",
      description: "The text the Sidebar text page shows.",
      default: "Hello from my sidebar plugin!",
      experimental_multiline: true,
    },
  });
  settings.onChange(() => bb.realtime.publish("message-changed", null));

  bb.rpc.register(rpcContract, {
    message_get: async () => ({ message: (await settings.get()).message }),
  });
}
