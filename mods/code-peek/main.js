// The code peek pane: a read-only view of the file a terminal link pointed at, scrolled to its
// line, which is selected. link.js opens it beside the terminal and sends each next link through
// shared "code-peek.<tab>" ({ path, line, machine, at }), so one pane per tab follows the clicks.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState } from "gpui-base";
import { props, shared, theme, settings, readTextFile, run, panes } from "herdr";

const PEEK = "code-peek";
// Language names the editor knows, as Herdr's own Files viewer maps them.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html", zsh: "bash", sh: "bash" };
const MAX = 400000;
const BELOW = 24;   // lines shown under the target: scroll there first, then select the target

// UTF-16 offsets of a 1-based line's start and end.
function lineRange(text, line) {
  let start = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", start);
    if (next < 0) break;
    start = next + 1;
  }
  const end = text.indexOf("\n", start);
  return { start, end: end < 0 ? text.length : end };
}

export default class CodePeek extends View {
  init(_props, cx) {
    this.key = `${PEEK}.${props()?.tab}`;
    this.at = null;
    this.code = null;
    this.error = null;
    this.target = null;
    this.check(cx);
    cx.timer.every(250, (cx) => this.check(cx));
  }

  // A new link for this tab: read the file (from its machine) and show it at the line.
  check(cx) {
    // second step of the scroll (a later tick, after the editor has laid out at the first)
    if (this.settle && this.code && Date.now() >= this.settleAt) { this.code.set_selected_range(this.settle); this.settle = null; cx.notify(); }
    const want = shared(this.key) ?? props()?.target;   // props.target: opened with a file already
    if (!want || want.at === this.at) return;
    this.at = want.at;
    this.target = want;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(want.path, { on: want.machine ?? null });
        if (this.at !== want.at) return;
        if (text === null) { this.code = null; this.error = "File not found"; return; }
        if (text.includes("\0")) { this.code = null; this.error = "Binary file"; return; }
        const value = text.length > MAX ? `${text.slice(0, MAX)}\n… (file truncated)` : text;
        const t = theme();
        const ext = (want.path.split("/").pop().split(".").pop() ?? "").toLowerCase();
        this.code?.release?.();
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        const line = want.line ?? 1;
        const lines = value.split("\n").length;
        this.code.set_selected_range(lineRange(value, Math.min(lines, line + BELOW)));
        this.settle = lineRange(value, line);
        this.settleAt = Date.now() + 600;
      } catch (e) {
        if (this.at === want.at) { this.code = null; this.error = String(e?.message ?? e); }
      } finally {
        cx.notify();
      }
    });
  }

  close() {
    const me = panes().find((p) => p.mod === PEEK && p.tab === props()?.tab);
    if (me) run("pane.close", { pane: me.pane });
  }

  render() {
    const t = theme();
    const s = settings();
    const want = this.target;
    const name = want ? want.path.split("/").pop() : "";
    const folder = want ? want.path.split("/").slice(0, -1).join("/").replace(/^\/Users\/[^/]+/, "~") : "";
    return v_flex().size_full().bg(t.background)
      .child(h_flex().h(28).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome).text_size(12)
        .child(div().flex_none().font_semibold().text_color(t.foreground).child(want ? `${name}:${want.line ?? 1}` : "Code"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${want?.machine ? `${want.machine}:` : ""}${folder}`))
        .child(div().id("code-peek-close").size(18).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
          .text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip("Close")
          .on_click(() => this.close())
          .child(svg("mods/pane/close.svg").size(11))))
      .child(this.code
        ? Editor.new(this.code).font_family(s.font_family).text_size(s.font_size).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child(this.error ?? (want ? "Loading…" : "Cmd+click a file:line link in a terminal")));
  }
}
