# Anchor: a Herdr Desktop layout

A calm, low-stimulation sidebar built around common ADHD strategies: one thing per tab, a shrinking timer, a parking lot for stray thoughts, and only the session that needs you in full.

Everything this layout adds to Herdr is in this repo, so it installs on its own. The only other mods it uses ship
with Herdr Desktop. Built against Herdr Desktop 0.1.14.

## Install

```sh
./install.sh
herdr-app do layout.switch --name anchor
```

The script copies `layouts/`, `themes/`, `mods/` and `programs.json` into `~/.config/herdr-app` (or `$HERDR_APP_HOME`), and `scripts/`
into `~/.config/herdr`. It saves any files it replaces to `backups/` in the Herdr home first. Mods reload by themselves.

## Claude Code stats

Cards get their numbers from a terminal label written by `scripts/claude-desktop.sh`. On each machine that runs
Claude Code, add this to the status line script, where `$input` holds the JSON Claude passes it:

```sh
{ printf '%s' "$input" | ~/.config/herdr/claude-desktop.sh & } 2>/dev/null
```

It needs `jq`, and does nothing outside a Herdr terminal. Without it, sessions still appear, just without stats.

## Claude in the new-tab menu

`programs.json` adds **Claude (personal)** and **Claude (work)** to Herdr's new-tab menu (the `+` in the tab bar). They run the
shell aliases `ccp` and `ccw` from `~/.zshrc` on the machine the space is on, which start Claude Code with
`~/.claude-personal` or `~/.claude-work` as its config; on a machine without them they start nothing. The install
script adds the two entries to any `programs.json` already in the Herdr home, keeping its others.

## Background sessions beside their session

When a Claude session in a Herdr pane starts background sessions (`claude --bg`), `scripts/claude-bg-panes.py` shows
each one beside it: the session keeps the left, and its background sessions stack evenly in a column on the right, each
running `claude attach <id>`. It's a Claude Code hook, so add it to the `hooks` in each Claude config's
`settings.json` on every machine that runs sessions:

```json
"PostToolUse": [
  { "matcher": "Bash", "hooks": [{ "type": "command", "command": "python3 -I ~/.config/herdr/claude-bg-panes.py", "timeout": 30 }] }
]
```

It only acts on background sessions Claude starts itself; `claude --bg` typed in a plain shell opens nothing. Problems go
to `~/.cache/herdr-claude/bg-panes.log`.

## What's here

| Path | What it is |
|---|---|
| `layouts/` | The layout, and its picture for the settings screen, if it has one |
| `themes/` | Its theme |
| `mods/` | Its sidebar and other mods, including the Close / Delete worktree dialog (`session-actions`) |
| `scripts/` | The stats script and the background-session hook |
| `programs.json` | The two Claude entries for the new-tab menu |

See `NOTICE.md` for what this derives from.
