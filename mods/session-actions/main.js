// session-actions: the dialog behind the Close and Delete worktree buttons on agent cards.
// Opened with props { action: "close" | "worktree", session, kids }, where session and each
// kid are { address, name, bg, sid, profile, dir }. Nothing happens until Confirm.
//
// Herdr's own `worktree` dialog isn't used for removal: it closes the whole space first (and
// with no space id, whichever is focused), which would end unrelated tabs. This removes the
// one worktree, and refuses while anything outside this session group is using it.
// A stopped background session keeps its conversation; the worktree's branch stays.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, exec, terminals } from "herdr";

const machineOf = (address) => (address.includes("/") ? address.split("/")[0] : null);
const localId = (address) => (address.includes("/") ? address.split("/").slice(1).join("/") : address);
const inside = (path, top) => path === top || (path ?? "").startsWith(`${top}/`);

// The profile's config dir under $HOME: "personal" is .claude-personal, none is .claude.
function configDir(profile) {
  if (!profile || profile === "default" || !/^[A-Za-z0-9_-]+$/.test(profile)) return ".claude";
  return `.claude-${profile}`;
}

// claude isn't always on the PATH Herdr's exec gets, and each profile has its own sessions.
const CLAUDE = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; CLAUDE_CONFIG_DIR="$HOME/$1"; export CLAUDE_CONFIG_DIR; shift; exec claude "$@"';
const claude = (args, profile, on) => exec("sh", ["-c", CLAUDE, "sh", configDir(profile), ...args], { on });

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

export default class SessionActions extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.busy = false;
    this.error = "";
    this.blocked = "";
    this.dirty = false;
    this.repo = null;
    const p = props() ?? {};
    this.on = machineOf(p.session?.address ?? "");
    this.closing = [p.session, ...(p.kids ?? [])].filter(Boolean);
    // Terminals that terminal.kill would end along with these, beyond the sessions listed.
    const addresses = new Set(this.closing.map((s) => s.address));
    this.alsoEnds = terminals()
      .filter((t) => t.state === "live" && t.parent && !addresses.has(t.address) && addresses.has(t.parent))
      .map((t) => t.name || t.template || t.program?.name || t.address);
    this.ready = p.action !== "worktree";
    if (p.action === "worktree") {
      cx.spawn(async (cx) => {
        // Anything that can't be checked counts as a reason not to delete.
        try { await this.inspect(p); } catch (error) { this.blocked = `Could not check the worktree: ${error}`; }
        this.ready = true;
        cx.notify();
      });
    }
  }

  // What removing this worktree would touch. Sets this.blocked if it shouldn't go ahead.
  async inspect(p) {
    const dir = p.session?.dir;
    if (!dir) { this.blocked = "This session hasn't reported its folder yet."; return; }
    const top = await git(dir, ["rev-parse", "--show-toplevel"], this.on);
    const gitDir = await git(dir, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"], this.on);
    const common = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], this.on);
    if (!top.ok || !gitDir.ok || !common.ok) { this.blocked = `${dir} is not in a git repository.`; return; }
    if (gitDir.out === common.out) { this.blocked = "This is the repository's main checkout, not a worktree."; return; }
    const branch = await git(top.out, ["branch", "--show-current"], this.on);
    this.repo = { top: top.out, main: common.out.replace(/\/\.git$/, ""), branch: branch.out };
    if (!this.repo.main || this.repo.main === common.out) { this.blocked = `Could not find the main checkout of ${top.out}.`; return; }
    this.dirty = (await this.status()) !== "";
    // git needs --force for submodules, which can lose commits: Herdr's space menu handles those.
    const mods = await exec("test", ["-e", `${top.out}/.gitmodules`], { on: this.on });
    if (mods.code === 0) { this.blocked = "This worktree has submodules. Use Remove worktree in the space menu, which checks them."; return; }
    // Anyone else in the folder: a terminal, or a session with no terminal attached.
    const closing = new Set(this.closing.map((s) => s.address));
    const sids = new Set(this.closing.map((s) => s.sid).filter(Boolean));
    const users = terminals()
      .filter((t) => t.state === "live" && machineOf(t.address) === this.on && !closing.has(t.address) && inside(t.foreground?.cwd ?? t.cwd, top.out))
      .map((t) => t.name || t.program?.name || t.address);
    const listed = await claude(["agents", "--json"], p.session.profile, this.on);
    if (listed.code !== 0) { this.blocked = `Could not list sessions: ${listed.stderr.trim() || "claude agents failed"}`; return; }
    for (const s of JSON.parse(listed.stdout || "[]")) {
      if (!sids.has(s.sessionId) && inside(s.cwd, top.out)) users.push(s.name || s.sessionId || "a session");
    }
    if (users.length) this.blocked = `Still in use by: ${[...new Set(users)].join(", ")}. Close those first.`;
  }

  async status() {
    const r = await git(this.repo.top, ["--no-optional-locks", "status", "--porcelain"], this.on);
    if (!r.ok) throw new Error(r.err || "git status failed");
    return r.out;
  }

  // Stops the kids before their parent. The first failure stops everything after it.
  async closeAll(session, kids) {
    for (const s of [...kids, session]) {
      if (s.bg) {
        const stopped = await claude(["stop", s.bg], s.profile, machineOf(s.address));
        if (stopped.code !== 0) throw new Error(`${s.name}: ${stopped.stderr.trim() || "claude stop failed"}`);
      }
      run("terminal.kill", { terminal: s.address });
    }
  }

  async confirm(cx) {
    if (this.busy || !this.ready || this.blocked) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    const p = props();
    let closed = false;
    try {
      if (p.action === "worktree") {
        // New changes since the warning was shown need their own consent.
        const changes = await this.status();
        if (changes && !this.dirty) {
          this.dirty = true;
          throw new Error("It has new uncommitted changes. Confirm again to delete them too.");
        }
      }
      await this.closeAll(p.session, p.kids ?? []);
      closed = true;
      if (p.action === "worktree") {
        const args = ["worktree", "remove", ...(this.dirty ? ["--force"] : []), this.repo.top];
        const r = await git(this.repo.main, args, this.on);
        if (!r.ok) throw new Error(r.err || "git worktree remove failed");
      }
      closeOverlay(p.overlay);
    } catch (error) {
      this.error = closed ? `The session is closed, but the worktree is still there. ${error.message ?? error}` : `${error.message ?? error}`;
      this.busy = false;
      cx.notify();
    }
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const remove = p.action === "worktree";
    const s = p.session ?? {};
    const kids = p.kids ?? [];
    const line = (text, color = t.muted) => div().text_color(color).child(text);
    const resume = s.bg ? `Its conversation is kept: claude attach ${s.bg}.` : "Its conversation is kept: claude --resume.";
    const button = (id, label, bg, fg, enabled, onClick) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(id === "no" ? t.input : bg).bg(bg).text_color(fg)
      .when(enabled, (el) => el.cursor_pointer().hover((x) => x.opacity(0.88)).on_click(onClick))
      .when(!enabled, (el) => el.opacity(0.45))
      .child(label);
    const canConfirm = this.ready && !this.blocked && !this.busy;
    return v_flex()
      .id("session-actions")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") cx.spawn(async (cx) => this.confirm(cx));
        else if (e.key === "escape") { if (!this.busy) closeOverlay(p.overlay); }
        else return;
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(remove ? `Close ${s.name} and delete its worktree?` : `Close ${s.name}?`))
      .child(v_flex().flex_1().min_h(0).gap(6).overflow_y_scrollbar()
        .child(line(`This ends the session. ${resume}`))
        .when(kids.length > 0, (el) => el.child(line(`It also stops ${kids.length === 1 ? "its attached session" : `its ${kids.length} attached sessions`}: ${kids.map((k) => k.name).join(", ")}.`, t.blocked)))
        .when(this.alsoEnds.length > 0, (el) => el.child(line(`Also ends: ${this.alsoEnds.join(", ")}.`, t.blocked)))
        .when(remove && !this.ready, (el) => el.child(line("Checking the worktree…", t.dim)))
        .when(remove && this.ready && Boolean(this.repo) && !this.blocked, (el) => el.child(line(`Deletes the folder ${this.repo.top}. ${this.repo.branch ? `The branch ${this.repo.branch} stays.` : "Commits stay in the repository only if a branch points to them."}`)))
        .when(remove && this.dirty && !this.blocked, (el) => el.child(line("It has uncommitted changes: they will be lost.", t.blocked)))
        .when(Boolean(this.blocked), (el) => el.child(line(this.blocked, t.blocked)))
        .when(Boolean(this.error), (el) => el.child(line(this.error, t.blocked))))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("no", "Cancel", t.raised, t.foreground, !this.busy, () => closeOverlay(props().overlay)))
        .child(button("yes", this.busy ? "Working…" : remove ? "Close and delete" : "Close session", t.blocked, "#ffffff", canConfirm, (_e, cx) => cx.spawn(async (cx) => this.confirm(cx)))));
  }
}
