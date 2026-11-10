#!/bin/bash
# Mirrors a Claude Code session's stats onto its herdr-core terminal as one
# label, claude.stats (compact JSON), for the Herdr desktop app's claude-cards
# and claude-status mods (~/.config/herdr-app/mods/ on the MacBook Pro). Labels
# reach every Herdr client live, across machines, so the app needs no files.
#
# Fed the status-line JSON on stdin; backgrounded from ~/.claude-*/statusline.sh
# next to claude-sidebar.sh (the herdr TUI version of the same card). No-op
# outside herdr-core (no HC_TERMINAL_ID) and inside a herdr TUI pane.
#
#   claude-desktop.sh --watch <terminal>
#       re-counts running subagents and attached background sessions every 5 s
#       while any exist (the status line only fires while Claude prints, so a
#       finished one would linger).

hc=$(command -v hc 2>/dev/null || echo "$HOME/.local/bin/hc")
CACHE="$HOME/.cache/herdr-claude/desktop"
MAX_SUBS=4

label() { "$hc" label "$HC_TERMINAL_ID" "claude.stats=$1" >/dev/null 2>&1; }

# Running subagents, as claude-sidebar.sh and /sessions-sidebar count them: a
# transcript under <session>/subagents/ whose .meta.json isn't finished and that
# changed in the last 60 s, plus the attached sessions below. Prints
# {"n":N,"names":[first MAX_SUBS],"at":<epoch s>}. n counts what is working; names
# also lists idle attached sessions, after the working ones.
subagents() {
    local sub="${1%.jsonl}/subagents" now f meta mt d names=() bg
    bg=$(attached); [[ -n "$bg" ]] || bg='[]'
    child_labels "$bg"
    if [[ -n "$1" && -d "$sub" ]]; then
        now=$(date +%s)
        while IFS= read -r f; do
            meta="${f%.jsonl}.meta.json"
            [[ -f "$meta" ]] && grep -q '"finished":true' "$meta" && continue
            mt=$(stat -f %m "$f" 2>/dev/null || echo 0)
            (( now - mt <= 60 )) || continue
            d=$(jq -r '.description // .agentType // "subagent"' "$meta" 2>/dev/null)
            names+=("${d:-subagent}")
        done < <(find "$sub" -name 'agent-*.jsonl' 2>/dev/null)
    fi
    printf '%s\n' "${names[@]}" | jq -Rsc --argjson at "$(date +%s)" --argjson max "$MAX_SUBS" \
        --argjson bg "$bg" \
        'split("\n") | map(select(length > 0)) as $helpers
         | ($bg | map(select(.working))) as $busy
         | ($bg | map(select(.working | not))) as $rest
         | {n: (($helpers | length) + ($busy | length)),
            names: ($helpers + ($busy | map(.name)) + ($rest | map("\(.name) · \(.state)")))[0:$max],
            helpers: $helpers[0:$max], hn: ($helpers | length),
            at: $at}'
}

# `claude agents --json`, cached for AGENTS_TTL seconds per config dir. Every status
# line refresh in every session lands here, and each call starts a full claude
# process (~150 MB plus a keychain lookup). Uncached, they pile up under memory
# pressure and can exhaust it. One caller refreshes behind a lock, with a hard
# timeout; the rest read the last result (or [] when there is none yet).
AGENTS_TTL=${AGENTS_TTL:-5}
agents_json() {
    local cfg=${CLAUDE_CONFIG_DIR:-$HOME/.claude} key f lock age claude tmp
    key=${cfg//[^A-Za-z0-9]/_}
    f="$CACHE/agents$key.json"; lock="${TMPDIR:-/tmp}/claude-desktop-agents$key.lock"
    age=$(( $(date +%s) - $(stat -f %m "$f" 2>/dev/null || echo 0) ))
    if (( age >= AGENTS_TTL )); then
        # A lock older than 30 s was left by a killed refresher: take it over.
        if [[ -d "$lock" ]] && (( $(date +%s) - $(stat -f %m "$lock" 2>/dev/null || echo 0) > 30 )); then
            rmdir "$lock" 2>/dev/null
        fi
        if mkdir "$lock" 2>/dev/null; then
            mkdir -p "$CACHE"
            claude=$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")
            tmp="$f.$$"
            if perl -e 'alarm shift; exec @ARGV' 10 "$claude" agents --json >"$tmp" 2>/dev/null \
               && jq -e 'type == "array"' "$tmp" >/dev/null 2>&1; then
                mv -f "$tmp" "$f"
            else
                rm -f "$tmp"; touch "$f" 2>/dev/null   # failed: back off a full TTL too
            fi
            rmdir "$lock" 2>/dev/null
        fi
    fi
    if jq -e 'type == "array"' "$f" >/dev/null 2>&1; then cat "$f"; else echo '[]'; fi
}

# `claude --bg` sessions attached to this terminal: its child terminals labelled
# claude.bg=<session id>. They keep their own transcripts, so subagents() can't see
# them; their state comes from `claude agents`. Prints [{id, address, name, working, state}].
attached() {
    local map claude
    map=$("$hc" ls --json 2>/dev/null | jq -r --arg me "$HC_TERMINAL_ID" \
            '.terminals[]? | select(.parent == $me and .state == "live") | .address' \
        | while IFS= read -r a; do
            "$hc" get "$a" --json 2>/dev/null | jq -c 'select(.labels["claude.bg"]) | {(.labels["claude.bg"]): .address}'
        done | jq -sc 'add // {}')
    [[ -z "$map" || "$map" == '{}' ]] && { echo '[]'; return; }
    agents_json | jq -c --argjson map "$map" '
        [.[] | select(.id and $map[.id])
         | {id, address: $map[.id], name: (.name // .id),
            working: (.status == "busy" or .state == "working"),
            state: (.status // .state // "idle")}]' || echo '[]'
}

# Background sessions never run the status line, so this builds the same payload from
# their job state and transcript (as claude-agents.sh does for the TUI) and runs it
# through this script with the child's terminal, giving each its own claude.stats.
# Skipped unless the transcript, state or cost changed. Spend is the session's /cost total,
# to the cent, as the sessions-sidebar plugin saves it; without that plugin, tokens.
child_labels() {
    local cfg=${CLAUDE_CONFIG_DIR:-$HOME/.claude} id addr state st sid tr last tok sig sigf cost
    cfg=${cfg/#\~/$HOME}
    while IFS=$'\t' read -r id addr state; do
        [[ -n "$id" ]] || continue
        st="$cfg/jobs/$id/state.json"; [[ -f "$st" ]] || continue
        sid=$(jq -r '.sessionId // empty' "$st")
        tr=$(ls "$cfg"/projects/*/"$sid".jsonl 2>/dev/null | head -1)
        [[ -f "$tr" ]] || continue
        cost=$(jq -r '.cost | select(. != null and . > 0)' "$cfg/sessions-sidebar/state/$sid.json" 2>/dev/null)
        sig="$(stat -f %m "$tr" 2>/dev/null)|$state|$cost"
        sigf="$CACHE/${addr//[^A-Za-z0-9]/_}.sig"
        [[ "$(cat "$sigf" 2>/dev/null)" == "$sig" ]] && continue
        last=$(grep '"type":"assistant"' "$tr" | tail -1)
        tok=$(grep '"type":"assistant"' "$tr" | jq -s '[.[].message.usage | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.output_tokens // 0)] | add // 0' 2>/dev/null)
        jq -n --slurpfile st "$st" --argjson last "${last:-null}" --arg tr "$tr" \
              --argjson now "$(date +%s)" --argjson tok "${tok:-0}" -f "$HOME/.config/herdr/claude-child-payload.jq" 2>/dev/null \
        | jq -c --arg cost "$cost" 'if $cost != "" then .cost.total_cost_usd = ($cost | tonumber) else . end' \
        | CLAUDE_BG_PARENT="$HC_TERMINAL_ID" CLAUDE_BG_STATE="$state" HC_TERMINAL_ID="$addr" "$0" >/dev/null 2>&1 \
        && { mkdir -p "$CACHE"; printf '%s' "$sig" > "$sigf"; }
    done < <(jq -r '.[] | [.id, .address, .state] | @tsv' <<<"$1")
}

if [[ "$1" == --watch ]]; then
    export HC_TERMINAL_ID=$2
    key=${2//[^A-Za-z0-9]/_}
    file="$CACHE/$key.json"
    lock="${TMPDIR:-/tmp}/claude-desktop-watch-$key"
    # One watcher per terminal; a lock left by a killed watcher is taken over.
    if ! mkdir "$lock" 2>/dev/null; then
        kill -0 "$(cat "$lock/pid" 2>/dev/null)" 2>/dev/null && exit 0
    fi
    echo $$ > "$lock/pid"
    trap 'rm -rf "$lock"' EXIT
    end=$(( $(date +%s) + 7200 ))    # 2 h at most
    while (( $(date +%s) < end )); do
        sleep 5
        [[ -f "$file" ]] || exit 0
        subs=$(subagents "$(jq -r '.tr // empty' "$file")") || exit 0
        new=$(jq -c --argjson s "$subs" '.subs = $s' "$file") || exit 0
        printf '%s' "$new" > "$file"
        label "$new"
        [[ "$(jq -r '.names | length' <<<"$subs")" == 0 ]] && exit 0
    done
    exit 0
fi

[[ -n "$HC_TERMINAL_ID" && -z "$HERDR_PANE_ID" && -x "$hc" ]] || exit 0
input=$(cat)
j() { jq -r "$1" <<<"$input" 2>/dev/null; }

# A background session inherits HC_TERMINAL_ID from the terminal that started it, so its
# own status line would overwrite that session's label. It has a job record named after its
# session id (its status line doesn't get CLAUDE_CODE_SESSION_KIND). Its stats come from child_labels.
if [[ -z "$CLAUDE_BG_PARENT" ]]; then
    bg_sid=$(j '.session_id // empty')
    bg_cfg=${CLAUDE_CONFIG_DIR:-$HOME/.claude}; bg_cfg=${bg_cfg/#\~/$HOME}
    [[ -n "$bg_sid" && "$(jq -r '.sessionId // empty' "$bg_cfg/jobs/${bg_sid:0:8}/state.json" 2>/dev/null)" == "$bg_sid" ]] && exit 0
fi

dir=$(j '.workspace.current_dir // empty')
transcript=$(j '.transcript_path // empty')

# Git: repo (of the common dir, so worktrees name their repo), branch, worktree or not
repo="" loc="br" branch=""
if [[ -n "$dir" ]] && git -C "$dir" rev-parse --show-toplevel >/dev/null 2>&1; then
    common=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
    repo=$(basename "$(dirname "$common")")
    branch=$(git -C "$dir" branch --show-current 2>/dev/null); branch=${branch:-detached}
    [[ "$(git -C "$dir" rev-parse --git-dir 2>/dev/null)" == */worktrees/* ]] && loc=wt
fi

# Remote Control: the payload doesn't say; the claude process's --remote-control
# flag, else remoteControlAtStartup in the settings (as claude-sidebar.sh).
rc=false
pid=$PPID
for _ in 1 2 3 4 5 6; do
    [[ -z "$pid" || "$pid" -le 1 ]] && break
    args=$(ps -o args= -p "$pid" 2>/dev/null)
    if [[ "$args" =~ (^|/)claude( |$) ]]; then
        [[ "$args" == *--remote-control* ]] && rc=true
        break
    fi
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
cfg=${CLAUDE_CONFIG_DIR:-$HOME/.claude}; cfg=${cfg/#\~/$HOME}
if [[ "$rc" == false ]]; then
    for f in "$cfg/settings.json" "$dir/.claude/settings.json" "$dir/.claude/settings.local.json"; do
        [[ -f "$f" ]] || continue
        v=$(jq -r 'if has("remoteControlAtStartup") then .remoteControlAtStartup|tostring else empty end' "$f" 2>/dev/null)
        [[ -n "$v" ]] && rc_setting=$v
    done
    [[ "$rc_setting" == "true" ]] && rc=true
fi

# Profile, for the account rate limits: ~/.claude-work -> work, ~/.claude-personal -> personal
profile=$(basename "$cfg"); profile=${profile#.claude}; profile=${profile#-}; profile=${profile:-default}

subs=$(subagents "$transcript")
now=$(date +%s)
json=$(jq -c --arg repo "$repo" --arg loc "$loc" --arg branch "$branch" --argjson rc "$rc" \
    --arg profile "$profile" --argjson subs "$subs" --arg tr "$transcript" --argjson now "$now" '{
    v: 1, at: $now, sid: .session_id, name: .session_name,
    start: ($now - (((.cost.total_duration_ms // 0) / 1000) | floor)),
    rc: $rc, repo: $repo, loc: $loc, branch: $branch, dir: .workspace.current_dir,
    model: ((.model.display_name // "Claude") | sub("^Claude "; "") | sub(" *\\([^)]*context\\)"; "")),
    effort: .effort.level,
    cost: .cost.total_cost_usd, tokens: .tokens_used,
    ctx: {size: (.context_window.context_window_size // 200000),
          pct: ((.context_window.used_percentage // 0) | floor)},
    cache: {warm: .prompt_cache.warm, exp: .prompt_cache.expires_at},
    rl: .rate_limits, rl_at: (if .rate_limits then $now else null end),
    profile: $profile, subs: $subs, tr: $tr
}' <<<"$input") || exit 0

mkdir -p "$CACHE"
file="$CACHE/${HC_TERMINAL_ID//[^A-Za-z0-9]/_}.json"
# A payload without rate limits (a session ending before its first reply) keeps the
# limits this terminal last saw, with when it saw them, for the same profile.
if [[ -f "$file" ]]; then
    json=$(jq -c --slurpfile prev "$file" '
        if .rl == null and $prev[0].rl != null and $prev[0].profile == .profile
        then .rl = $prev[0].rl | .rl_at = ($prev[0].rl_at // $prev[0].at) else . end' <<<"$json") || exit 0
fi
# An attached background session: names its parent and state, and shows the parent's
# account limits (same profile), since it has no status line of its own to report them.
if [[ -n "$CLAUDE_BG_PARENT" ]]; then
    limits=$(jq -c '{rl, rl_at}' "$CACHE/${CLAUDE_BG_PARENT//[^A-Za-z0-9]/_}.json" 2>/dev/null); [[ -n "$limits" ]] || limits='{}'
    json=$(jq -c --argjson limits "$limits" --arg parent "$CLAUDE_BG_PARENT" --arg state "$CLAUDE_BG_STATE" \
        '. + $limits + {parent: $parent, state: $state}' <<<"$json") || exit 0
fi
printf '%s' "$json" > "$file"
label "$json"
(( $(jq -r '.names | length' <<<"$subs") > 0 )) && nohup "$0" --watch "$HC_TERMINAL_ID" >/dev/null 2>&1 &
exit 0
