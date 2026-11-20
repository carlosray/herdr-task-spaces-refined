# Source from Bash or Zsh to make plain agent names open the Herdr picker.
# The wrapper itself is installed independently and also works as herdr-agent TOOL.
if [ -x "$HOME/.local/bin/herdr-agent" ]; then
    codex() { command "$HOME/.local/bin/herdr-agent" codex "$@"; }
    claude() { command "$HOME/.local/bin/herdr-agent" claude "$@"; }
    opencode() { command "$HOME/.local/bin/herdr-agent" opencode "$@"; }
    pi() { command "$HOME/.local/bin/herdr-agent" pi "$@"; }
fi
