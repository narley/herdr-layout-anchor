// Cmd+click (Ctrl+click) on a code file link with a line, `src/foo.ts:318`, in any terminal: the
// file opens read-only in a pane to the right of that terminal, at that line. A second click
// reuses the pane. Works for terminals on other machines too (the file is read from there).
// A local link without a line goes on to the usual opener (your editor).
import { panes, run, setShared } from "herdr";

const PEEK = "code-peek";

// The path part of a link's text: no :line:col suffix, no #L anchor, no file:// prefix.
function pathOf(raw) {
  return String(raw ?? "")
    .replace(/^file:\/\/[^/]*/, "")
    .replace(/#L\d+.*$/, "")
    .replace(/(:\d+){1,2}(-\d+)?$/, "");
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
  if (!path) return "pass";
  const tab = source.tab;
  setShared(`${PEEK}.${tab}`, { path, line: link.line ?? 1, machine: source.machine ?? null, at: Date.now() });
  const open = panes().find((p) => p.mod === PEEK && p.tab === tab);
  if (open) run("pane.focus", { pane: open.pane });
  else run("pane.split", { direction: "right", ...(source.pane ? { pane: source.pane } : {}), mod: PEEK, props: { tab } });
  return "handled";
}
