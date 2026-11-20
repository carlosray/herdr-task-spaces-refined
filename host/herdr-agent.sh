#!/bin/bash
# A foreground launch adapter: native Herdr PTY outside, direct exec inside.
set +x +v
set -eu
case "${1:-}" in
  codex|claude|nclaude|opencode|pi) tool=$1; shift ;;
  *) printf '%s\n' 'Usage: herdr-agent {codex|claude|nclaude|opencode|pi} [arguments...]' >&2; exit 2 ;;
esac
# Adapter options precede native CLI arguments and are never passed to the agent.
display_title=''; selected_task=''; new_task=''; model_options=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --herdr-title|--herdr-task|--herdr-new-task|--herdr-model)
      option=$1
      [ "$#" -ge 2 ] || { printf 'A value is required for %s.\n' "$option" >&2; exit 2; }
      case "$option" in
        --herdr-title) display_title=$2 ;;
        --herdr-task) selected_task=$2 ;;
        --herdr-new-task) new_task=$2 ;;
        --herdr-model) model_options=(--herdr-model "$2") ;;
      esac
      shift 2 ;;
    *) break ;;
  esac
done
[ -z "$selected_task" ] || [ -z "$new_task" ] || { printf '%s\n' 'Choose --herdr-task OR --herdr-new-task.' >&2; exit 2; }
[ -z "$display_title" ] || display_title=$(python3 -c 'import sys
v=sys.argv[1].strip()
if not v or len(v)>160 or any(ord(c)<32 or ord(c)==127 for c in v):sys.exit("Invalid session name")
print(v)' "$display_title")
native_command=${1:-}
if [ "${#model_options[@]}" -gt 0 ]; then set -- "${model_options[@]}" "$@"; fi
utility=false
case "$native_command" in --help|-h|--version|-V|auth|app-server|update|completion|completions) utility=true ;; esac
config="$HOME/.config/herdr-core/agents.json"
[ -r "$config" ] || config=/dev/null
hc=$(command -v hc)
helper=$(cd -- "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")
cwd=$(pwd -P)
project=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || project=$cwd
if [ "$project" = "$HOME" ] || [ "$project" = / ]; then project=$cwd; fi
space=''
source_meta=''
nested=false
terminal_meta=''
if [ -n "${HC_TERMINAL_ID:-}" ]; then
  terminal_meta=$("$hc" get "$HC_TERMINAL_ID" --json)
  source_meta=$terminal_meta
  owner_pid=$(printf '%s' "$terminal_meta" | jq -r '.labels["agent.pid"] // (if .status.app? then .foreground.pid else empty end) // empty')
  # A tool shell inherits its parent's HC identity. Give a nested harness its
  # own native terminal rather than reassigning the parent's conversation ID.
  if [ -n "$owner_pid" ] && python3 - "$owner_pid" "$$" <<'PY'
import os,subprocess,sys
try:
    owner,current=map(int,sys.argv[1:])
    if owner <= 1 or owner == current: raise ValueError()
    try:
        os.kill(owner,0)
    except ProcessLookupError:
        sys.exit(1)
    seen=set()
    while current > 1 and current not in seen:
        seen.add(current)
        current=int(subprocess.check_output(['ps','-o','ppid=','-p',str(current)],text=True).strip())
        if current == owner: sys.exit(0)
except ValueError:
    sys.exit(1)
except (OSError,subprocess.SubprocessError):
    # A live owner whose ancestry cannot be inspected must not be overwritten.
    sys.exit(0)
sys.exit(1)
PY
  then
    nested=true
    unset HC_TERMINAL_ID HERDR_AGENT_PID HERDR_AGENT_TOOL HERDR_AGENT_LAUNCH_ID
    terminal_meta=''
  fi
fi
space=$(printf '%s' "$terminal_meta" | jq -r '.labels["herdr.space"] // empty')
context=''
# A console shell may have cd'ed away from its original Space. Its inherited
# labels are context to verify, not a fresh GUI/hc destination instruction.
human_shell=false
if [ -n "$terminal_meta" ] && printf '%s' "$terminal_meta" | jq -e   '(.argv // []) as $a | ($a[0] // "" | split("/") | last) as $p | (["zsh","bash","sh","fish"] | index($p)) != null and all($a[1:][]; . == "-l" or . == "-i" or . == "-il" or . == "-li" or . == "--login")' >/dev/null; then
  human_shell=true
fi
if [ "$utility" = false ] && { [ -z "$space" ] || [ "$human_shell" = true ] || [ -n "$selected_task" ] || [ -n "$new_task" ]; }; then
  resolver="$HOME/.config/agent-dev/herdr-session.py"
  [ -r "$resolver" ] || { printf '%s\n' 'Herdr session resolver is missing; repair the launcher installation.' >&2; exit 2; }
  resolve_options=(--cwd "$cwd" --tool "$tool")
  if [ "$#" -eq 0 ] && [ -z "$display_title$selected_task$new_task" ]; then
    resolve_options+=(--allow-attach)
  fi
  current_terminal=$(printf '%s' "$source_meta" | jq -r '.address // empty')
  [ -z "$current_terminal" ] || resolve_options+=(--current-terminal "$current_terminal")
  current_space=$(printf '%s' "$source_meta" | jq -r '.labels["herdr.space"] // empty')
  [ -z "$current_space" ] || resolve_options+=(--current-space "$current_space")
  [ -z "$display_title" ] || resolve_options+=(--title "$display_title")
  [ -z "$selected_task" ] || resolve_options+=(--task "$selected_task")
  [ -z "$new_task" ] || resolve_options+=(--new-task "$new_task")
  if [ -t 0 ] && [ -t 1 ]; then resolve_options+=(--interactive); fi
  context=$(python3 -B "$resolver" "${resolve_options[@]}")
  existing=$(printf '%s' "$context" | jq -r '.attach // empty')
  if [ -n "$existing" ]; then exec "$hc" attach "$existing"; fi
  destination=$(printf '%s' "$context" | jq -er '.space')
  display_title=$(printf '%s' "$context" | jq -er '.title')
  # Labels cannot safely rehome an already adopted pane. Open a fresh terminal.
  if [ -n "${HC_TERMINAL_ID:-}" ] && [ "$space" != "$destination" ]; then
    unset HC_TERMINAL_ID HERDR_AGENT_PID HERDR_AGENT_TOOL HERDR_AGENT_LAUNCH_ID
    terminal_meta=''
  fi
  space=$destination
fi
if [ -z "$space" ]; then
  # Help/maintenance invocations are not new agent sessions. Keep their legacy
  # native PTY behavior, but never consult agents.json's arbitrary project Space.
  space="sp-cli-$(printf '%s' "$project" | shasum -a 256 | cut -c1-20)"
fi
if [ -z "${HC_TERMINAL_ID:-}" ]; then
  options=(run --no-parent --outlive-parent --no-notify --keep --cwd "$cwd"
           --label "herdr.space=$space" --label "agent.tool=$tool")
  if [ -n "$context" ]; then
    launch=$(printf '%s' "$context" | jq -er '.launch')
    options+=(--name "agent-${launch:0:12}"       --label "herdr.tab=$(printf '%s' "$context" | jq -er '.tab')"       --label "orchestration.task=$(printf '%s' "$context" | jq -er '.task')"       --label "session.title=$display_title")
    if [ "$nested" = true ]; then
      parent=$(printf '%s' "$source_meta" | jq -r '.address // empty')
      native=$(printf '%s' "$source_meta" | jq -r '.labels["native.session"] // empty')
      [ -z "$parent" ] || options+=(--label "orchestration.parent=$parent")
      [ -z "$native" ] || options+=(--label "orchestration.parent-session=$native")
    fi
  elif [ -n "$display_title" ]; then options+=(--label "session.title=$display_title"); fi
  if [ -t 0 ] && [ -t 1 ]; then
    address=$("$hc" "${options[@]}" --bg --json -- "$helper" "$tool" "$@" | jq -er '.address')
    exec "$hc" attach "$address"
  fi
  exec "$hc" "${options[@]}" -- "$helper" "$tool" "$@"
fi

if [ -n "$display_title" ]; then
  "$hc" label "$HC_TERMINAL_ID" "session.title=$display_title" >/dev/null
fi
# Existing Herdr panes remain the same terminal. Adopt an unlabelled terminal.
if ! printf '%s' "$terminal_meta" | jq -e '.labels["herdr.space"] | length > 0' >/dev/null; then
  "$hc" label "$HC_TERMINAL_ID" "herdr.space=$space" >/dev/null
fi
HERDR_AGENT_LAUNCH_ID=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
"$hc" label "$HC_TERMINAL_ID" "agent.tool=$tool" "agent.launch=$HERDR_AGENT_LAUNCH_ID" "agent.pid=$$" native.session= agent.model= >/dev/null
export HERDR_AGENT_TOOL="$tool"
export HERDR_AGENT_LAUNCH_ID
export HERDR_AGENT_PID="$$"
for name in $(compgen -e); do
  case "$name" in ORCA_*|SUPERSET_*|PARADEV_*|AI_AGENT_*|AOE_*|AGENT_OF_EMPIRES_*) unset "$name";; esac
done
unset CLAUDE_CODE_DISABLE_AGENT_VIEW
if [ -r "$HOME/.config/agent-dev/environment.sh" ]; then
  . "$HOME/.config/agent-dev/environment.sh"
fi
while IFS=$'\t' read -r name filename; do
  [ -n "$name" ] || continue
  value=$(cat -- "$filename")
  export "$name=$value"
done < <(jq -r --arg t "$tool" '.tools[$t].credential_files // {} | to_entries[] | [.key,.value] | @tsv' "$config")
executable=$(jq -r --arg t "$tool" '.tools[$t].executable // empty' "$config")
[ -n "$executable" ] || executable=$(command -v "$tool")
# This option belongs to the GUI/scheduler, not to any agent CLI. A missing
# override leaves each tool's own default untouched.
if [ "${1:-}" = --herdr-model ]; then
  [ "$#" -ge 2 ] || { printf '%s\n' 'A model identifier is required.' >&2; exit 2; }
  model=$2
  case "$model" in ''|-*|*[[:space:][:cntrl:]]*) printf '%s\n' 'Invalid model identifier.' >&2; exit 2;; esac
  [ "${#model}" -le 512 ] || { printf '%s\n' 'Model identifier is too long.' >&2; exit 2; }
  shift 2
  "$hc" label "$HC_TERMINAL_ID" "agent.model=$model" >/dev/null
  if [ "$tool" = opencode ]; then
    # Preparing a model is a NEW session operation. Never create a throwaway
    # conversation when the caller meant to resume, run a maintenance command,
    # or use a different/private server. Those native commands remain available
    # unchanged without this GUI-only model option.
    model_needs_value=false
    for argument do
      if [ "$model_needs_value" = true ]; then model_needs_value=false; continue; fi
      case "$argument" in
        --auto|--print-logs) ;;
        --prompt|--log-level) model_needs_value=true ;;
        --prompt=*|--log-level=*) ;;
        *) printf '%s\n' 'OpenCode model override supports a new session on the default server only. Resume first and change its model in OpenCode.' >&2; exit 2 ;;
      esac
    done
    [ "$model_needs_value" = false ] || { printf '%s\n' 'A value is missing from an OpenCode option.' >&2; exit 2; }
    session=$(python3 "$HOME/.config/agent-dev/opencode-model.py" "$executable" "$model")
    "$hc" label "$HC_TERMINAL_ID" "native.session=$session" >/dev/null
    set -- --session "$session" "$@"
  else
    set -- --model "$model" "$@"
  fi
fi
# OpenCode runs sessions in a shared server, so its process cannot identify a
# new interactive conversation afterwards. Prepare its exact ID up front. Do not
# alter maintenance commands, explicit resumes, or arbitrary original flags.
opencode_new=false
if [ "$tool" = opencode ]; then
  opencode_new=true
  needs_value=false
  for argument do
    if [ "$needs_value" = true ]; then needs_value=false; continue; fi
    case "$argument" in
      --auto|--print-logs) ;;
      --prompt|--log-level) needs_value=true ;;
      --prompt=*|--log-level=*) ;;
      *) opencode_new=false; break ;;
    esac
  done
  [ "$needs_value" = false ] || opencode_new=false
fi
if [ "$opencode_new" = true ]; then
  session=$(python3 "$HOME/.config/agent-dev/opencode-model.py" "$executable")
  "$hc" label "$HC_TERMINAL_ID" "native.session=$session" >/dev/null
  set -- --session "$session" "$@"
fi
if [ "$tool" = codex ]; then
  has_no_daemon=false
  for argument do
    [ "$argument" != --no-daemon ] || has_no_daemon=true
  done
  if [ "$has_no_daemon" = false ]; then
    set -- --no-daemon "$@"
  fi
fi
exec "$executable" "$@"
