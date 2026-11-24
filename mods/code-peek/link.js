// Cmd+click (Ctrl+click) on a code file link with a line, `src/foo.ts:318`, in any terminal: the
// file opens read-only in a pane to the right of that terminal, at that line. A second click
// reuses the pane. Works for terminals on other machines too (the file is read from there).
// A local link without a line goes on to the usual opener (your editor).
import { panes, run, setShared } from "herdr";

const PEEK = "code-peek";

// The path part of a link's text: no :line:col suffix, no #L anchor, no file:// prefix.
// Sentence punctuation after a link ("see /x/spike.md." or "(foo.ts:318),") isn't part of it.
function pathOf(raw) {
  return String(raw ?? "")
    .replace(TRAIL, "")
    .replace(/^file:\/\/[^/]*/, "")
    .replace(/#L\d+.*$/, "")
    .replace(/(:\d+){1,2}(-\d+)?$/, "");
}

// The line in a link's text ("foo.ts:318", "foo.ts:12:4)", "foo.py#L40"), or null.
const TRAIL = /[.,;:!?)\]}'"\u00bb\u2026]+$/;
function lineOf(raw) {
  const text = String(raw ?? "").replace(TRAIL, "");
  const m = /:(\d+)(?::\d+)?(?:-\d+)?$/.exec(text) || /#L(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

function resolve(path, cwd) {
  if (path.startsWith("/") || !cwd) return path;
  const parts = `${cwd}/${path}`.split("/");
  const out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return `/${out.join("/")}`;
}

export async function handleLink({ link, source }) {
  if (link.kind !== "file") return "pass";
  const remote = Boolean(source.machine);
  if (!link.line && !remote) return "pass";
  const path = link.path ?? resolve(pathOf(link.raw), source.cwd);
  // the line, when Herdr couldn't read it from text it didn't resolve (a remote terminal's link)
  const line = link.line ?? lineOf(link.raw);
  if (!path) return "pass";
  const tab = source.tab;
  setShared(`${PEEK}.${tab}`, { path, line: line ?? 1, machine: source.machine ?? null, cwd: source.cwd ?? null, ref: pathOf(link.raw), at: Date.now() });
  const open = panes().find((p) => p.mod === PEEK && p.tab === tab);
  if (open) run("pane.focus", { pane: open.pane });
  else run("pane.split", { direction: "right", ...(source.pane ? { pane: source.pane } : {}), mod: PEEK, props: { tab } });
  return "handled";
}
