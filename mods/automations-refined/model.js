// Persistent automation input, independent of rendering or hosting requests.
export const SUPPORTED_AUTOMATION_AGENTS = ["codex", "claude", "nclaude", "pi", "opencode", "copilot"];
export function automationSpace(entry, all) {
  const machine = entry.machine || null;
  const id = machine && entry.workspace_id ? `${machine}/${entry.workspace_id}` : entry.workspace_id;
  return all.find(s => id && s.id === id && (s.machine || null) === machine)
    ?? all.find(s => (s.machine || null) === machine && s.folder === entry.repo)
    ?? null;
}

export function automationInput(fields, selection) {
  if (!selection?.space || !selection.folder) throw Error("Choose an existing Space with a working directory.");
  if (!selection.agent?.key) throw Error("Choose an installed agent.");
  if (selection.error) throw Error(selection.error);
  const machine = selection.machine || "";
  let id = selection.space.id;
  if (machine && id.startsWith(`${machine}/`)) id = id.slice(machine.length + 1);
  if (!fields.name?.trim()) throw Error("Name is required.");
  if (!fields.prompt?.trim()) throw Error("Prompt is required.");
  const timeout = Number(fields.timeout);
  if (!Number.isInteger(timeout) || timeout < 1) throw Error("Timeout must be a positive number of minutes.");
  return {
    name: fields.name.trim(), manual: Boolean(fields.manual), cron: fields.manual ? "" : fields.cron.trim(),
    disabled: Boolean(fields.disabled), workspace: "existing", workspace_id: id, machine,
    repo: selection.folder, agent: selection.agent.key, model: selection.model || "",
    prompt: fields.prompt, timeout_minutes: timeout, close_workspace: "never", template: "", workflow: "",
  };
}

export function automationRows(all, section) {
  return section === "history" ? [] : all.filter(a => Boolean(a.manual) === (section === "manual"));
}

// Deliberately small Raycast-style grammar. Values are data, never evaluated.
function argumentParts(prompt) {
  const parts = [], pattern = /\{argument\s+name="([^"{}]+)"\s*\}/g;
  let cursor = 0;
  for (const match of prompt.matchAll(pattern)) {
    const literal = prompt.slice(cursor, match.index);
    if (literal.includes("{argument")) throw Error('Invalid argument placeholder. Use {argument name="Name"}.');
    const name = match[1];
    if (!name.trim()) throw Error("Argument placeholder needs a name.");
    parts.push({literal}, {name}); cursor = match.index + match[0].length;
  }
  const literal = prompt.slice(cursor);
  if (literal.includes("{argument")) throw Error('Invalid argument placeholder. Use {argument name="Name"}.');
  parts.push({literal}); return parts;
}
export function promptArguments(prompt) {
  return [...new Set(argumentParts(prompt).filter(p => p.name !== undefined).map(p => p.name))];
}
export function expandPrompt(prompt, values) {
  const parts = argumentParts(prompt), names = new Set(parts.filter(p => p.name !== undefined).map(p => p.name));
  for (const name of names) if (!Object.prototype.hasOwnProperty.call(values,name) || typeof values[name] !== "string" || !values[name].trim()) throw Error(`Enter ${name}.`);
  for (const name of Object.keys(values)) if (!names.has(name)) throw Error(`Unknown argument: ${name}.`);
  return parts.map(p => p.name !== undefined ? values[p.name] : p.literal).join("");
}
