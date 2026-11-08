# Builds a Claude status-line-shaped payload for a background session, from its
# job state ($st[0]), last assistant transcript entry ($last) and transcript path.
# Used by claude-agents.sh (child_stats) to feed claude-sidebar.sh.
def mname:
  if . == null or . == "" then "Claude"
  else (capture("claude-(?<f>[a-z]+)-(?<a>[0-9]+)-(?<b>[0-9]+)") // null) as $m
    | if $m then ($m.f[0:1] | ascii_upcase) + $m.f[1:] + " " + $m.a + "." + $m.b else . end
  end;
def epoch: if . == null then null else (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) end;

$st[0] as $s
| ($last.message.usage // {}) as $u
| (($u.input_tokens // 0) + ($u.cache_read_input_tokens // 0) + ($u.cache_creation_input_tokens // 0)) as $used
| (($last.message.model // "") | test("opus")) as $opus
# Window size isn't recorded: Opus sessions run with 1M here, others 200k
| (if $used > 200000 or $opus then 1000000 else 200000 end) as $win
| ($s.respawnFlags // []) as $fl
| ([range(0; $fl | length) | select($fl[.] == "--effort") | $fl[. + 1]] | first) as $effort
| ($last.timestamp | epoch) as $lt
| (if (($u.cache_creation.ephemeral_5m_input_tokens // 0) > 0) and (($u.cache_creation.ephemeral_1h_input_tokens // 0) == 0) then 300 else 3600 end) as $ttl
| (($s.createdAt | epoch) // $now) as $created
| {
    session_id: $s.sessionId,
    session_name: ($s.name // null),
    transcript_path: $tr,
    workspace: {current_dir: ($s.worktreePath // $s.cwd)},
    model: {display_name: ($last.message.model | mname)},
    effort: (if $effort then {level: $effort} else null end),
    cost: {total_duration_ms: (($now - $created) * 1000)},
    tokens_used: $tok,
    context_window: {context_window_size: $win, used_percentage: ($used * 100 / $win | floor)},
    prompt_cache: (if $lt then {warm: (($lt + $ttl) > $now), expires_at: ($lt + $ttl)} else null end)
  }
