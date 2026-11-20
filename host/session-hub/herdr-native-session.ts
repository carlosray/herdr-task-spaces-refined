// Metadata-only native identity. An inherited terminal variable is not ownership.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function herdrNativeSession(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const terminal = process.env.HC_TERMINAL_ID;
    const inheritedOwner = Number(process.env.HERDR_AGENT_PID || 0);
    const id = ctx.sessionManager.getSessionId();
    if (!terminal || !/^[A-Za-z0-9_-]+$/.test(terminal) || !id) return;
    if (inheritedOwner && inheritedOwner !== process.pid) return;
    try {
      const r = await pi.exec("hc", ["get", terminal, "--json"]);
      if (r.code !== 0) return;
      const metadata = JSON.parse(r.stdout);
      const owner = Number(metadata.labels?.["agent.pid"] || 0);
      if (!owner || owner !== process.pid || metadata.labels?.["agent.tool"] !== "pi") return;
      await pi.exec("herdr-session-probe", ["--pi-session", id]);
    } catch {}
  });
}
