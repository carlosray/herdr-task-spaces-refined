export const SETTINGS_KEY = 'herdr_agent_settings';
export const ICONS_KEY = 'agent-settings.icons';
const ROOT = 'icons/herdr-agent-glyphs/';
const knownGlyphs = new Set(['claude','codex','pi','opencode','cursor','copilot','amp','gemini','grok',
  'antigravity','crush','dsh-tui','goose','hermes','kimi','kiro','nclaude','omp','pig','qoder']);
const glyph = name => ({icon: ROOT + name + '.svg', tint: true, tile: '#292b30', color: '#e5e5e5'});
const iconFields = ['icon','tint','tile','color'];
const iconOf = program => Object.fromEntries(iconFields.map(key => [key, program[key] ?? null]));
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function parseConfig(raw) {
  const config = raw === null ? {} : JSON.parse(raw);
  if (!object(config) || (config.programs !== undefined && !object(config.programs)))
    throw Error('programs.json must contain a programs object.');
  if (Object.values(config.programs??{}).some(program=>!object(program)))
    throw Error('A program entry is invalid.');
  const settings = config[SETTINGS_KEY];
  if (settings !== undefined && (!object(settings) || settings.version !== 1 || !object(settings.entries) ||
    Object.values(settings.entries).some(entry=>!object(entry))))
    throw Error('The agent settings version is unsupported.');
  return config;
}

export function iconsFor(agent) {
  const name = ({codex:'openai', nclaude:'claude'})[agent.key] ??
    (knownGlyphs.has(agent.key) ? agent.key : 'terminal');
  const standard = agent.key === 'codex' ? 'OpenAI' :
    ['claude','nclaude'].includes(agent.key) ? 'Claude starburst' : 'Monochrome';
  return [
    {id:'mono', label:standard, ...glyph(name)},
    ...[['near-gray','Near gray'],['muted-color','Muted color']].map(([id,label])=>({
      id, label, icon:ROOT+name+'-'+id+'.svg', tint:false, tile:'#292b30', color:null,
    })),
    {id:'original', label:'Original', ...agent.original},
    ...(['claude','nclaude'].includes(agent.key)
      ? [{id:'claude-orange', label:'Claude in orange', icon:ROOT+'claude-orange.svg', tint:false, tile:null, color:null}]
      : []),
    ...[['terminal','Terminal'],['orbit','Orbit'],['diamond','Diamond'],['bolt','Bolt']]
      .map(([id,label])=>({id,label,...glyph(id)})),
  ];
}

export function catalog(config, local, remote = []) {
  const entries = config[SETTINGS_KEY]?.entries ?? {};
  const rows = new Map();
  for (const program of [...remote, ...local]) if (program.key) rows.set(program.key, program);
  for (const key of Object.keys(entries)) if (!rows.has(key)) rows.set(key, {key});
  const installed = rows => new Set(rows.filter(program=>program.installed).map(program=>program.key));
  const localKeys = installed(local), remoteKeys = installed(remote);
  return [...rows.values()].map(program => {
    const {key} = program;
    const saved = Object.hasOwn(entries,key) ? entries[key] : {};
    const override = Object.hasOwn(config.programs ?? {}, key) ? config.programs[key] : {};
    return {
      key, name: override.name??program.name??saved.name??key,
      run: override.run??program.run??saved.run??[],
      original: saved.original??iconOf(program),
      choice: saved.choice??'original', disabled: Boolean(saved.disabled), removed: Boolean(saved.removed),
      custom: Boolean(saved.custom), local: localKeys.has(key), remote: remoteKeys.has(key),
    };
  }).sort((a,b)=>Number(b.local||b.remote)-Number(a.local||a.remote) || a.name.localeCompare(b.name));
}

export function quoteCommand(argv) {
  return argv.map(word=>word && /^[\w@%+=:,./~-]+$/.test(word)
    ? word : "'" + word.replaceAll("'", "'\\''") + "'").join(' ');
}

export function parseCommand(text) {
  if (/[\0\r\n]/.test(text)) throw Error('Enter the command on one line.');
  let quote = '', token = '', started = false;
  const argv = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === quote) { quote = ''; continue; }
    if (ch === '\\' && quote !== "'") {
      if (i + 1 === text.length) throw Error('Finish the escape at the end of the command.');
      if (quote === '"' && !['"','\\','$','`'].includes(text[i+1])) { token += ch; continue; }
      token += text[++i]; started = true; continue;
    }
    if (!quote && (ch === "'" || ch === '"')) { quote = ch; started = true; continue; }
    if (!quote && /\s/.test(ch)) {
      if (started) argv.push(token);
      token=''; started=false; continue;
    }
    token += ch; started=true;
  }
  if (quote) throw Error('Close the quoted argument.');
  if (started) argv.push(token);
  if (!argv[0] || argv[0].startsWith('-')) throw Error('Enter an executable followed by its arguments.');
  return argv;
}

export function newAgentKey(name, config, rows) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48) || 'custom-agent';
  const used = new Set(['terminal','shell','agent','program','constructor','prototype',
    ...Object.keys(config.programs??{}), ...Object.keys(config[SETTINGS_KEY]?.entries??{}), ...rows.map(row=>row.key)]);
  let key=base;
  for(let n=2;used.has(key);n++)key=base+'-'+n;
  return key;
}

export function editAgent(config, row, change) {
  const changes = config[SETTINGS_KEY]?.entries ?? {};
  const previous = Object.hasOwn(changes,row.key) ? changes[row.key] : {};
  const program = {...(Object.hasOwn(config.programs??{},row.key) ? config.programs[row.key] : {})};
  const next = {...previous, original:row.original, name:change.name??row.name, choice:change.choice??row.choice,
    custom:row.custom, disabled:change.disabled??row.disabled, removed:change.removed??row.removed};
  if (change.name !== undefined) program.name = change.name;
  if (change.run !== undefined) {
    program.run = [...change.run];
    if (row.custom && program.match === undefined) {
      const command = change.run[0].split('/').at(-1);
      if (/^[a-zA-Z0-9._+-]+$/.test(command) && !['bash','zsh','sh','fish','env','node','python','python3','herdr-agent'].includes(command))
        program.match = [command];
    }
  }
  if (change.choice !== undefined) {
    const choice = iconsFor(row).find(icon=>icon.id===change.choice);
    if (!choice) throw Error('Unknown icon.');
    for (const field of iconFields) {
      if (choice[field] === null || choice[field] === undefined) delete program[field];
      else program[field] = choice[field];
    }
  }
  return {...config, programs:{...config.programs,[row.key]:program},
    [SETTINGS_KEY]:{version:1,entries:{...changes,[row.key]:next}}};
}

export function seedDefaults(config, native) {
  let next = config;
  for (const row of catalog(config,native)) {
    if (knownGlyphs.has(row.key) && !Object.hasOwn(config[SETTINGS_KEY]?.entries??{},row.key))
      next=editAgent(next,row,{choice:'mono'});
  }
  return next;
}

export function programIcons(config) {
  return Object.fromEntries(Object.entries(config.programs??{})
    .filter(([,program])=>typeof program.icon==='string')
    .map(([key,program])=>[key,iconOf(program)]));
}
