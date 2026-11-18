export default async function plugin(bb: any) {
  const s = bb.settings.define({ msg: { type: "string", label: "Msg", description: "m", default: "default" } });
  bb.log.info(`betatest ${"0.1.0"} msg=${(await s.get()).msg}`);
}
