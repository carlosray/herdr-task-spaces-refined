# Task Spaces Refined

When asked to add this layout, read the destination's `~/.config/herdr-app/AGENTS.md` and this repository's README and RECIPE. Confirm that the runtime prerequisites are available, inspect the bundled installer and modules, then run `python3 install.py` in this repository. Select the layout only when requested. Use the provided options to match the user's installation scope. Set up connected remote hosts through `--host NAME` or the host header Setup action.

This repository contains reusable source and public sample configuration only. Keep local paths, runtime state, provider configuration, checkout claims, personal notes and identifying screenshots out of commits. Do not copy an entire installed app home.

For a change to a module, use `herdr-app check mods/MODULE`. Run `python3 -B tests/test_close.py` for the checkout close contract. Test installation using an isolated home before editing live config. Inspect `git status` before sharing a release.

When preparing a PR, the author captures and attaches before and after screenshots in the PR description. Use the same synthetic data, viewport, and theme at both revisions. Show each affected UI surface. For a non-visual change, attach a workspace pair and state that no UI change is expected. Paste the images into GitHub under **Screenshots → Before** and **Screenshots → After** before marking the PR ready. Keep screenshots from a real personal workspace out of PRs.

Use `.github/ci/preview_capture.py` to capture the initial pair with an isolated Herdr App and Core. See the README for the command. For a follow-up comparison, add the `ui-preview` label to the current PR revision. Remove and re-add it after a new commit to request another run. The CI preview is separate from the author's attachments.
