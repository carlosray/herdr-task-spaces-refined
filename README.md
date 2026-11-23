# Task Spaces Refined

A Herdr desktop layout for running several projects at once. The sidebar groups agents by host, repository, task, and assigned worktree. It also shows logical managers, and GitHub pull requests and GitLab merge requests. The work area includes tabs, a file and changes inspector, session recovery, and Automations.

## Install

Install and start [Herdr Desktop and Core](https://herdr.dev/guide/) first. This layout was developed against Herdr App 0.1.16 and Core 0.1.21 on macOS, with Linux Core hosts.

Ask your agent to install it:

> Read `~/.config/herdr-app/AGENTS.md`, then install Task Spaces Refined from https://github.com/carlosray/herdr-task-spaces-refined. Follow its root AGENTS.md and README.

Or install from a terminal:

```sh
git clone https://github.com/carlosray/herdr-task-spaces-refined.git
cd herdr-task-spaces-refined
python3 install.py
```

Choose **task-spaces-refined** in Herdr's layout switcher. Installation adds the layout beside your existing layouts. It merges only this layout's key scope and backs up replaced files. The installer doesn't carry over any machines, agents, projects, sessions, credentials, or tasks from another installation.

| Feature | Requirements |
| --- | --- |
| Layout and Task Spaces | Herdr Desktop, `hc`, Git, Python 3.10+ |
| Console picker | Bash, `jq`, `fzf` 0.70+, and the agent CLI you want to run |
| GitHub pull requests | `gh` on the desktop host, with `gh auth login` |
| GitLab merge requests | `glab` on the desktop host, with `glab auth login`. Supported remotes use `gitlab.com` or a hostname starting with `gitlab.` |
| Automations | Go 1.26+ or Go with toolchain auto-download. Start the scheduler from the Automations panel when you want scheduled jobs to run |

Put `~/.local/bin` on the PATH of Herdr Core on each execution host. Sign in to agent CLIs and Git forges on the hosts where you use them.

The default installation includes the wrapper, agent instructions, session metadata hooks, and Automations. Use `--no-wrapper`, `--no-instructions`, `--no-hooks`, and `--no-automations` to omit components. The first three apply to remote setups launched from this desktop as well. To use the console picker, call `herdr-agent codex` (or `claude`, `opencode`, `pi`). To also use plain agent command names, source `~/.config/agent-dev/herdr-shell.sh` from your Bash/Zsh configuration. The layout can launch agents through stock Herdr even when the shell wrapper is omitted.

## Layout updates

After installing with `install.py`, open **Layout settings → Updates → Update layout**.
The updater downloads the latest stable [GitHub Release](https://github.com/carlosray/herdr-task-spaces-refined/releases),
checks the ZIP against its published SHA-256 and runs its installer with the original options.
It refreshes the layout, packaged mods, and the local host components selected at installation.
Existing mod settings, shortcuts, and sections of agent instructions outside the managed block are retained.
The installer keeps backups. Check `data/task-spaces-refined-update.log` in the Herdr app home if an update fails.

Older or manually assembled copies need a one-time install from an extracted release to enroll.
Pass the release tag and the install options you want to retain, for example
`python3 install.py --release-tag v0.1.1 --no-instructions --no-hooks`.
For a customized setup, add `--keep-local-code` on the first managed install. It keeps
existing local mod code and host wrappers. Later updates merge independent changes
against the previous release and stop before installing if the changes conflict.
The original release sources and the local edits stay on your machine.

Use **Setup** for each remote host whose helpers should be upgraded. The desktop update does not restart
agents or update the Herdr application itself.

## Worktree close policy

Open the repository header menu and choose **Worktree close settings**. The policy belongs to that repository on that host. Enable return options, set the target branch, and optionally set a command such as `git branch-idle` if your repository defines it. The default target is `{worktree}-idle`. When the command is empty, Git switches to the target local branch, which must already exist. The policy is off by default.

Close the assigned worktree from its context menu or close its last tab or pane using this layout's controls. The same confirmation offers **Keep worktree**, **Return to pool**, and **Delete worktree**. Keep is selected initially. Return and Delete check cleanliness before closing and again after all Herdr users of that checkout have exited. Delete uses `git worktree remove` and keeps the branch. Existing terminal exits that leave a shell open do not count as closing its tab.

After confirmation, the return or delete runs from a progress card at the bottom right. It shows the worktree being processed and offers retry or cancellation if the operation stops.

A failed return or delete retains the assignment for retry or cancellation. For recovery after closing the dialog, inspect `herdr-task snapshot` on the owning host and use the saved `close_action.id` with `finish-close-worktree` or `cancel-close-worktree`. A custom command runs with the user's permissions on the chosen host. Use a command you trust. Treat a timeout or partial custom command failure as uncertain and inspect the branch before retrying.

If creating a worktree is interrupted, open **Add a worktree → Resume setup** in its task. The host verifies the saved checkout before reusing its Space. You can also run `herdr-task resume-worktree --space SPACE` on the owning host. An interrupted folder with local changes stays reserved for inspection. A different worktree path can still be used.

## Agent coordination and remote hosts

The installer adds a managed reference in `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md` and installs the shared skill for both tools. The skill describes exact destinations, native `hc` messaging, and logical manager metadata. Actual message permissions come from Herdr Core. Existing agents may need to read the installed skill before using it.

Add a remote machine through Herdr as usual. The first time a new host becomes ready, Herdr offers to install the host tools. For an existing host, click **Setup** in its header. The same operation is available from the installer as `python3 install.py --host NAME`. It sends only the host tools and public instructions over `hc exec`. Host credentials and configuration stay on that host. Python, Git and Herdr Core must already be available there.

## Pull request screenshots and review

The PR author embeds the first before/after pair under **Screenshots → Before** and **Screenshots → After** in the PR description. The required CI check validates separate images when the PR is ready for review. Use GitHub attachments or raw GitHub PNG URLs pinned to a full commit SHA. Use synthetic data at the same window size and theme. For changes with no visible effect, show the workspace and state the expected result.

With `herdr-app` and `hc` on PATH, run the fixture against two unpacked source revisions. Choose the affected screens or use `workspace` for a non-visual change.

```sh
python3 -B .github/ci/preview_capture.py /path/to/before /path/to/after /tmp/herdr-previews workspace changes
```

On headless Linux, run that command under `xvfb-run -a -s "-screen 0 1440x960x24"`. The `Herdr UI previews` workflow contains the display dependencies and verifies the pinned App and Core downloads. Full scenario names and their path mappings are in `.github/ci/preview_scenarios.py`.

Add the `ui-preview` label in the PR to request a fresh Linux run. It captures the base and the proposed merge for the affected screens, uploads both sets of PNGs, and posts the artifact link in the PR. After updating the PR, remove and re-add the label to compare the new revision.

Token Factory uses the Actions secret `NEBIUS_API_KEY` and the Actions variable `NEBIUS_BASE_URL`. Set `NEBIUS_MODEL` to `moonshotai/Kimi-K3.1-Pro` for code review and `NEBIUS_VISUAL_MODEL` to `deepseek-ai/DeepSeek-V4.1-Flash-1017` for the on-demand image comparison. The visual report flags visible layout issues and links the raw captures. The fixture run uses GitHub's PR sandbox with read-only repository access. The review jobs read the diff and screenshot data from the base branch workflow.

## License

See [LICENSE](LICENSE), [NOTICE](NOTICE), and the notices supplied with the vendored mods and icon assets. The Automations backend retains its upstream license.
