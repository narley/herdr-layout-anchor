// Opens a code reference from the selected text: select `mlo-processor.ts:318` in a terminal (Herdr
// copies a selection as you make it), press the key bound to `mod.open:code-peek-open` (Cmd+Shift+O),
// and the code-peek pane opens beside that terminal at that line. The file is looked up from the
// terminal's folder on its machine, so a bare name works too (code-peek's viewer does the search).
// Shows a line while it works, or why it couldn't, then closes.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, focused, exec, run, panes, setShared, closeOverlay, theme, checking } from "herdr";

const PEEK = "code-peek";
// A file reference: a path with an extension, optionally :line[:col][-end] or #L<line>.
const REF = /(?:[\w@~.+-]*\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:-L?\d+)?)?/;

function parse(text) {
  const m = REF.exec(String(text ?? "").trim());
  if (!m) return null;
  const raw = m[0];
  const line = Number((/:(\d+)(?::\d+)?(?:-\d+)?$/.exec(raw) ?? /#L(\d+)/.exec(raw) ?? [])[1]) || 1;
  const ref = raw.replace(/#L.*$/, "").replace(/(:\d+){1,2}(-\d+)?$/, "");
  return { ref, line };
}

function resolve(path, cwd) {
  if (path.startsWith("/") || !cwd) return path;
  if (path.startsWith("~/")) return path;   // left to the search: home differs per machine
  const out = [];
  for (const p of `${cwd}/${path}`.split("/")) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return `/${out.join("/")}`;
}

export default class CodePeekOpen extends View {
  init(_props, cx) {
    this.note = "Reading the selection…";
    if (checking()) return;   // `herdr-app check` runs init for real: open nothing
    cx.spawn(async (cx) => {
      try { this.note = await this.open(); } catch (e) { this.note = String(e?.message ?? e); }
      cx.notify();
      if (this.note === "") closeOverlay(props().overlay);
      else cx.timer.every(2500, () => closeOverlay(props().overlay));
    });
  }

  // "" when the pane opened; otherwise what to tell the person.
  async open() {
    const f = focused();
    if (!f?.terminal) return "Focus a terminal first";
    const clip = await exec("pbpaste", [], { timeout: 5000 });
    const found = parse(clip.stdout);
    if (!found) return "Select a file reference first, like foo.ts:318";
    const machine = f.terminal.includes("/") ? f.terminal.split("/")[0] : null;
    const tab = f.tab;
    setShared(`${PEEK}.${tab}`, { path: resolve(found.ref, f.cwd), line: found.line, machine, cwd: f.cwd ?? null, ref: found.ref, at: Date.now() });
    const open = panes().find((p) => p.mod === PEEK && p.tab === tab);
    if (open) run("pane.focus", { pane: open.pane });
    else run("pane.split", { direction: "right", ...(f.pane ? { pane: f.pane } : {}), mod: PEEK, props: { tab } });
    return "";
  }

  render() {
    const t = theme();
    return h_flex().size_full().px(14).items_center().bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(div().truncate().child(this.note));
  }
}
