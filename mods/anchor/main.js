// ANCHOR: a calm sidebar that keeps one thing in front of you.
//
//   Right now      One line per tab. Coming back to a tab shows what you were doing there.
//   Timer          A bar that shrinks, in rough minutes rather than a ticking clock.
//   Needs you      Sessions that want you, the longest wait first. The first gets a full card.
//   Alongside you  Sessions getting on with it, folded away.
//   Parking lot    Type a stray thought, press Enter, and the keyboard returns to your pane.
//
// Colour never carries meaning alone, and nothing here flashes or pulses.
// With more than one machine, sessions on another one carry its name, and Spaces are grouped by machine.
// Everything is kept in shared state, so it survives restarts:
//   anchor.now     { <tab id>: { text, at } }       anchor.seen    { <tab id>: ms left the tab }
//   anchor.timer   { kind, start, end, told }       anchor.parked  [{ text, at }]
//   anchor.wins    { day, items: [{ text, at }] }   anchor.quiet   { zoomed: <pane id> | null }
//   anchor.alongside  true while that list is open
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { hc, agents, terminals, spaces, panes, run, openOverlay, notify, setAgentOrder, theme, shared, setShared, props, window as appWindow } from "herdr";

const NOW = "anchor.now";
const SEEN = "anchor.seen";
const TIMER = "anchor.timer";
const PARKED = "anchor.parked";
const WINS = "anchor.wins";
const QUIET = "anchor.quiet";
const ALONGSIDE = "anchor.alongside";

const MIN_MS = 60000;
const SIDEBAR = 304;
const GUTTER = 16;
const BAR_W = SIDEBAR - GUTTER * 2 - 1;   // the sidebar's width is fixed, and a shrinking bar needs pixels
const KEEP_TABS = 60;
const KEEP_PARKED = 200;
const BACK_AFTER_MS = 10 * MIN_MS;        // shorter absences don't need a reminder
const BACK_SHOWN_MS = 2 * MIN_MS;
const NUDGE_AFTER_MS = 90 * MIN_MS;
const NUDGE_SNOOZE_MS = 30 * MIN_MS;
const AWAY_MS = 10 * MIN_MS;              // this long away from the window counts as a break
const SLEPT_MS = 2 * MIN_MS;              // a longer gap between ticks means the machine slept
const STALE_S = 12 * 3600;
const SPACES_MAX_H = 180;               // the open Spaces list; past this it scrolls

const WORDS = {
  blocked: "Waiting for your answer",
  done: "Finished, have a look",
  working: "Working",
  idle: "Resting",
  detached: "Detached, click to reattach",
};
const SHORT = { detached: "Detached", blocked: "Waiting", done: "Finished", working: "Working", idle: "Resting" };
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };

const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const winsToday = () => { const w = shared(WINS); return w?.day === today() ? w.items : []; };
const roughly = (ms) => {
  const mins = Math.round(ms / MIN_MS);
  if (mins < 60) return `${Math.max(1, mins)} min`;
  const hours = Math.round(mins / 30) / 2;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
};
const ago = (ms) => (ms < MIN_MS ? "just now" : `${roughly(ms)} ago`);

function currentTab() {
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs?.find((x) => x.active) ?? null;
  return { space, tab, label: tab ? (tab.named ? tab.name : space.name) : "" };
}
const focusedPane = () => panes().find((p) => p.focused) ?? null;

// Quiet mode: only the current pane and your one thing. Leaving undoes only the zoom it added.
function setQuiet(on) {
  if (on) {
    const pane = focusedPane();
    const others = pane && panes().some((p) => p.tab === pane.tab && p.pane !== pane.pane);
    const zoom = others && !pane.zoomed;
    setShared(QUIET, { zoomed: zoom ? pane.pane : null });
    if (zoom) run("pane.zoom", { pane: pane.pane });
    run("layout.hide", { id: "tabs" });
  } else {
    const zoomed = shared(QUIET)?.zoomed;
    setShared(QUIET, null);
    if (zoomed && panes().find((p) => p.pane === zoomed)?.zoomed) run("pane.zoom", { pane: zoomed });
    run("layout.show", { id: "tabs" });
  }
}

// An attached session's pane can lose Claude (a restart, a crash) and fall back to a shell, while
// its old labels stay. Such a card is DETACHED, and clicking it reattaches: it only types when the
// pane is at a shell prompt, so anything else running there just gets focus.
const detachedFrom = (t) => {
  const fg = t.foreground;
  return Boolean(fg) && !(fg.argv ?? []).join(" ").includes("claude") && !/^\d+\.\d+\.\d+/.test(fg.name ?? "");
};
const atShell = (t) => /^-?(zsh|bash|fish|sh|dash)$/.test(String(t.foreground?.name ?? "").split("/").pop());
async function reattach(k) {
  run("pane.focus", { terminal: k.address });
  if (!k.shell || !/^[A-Za-z0-9_-]+$/.test(k.bg ?? "")) return;
  const profile = k.stats?.profile;
  const config = profile && profile !== "default" && /^[A-Za-z0-9_-]+$/.test(profile) ? `CLAUDE_CONFIG_DIR="$HOME/.claude-${profile}" ` : "";
  await hc(["keys", k.address, "ctrl+u"]);   // anything half-typed at the prompt
  const r = await hc(["send", k.address, `${config}claude attach ${k.bg}`]);
  if (r.code !== 0) notify({ title: "Couldn't reattach", body: (r.stderr || r.stdout || "").trim(), level: "error" });
}

// Attached background sessions, by their parent's address, as agent-shaped rows.
function bgChildren(all) {
  const out = new Map();
  for (const t of all) {
    const raw = t.labels?.["claude.stats"];
    if (!raw || !t.labels?.["claude.bg"] || t.state !== "live") continue;
    let s;
    try { s = JSON.parse(raw); } catch { continue; }
    if (!s.parent) continue;
    const machine = t.address.includes("/") ? `${t.address.split("/")[0]}/` : "";
    const key = `${machine}${s.parent}`;
    const status = detachedFrom(t) ? "detached" : s.state === "working" || s.state === "busy" ? "working" : /input|wait|block/.test(s.state ?? "") ? "blocked" : "idle";
    out.set(key, [...(out.get(key) ?? []), { address: t.address, app: "claude-code", status, shell: atShell(t), bg: t.labels["claude.bg"], stats: s, child: true }]);
  }
  for (const kids of out.values()) kids.sort((x, y) => String(x.stats.name ?? x.address).localeCompare(String(y.stats.name ?? y.address)));
  return out;
}

function claudeStats(all) {
  const out = new Map();
  for (const t of all) {
    const raw = t.labels?.["claude.stats"];
    if (!raw || t.state !== "live") continue;
    try { out.set(t.address, JSON.parse(raw)); } catch {}
  }
  return out;
}

// The machine a session lives on: the prefix of a remote address ("macmini/t4"), null for this one.
const machineOf = (address) => (String(address ?? "").includes("/") ? String(address).split("/")[0] : null);

function nameOf(a, s, sp) {
  if (s?.name) return s.name;
  for (const space of sp) for (const tab of space.tabs ?? []) if (tab.id === a.tab) return tab.named ? tab.name : space.name;
  return a.space_name || a.tab_name || a.address;
}

// The numbers stay out of sight until you hover.
function detailsTip(a, s, name, now) {
  const lines = [name, WORDS[a.status] ?? String(a.status ?? "")];
  if (machineOf(a.address)) lines.push(`On ${machineOf(a.address)}`);
  if (!s || a.status === "detached") return lines.join("\n");
  const old = now - (s.at ?? 0) > STALE_S ? " (old reading)" : "";
  lines.push(s.repo || "~");
  if (s.branch) lines.push(`${s.loc === "wt" ? "Worktree" : "Branch"}: ${s.branch}`);
  const spend = s.tokens != null && s.cost == null ? `${Math.floor(s.tokens / 1000)}k tokens` : `$${(s.cost ?? 0).toFixed(2)}`;
  lines.push(`${s.model ?? "claude"}${s.effort ? ` ${s.effort}` : ""} · ${spend}`);
  lines.push(`Context: ${100 - (s.ctx?.pct ?? 0)}% left${old}`);
  const five = s.rl?.five_hour;
  if (five && five.resets_at > now) lines.push(`5-hour limit: ${Math.round(100 - (five.used_percentage ?? 0))}% left${old}`);
  return lines.join("\n");
}

const actionInfo = (a, s) => ({ address: a.address, name: s?.name || a.address, bg: a.bg ?? null, sid: s?.sid ?? null, profile: s?.profile ?? null, dir: s?.dir ?? null });

export default class Anchor extends View {
  init(_props, cx) {
    if (props()?.bar) return;
    this.tabId = null;
    this.editTab = null;
    this.editing = false;
    this.shrinking = false;
    this.back = null;
    this.hovered = null;
    this.cheerUntil = 0;
    this.parkedUntil = 0;
    this.showSpaces = false;
    this.activeMs = 0;
    this.awayMs = 0;
    this.lastTick = Date.now();
    this.snoozeUntil = 0;
    this.lastPane = null;

    this.nowInput = InputState.new({ placeholder: "What's the one thing?" });
    this.nowInput.on("submit", () => this.finishEdit(true));
    this.nowInput.on("blur", () => this.finishEdit(false));

    this.parkInput = InputState.new({ placeholder: "Stray thought? Park it here" });
    this.parkFocused = false;
    this.parkInput.on("submit", (_e, cx) => { this.park(); cx.notify(); });
    this.parkInput.on("focus", (_e, cx) => { this.parkFocused = true; cx.notify(); });
    this.parkInput.on("blur", (_e, cx) => { this.parkFocused = false; cx.notify(); });

    let ticks = 0;
    cx.timer.every(1000, (cx) => {
      const redraw = this.tick();
      if (redraw || ++ticks % 15 === 0) cx.notify();
    });
  }

  // True while something on screen is moving.
  tick() {
    const now = Date.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    if (dt > SLEPT_MS) this.activeMs = 0;
    else if (appWindow()?.active) { this.activeMs += dt; this.awayMs = 0; }
    else {
      this.awayMs += dt;
      if (this.awayMs >= AWAY_MS) this.activeMs = 0;
    }
    const timer = shared(TIMER);
    if (timer && !timer.told && timer.end <= now) {
      setShared(TIMER, { ...timer, told: true });
      if (timer.kind === "break") notify({ title: "Break's over", body: this.nowText() || "Pick one small thing.", level: "info" });
      else notify({ title: "Time's up", body: "Keep going, or take a break?", level: "info" });
    }
    return Boolean(timer && !timer.told) || (this.back && this.back.until <= now) || this.cheerUntil > 0 || this.parkedUntil > 0;
  }

  nowText() {
    return shared(NOW)?.[this.tabId]?.text ?? "";
  }

  // Each tab keeps its own line, and returning after a while says how long it's been.
  trackTab(id) {
    if (id === this.tabId) return;
    const now = Date.now();
    const seen = { ...(shared(SEEN) ?? {}) };
    const gap = id && seen[id] ? now - seen[id] : 0;
    if (this.tabId) {
      seen[this.tabId] = now;
      const old = Object.keys(seen).sort((x, y) => seen[y] - seen[x]).slice(KEEP_TABS);
      for (const k of old) delete seen[k];
      setShared(SEEN, seen);
    }
    this.tabId = id;
    this.back = gap >= BACK_AFTER_MS ? { gap, until: now + BACK_SHOWN_MS } : null;
  }

  saveNow(tab, text) {
    if (!tab) return;
    const all = { ...(shared(NOW) ?? {}) };
    const clean = text.trim();
    if (clean) all[tab] = { text: clean, at: Date.now() };
    else delete all[tab];
    const old = Object.keys(all).sort((x, y) => (all[y].at ?? 0) - (all[x].at ?? 0)).slice(KEEP_TABS);
    for (const k of old) delete all[k];
    setShared(NOW, all);
  }

  startEdit(shrinking = false) {
    const text = this.nowText();
    this.editing = true;
    this.editTab = this.tabId;
    this.shrinking = shrinking;
    this.nowInput.set_value(text);
    if (shrinking && text) this.nowInput.set_selected_range({ start: 0, end: text.length });
    this.nowInput.focus();
  }

  finishEdit(backToPane) {
    if (!this.editing) return;
    this.editing = false;
    this.shrinking = false;
    this.back = null;
    this.saveNow(this.editTab, this.nowInput.value());
    if (backToPane) this.backToPane();
  }

  backToPane() {
    if (this.lastPane) run("pane.focus", { pane: this.lastPane });
  }

  // Starting is often the hard part: make the task smaller and give it five minutes.
  stuck() {
    if (!shared(TIMER)) this.startTimer("focus", 5);
    this.startEdit(true);
  }

  finishThing() {
    const text = this.nowText();
    if (!text) return;
    setShared(WINS, { day: today(), items: [...winsToday(), { text, at: Date.now() }] });
    this.saveNow(this.tabId, "");
    this.back = null;
    this.cheerUntil = Date.now() + 5000;
  }

  startTimer(kind, mins) {
    const now = Date.now();
    setShared(TIMER, { kind, start: now, end: now + mins * MIN_MS, told: false });
    if (kind === "break") { this.activeMs = 0; this.snoozeUntil = 0; }
  }

  extendTimer(mins) {
    const timer = shared(TIMER);
    if (!timer) return;
    const now = Date.now();
    setShared(TIMER, { ...timer, start: timer.told ? now : timer.start, end: Math.max(now, timer.end) + mins * MIN_MS, told: false });
  }

  park() {
    const text = this.parkInput.value().trim();
    if (!text) return this.backToPane();
    setShared(PARKED, [{ text, at: Date.now() }, ...(shared(PARKED) ?? [])].slice(0, KEEP_PARKED));
    this.parkInput.set_value("");
    this.parkedUntil = Date.now() + 2500;
    this.backToPane();
  }

  unpark(item) {
    setShared(PARKED, (shared(PARKED) ?? []).filter((p) => p.at !== item.at));
  }

  // A parked thought becomes the one thing; the line it replaces is parked, not lost.
  promote(item) {
    const current = this.nowText();
    const rest = (shared(PARKED) ?? []).filter((p) => p.at !== item.at);
    setShared(PARKED, current ? [{ text: current, at: Date.now() }, ...rest] : rest);
    this.saveNow(this.tabId, item.text);
    this.back = null;
  }

  go(a) {
    if (a.status === "detached") return reattach(a);
    run(a.child ? "pane.focus" : "agent.focus", { terminal: a.address });
  }

  // ---- small parts ----

  pill(id, label, action, { primary = false, tip = null } = {}) {
    const t = theme();
    return h_flex().id(id).h(26).px(10).flex_none().items_center().justify_center().rounded(7).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.85))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(label);
  }

  sectionTitle(text, right = null) {
    const t = theme();
    return h_flex().w_full().h(18).flex_none().items_center().gap(6)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.muted).child(text))
      .when(Boolean(right), (el) => el.child(right));
  }

  dot(status) {
    const t = theme();
    return div().size(8).flex_none().rounded_full().bg(t[status] ?? t.idle);
  }

  iconChip(id, icon, tip, action) {
    const t = theme();
    return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.muted)
      .cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); action(); })
      .child(typeof icon === "string" && icon.endsWith(".svg") ? svg(icon).size(12) : icon);
  }

  sessionButtons(a, s, kids) {
    const open = (action) => openOverlay({ mod: "session-actions", kind: "dialog", modal: true, width: 480, height: 300, props: { action, session: actionInfo(a, s), kids: kids.map((k) => actionInfo(k, k.stats)) } });
    return h_flex().flex_none().gap(2)
      .when(s?.loc === "wt" && Boolean(s?.dir), (el) => el.child(this.iconChip(`act-wt-${a.address}`, "mods/anchor/bin.svg", "Close this session and delete its worktree", () => open("worktree"))))
      .child(this.iconChip(`act-close-${a.address}`, "mods/pane/close.svg", "Close this session", () => open("close")));
  }

  // ---- the top bar: its block drags the window, so buttons stop the press ----

  bar(t) {
    const quiet = Boolean(shared(QUIET));
    const stop = (_e, cx) => cx.stop_propagation();
    const icon = (id, path, tip, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stop).on_click(action).child(svg(path).size(14));
    return h_flex().size_full().bg(t.chrome).pl(appWindow()?.platform === "macos" && !appWindow()?.fullscreen ? 84 : GUTTER).pr(10).gap(4).items_center()
      .child(div().flex_1().min_w(0))
      .child(h_flex().id("anchor-quiet").h(24).px(9).flex_none().items_center().rounded(6).text_size(12).font_medium()
        .bg(quiet ? t.selected : t.chrome).text_color(quiet ? t.accent : t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(quiet ? "Bring everything back" : "Hide everything except this pane and your one thing")
        .on_mouse_down("left", stop).on_click(() => setQuiet(!quiet))
        .child(quiet ? "Leave quiet" : "Quiet"))
      .child(icon("anchor-find", "mods/workspace-chrome/search.svg", "Find a session, tab or file", () => run("mod.open", { name: "picker" })))
      .child(icon("anchor-settings", "mods/workspace-chrome/settings.svg", "Settings", () => run("app.settings")));
  }

  // ---- right now ----

  nowSection(t, label) {
    const text = this.nowText();
    const now = Date.now();
    const cheering = this.cheerUntil > now;
    if (!cheering) this.cheerUntil = 0;
    const back = this.back && this.back.until > now && text ? this.back : null;
    if (this.back && this.back.until <= now) this.back = null;
    const wins = winsToday();
    const title = this.shrinking ? "What's the tiniest next step?" : label ? `Right now, in ${label}` : "Right now";
    return v_flex().w_full().flex_none().px(GUTTER).pt(4).pb(12).gap(8)
      .child(this.sectionTitle(title))
      .when(Boolean(back), (el) => el.child(div().text_size(12).text_color(t.accent).child(`Welcome back. You left this ${roughly(back.gap)} ago, and you were doing:`)))
      .when(this.editing, (el) => el.child(Input.new(this.nowInput).w_full().h(38).flex_none().px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(14).text_color(t.foreground)))
      .when(!this.editing, (el) => el.child(div().id("anchor-now-text").w_full().min_h(38).py(2).cursor_text().rounded(6)
        .hover((s) => s.opacity(0.85))
        .tooltip("Click to edit")
        .on_click((_e, cx) => { this.startEdit(); cx.notify(); })
        .when(Boolean(text), (e) => e.text_size(17).font_semibold().line_height("24px").text_color(t.foreground).child(text))
        .when(!text, (e) => e.text_size(17).line_height("24px").text_color(t.dim).child(cheering ? "Nice. That's done." : "What's the one thing?"))))
      .when(this.editing && this.shrinking, (el) => el.child(div().text_size(12).text_color(t.muted).child("Something you could do in two minutes. Enter when ready.")))
      .when(!this.editing, (el) => el.child(h_flex().w_full().gap(6).items_center()
        .when(Boolean(text), (e) => e.child(this.pill("anchor-done", "Done", () => this.finishThing(), { primary: true, tip: "Mark it done and count it for today" })))
        .child(this.pill("anchor-stuck", "Stuck?", (cx) => { this.stuck(); cx.notify(); }, { tip: "Shrink it to a tiny step and start five minutes" }))
        .child(div().flex_1().min_w(0))
        .when(wins.length > 0, (e) => e.child(div().id("anchor-wins").flex_none().text_size(12).text_color(t.muted)
          .tooltip(["Finished today:", ...wins.map((w) => `• ${w.text}`)].join("\n"))
          .child(`${wins.length} done today`)))));
  }

  // ---- the timer ----

  timerSection(t) {
    const timer = shared(TIMER);
    const now = Date.now();
    const box = () => v_flex().w_full().flex_none().px(GUTTER).py(12).gap(8).border_t(1).border_color(t.border);
    if (!timer) {
      return box()
        .child(this.sectionTitle("Give it"))
        .child(h_flex().w_full().gap(6)
          .child(this.pill("anchor-t5", "5 min", () => this.startTimer("focus", 5), { tip: "Starting is the hard part. Just five minutes." }))
          .child(this.pill("anchor-t15", "15 min", () => this.startTimer("focus", 15)))
          .child(this.pill("anchor-t25", "25 min", () => this.startTimer("focus", 25))));
    }
    const rest = timer.kind === "break";
    if (timer.told || timer.end <= now) {
      return box()
        .child(div().text_size(13).font_medium().text_color(t.foreground).child(rest ? "Break's over." : "Time's up. How's it going?"))
        .child(h_flex().w_full().gap(6)
          .when(rest, (el) => el.child(this.pill("anchor-t-back", "Back to it", () => setShared(TIMER, null), { primary: true })))
          .when(!rest, (el) => el.child(this.pill("anchor-t-more", "5 more", () => this.extendTimer(5), { primary: true }))
            .child(this.pill("anchor-t-break", "Break 5", () => this.startTimer("break", 5)))
            .child(this.pill("anchor-t-stop", "Stop", () => setShared(TIMER, null)))));
    }
    const left = timer.end - now;
    const frac = Math.max(0, Math.min(1, left / (timer.end - timer.start)));
    const word = left < MIN_MS ? "under a minute left" : `about ${roughly(left)} left`;
    return box()
      .child(this.sectionTitle(rest ? "Break. Look away from the screen." : "Focus time"))
      .child(div().id("anchor-timer-bar").w(BAR_W).h(10).rounded(5).bg(t.raised).overflow_hidden().tooltip(word)
        .child(div().h_full().w(Math.max(frac > 0 ? 4 : 0, Math.round(BAR_W * frac))).rounded(5).bg(rest ? t.done : t.accent)))
      .child(h_flex().w_full().gap(6).items_center()
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).child(word))
        .when(!rest, (el) => el.child(this.pill("anchor-t-plus", "+5", () => this.extendTimer(5), { tip: "Five more minutes" })))
        .child(this.pill("anchor-t-end", "Stop", () => setShared(TIMER, null))));
  }

  // ---- a long stretch: said once, easy to wave away ----

  nudgeSection(t) {
    if (this.activeMs < NUDGE_AFTER_MS || Date.now() < this.snoozeUntil || shared(TIMER)?.kind === "break") return null;
    return v_flex().w_full().flex_none().px(GUTTER).py(10).gap(8).bg(t.surface).border_t(1).border_color(t.border)
      .child(div().text_size(12.5).text_color(t.foreground).child(`You've been at it for about ${roughly(this.activeMs)}. Water? Stretch?`))
      .child(h_flex().gap(6)
        .child(this.pill("anchor-n-break", "Break 5", () => this.startTimer("break", 5), { primary: true }))
        .child(this.pill("anchor-n-later", "Later", (cx) => { this.snoozeUntil = Date.now() + NUDGE_SNOOZE_MS; cx.notify(); })));
  }

  // ---- sessions ----

  // The other machine's name beside a session on it; nothing for this one, or with only one machine.
  machineTag(address, t) {
    const m = machineOf(address);
    if (!m || !this.multi) return null;
    return div().flex_none().max_w(80).truncate().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(m);
  }

  sessionCard(a, s, kids, sp, now, focusedTerm, t) {
    const name = nameOf(a, s, sp);
    const here = a.address === focusedTerm;
    const hovered = this.hovered === a.address;
    return v_flex().id(`anchor-card-${a.address}`).w_full().flex_none().p(10).gap(6).rounded(9).border_1().border_color(t[a.status] ?? t.border).bg(t.surface)
      .cursor_pointer().hover((x) => x.bg(t.raised))
      .on_hover((on, cx) => { if (on) this.hovered = a.address; else if (hovered) this.hovered = null; cx.notify(); })
      .on_click(() => this.go(a))
      .child(h_flex().w_full().gap(7).items_center()
        .child(this.dot(a.status))
        .child(div().id(`anchor-card-name-${a.address}`).flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(t.foreground).tooltip(detailsTip(a, s, name, now)).child(name))
        .children([this.machineTag(a.address, t)].filter(Boolean))
        .when(hovered, (el) => el.child(this.sessionButtons(a, s, kids))))
      .child(div().text_size(12).text_color(t[a.status] ?? t.muted).child(WORDS[a.status] ?? String(a.status ?? "")))
      .when(Boolean(s?.repo), (el) => el.child(div().w_full().truncate().text_size(11.5).text_color(t.muted).child(`${s.repo}${s.branch ? ` · ${s.branch}` : ""}`)))
      .when(here, (el) => el.child(div().text_size(11.5).text_color(t.muted).child("You're here")));
  }

  sessionRow(a, s, kids, sp, now, focusedTerm, t) {
    const name = nameOf(a, s, sp);
    const hovered = this.hovered === a.address;
    return h_flex().id(`anchor-row-${a.address}`).w_full().h(28).flex_none().px(6).gap(7).items_center().rounded(6)
      .when(a.address === focusedTerm, (el) => el.bg(t.selected))
      .when(Boolean(a.child), (el) => el.pl(20))
      .cursor_pointer().hover((x) => x.bg(t.hover))
      .on_hover((on, cx) => { if (on) this.hovered = a.address; else if (hovered) this.hovered = null; cx.notify(); })
      .on_click(() => this.go(a))
      .child(this.dot(a.status))
      .child(div().id(`anchor-row-name-${a.address}`).flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).tooltip(detailsTip(a, s, name, now)).child(name))
      .children([this.machineTag(a.address, t)].filter(Boolean))
      .when(hovered, (el) => el.child(this.sessionButtons(a, s, kids)))
      .when(!hovered, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.muted).child(SHORT[a.status] ?? String(a.status ?? ""))));
  }

  // Parents with their attached sessions under them, whichever list each one lands in.
  gather() {
    const all = terminals();
    const kids = bgChildren(all);
    const flat = [...kids.values()].flat();
    const nested = new Set(flat.map((k) => k.address));
    const parents = agents().filter((a) => !nested.has(a.address));
    const stats = claudeStats(all);
    const everyone = parents.flatMap((a) => [a, ...(kids.get(a.address) ?? [])]);
    const orphans = flat.filter((k) => !everyone.includes(k));
    return { kids, stats, everyone: [...everyone, ...orphans] };
  }

  queueSection(t, gathered, sp, focusedTerm) {
    const { kids, stats, everyone } = gathered;
    const now = Math.floor(Date.now() / 1000);
    const needs = everyone.filter((a) => a.status === "blocked" || a.status === "done")
      .sort((x, y) => (RANK[x.status] - RANK[y.status]) || ((x.seq ?? 0) - (y.seq ?? 0)));
    const quiet = everyone.filter((a) => !needs.includes(a));
    const open = Boolean(shared(ALONGSIDE));
    const kidsOf = (a) => kids.get(a.address) ?? [];
    const row = (a) => this.sessionRow(a, stats.get(a.address) ?? a.stats, kidsOf(a), sp, now, focusedTerm, t);
    return v_flex().id("anchor-queue").w_full().flex_1().min_h(0).px(GUTTER).py(12).gap(8).border_t(1).border_color(t.border).overflow_y_scrollbar()
      .child(this.sectionTitle(needs.length > 1 ? `Needs you · ${needs.length}` : "Needs you"))
      .when(needs.length === 0, (el) => el.child(div().flex_none().text_size(12.5).text_color(t.muted).child("Nothing right now. Stay with your one thing.")))
      .when(needs.length > 0, (el) => el.child(this.sessionCard(needs[0], stats.get(needs[0].address) ?? needs[0].stats, kidsOf(needs[0]), sp, now, focusedTerm, t)))
      .children(needs.slice(1).map(row))
      .when(quiet.length > 0, (el) => el.child(h_flex().id("anchor-alongside").w_full().h(26).flex_none().mt(2).gap(6).items_center().rounded(6).cursor_pointer()
        .hover((x) => x.bg(t.hover)).tooltip(open ? "Fold this list" : "Show these sessions")
        .on_click(() => setShared(ALONGSIDE, !open))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.muted).child(`Alongside you · ${quiet.length}`))
        .child(div().flex_none().w(16).text_center().text_size(13).text_color(t.muted).child(open ? "–" : "+"))))
      .when(open, (el) => el.children(quiet.map(row)));
  }

  // In quiet mode the list is hidden, so all that shows is whether something's waiting.
  quietSummary(t, gathered) {
    const waiting = gathered.everyone.filter((a) => a.status === "blocked" || a.status === "done");
    return v_flex().w_full().flex_1().min_h(0).px(GUTTER).py(12).gap(8).border_t(1).border_color(t.border)
      .when(waiting.length === 0, (el) => el.child(div().text_size(12).text_color(t.dim).child("All quiet.")))
      .when(waiting.length > 0, (el) => el.child(h_flex().id("anchor-quiet-waiting").w_full().gap(7).items_center().cursor_pointer().rounded(6)
        .hover((x) => x.bg(t.hover)).tooltip("Leave quiet mode and go there")
        .on_click(() => { setQuiet(false); this.go(waiting[0]); })
        .child(this.dot(waiting[0].status))
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(waiting.length === 1 ? "1 session needs you" : `${waiting.length} sessions need you`))));
  }

  // ---- the parking lot ----

  parkSection(t, showList) {
    const parked = shared(PARKED) ?? [];
    const now = Date.now();
    const saved = this.parkedUntil > now;
    if (!saved) this.parkedUntil = 0;
    const title = saved ? "Parked. Back to it." : parked.length ? `Parking lot · ${parked.length}` : "Parking lot";
    return v_flex().w_full().flex_none().px(GUTTER).py(12).gap(8).border_t(1).border_color(t.border)
      .child(this.sectionTitle(title))
      .child(Input.new(this.parkInput).w_full().h(32).flex_none().px(10).items_center().rounded(7).border_1()
        .border_color(this.parkFocused ? t.accent : t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
      .when(showList && parked.length > 0, (el) => el.child(v_flex().id("anchor-parked").w_full().max_h(112).gap(1).overflow_y_scrollbar()
        .children(parked.map((p) => {
          const key = `park-${p.at}`;
          const hovered = this.hovered === key;
          return h_flex().id(key).w_full().h(26).flex_none().gap(4).items_center().rounded(5).px(4).hover((x) => x.bg(t.hover))
            .on_hover((on, cx) => { if (on) this.hovered = key; else if (hovered) this.hovered = null; cx.notify(); })
            .child(div().id(`${key}-text`).flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).tooltip(`${p.text}\nParked ${ago(now - p.at)}`).child(p.text))
            .when(hovered, (e) => e.child(this.iconChip(`${key}-up`, "↑", "Make this my one thing", () => this.promote(p)))
              .child(this.iconChip(`${key}-x`, "mods/pane/close.svg", "Remove", () => this.unpark(p))));
        }))));
  }

  // ---- spaces, folded down to one line ----

  // Spaces in Herdr's order, grouped by machine: this one first, the others as they first appear.
  byMachine(sp) {
    const groups = new Map([[null, []]]);
    for (const s of sp) { const m = s.machine ?? null; if (!groups.has(m)) groups.set(m, []); groups.get(m).push(s); }
    return [...groups].filter(([, list]) => list.length);
  }

  spacesSection(t, sp) {
    const active = sp.find((s) => s.active);
    const others = sp.filter((s) => !s.active);
    const waiting = others.filter((s) => s.status === "blocked" || s.status === "done").length;
    // As tall as its spaces, up to SPACES_MAX_H; past that it scrolls, with the bar always shown.
    const groups = this.byMachine(sp);
    const listH = Math.min(SPACES_MAX_H, sp.length * 27 + (this.multi ? groups.length * 21 : 0) + 4);
    return v_flex().w_full().flex_none().px(10).py(4).border_t(1).border_color(t.border)
      .when(this.showSpaces, (el) => el.child(v_flex().w_full().h(listH).flex_none().pb(4).child(v_flex().id("anchor-spaces").w_full().flex_1().min_h(0).gap(1).overflow_y_scrollbar().mode("always")
        .children(groups.flatMap(([m, list]) => [
          ...(this.multi ? [div().w_full().h(20).flex_none().px(6).pt(4).text_size(10.5).font_medium().text_color(t.dim).child(m ?? "This Mac")] : []),
          ...list.map((s) => h_flex().id(`anchor-space-${s.id}`).w_full().h(26).flex_none().px(6).gap(7).items_center().rounded(6)
          .bg(s.active ? t.selected : t.chrome).cursor_pointer().hover((x) => x.bg(t.hover))
          .on_click((_e, cx) => { run("space.select", { id: s.id }); this.showSpaces = false; cx.notify(); })
          .child(this.dot(s.status ?? "idle"))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(s.name)))])))))
      .child(h_flex().id("anchor-space-toggle").w_full().h(26).px(6).gap(6).items_center().rounded(6).cursor_pointer().hover((x) => x.bg(t.hover))
        .tooltip(this.showSpaces ? "Fold spaces" : "Switch space")
        .on_click((_e, cx) => { this.showSpaces = !this.showSpaces; cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(active?.name ?? "Spaces"))
        .when(Boolean(this.multi && active?.machine), (el) => el.child(this.machineTag(`${active.machine}/`, t)))
        .when(waiting > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.blocked).child(`${waiting} waiting`)))
        .when(others.length > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(`+${others.length}`))));
  }

  render() {
    const t = theme();
    if (props()?.bar) return this.bar(t);
    const sp = spaces();
    this.multi = new Set(sp.map((s) => s.machine ?? null)).size > 1;
    const { tab, label } = currentTab();
    this.trackTab(tab?.id ?? null);
    const focused = focusedPane();
    if (focused) this.lastPane = focused.pane;
    const focusedTerm = focused?.terminal ?? null;
    const gathered = this.gather();
    const parents = gathered.everyone.filter((a) => !a.child);
    setAgentOrder([...parents].sort((x, y) => (RANK[x.status] ?? 9) - (RANK[y.status] ?? 9)).map((a) => a.address));
    const quiet = Boolean(shared(QUIET));
    return v_flex().id("anchor").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(this.nowSection(t, label))
      .child(this.timerSection(t))
      .children([this.nudgeSection(t)].filter(Boolean))
      .child(quiet ? this.quietSummary(t, gathered) : this.queueSection(t, gathered, sp, focusedTerm))
      .child(this.parkSection(t, !quiet))
      .when(!quiet, (el) => el.child(this.spacesSection(t, sp)));
  }
}
