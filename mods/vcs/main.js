// VCS: one pane for git and svn, laid out like Sublime Merge.
//
// Left: the commit graph, its first row the uncommitted changes, and the
// commit box. Right: the selected commit (message, author), the file tree,
// and the diff. Regions resize by their splitters; the pane zooms like any
// other. Diff lines take clicks: a selection is quoted (path:lines) to the
// clipboard or pasted into an agent's prompt for review.
//
// Open it as a pane:
//   pane.split { direction: "right", mod: "vcs" }
// Or on its own: ctrl-shift-g (mod.open:vcs).
//
// The repository address is fixed. The first load takes the folder the
// terminal is in and pins it (shared "vcs.repo"); afterwards the terminal
// moving around does not move the pane. It changes only on purpose: click the
// path in the header, `o` (pick a folder), or `O` (the terminal's folder
// again). A folder that is both a git checkout and an svn working copy is
// switched with the GIT/SVN chip or `v`; the choice is part of the pin.

import * as fs from "fs/promises";
import { View, div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { agents, appHome, focused, hc, home, notify, panes, pickFolder, props, readTextFile, run, setShared, settings, shared, spaces, theme, watchFolder, writeTextFile } from "herdr";
import { layoutLanes } from "./lanes.js";

// hc exec, not exec: a mod's exec pays a login-shell start (seconds here);
// hc runs the program directly in the core's environment (~0.15 s).
const hcExec = (cmd, args, { cwd, on } = {}) => hc([
  "exec",
  ...(on ? ["--on", on] : []),
  ...(cwd ? ["--cwd", cwd] : []),
  "--",
  cmd,
  ...args,
]);

const LIMIT = 300;
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F\u{1F300}-\u{1FAFF}]/u;
const textWidth = (text) => {
  let w = 0;
  for (const ch of text) w += WIDE.test(ch) ? 2 : 1;
  return w;
};
const ROW = 24;
const LANE = 12;
const PAD = 6;
const MAX_DIFF = 3000;
const MAX_UNTRACKED_BYTES = 64 * 1024;
const LANG = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  py: "py", rs: "rs", go: "go", c: "c", h: "c", cpp: "c", cc: "c", cxx: "c", hpp: "c", cs: "c",
  java: "c", kt: "c", kts: "c", swift: "c", php: "c", rb: "rb", sh: "sh", bash: "sh", zsh: "sh",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", html: "html", css: "css", scss: "css", md: "md",
};
const KEYWORDS = {
  js: "const let var function return if else for while do switch case break continue class extends new this super import export from default async await try catch finally throw typeof instanceof in of null undefined true false delete void yield static get set",
  ts: "const let var function return if else for while do switch case break continue class extends new this super import export from default async await try catch finally throw typeof instanceof in of null undefined true false delete void yield static get set interface type enum implements readonly public private protected namespace declare as satisfies",
  py: "def class return if elif else for while import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False async await self",
  rs: "fn let mut const struct enum impl trait pub use mod match if else loop while for in return break continue as unsafe where dyn ref move async await crate self super Self true false",
  go: "package import func var const type struct interface map chan go defer if else for range return switch case default break continue select nil true false",
  c: "int char float double void long short unsigned signed struct union enum typedef static const if else for while do switch case break continue return sizeof goto extern volatile inline true false null nullptr class public private protected new delete this namespace using template typename virtual override final",
  rb: "def end class module if elsif else unless while until for in do return yield begin rescue ensure raise lambda proc nil true false self super require",
  sh: "if then else elif fi for while do done case esac function echo export local return cd exit source alias set unset read printf",
  json: "true false null",
  yaml: "true false null yes no",
  toml: "true false",
  html: "",
  css: "",
  md: "",
};
function tokenize(text, lang) {
  const words = KEYWORDS[lang] ? new Set(KEYWORDS[lang].split(" ")) : null;
  const hash = lang === "py" || lang === "rb" || lang === "sh" || lang === "yaml" || lang === "toml";
  const out = [];
  let plain = "";
  const flush = () => { if (plain) { out.push({ s: plain, k: null }); plain = ""; } };
  const add = (s, k) => { if (!s) return; flush(); out.push({ s, k }); };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { add(text.slice(i), "comment"); break; }
    if (hash && c === "#" && !(lang === "toml" && text[i + 1] === "[")) { add(text.slice(i), "comment"); break; }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const to = end < 0 ? text.length : end + 2;
      add(text.slice(i, to), "comment");
      i = to;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === c) { j++; break; }
        j++;
      }
      add(text.slice(i, j), "string");
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9" && !/[A-Za-z_$]/.test(text[i - 1] ?? "")) {
      const m = /^[0-9][0-9a-fA-FxX._]*/.exec(text.slice(i));
      add(m[0], "number");
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
      const word = m[0];
      if (words && words.has(word)) add(word, "keyword");
      else plain += word;
      i += word.length;
      continue;
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}
const LANG_OF = (path) => {
  const ext = String(path ?? "").split(".").pop()?.toLowerCase() ?? "";
  return LANG[ext] ?? null;
};
// The last state per folder, shared by every copy: reopening the pane paints at once.
const CACHE = globalThis.__vcsCache ?? (globalThis.__vcsCache = new Map());
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const tilde = (path) => {
  const h = home();
  if (!path) return "";
  if (path === h) return "~";
  return path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
};

function location() {
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs?.find((t) => t.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  let cwd = pane?.cwd ?? null;
  if (!cwd && tab) cwd = panes().find((p) => p.tab === tab.id && p.terminal && p.cwd)?.cwd ?? null;
  cwd = cwd ?? f?.cwd ?? space?.folder ?? null;
  const on = space?.machine ?? (f?.terminal?.includes("/") ? f.terminal.split("/")[0] : null);
  return { cwd, on };
}

// Every working copy `dir` is inside. A folder can be both: a git checkout
// kept under an svn working copy, or a migration in progress. The pane shows
// one of them and can be pointed at the other.
async function probeKinds(dir, on) {
  const [g, s] = await Promise.all([
    hcExec("git", ["-C", dir, "rev-parse", "--show-toplevel"], { on }).catch(() => null),
    hcExec("svn", ["info", "--show-item", "wc-root"], { cwd: dir, on }).catch(() => null),
  ]);
  const kinds = [];
  if (g && g.code === 0 && g.stdout.trim()) kinds.push({ kind: "git", root: g.stdout.trim() });
  if (s && s.code === 0 && s.stdout.trim()) kinds.push({ kind: "svn", root: s.stdout.trim() });
  return kinds;
}

// The nearest folder that is a working copy, with every kind it is in; the one
// matching `prefer` is selected. `folder` is where the search stopped, which is
// what the pane pins as its repository address.
async function detect(cwd, on, prefer) {
  let dir = cwd;
  for (let i = 0; i < 24 && dir; i++) {
    const kinds = await probeKinds(dir, on);
    if (kinds.length) return { ...(kinds.find((k) => k.kind === prefer) ?? kinds[0]), on, folder: dir, kinds };
    const parent = dir.replace(/[\\/][^\\/]+$/, "");
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

const laneColors = (t) => [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi10, t.ansi13, t.ansi11, t.ansi14, t.ansi9];

function parseRefs(field) {
  const inner = (field ?? "").trim().replace(/^\(/, "").replace(/\)$/, "");
  if (!inner) return [];
  return inner.split(", ").map((name) => {
    if (name.startsWith("HEAD -> ")) return { kind: "head", name: name.slice(8) };
    if (name === "HEAD") return { kind: "head", name: "HEAD" };
    if (name.startsWith("tag: ")) return { kind: "tag", name: name.slice(5) };
    if (name.includes("/")) return { kind: "remote", name };
    return { kind: "branch", name };
  });
}

const statsOf = (lines) => {
  let add = 0;
  let del = 0;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
};

export default class Vcs extends View {
  kind = null;
  root = null;
  on = null;
  prefer = "git";
  // The repository address is fixed: the first load pins the folder found from
  // the terminal; changing it is explicit (pick a folder, or take the
  // terminal's again). Persisted as shared "vcs.repo" = {path, on, kind}.
  folder = null;
  kinds = [];
  label = "";
  error = null;
  width = 0;
  watching = null;
  where = null;

  // graph
  raw = [];
  rows = [];
  lanes = 1;
  commits = 0;
  gsel = -1;
  detail = null;
  gbusy = false;
  selectToken = 0;

  // working tree
  files = [];
  dsel = null;
  view = "unified";
  ignoreWs = false;
  dbusy = false;
  diffBusy = false;
  stagedCount = 0;
  workingCount = 0;
  collapsed = new Set();

  // layout
  leftW = 340;
  treeH = 230;
  detailsH = 110;
  paneH = 0;
  drag = null;
  showDetails = true;
  showTree = true;
  context = 3;
  filterText = "";

  // diff state
  mainLines = [];
  mainModel = null;
  detailLines = [];
  detailModel = null;
  tsel = null;
  dragging = false;
  menu = null;
  scrollY = 0;
  scrollX = 0;
  viewportH = 0;
  diffW = 0;
  charW = 6.9;
  gaps = new Map();
  gapDrag = null;
  textCache = new Map();
  commitCache = new Map();
  fileCache = new Map();
  ta = null;
  filterInput = null;

  region = 1;
  maxRegion = null;
  savedSizes = null;
  treeSel = null;
  lastG = 0;
  lastZ = 0;
  visual = false;
  typing = false;
  searchOpen = false;
  query = "";
  jumpMode = false;
  jumpLabels = null;
  pendingHunk = null;
  pendingFind = null;
  pendingFindMsg = null;
  lastY = 0;
  splitSide = "l";
  pendingCtrlW = false;
  msgSel = null;
  msgVisual = false;
  filterFocus = false;
  filterNative = false;
  ownPane = null;
  amend = false;
  lineOpen = false;
  lineText = "";
  // Focus state, two layers (the whole model is in the focus section below).
  focusEdge = null;
  focusMounted = false;
  searchNative = false;
  inputHover = false;
  searchHover = false;

  // Herdr owns pane navigation; this handle owns region keyboard navigation.
  // Observe live pane/capture edges in render, never on a polling clock or a
  // repository callback. The deferred handoff revalidates its exact edge.
  appPaneFocused() {
    const f = focused();
    if (!f?.pane || props()?.overlay) return false;
    const all = panes();
    if (!all.some((p) => p.pane === f.pane && p.mod === "vcs")) return false;
    // Identity is saved in this pane's props, including after app restart.
    // Never infer it from whichever pane happens to hold focus.
    const id = props()?.vcsPane;
    const matches = id ? all.filter((p) => p.mod === "vcs" && (p.pane === id || p.pane.endsWith("/" + id))) : [];
    this.ownPane = matches.length === 1 ? matches[0].pane : null;
    return this.ownPane === f.pane;
  }

  observePaneFocus(cx) {
    if (!this.focusMounted || props()?.overlay) return;
    const pane = focused()?.pane ?? null;
    const capture = this.capturing() ? shared("keys.capturing") : null;
    const edge = `${pane}|${capture?.state ?? ""}|${capture?.ts ?? ""}`;
    if (edge === this.focusEdge) return;
    this.focusEdge = edge;
    if (capture || !this.appPaneFocused()) return;
    const region = this.region;
    // spawn starts synchronously until its first await; a timer must cross
    // the render boundary before a native focus mutation is legal.
    cx.timer.after(32, () => {
      if (this.closed || this.focusEdge !== edge || focused()?.pane !== pane
          || this.capturing() || !this.appPaneFocused() || this.region !== region) return;
      // An input may have received a click since the pane edge was observed.
      if (this.typing || this.filterNative || this.searchNative || this.hasKeyboard()) return;
      this.handle.focus();
    });
  }

  // Does an overlay own the keyboard? The mark is { state, ts }, written by
  // whichever overlay is up; one older than 5 min is a leftover from a copy
  // that died without clearing it, so it stops blocking us.
  capturing() {
    const s = shared("keys.capturing");
    return Boolean(s) && typeof s === "object" && Date.now() - (s.ts ?? 0) < 300_000;
  }

  // GPUI's is_focused()/release() raise an empty-message error once the pane's
  // element has left the focus tree; that only happens when the keyboard is
  // already gone, so both read as "not ours".
  hasKeyboard() {
    try { return this.handle.is_focused(); } catch { return false; }
  }

  bindPaneIdentity(cx) {
    if (!props()?.overlay && !props()?.vcsPane) {
      // Older panes have no identity props. Fill only that metadata through
      // core's versioned document API; the host remounts them with their ID.
      const machine = location().on;
      cx.spawn(async () => {
        try {
          const result = await hcExec("pwsh", ["-NoProfile", "-File", `${appHome()}/mods/vcs/bind-panes.ps1`,
            ...(machine ? ["-Machine", machine] : [])]);
          if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Pane binding failed");
        } catch (error) {
          notify({ title: "VCS pane identity", body: String(error?.message ?? error), level: "error" });
        }
      });
    }
  }

  init(_p, cx) {
    this.handle = cx.focus_handle();
    // Hidden tab copies do not render. Keep their last observed pane/capture
    // edge current too, so returning to the same pane is still an entry.
    // No notify or repository work: only a new edge can schedule a handoff.
    cx.timer.every(75, (cx) => this.observePaneFocus(cx));
    // An overlay copy is its own window and keeps the keyboard it takes; a pane
    // copy receives a guarded handoff when Herdr focuses its pane.
    if (props()?.overlay) {
      this.handle.focus();
      setShared("keys.capturing", (this.capture = { state: "vcs", ts: Date.now() }));
    }
    this.ta = TextareaState.new({ placeholder: "Commit message", rows: 3 });
    this.ta.on("submit", (_e, cx) => { if (this.amend) this.amendCommit(cx); else this.commit(cx); });
    this.graphScroll = VirtualListScrollHandle.new();
    this.treeScroll = VirtualListScrollHandle.new();
    this.ta.on("focus", (_e, cx) => { this.region = 2; this.typing = true; cx.notify(); });
    this.ta.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.searchInput = InputState.new({ placeholder: "Search diff" });
    this.searchInput.on("focus", (_e, cx) => { this.searchNative = true; this.region = 4; cx.notify(); });
    this.searchInput.on("change", (_e, cx) => { this.query = this.searchInput.value(); this.searchJump(1, cx); });
    this.searchInput.on("submit", (_e, cx) => { this.searchOpen = false; this.handle.focus(); cx.notify(); });
    this.searchInput.on("blur", (_e, cx) => { this.searchNative = false; cx.notify(); });
    this.filterInput = InputState.new({ placeholder: "Filter files" });
    this.filterInput.on("change", (_e, cx) => { this.filterText = this.filterInput.value(); cx.notify(); });
    this.filterInput.on("focus", (_e, cx) => { this.region = 3; this.filterFocus = true; this.filterNative = true; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { this.filterFocus = false; this.filterNative = false; cx.notify(); });
    const loc = location();
    const hit = CACHE.get(`${loc.cwd}|${loc.on}`);
    if (hit && Date.now() - hit.at < 300000) this.hydrate(hit);
    this.load(cx);
    // The address is fixed, so the terminal changing folders must not move the
    // pane. This only retries after a restart, when the pane is focused before
    // the terminal reports a folder (leaving it on "Not a git or svn working
    // copy" forever).
    cx.timer.every(2500, (cx) => {
      const retry = !this.kind && (this.retries ?? 0) < 6 && Boolean(location().cwd);
      if (!retry) return;
      this.retries = (this.retries ?? 0) + 1;
      this.load(cx);
    });
  }

  // An overlay copy owns the keyboard while it is shown; hand the mark back so
  // the pane copy underneath (or any other pane mod) may take it again.
  close() {
    this.closed = true;
    this.watching = null;
    this.watchTask?.cancel();
    this.refreshTimer?.cancel();
    this.selectToken++;
    if (this.capture && shared("keys.capturing")?.ts === this.capture.ts) setShared("keys.capturing", null);
  }

  async load(cx) {
    if (this.closed) return;
    if (this.loading) { this.queued = true; return; }
    this.loading = true;
    try {
      const { cwd, on } = location();
      const pin = this.pin();
      // The first load takes the terminal's folder and fixes it; later ones
      // stay on that address until it is changed on purpose.
      const folder = pin?.path ?? cwd;
      const at = pin ? (pin.on ?? null) : on;
      this.where = `${folder}|${at}`;
      if (!folder) {
        this.error = "No focused folder";
        return;
      }
      const prefer = pin?.kind ?? this.prefer;
      const v = this.root && this.folder === folder && this.on === at && this.kind === prefer
        ? { root: this.root, folder, on: at, kind: this.kind, kinds: this.kinds }
        : await detect(folder, at, prefer);
      if (!v) {
        Object.assign(this, { kind: null, root: null, rows: [], raw: [], commits: 0, gsel: -1, detail: null, files: [], dsel: null, kinds: [], error: "Not a git or svn working copy" });
        return;
      }
      if (!pin) this.setPin({ path: v.folder ?? folder, on: v.on ?? null, kind: v.kind });
      Object.assign(this, { kind: v.kind, root: v.root, on: v.on, error: null, folder: v.folder ?? folder, kinds: v.kinds ?? [] });
      await this.loadDiff(cx);
      await this.loadGraph(cx);
      CACHE.set(`${this.folder}|${this.on}`, {
        at: Date.now(), kind: this.kind, root: this.root, on: this.on, label: this.label,
        raw: this.raw, rows: this.rows, lanes: this.lanes, commits: this.commits,
        files: this.files.map((f) => ({ ...f, lines: null })), dsel: this.dsel,
        stagedCount: this.stagedCount, workingCount: this.workingCount, gsel: this.gsel,
        detail: this.detail ? { ...this.detail, files: (this.detail.files ?? []).map((f) => ({ ...f })) } : null,
      });
      if (CACHE.size > 6) CACHE.delete(CACHE.keys().next().value);
      this.watch(v, cx);
    } catch (err) {
      this.error = String(err?.message ?? err);
    } finally {
      this.loading = false;
      cx.notify();
      if (this.queued) {
        this.queued = false;
        cx.spawn(async (cx) => this.load(cx));
      }
    }
  }

  watch(v, cx) {
    const key = `${v.on ?? ""}|${v.root}`;
    if (this.watching === key) return;
    this.watchTask?.cancel();
    this.watching = key;
    this.watchTask = cx.spawn(async (cx) => {
      while (!this.closed && this.watching === key) {
        let changed = [];
        try {
          changed = await watchFolder(v.root);
        } catch {
          await new Promise((resolve) => cx.timer.after(2000, resolve));
          this.watching = null;
          this.load(cx);
          return;
        }
        if (this.closed || this.watching !== key) return;
        const paths = Array.isArray(changed) ? changed : [];
        if (paths.length && paths.every((p) => p.includes(".git/") || p.includes(".git\\") || p.endsWith(".git") || p.endsWith(".git\\"))) continue;
        this.refreshTimer?.cancel();
        this.refreshTimer = cx.timer.after(350, (cx) => {
          if (!this.closed && this.watching === key) this.load(cx);
        });
      }
    });
  }

  async loadGraph(cx) {
    try {
      if (this.kind === "git") {
        const log = await hcExec("git", [...READ, "-C", this.root, "log", "--all", "--date-order", `-n${LIMIT}`,
          "--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ar%x1f%s%x1f%D"], { on: this.on });
        if (log.code !== 0) throw new Error((log.stderr || "git log failed").trim());
        const commits = [];
        for (const record of (log.stdout ?? "").split("\x1e")) {
          if (!record.trim()) continue;
          const [full, parents, author, date, subject, refs] = record.split("\x1f");
          if (!full) continue;
          const parsed = parseRefs(refs);
          commits.push({
            hash: full, short: full.slice(0, 8), full,
            parents: (parents ?? "").split(" ").filter(Boolean),
            author: author ?? "", date: date ?? "", subject: subject ?? "",
            refs: parsed, head: parsed.some((r) => r.kind === "head"),
          });
        }
        const dirty = this.files?.length ?? 0;
        if (dirty) commits.unshift({ hash: "*", short: "*", full: "*", parents: commits[0] ? [commits[0].hash] : [], uncommitted: true, dashed: true, refs: [], head: false, author: "", date: "", subject: `Uncommitted changes (${dirty})` });
        const { rows, width } = layoutLanes(commits);
        const head = commits.find((c) => c.head)?.refs.find((r) => r.kind === "head");
        Object.assign(this, { raw: commits, rows, lanes: width, commits: commits.filter((c) => !c.uncommitted).length, label: head?.name || (commits.length ? "detached" : "") });
        const first = commits.some((c) => c.uncommitted) ? (rows.length > 1 ? 1 : 0) : 0;
        this.gsel = this.gsel >= 0 ? Math.min(this.gsel, Math.max(0, rows.length - 1)) : first;
        if (rows.length) this.select(this.gsel, cx);
      } else {
        const [info, log] = await Promise.all([
          hcExec("svn", ["info", "--show-item", "relative-url"], { cwd: this.root, on: this.on }).catch(() => null),
          hcExec("svn", ["log", "-v", `-l${LIMIT}`, "-r", "HEAD:1", "--non-interactive"], { cwd: this.root, on: this.on }),
        ]);
        if (log.code !== 0) throw new Error((log.stderr || "svn log failed").trim());
        const rows = [];
        // `svn log` prints a separator line between revisions and uses CRLF on
        // Windows. Parse the header from its own line: a `[^|]*$` regex would
        // swallow the whole block, since it may cross newlines.
        for (const block of (log.stdout ?? "").split(/^-{20,}\r?$/m)) {
          const lines = block.split("\n").map((line) => line.replace(/\r$/, ""));
          const headerAt = lines.findIndex((line) => /^r\d+ \| /.test(line));
          if (headerAt < 0) continue;
          const head = /^r(\d+) \| ([^|]*) \| (.*?) \| (.*)$/.exec(lines[headerAt]);
          if (!head) continue;
          const files = [];
          let i = headerAt + 1;
          while (i < lines.length) {
            const m = /^\s+([AMDR]) (\S+)(?: \(from (\S+):(\d+)\))?/.exec(lines[i]);
            if (m) files.push({ status: m[1], path: m[2], from: m[3] ?? null, fromRev: m[4] ?? null });
            else if (files.length && !lines[i].trim()) break;
            i++;
          }
          while (i < lines.length && !lines[i].trim()) i++;
          rows.push({ rev: head[1], author: head[2].trim(), date: head[3].trim(), message: lines.slice(i).join("\n").trim(), files, copies: files.filter((f) => f.from) });
        }
        let wcPath = (info?.stdout ?? "").trim().replace(/^\^/, "");
        const dirty = this.files?.length ?? 0;
        if (dirty) rows.unshift({ rev: "*", uncommitted: true, author: "", date: "", message: `Uncommitted changes (${dirty})`, files: [], copies: [] });
        Object.assign(this, { raw: rows, rows, lanes: 1, commits: rows.filter((r) => !r.uncommitted).length, label: wcPath || "svn", wcPath });
        this.gsel = this.gsel >= 0 ? Math.min(this.gsel, Math.max(0, rows.length - 1)) : (dirty && rows.length > 1 ? 1 : 0);
        if (rows.length) this.select(this.gsel, cx);
      }
    } catch (err) {
      Object.assign(this, { rows: [], raw: [], commits: 0, gsel: -1, detail: null, error: String(err?.message ?? err) });
    }
  }

  select(index, cx) {
    this.amend = false;
    if (!this.raw[index]) return;
    // Background selection must never take keyboard focus.
    this.selectToken++;
    // The highlight follows the keys at once; only the detail fetch is throttled.
    this.gsel = index;
    const graphOffset = this.rows[0]?.uncommitted ? 1 : 0;
    if (index >= graphOffset) this.graphScroll?.scroll_to_item(index - graphOffset, "center");
    cx.notify();
    this.pendingSelect = index;
    if (this.selectBusy) return;
    this.selectBusy = true;
    cx.spawn(async (cx) => {
      try {
        while (this.pendingSelect != null) {
          // Let a burst of j/k settle: only the last one in a burst loads git.
          await new Promise((r) => cx.timer.after(90, r));
          if (this.pendingSelect == null) break;
          const next = this.pendingSelect;
          this.pendingSelect = null;
          await this.selectNow(next, cx);
        }
      } finally {
        this.selectBusy = false;
      }
    });
  }

  async selectNow(index, cx) {
    const row = this.raw[index];
    if (!row) return;
    const token = ++this.selectToken;
    this.gsel = index;
    const graphOffset = this.rows[0]?.uncommitted ? 1 : 0;
    if (index >= graphOffset) this.graphScroll?.scroll_to_item(index - graphOffset, "center");
    this.gbusy = true;

    // The same commit is already on screen: nothing to fetch but its diff.
    if (this.kind === "git" && row.full && this.detail?.hash === row.full) {
      cx.notify();
      if (!this.detailModel && this.dsel) {
        const target = this.detail;
        const path = this.dsel;
        cx.spawn(async (cx) => {
          const lines = await this.gitFileDiff(row.full, path, target.parents?.length ?? 1);
          const text = await this.gitFileText(row.full, path);
          if (token === this.selectToken) {
            if (this.detail === target) this.setDetailLines(lines, text ? text.split("\n") : null);
            this.gbusy = false;
            cx.notify();
          }
        });
      } else {
        this.gbusy = false;
        cx.notify();
      }
      return;
    }

    // Show "Loading…" instead of the previous commit's message and files.
    this.detail = null;
    this.detailLines = [];
    this.detailModel = null;
    this.tsel = null;
    this.menu = null;
    cx.notify();

    try {
      if (this.kind === "git") {
        const hash = row.full;
        if (row.uncommitted) {
          const files = this.files.map((f) => ({ path: f.path, add: f.add, del: f.del, status: f.untracked ? "A" : (f.y?.trim() || f.x?.trim() || "M") }));
          this.detail = { uncommitted: true, short: "*", message: row.subject, files };
          if (!files.some((f) => f.path === this.dsel)) this.dsel = files[0]?.path ?? null;
          this.fileSel = this.dsel;
          await this.loadMainFile(cx);
          return;
        }
        const cachedDetail = this.commitCache.get(hash);
        if (cachedDetail) {
          this.detail = cachedDetail;
          if (!cachedDetail.files.some((f) => f.path === this.dsel)) this.dsel = cachedDetail.files[0]?.path ?? null;
          this.fileSel = this.dsel;
          this.setDetailLines([]);
          if (this.dsel) {
            const target = this.detail;
            const path = this.dsel;
            cx.spawn(async (cx) => {
              const lines = await this.gitFileDiff(hash, path, target.parents?.length ?? 1);
              const text = await this.gitFileText(hash, path);
              if (token === this.selectToken && this.detail === target) {
                this.setDetailLines(lines, text ? text.split("\n") : null);
                cx.notify();
              }
            });
          }
          return;
        }
        const [numstat, body, names] = await Promise.all([
          hcExec("git", [...READ, "-C", this.root, "show", "--numstat", "--format=", hash], { on: this.on }),
          hcExec("git", [...READ, "-C", this.root, "show", "-s", "--format=%B", hash], { on: this.on }),
          hcExec("git", [...READ, "-C", this.root, "show", "--name-status", "--format=", hash], { on: this.on }),
        ]);
        if (token !== this.selectToken || this.pendingSelect != null) return;
        const statusOf = new Map();
        for (const line of (names.stdout ?? "").split("\n")) {
          const m = /^([AMD])\d*\t(.+)$/.exec(line);
          if (m) statusOf.set(m[2], m[1]);
        }
        const files = [];
        for (const line of (numstat.stdout ?? "").split("\n")) {
          const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
          if (m) files.push({ path: m[3], add: m[1] === "-" ? null : Number(m[1]), del: m[2] === "-" ? null : Number(m[2]), status: statusOf.get(m[3]) ?? "M" });
        }
        this.detail = { hash: row.full, short: String(row.full).slice(0, 8), parents: row.parents ?? [], author: row.author ?? "", date: row.date ?? "", refs: row.refs ?? [], message: (body.stdout ?? "").trim(), files };
        if (this.commitCache.size > 60) this.commitCache.clear();
        this.commitCache.set(hash, this.detail);
        if (!files.some((f) => f.path === this.dsel)) this.dsel = files[0]?.path ?? null;
        this.fileSel = this.dsel;
        this.setDetailLines([]);
        if (this.dsel) {
          const target = this.detail;
          const path = this.dsel;
          cx.spawn(async (cx) => {
            const lines = await this.gitFileDiff(hash, path, target.parents?.length ?? 1);
            const text = await this.gitFileText(hash, path);
            if (token === this.selectToken && this.detail === target) {
              this.setDetailLines(lines, text ? text.split("\n") : null);
              cx.notify();
            }
          });
        }
      } else {
        if (row.uncommitted) {
          const files = this.files.map((f) => ({ path: f.path, add: f.add, del: f.del, status: f.code ?? "M" }));
          this.detail = { uncommitted: true, short: "*", message: row.message, files };
          if (!files.some((f) => f.path === this.dsel)) this.dsel = files[0]?.path ?? null;
          this.fileSel = this.dsel;
          await this.loadMainFile(cx);
          return;
        }
        const files = (row.files ?? []).map((f) => {
          const rel = this.wcPath && f.path.startsWith(this.wcPath) ? f.path.slice(this.wcPath.length).replace(/^\//, "") : f.path.replace(/^\//, "");
          return { path: f.path, local: rel, status: f.status, add: null, del: null, from: f.from, fromRev: f.fromRev };
        });
        this.detail = { rev: row.rev, author: row.author, date: row.date, message: row.message, files };
        if (!files.some((f) => f.path === this.dsel)) this.dsel = files.find((f) => f.status !== "D")?.path ?? files[0]?.path ?? null;
        this.fileSel = this.dsel;
        const lines = this.dsel ? await this.svnFileDiff(row.rev, files.find((f) => f.path === this.dsel)) : [];
        if (token !== this.selectToken) return;
        this.setDetailLines(lines);
      }
    } catch (err) {
      if (token !== this.selectToken) return;
      this.detail = { error: String(err?.message ?? err) };
      this.setDetailLines([]);
    } finally {
      if (token === this.selectToken) {
        this.gbusy = false;
        cx.notify();
      }
    }
  }

  async gitFileDiff(hash, path, parentCount = 1) {
    const cacheKey = `${hash}|${path}|${parentCount}|${this.context}`;
    const cached = this.fileCache.get(cacheKey);
    if (cached) return cached;
    const args = parentCount > 1
      ? [...READ, "-C", this.root, "diff", "--no-color", `-U${this.context}`, `${hash}^1`, hash, "--", path]
      : [...READ, "-C", this.root, "show", "--format=", "--no-color", "--patch", `-U${this.context}`, hash, "--", path];
    const r = await hcExec("git", args, { on: this.on });
    if (r.code !== 0) return [`(${(r.stderr || "git show failed").trim()})`];
    const text = r.stdout ?? "";
    const lines = text.trim() ? text.split("\n").slice(0, MAX_DIFF) : [];
    if (this.fileCache.size > 200) this.fileCache.clear();
    this.fileCache.set(cacheKey, lines);
    return lines;
  }

  async gitFileText(hash, path) {
    const key = `${hash}|${path}`;
    if (this.textCache.has(key)) return this.textCache.get(key);
    const r = await hcExec("git", [...READ, "-C", this.root, "show", `${hash}:${path}`], { on: this.on }).catch(() => null);
    const text = r && r.code === 0 && !(r.stdout ?? "").includes("\0") ? r.stdout : null;
    if (this.textCache.size > 100) this.textCache.clear();
    this.textCache.set(key, text);
    return text;
  }

  async svnFileDiff(rev, file) {
    if (!file) return [];
    const r = await hcExec("svn", ["diff", "-c", String(rev), file.local ?? file.path, "--non-interactive"], { cwd: this.root, on: this.on });
    if (r.code !== 0) return [`(${(r.stderr || "svn diff failed").trim()})`];
    return (r.stdout ?? "").split("\n").slice(0, MAX_DIFF);
  }

  async pickFile(path, cx) {
    if (!this.detail) return;
    this.fileSel = path;
    cx.notify();
    if (this.detail.uncommitted) {
      const file = this.files.find((f) => f.path === path);
      this.setDetailLines(file?.lines ?? [], file?.text ? file.text.split(/\r?\n/) : null);
    } else if (this.kind === "git") {
      const lines = await this.gitFileDiff(this.detail.hash, path, this.detail.parents?.length ?? 1);
      const text = await this.gitFileText(this.detail.hash, path);
      this.setDetailLines(lines, text ? text.split("\n") : null);
    } else {
      this.setDetailLines(await this.svnFileDiff(this.detail.rev, this.detail.files.find((f) => f.path === path)));
    }
    cx.notify();
  }

  // Focus moving between a terminal and this pane can resolve to another
  // folder in the same repository; that must not reload the whole view.
  // A click focuses this pane; that must not send the view to another
  // terminal's folder. Only a focused terminal may change the repository.
  focusIsMod() {
    const f = focused();
    return !f || !f.terminal;
  }

  insideRoot(cwd) {
    if (!cwd || !this.root) return false;
    const norm = (value) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const root = norm(this.root);
    const at = norm(cwd);
    return at === root || at.startsWith(root + "/");
  }

  hydrate(hit) {
    Object.assign(this, {
      kind: hit.kind, root: hit.root, on: hit.on, label: hit.label,
      raw: hit.raw, rows: hit.rows, lanes: hit.lanes, commits: hit.commits,
      files: hit.files.map((f) => ({ ...f, lines: null })), dsel: hit.dsel,
      stagedCount: hit.stagedCount, workingCount: hit.workingCount, gsel: hit.gsel ?? -1,
      filesKey: (this.filesKey ?? 0) + 1,
      detail: null, error: null,
    });
    // Only restore cached details when they belong to the cached selection.
    const row = hit.rows?.[hit.gsel];
    const detail = hit.detail;
    if (detail && row) {
      const same = detail.uncommitted ? Boolean(row.uncommitted) : (row.full != null && String(detail.hash) === String(row.full));
      if (same) this.detail = detail;
    }
  }

  async loadDiff(cx) {
    try {
      if (this.kind === "git") {
        const run = (args) => hcExec("git", [...READ, "-C", this.root, ...args], { on: this.on });
        const [status, numstat] = await Promise.all([
          run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
          run(["diff", "HEAD", "--numstat", "-z", "--no-renames"]).catch(() => null),
        ]);
        if (status.code !== 0) throw new Error((status.stderr || "git status failed").trim());
        const entries = status.stdout.split("\0").filter((e) => e.length > 3).map((e) => ({ xy: e.slice(0, 2), path: e.slice(3) }));
        const stats = new Map();
        for (const rec of (numstat?.stdout ?? "").split("\0")) {
          const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
          if (m) stats.set(m[3], { add: m[1] === "-" ? null : Number(m[1]), del: m[2] === "-" ? null : Number(m[2]) });
        }
        const files = [];
        let staged = 0;
        let working = 0;
        for (const { xy, path } of entries) {
          const untracked = xy === "??";
          const x = xy[0];
          const y = xy[1];
          if (!untracked && x !== " " && x !== "?") staged++;
          if (untracked || y !== " ") working++;
          const st = stats.get(path);
          files.push({ path, status: untracked ? "??" : xy, x, y, untracked, add: st?.add ?? null, del: st?.del ?? null, lines: null, staged: !untracked && x !== " " && x !== "?", dirty: untracked || y !== " " });
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        Object.assign(this, { files, stagedCount: staged, workingCount: working, filesKey: (this.filesKey ?? 0) + 1 });
        if (!files.some((f) => f.path === this.dsel)) this.dsel = files[0]?.path ?? null;
        await this.loadMainFile(cx);
      } else {
        const run = (args) => hcExec("svn", [...args, "--non-interactive"], { cwd: this.root, on: this.on });
        const status = await run(["status"]);
        if (status.code !== 0) throw new Error((status.stderr || "svn status failed").trim());
        const changes = new Map();
        for (const line of status.stdout.split("\n")) {
          if (line.length < 9) continue;
          const code = line[0];
          if (code === " " || code === "I" || code === "X") continue;
          changes.set(line.slice(8).trim().replace(/\\/g, "/"), code);
        }
        // `svn status` reports an unversioned directory as one entry (".git"
        // beside a git checkout) and diffing a directory is an error: keep the
        // entries that are really files.
        const files = [];
        for (const [path, code] of changes) {
          if (code === "!") continue;                       // missing on disk: nothing to diff
          if (code === "?") {
            // An unversioned directory arrives as one entry (".git" beside a git
            // checkout) and diffing it is an error. readdir answers only for
            // directories; this fs has no stat().
            let isDir = false;
            try { await fs.readdir(`${this.root}/${path}`); isDir = true; } catch { /* a file */ }
            if (isDir) continue;
          }
          files.push({ path, code, untracked: code === "?", add: null, del: null, lines: null, staged: false, dirty: true });
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        Object.assign(this, { files, stagedCount: 0, workingCount: files.length, filesKey: (this.filesKey ?? 0) + 1 });
        if (!files.some((f) => f.path === this.dsel)) this.dsel = files[0]?.path ?? null;
        await this.loadMainFile(cx);
      }
    } catch (err) {
      Object.assign(this, { files: [], dsel: null, error: String(err?.message ?? err) });
      this.setMainLines([]);
    }
  }

  // One file's diff, fetched when it is picked; opening the pane never pays
  // for a whole tree's changes.
  async loadMainFile(cx) {
    const file = this.files.find((f) => f.path === this.dsel);
    if (!file) {
      this.setMainLines([]);
      return;
    }
    const key = `${this.context}|${this.ignoreWs}`;
    if (file.lines && file.linesKey === key) {
      this.setMainLines(file.lines, file.text ? file.text.split(/\r?\n/) : null);
      return;
    }
    this.diffBusy = true;
    cx.notify();
    try {
      let lines = [];
      let fileText = null;
      if (this.kind === "git") {
        if (file.untracked) {
          try {
            const text = await readTextFile(`${this.root}/${file.path}`, { on: this.on });
            if (text != null) {
              const body = text.slice(0, MAX_UNTRACKED_BYTES);
              const raw = body.split(/\r?\n/);
              if (raw.length && raw[raw.length - 1] === "") raw.pop();
              const shown = raw.slice(0, MAX_DIFF);
              lines = [`diff --git a/${file.path} b/${file.path}`, "new file mode 100644", "--- /dev/null", `+++ b/${file.path}`, `@@ -0,0 +1,${shown.length} @@`, ...shown.map((line) => "+" + line)];
              file.add = shown.length;
              file.del = 0;
              fileText = body;
            }
          } catch {}
        } else {
          const ws = this.ignoreWs ? ["-w"] : [];
          const r = await hcExec("git", [...READ, "-C", this.root, "diff", "HEAD", ...ws, "--no-color", "--no-ext-diff", `-U${this.context}`, "--", file.path], { on: this.on });
          if (r.code !== 0) throw new Error((r.stderr || "git diff failed").trim());
          lines = (r.stdout ?? "").split("\n");
        }
      } else if (file.untracked) {
        // svn diff has nothing to compare an unversioned file with; show it as
        // one new file, the way git's untracked preview does.
        try {
          const text = await readTextFile(`${this.root}/${file.path}`, { on: this.on });
          if (text != null) {
            const body = text.slice(0, MAX_UNTRACKED_BYTES);
            const raw = body.split(/\r?\n/);
            if (raw.length && raw[raw.length - 1] === "") raw.pop();
            const shown = raw.slice(0, MAX_DIFF);
            lines = ["--- /dev/null", `+++ ${file.path}`, `@@ -0,0 +1,${shown.length} @@`, ...shown.map((line) => "+" + line)];
            file.add = shown.length;
            file.del = 0;
            fileText = body;
          }
        } catch {}
      } else {
        const r = await hcExec("svn", ["diff", "--non-interactive", ...(this.ignoreWs ? ["-x", "-w"] : []), "-x", `-U${this.context}`, "--", file.path], { cwd: this.root, on: this.on });
        if (r.code !== 0) throw new Error((r.stderr || "svn diff failed").trim());
        lines = (r.stdout ?? "").split("\n");
      }
      if (fileText == null) {
        try {
          const text = await readTextFile(`${this.root}/${file.path}`, { on: this.on });
          if (text && text.length < 4 * 1024 * 1024 && !text.includes("\0")) fileText = text;
        } catch {}
      }
      file.lines = lines;
      file.linesKey = key;
      file.text = fileText;
      const st = statsOf(lines);
      file.add = st.add;
      file.del = st.del;
      if (this.dsel === file.path) this.setMainLines(lines, fileText ? fileText.split(/\r?\n/) : null);
    } catch (err) {
      if (this.dsel === file.path) this.setMainLines([`(${String(err?.message ?? err)})`]);
    } finally {
      this.diffBusy = false;
      cx.notify();
    }
  }

  async runAction(kind, cx) {
    const f = this.files.find((x) => x.path === this.dsel);
    if (!f || this.dbusy) return;
    this.dbusy = true;
    cx.notify();
    try {
      if (this.kind === "git") {
        if (kind === "stage") await hcExec("git", ["-C", this.root, "add", "--", f.path], { on: this.on });
        else if (kind === "unstage") await hcExec("git", ["-C", this.root, "restore", "--staged", "--", f.path], { on: this.on });
        else if (kind === "revert") await hcExec("git", ["-C", this.root, "restore", "--worktree", "--", f.path], { on: this.on });
      } else {
        if (kind === "stage") await hcExec("svn", ["add", "--", f.path, "--non-interactive"], { cwd: this.root, on: this.on });
        else if (kind === "revert") await hcExec("svn", ["revert", "--", f.path, "--non-interactive"], { cwd: this.root, on: this.on });
      }
    } catch (err) {
      notify({ title: `${kind} failed`, body: String(err?.message ?? err), level: "error" });
    }
    this.dbusy = false;
    await this.load(cx);
  }

  async commit(cx) {
    if (!this.detail?.uncommitted) return;
    const message = (this.ta?.value() ?? "").trim();
    if (!message || this.dbusy) {
      notify({ title: "Commit needs a message", level: "warning" });
      return;
    }
    this.dbusy = true;
    cx.notify();
    try {
      const r = this.kind === "git"
        ? await hcExec("git", ["-C", this.root, "commit", "-m", message], { on: this.on })
        : await hcExec("svn", ["commit", "-m", message, "--non-interactive"], { cwd: this.root, on: this.on });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || "commit failed").trim());
      notify({ title: "Committed", body: message.split("\n")[0], level: "success" });
      this.ta.set_value("");
    } catch (err) {
      notify({ title: "Commit failed", body: String(err?.message ?? err), level: "error" });
    }
    this.dbusy = false;
    await this.load(cx);
  }

  // The pinned repository address: {path, on, kind} in shared "vcs.repo".
  pin() {
    const p = shared("vcs.repo");
    return p && typeof p === "object" && typeof p.path === "string" ? p : null;
  }

  setPin(next) {
    setShared("vcs.repo", next ? { path: next.path, on: next.on ?? null, kind: next.kind ?? null } : null);
  }

  // Point the pane at another folder (or at the terminal's folder again). The
  // address stays fixed until this is used.
  async changeRepo(cx) {
    const folder = await pickFolder({ prompt: "Repository folder" });
    if (!folder) return;
    const v = await detect(folder, this.on ?? null, this.kind ?? this.prefer);
    if (!v) {
      notify({ title: "Not a git or svn working copy", body: tilde(folder), level: "warning" });
      return;
    }
    this.setPin({ path: v.folder ?? folder, on: v.on ?? null, kind: v.kind });
    this.prefer = v.kind;
    this.watching = null;
    await this.load(cx);
  }

  async repoFromCwd(cx) {
    this.setPin(null);
    this.watching = null;
    await this.load(cx);
  }

  // The same folder can be a git checkout and an svn working copy (a migration
  // in progress). Switching re-probes the pinned folder, so the choice is real:
  // when the other system is not there, nothing changes and a toast says so.
  async switchVcs(cx) {
    const other = this.kind === "git" ? "svn" : "git";
    const folder = this.folder ?? this.root;
    if (!folder) return;
    const kinds = await probeKinds(folder, this.on ?? null);
    const pick = kinds.find((k) => k.kind === other);
    if (!pick) {
      notify({
        title: `No ${other} working copy`,
        body: `${tilde(folder)} — ${this.kind ? `this folder is ${this.kind}` : "neither git nor svn here"}`,
        level: "warning",
        timeout: 4000,
      });
      return;
    }
    this.prefer = pick.kind;
    this.setPin({ path: folder, on: this.on ?? null, kind: pick.kind });
    this.watching = null;
    await this.load(cx);
  }

  setContext(cx) {
    this.files.forEach((f) => { f.lines = null; });
    this.detailModel = null;
    this.detailLines = [];
    if (this.detail?.uncommitted) {
      this.loadMainFile(cx);
    } else if (this.dsel) {
      this.pickFile(this.dsel, cx);
    }
    cx.notify();
  }

  key(e, cx) {
    const k = e.key === "space" ? " " : (e.key.length === 1 && e.modifiers?.shift ? e.key.toUpperCase() : e.key);
    // Keys reach this copy only while it holds the keyboard, which also means
    // the app's focused pane is ours: no guesswork, focus() learned it.
    if (this.menu) {
      const items = this.menu.items ?? [];
      if (k === "escape") { this.menu = null; cx.notify(); return; }
      if (k === "j" || k === "down") { this.menu.index = Math.min(items.length - 1, (this.menu.index ?? 0) + 1); cx.notify(); return; }
      if (k === "k" || k === "up") { this.menu.index = Math.max(0, (this.menu.index ?? 0) - 1); cx.notify(); return; }
      if (k === "enter") { const item = items[this.menu.index ?? 0]; this.menu = null; if (item) item.action(cx); cx.notify(); return; }
      this.menu = null;
      cx.notify();
    }
    if (this.jumpMode) {
      if (k === "escape") { this.jumpMode = false; this.jumpLabels = null; cx.notify(); return; }
      const target = this.jumpLabels?.get(k);
      if (target) {
        this.jumpMode = false;
        this.jumpLabels = null;
        if (this.tsel) {
          this.tsel.focus = { row: target.row, col: target.col };
          this.tsel.anchor = { ...this.tsel.focus };
          this.moveCaretTo(target.row, cx);
        }
        cx.notify();
      }
      return;
    }
    if (this.pendingHunk) {
      const hunk = this.pendingHunk;
      this.pendingHunk = null;
      if (k === "h" || k === "l") { this.jumpHunk(hunk === "]" ? 1 : -1, cx); return; }
    }
    if (this.pendingFind) {
      const dir = this.pendingFind;
      this.pendingFind = null;
      if (k.length === 1) this.findCharInLine(k, dir, cx);
      return;
    }
    if (this.pendingFindMsg) {
      const dir = this.pendingFindMsg;
      this.pendingFindMsg = null;
      if (k.length === 1) this.findCharInMsg(k, dir, cx);
      return;
    }
    if (this.filterFocus) {
      if (this.filterNative) {
        if (k === "escape" || k === "enter") {
          this.filterFocus = false;
          this.filterNative = false;
          this.handle.focus();
          cx.notify();
        }
        return;
      }
      if (k === "escape" || k === "enter") { this.filterFocus = false; this.handle.focus(); cx.notify(); return; }
      if (k === "backspace") {
        this.filterText = this.filterText.slice(0, -1);
        this.filterInput.set_value(this.filterText);
        cx.notify();
        return;
      }
      if (k.length === 1) {
        this.filterText += k;
        this.filterInput.set_value(this.filterText);
        cx.notify();
        return;
      }
      return;
    }
    if (this.lineOpen) {
      if (k === "escape") { this.lineOpen = false; this.handle.focus(); cx.notify(); return; }
      if (k === "enter") {
        const n = parseInt(this.lineText || "0", 10);
        this.lineOpen = false;
        this.handle.focus();
        if (n > 0) this.jumpToLine(n, cx);
        cx.notify();
        return;
      }
      if (k === "backspace") { this.lineText = this.lineText.slice(0, -1); cx.notify(); return; }
      if (/^[0-9]$/.test(k)) { this.lineText += k; cx.notify(); return; }
      this.lineOpen = false;
      cx.notify();
      return;
    }
    if (this.typing) {
      if (k === "escape") {
        if (this.amend) {
          this.amend = false;
          this.ta.set_value("");
          cx.notify();
        }
        this.handle.focus();
      }
      return;
    }
    if (this.searchOpen) {
      if (k === "escape") {
        this.searchOpen = false;
        this.handle.focus();
        cx.notify();
      }
      return;
    }
    if (e.keystroke === "ctrl-c" || e.keystroke === "cmd-c") {
      if (this.tsel) this.quote(cx);
      return;
    }
    if (e.keystroke === "ctrl-shift-a") { this.selectAllDiff(cx); return; }
    if (e.keystroke === "ctrl-w") { this.pendingCtrlW = true; return; }
    if (this.pendingCtrlW) {
      this.pendingCtrlW = false;
      if ((k === "h" || k === "l") && this.view === "split") {
        this.splitSide = k === "h" ? "l" : "r";
        if (this.tsel) this.tsel.side = this.splitSide;
        this.region = 4;
        this.handle.focus();
        cx.notify();
      }
      return;
    }
    if (k === "escape") {
      this.tsel = null;
      this.visual = false;
      this.menu = null;
      this.msgSel = null;
      cx.notify();
      return;
    }
    if (!e.modifiers?.control && ["1", "2", "3", "4"].includes(k)) {
      this.focusRegion(Number(k), cx);
      return;
    }
    if (k === "+" || e.keystroke === "shift-=") { this.maximizeRegion(this.region, cx); return; }
    if (k === "-") { this.restoreMax(cx); return; }
    if (k === "t" && !e.modifiers?.control && this.region === 4) {
      this.view = this.view === "split" ? "unified" : "split";
      this.tsel = null;
      this.menu = null;
      cx.notify();
      return;
    }
    if (k === "c" && !e.modifiers?.control) {
      if (this.detail?.uncommitted) this.ta.focus();
      return;
    }
    if (k === "]") { this.pendingHunk = "]"; return; }
    if (k === "[") { this.pendingHunk = "["; return; }
    if (this.region === 1) return this.graphKey(k, e, cx);
    if (this.region === 2) return this.msgKey(k, e, cx);
    if (this.region === 3) return this.treeKey(k, e, cx);
    return this.diffKey(k, e, cx);
  }

  focusRegion(n, cx) {
    this.region = Math.max(1, Math.min(4, n));
    if (this.maxRegion != null) this.maxRegion = this.region;
    if (this.region === 2 && this.detail && !this.detail.uncommitted && !this.msgSel) {
      this.msgSel = { a: { row: 0, col: 0 }, f: { row: 0, col: 0 } };
    }
    if (this.region === 2 && this.detail?.uncommitted) this.ta.focus();
    else if (!this.hasKeyboard()) this.handle.focus();
    if (this.region === 3) this.ensureTreeSel(cx);
    if (this.region === 4) this.ensureCaret(cx);
    cx.notify();
  }

  maximizeRegion(n, cx) {
    if (this.maxRegion === n) return this.restoreMax(cx);
    this.maxRegion = n;
    this.region = n;
    if (n === 2 && this.detail?.uncommitted) this.ta.focus();
    else if (!this.hasKeyboard()) this.handle.focus();
    cx.notify();
  }

  restoreMax(cx) {
    this.maxRegion = null;
    cx.notify();
  }

  activateRegion(n, cx) {
    if (this.region !== n) {
      this.region = n;
      if (this.maxRegion != null) this.maxRegion = n;
      cx.notify();
    }
    if (n === 2 && this.detail?.uncommitted) {
      if (!this.typing && !this.inputHover) this.ta.focus();
      return;
    }
    if (!this.searchHover && !this.filterNative && !this.hasKeyboard()) this.handle.focus();
  }

  regionBox(el, n) {
    return el.on_mouse_down("left", (_e, cx) => this.activateRegion(n, cx));
  }

  layoutButton(t, value, label) {
    const on = this.maxRegion === value;
    return div().id(`vcs-layout-${value ?? "all"}`).h(18).px(6).flex().items_center().rounded(0)
      .text_size(9.5).cursor_pointer().bg(on ? t.accent : t.raised)
      .text_color(on ? t.accent_foreground : t.dim)
      .on_click((_e, cx) => {
        this.maxRegion = value;
        if (value) {
          this.region = value;
          if (value === 2 && this.detail?.uncommitted) this.ta.focus();
          else if (!this.hasKeyboard()) this.handle.focus();
        }
        cx.notify();
      })
      .child(label);
  }

  regionChip(t, n) {
    return div().id(`vcs-region-${n}`).w(15).h(14).flex_none().flex().items_center().justify_center()
      .rounded(3).text_size(9).cursor_pointer()
      .bg(this.region === n ? t.accent : t.raised)
      .text_color(this.region === n ? t.accent_foreground : t.dim)
      .on_click((_e, cx) => { cx.stop_propagation(); this.focusRegion(n, cx); })
      .child(String(n));
  }

  graphKey(k, e, cx) {
    const open = this.rows[0]?.uncommitted ? 1 : 0;
    if (k === "down" || k === "j") return this.select(Math.min(this.rows.length - 1, Math.max(this.gsel, 0) + 1), cx);
    if (k === "up" || k === "k") return this.select(Math.max(0, this.gsel - 1), cx);
    if (k === "g") {
      const now = Date.now();
      if (now - this.lastG < 500) { this.lastG = 0; this.select(0, cx); }
      else this.lastG = now;
      return;
    }
    if (k === "G") return this.select(this.rows.length - 1, cx);
    if (k === "m") { this.openCommitMenu(cx); return; }
    if (k === "v") { this.switchVcs(cx); return; }
    if (k === "o") { this.changeRepo(cx); return; }
    if (k === "O") { this.repoFromCwd(cx); return; }
    if (k === "enter") { this.focusRegion(3, cx); return; }
    void open;
  }

  ensureTreeSel(cx) {
    const rows = this.treeRows();
    if (!rows.length) { this.treeSel = null; return; }
    if (!rows.some((r) => (r.kind === "dir" ? r.path : r.file.path) === this.treeSel)) {
      const first = rows.find((r) => r.kind === "file") ?? rows[0];
      this.treeSel = first.kind === "dir" ? first.path : first.file.path;
    }
    this.treeScroll?.scroll_to_item(rows.findIndex((r) => (r.kind === "dir" ? r.path : r.file.path) === this.treeSel), "center");
    cx.notify();
  }

  treeKey(k, e, cx) {
    const rows = this.treeRows();
    if (!rows.length) return;
    const keyOf = (r) => r.kind === "dir" ? r.path : r.file.path;
    let at = rows.findIndex((r) => keyOf(r) === this.treeSel);
    if (at < 0) { this.ensureTreeSel(cx); return; }
    if (k === "down" || k === "j") at = Math.min(rows.length - 1, at + 1);
    else if (k === "up" || k === "k") at = Math.max(0, at - 1);
    else if (k === "G") at = rows.length - 1;
    else if (k === "g") {
      const now = Date.now();
      if (now - this.lastG < 500) { this.lastG = 0; at = 0; }
      else { this.lastG = now; return; }
    } else if (k === "l" || k === "right") {
      const row = rows[at];
      if (row.kind === "dir" && this.collapsed.has(row.path)) {
        this.collapsed.delete(row.path);
        this.collapsedVersion = (this.collapsedVersion ?? 0) + 1;
        cx.notify();
      } else if (row.kind === "file") {
        this.openTreeSel(cx);
      }
      return;
    } else if (k === "h" || k === "left") {
      const row = rows[at];
      if (row.kind === "dir" && !this.collapsed.has(row.path)) {
        this.collapsed.add(row.path);
        this.collapsedVersion = (this.collapsedVersion ?? 0) + 1;
        cx.notify();
      }
      return;
    } else if (k === "enter") {
      const row = rows[at];
      if (row.kind === "file") this.focusRegion(4, cx);
      else this.openTreeSel(cx);
      return;
    } else if (k === " ") {
      this.fileAction("toggleAdd", keyOf(rows[at]), cx);
      return;
    } else if (k === "d") {
      this.fileAction("revert", keyOf(rows[at]), cx);
      return;
    } else if (k === "A") {
      this.fileAction("toggleAll", null, cx);
      return;
    } else if (k === "m") {
      this.openTreeMenu(cx);
      return;
    } else if (k === "/") {
      this.filterFocus = true;
      this.handle.focus();
      cx.notify();
      return;
    } else if (k === "s") { this.runAction("stage", cx); return; }
    else if (k === "u") { this.runAction("unstage", cx); return; }
    else if (k === "r") { this.runAction("revert", cx); return; }
    else return;
    if (this.treeSel === keyOf(rows[at]) && k !== "G") return;
    this.treeSel = keyOf(rows[at]);
    this.treeScroll?.scroll_to_item(at, "center");
    const row = rows[at];
    if (row.kind === "file") this.treeClick(`f:${row.file.path}`, cx);
    else cx.notify();
  }

  fileAction(kind, path, cx) {
    if (this.dbusy) return;
    if (kind !== "addAll" && kind !== "toggleAll" && !path) return;
    this.dbusy = true;
    cx.notify();
    cx.spawn(async (cx) => {
    try {
      if (this.kind === "git") {
        const file = path ? this.files.find((f) => f.path === path) : null;
        let args;
        if (kind === "toggleAdd") args = file?.staged ? ["restore", "--staged", "--", path] : ["add", "--", path];
        else if (kind === "toggleAll") args = this.stagedCount > 0 ? ["reset"] : ["add", "-A"];
        else if (kind === "add" || kind === "addAll") args = kind === "add" ? ["add", "--", path] : ["add", "-A"];
        else args = ["restore", "--worktree", "--", path];
        const r = await hcExec("git", ["-C", this.root, ...args], { on: this.on });
        if (r.code !== 0) throw new Error((r.stderr || "git failed").trim());
      } else {
        const file = path ? this.files.find((f) => f.path === path) : null;
        if (kind === "toggleAdd" || kind === "add") {
          const added = file?.code === "A";
          const args = added ? ["revert", "--non-interactive", "--", path] : ["add", "--force", "--non-interactive", "--", path];
          const r = await hcExec("svn", args, { cwd: this.root, on: this.on });
          if (r.code !== 0) throw new Error((r.stderr || "svn failed").trim());
        } else if (kind === "toggleAll" || kind === "addAll") {
          const anyAdded = this.files.some((f) => f.code === "A");
          const args = anyAdded ? ["revert", "--non-interactive", "."] : ["add", "--force", "--non-interactive", "."];
          const r = await hcExec("svn", args, { cwd: this.root, on: this.on });
          if (r.code !== 0) throw new Error((r.stderr || "svn failed").trim());
        } else {
          const r = await hcExec("svn", ["revert", "--non-interactive", "--", path], { cwd: this.root, on: this.on });
          if (r.code !== 0) throw new Error((r.stderr || "svn revert failed").trim());
        }
      }
    } catch (err) {
      notify({ title: `${kind} failed`, body: String(err?.message ?? err), level: "error" });
    }
    this.dbusy = false;
    await this.load(cx);
    });
  }

  openTreeSel(cx) {
    const row = this.treeRows().find((r) => (r.kind === "dir" ? r.path : r.file.path) === this.treeSel);
    if (!row) return;
    if (row.kind === "dir") {
      if (this.collapsed.has(row.path)) this.collapsed.delete(row.path);
      else this.collapsed.add(row.path);
      this.collapsedVersion = (this.collapsedVersion ?? 0) + 1;
      cx.notify();
    } else {
      this.treeClick(`f:${row.file.path}`, cx);
    }
  }

  ensureCaret(cx) {
    if (this.tsel) return;
    const which = this.diffTarget();
    const { rows } = this.viewRows(which);
    if (!rows.length) return;
    const view = this.view === "split" ? "s" : "u";
    const side = view === "s" ? this.splitSide : null;
    this.tsel = { which, view, side, anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } };
    cx.notify();
  }

  diffKey(k, e, cx) {
    this.ensureCaret(cx);
    const ts = this.tsel;
    if (!ts) return;
    if (k === "down" || k === "j") return this.moveCaret(cx, "down", this.visual);
    if (k === "up" || k === "k") return this.moveCaret(cx, "up", this.visual);
    if (k === "g") {
      const now = Date.now();
      if (now - this.lastG < 500) { this.lastG = 0; this.moveCaretTo(0, cx); }
      else this.lastG = now;
      return;
    }
    if (k === "G") { const rows = this.viewRows(ts.which).rows; return this.moveCaretTo(rows.length - 1, cx); }
    if (k === "v") {
      this.visual = !this.visual;
      ts.anchor = { ...ts.focus };
      cx.notify();
      return;
    }
    if (k === "V") {
      const text = this.rowText(ts, this.viewRows(ts.which).rows[ts.focus.row]);
      ts.anchor = { row: ts.focus.row, col: 0 };
      ts.focus = { row: ts.focus.row, col: text.length };
      this.visual = true;
      cx.notify();
      return;
    }
    if (k === "y") {
      const now = Date.now();
      if (now - (this.lastY ?? 0) < 600) { this.lastY = 0; this.yankDiffLine(cx); return; }
      this.lastY = now;
      const text = this.selectedText();
      if (text) {
        cx.write_to_clipboard(text + "\n");
        notify({ title: "Copied", body: `${text.split("\n").length} line(s)` });
      }
      return;
    }
    if (k === "0") return this.moveCaret(cx, "home", this.visual);
    if (k === "^") {
      const text = this.rowText(ts, this.viewRows(ts.which).rows[ts.focus.row]);
      const at = text.search(/\S/);
      ts.focus = { row: ts.focus.row, col: at >= 0 ? at : 0 };
      if (!this.visual) ts.anchor = { ...ts.focus };
      cx.notify();
      return;
    }
    if (k === "$") return this.moveCaret(cx, "end", this.visual);
    if (k === "f" || k === "F") { this.pendingFind = k === "f" ? 1 : -1; return; }
    if (k === "m") { this.openDiffMenuAtCaret(cx); return; }
    if (k === "h" || k === "left") return this.moveCaret(cx, "left", this.visual);
    if (k === "l" || k === "right") return this.moveCaret(cx, "right", this.visual);
    if (k === "w") return this.wordMove(cx, 1, this.visual);
    if (k === "b") return this.wordMove(cx, -1, this.visual);
    if (k === "e") return this.wordEnd(cx, this.visual);
    if (k === "{") return this.paragraph(cx, -1);
    if (k === "}") return this.paragraph(cx, 1);
    if (k === "s") { this.startJumpMode(cx); return; }
    if (k === "z") { this.lastZ = Date.now(); return; }
    if (k === "a" && Date.now() - this.lastZ < 600) { this.toggleGapAtCaret(cx); return; }
    if (k === "A" && Date.now() - this.lastZ < 600) { this.toggleAllGaps(cx); return; }
    if (k === ":") {
      this.lineOpen = true;
      this.lineText = "";
      cx.notify();
      return;
    }
    if (k === "/") { this.searchOpen = true; this.searchInput.focus(); cx.notify(); return; }
    if (k === "n") { this.searchJump(1, cx); return; }
    if (k === "N") { this.searchJump(-1, cx); return; }
    if (e.keystroke === "ctrl-d") { this.moveCaret(cx, "pagedown", false); return; }
    if (e.keystroke === "ctrl-u") { this.moveCaret(cx, "pageup", false); return; }
  }

  rowTextAt(ts, row) {
    return this.rowText(ts, this.viewRows(ts.which).rows[row]);
  }

  wordMove(cx, dir, extend) {
    const ts = this.tsel;
    if (!ts) return;
    const rows = this.viewRows(ts.which).rows;
    let row = ts.focus.row;
    let col = ts.focus.col;
    let text = this.rowText(ts, rows[row]);
    const isw = (c) => /[A-Za-z0-9_$]/.test(c ?? "");
    if (dir > 0) {
      while (true) {
        if (col < text.length && isw(text[col])) {
          while (col < text.length && isw(text[col])) col++;
        } else while (col < text.length && !isw(text[col])) col++;
        if (col < text.length) break;
        if (row >= rows.length - 1) { col = text.length; break; }
        row++;
        col = 0;
        text = this.rowText(ts, rows[row]);
        if (!text) continue;
      }
    } else {
      while (true) {
        if (col > 0) {
          col--;
          while (col > 0 && !isw(text[col])) col--;
          while (col > 0 && isw(text[col - 1])) col--;
          break;
        }
        if (row <= 0) break;
        row--;
        text = this.rowText(ts, rows[row]);
        col = text.length;
        if (!text) continue;
      }
    }
    ts.focus = { row, col };
    if (!extend) ts.anchor = { ...ts.focus };
    this.moveCaretTo(row, cx);
  }

  wordEnd(cx, extend) {
    const ts = this.tsel;
    if (!ts) return;
    const rows = this.viewRows(ts.which).rows;
    let row = ts.focus.row;
    let col = ts.focus.col;
    let text = this.rowText(ts, rows[row]);
    const isw = (c) => /[A-Za-z0-9_$]/.test(c ?? "");
    while (row < rows.length - 1 || col < text.length) {
      if (col < text.length && isw(text[col])) {
        while (col < text.length && isw(text[col])) col++;
        break;
      }
      if (col < text.length) { col++; continue; }
      row++;
      col = 0;
      text = this.rowText(ts, rows[row]);
    }
    ts.focus = { row, col: Math.max(0, col - (col === text.length ? 1 : 0)) };
    if (!extend) ts.anchor = { ...ts.focus };
    this.moveCaretTo(row, cx);
  }

  paragraph(cx, dir) {
    const ts = this.tsel;
    if (!ts) return;
    const rows = this.viewRows(ts.which).rows;
    let row = ts.focus.row;
    while (true) {
      row += dir;
      if (row < 0 || row >= rows.length) { row = Math.max(0, Math.min(rows.length - 1, row)); break; }
      if (!this.rowText(ts, rows[row]).trim()) break;
    }
    ts.focus = { row, col: 0 };
    ts.anchor = { ...ts.focus };
    this.moveCaretTo(row, cx);
  }

  startJumpMode(cx) {
    this.ensureCaret(cx);
    const which = this.diffTarget();
    const rows = this.viewRows(which).rows;
    const height = this.viewportH || 320;
    const first = Math.max(0, Math.floor(this.scrollY / 18));
    const last = Math.min(rows.length, Math.ceil((this.scrollY + height) / 18) + 1);
    const labels = new Map();
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    let n = 0;
    for (let i = first; i < last; i++) {
      if (!this.rowText(this.tsel, rows[i]).trim()) continue;
      const label = n < 26 ? alphabet[n] : alphabet[Math.floor(n / 26) - 1] + alphabet[n % 26];
      labels.set(label, { row: i, col: 0 });
      n++;
    }
    this.jumpLabels = labels;
    this.jumpMode = labels.size > 0;
    cx.notify();
  }

  keepCaretX(col) {
    const cw = this.charW || 7;
    const viewW = this.view === "split" ? Math.max(120, (this.diffW || 600) / 2 - 50) : Math.max(120, (this.diffW || 600) - 95);
    const x = col * cw;
    if (x < this.scrollX) this.scrollX = Math.max(0, x - 2 * cw);
    else if (x > this.scrollX + viewW - cw) this.scrollX = x - viewW + 2 * cw;
  }

  moveCaretTo(row, cx) {
    const ts = this.tsel;
    if (!ts) return;
    const rows = this.viewRows(ts.which).rows;
    const r = Math.max(0, Math.min(rows.length - 1, row));
    const len = this.rowText(ts, rows[r]).length;
    ts.focus = { row: r, col: Math.min(ts.focus.col, len) };
    if (!this.visual) ts.anchor = { ...ts.focus };
    const h = this.viewportH || 320;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, rows.length * 18 - h)));
    if (r * 18 < this.scrollY) this.scrollY = r * 18;
    else if (r * 18 > this.scrollY + h - 36) this.scrollY = Math.max(0, r * 18 - h + 36);
    cx.notify();
  }

  toggleGapAtCaret(cx) {
    const ts = this.tsel;
    const which = ts?.which ?? this.diffTarget();
    const rows = this.viewRows(which).rows;
    const bars = rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === "gapbar");
    if (!bars.length) return this.toggleAllGaps(cx);
    const at = ts?.focus.row ?? 0;
    const bar = bars.filter((b) => b.i <= at).pop() ?? bars[0];
    const cur = this.gaps.get(bar.r.key) ?? 0;
    this.gaps.set(bar.r.key, cur >= bar.r.total ? 0 : bar.r.total);
    const after = this.viewRows(which).rows.length;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, after * 18 - (this.viewportH || 320))));
    cx.notify();
  }

  toggleAllGaps(cx) {
    const which = this.tsel?.which ?? this.diffTarget();
    const info = this.masterInfo(which);
    if (!info) return;
    for (const g of info.gaps) this.gaps.set(g.key, info.expanded ? 0 : g.total);
    const after = this.viewRows(which).rows.length;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, after * 18 - (this.viewportH || 320))));
    cx.notify();
  }

  searchText(row) {
    if (!row || row.kind === "@" || row.kind === "gap" || row.kind === "gapbar") return "";
    if (row.kind === "pair") return `${row.del?.text ?? ""} ${row.add?.text ?? ""}`;
    return row.text ?? "";
  }

  searchJump(dir, cx) {
    const q = this.query.trim().toLowerCase();
    if (!q) return;
    const which = this.tsel?.which ?? this.diffTarget();
    const rows = this.viewRows(which).rows;
    if (!rows.length) return;
    const start = this.tsel?.focus.row ?? Math.floor(this.scrollY / 18);
    for (let n = 1; n <= rows.length; n++) {
      const i = ((start + dir * n) % rows.length + rows.length) % rows.length;
      const text = this.searchText(rows[i]);
      const at = text.toLowerCase().indexOf(q);
      if (at >= 0) {
        const ts = this.tsel ?? (this.tsel = { which, view: this.view === "split" ? "s" : "u", side: this.view === "split" ? (rows[i]?.del ? "l" : "r") : null, anchor: { row: i, col: at }, focus: { row: i, col: at } });
        ts.focus = { row: i, col: at };
        ts.anchor = { row: i, col: at };
        this.moveCaretTo(i, cx);
        return;
      }
    }
  }

  // ---- graph drawing (lanes as paths, like Git Graph)

  graphCell(t, row, commit) {
    const colors = laneColors(t);
    const x = (lane) => PAD + lane * LANE + LANE / 2;
    const y = (v) => v * ROW;
    const paths = new Map();
    for (const [a, ya, b, yb, c, dashed] of row.segments) {
      const color = dashed ? t.dim : colors[c % colors.length];
      const key = `${color}${dashed ? "-" : ""}`;
      let p = paths.get(key)?.p ?? (dashed ? PathBuilder.stroke(1.5).dash_array([3, 3]) : PathBuilder.stroke(1.5));
      p = p.move_to(x(a), y(ya));
      if (a === b) p = p.line_to(x(b), y(yb));
      else {
        const mid = (y(ya) + y(yb)) / 2;
        p = p.cubic_bezier_to(x(b), y(yb), x(a), mid, x(b), mid);
      }
      paths.set(key, { p, color });
    }
    const color = commit.uncommitted ? t.dim : colors[row.lane % colors.length];
    const dot = div().absolute().left(x(row.lane) - 4).top(ROW / 2 - 4).size(8).rounded(4);
    return div().relative().flex_none().w(PAD * 2 + this.lanes * LANE).h(ROW).overflow_hidden()
      .children([...paths.values()].map(({ p, color }) => window.paint_path(p.build(), color).absolute().top(0).left(0).size_full()))
      .child(commit.head || commit.uncommitted ? dot.bg(t.background).border(2).border_color(color) : dot.bg(color));
  }

  rowEl(t, font, commit, row, index) {
    const on = index === this.gsel;
    if (this.kind === "svn") {
      const r = commit;
      return h_flex().h(ROW).flex_none().items_center().px(6).gap(8).cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .child(div().w(14).flex_none().text_color(t.accent).child("●"))
        .child(div().w(62).flex_none().font_family(font).text_size(11.5).text_color(t.muted).child(r.uncommitted ? "*" : `r${r.rev}`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child((r.message ?? "").split("\n")[0] || "(no message)"))
        .when(r.copies?.length > 0, (el) => el.child(div().text_size(11).text_color(t.done).truncate().child(r.copies.map((c) => `→ ${c.path}`).join("  "))))
        .child(div().flex_none().whitespace_nowrap().text_size(11).text_color(t.dim).child(`${r.author}  ${r.date}`));
    }
    const c = commit;
    return h_flex().h(ROW).flex_none().items_center().px(6).gap(6).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .child(this.graphCell(t, row, c))
      .child(div().w(66).flex_none().font_family(font).text_size(11.5).text_color(t.dim).child(c.uncommitted ? "*" : c.short))
      .child(h_flex().flex_none().gap(5).children(c.refs.slice(0, 4).map((ref) =>
        div().text_size(11).px(5).rounded(0)
          .bg(ref.kind === "head" ? t.solid : ref.kind === "tag" ? t.raised : t.selected)
          .text_color(ref.kind === "head" ? t.solid_foreground : ref.kind === "tag" ? (t.warning ?? t.ansi3) : t.foreground)
          .child(ref.name))))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(c.uncommitted ? t.ansi3 : t.foreground).child(c.subject))
      .child(div().flex_none().whitespace_nowrap().text_size(11).text_color(t.dim).child(c.uncommitted ? "" : `${c.author}  ${c.date}`));
  }

  detailsSection(t, font, fill) {
    const d = this.detail;
    const bar = h_flex().h(30).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border).bg(this.region === 2 ? t.selected : t.chrome)
      .on_mouse_down("left", (_e, cx) => {
        this.region = 2;
        if (this.detail?.uncommitted) this.ta.focus(); else this.handle.focus();
        cx.notify();
      });
    if (!d) return v_flex().flex_none().child(bar.child(div().text_size(11.5).text_color(t.dim).child(this.loading || this.gbusy ? "Loading…" : "Pick a commit")));
    if (d.error) return v_flex().flex_none().child(bar.child(div().text_size(11.5).text_color(t.blocked).child(d.error)));
    const refs = (d.refs ?? []).slice(0, 5).map((ref) => div().text_size(10).px(4).rounded(0)
      .bg(ref.kind === "head" ? t.solid : t.raised)
      .text_color(ref.kind === "head" ? t.solid_foreground : t.muted).child(ref.name));
    const head = bar
      .child(this.regionChip(t, 2))
      .child(this.chevron(t, "vcs-details-toggle", this.showDetails, () => {
        this.showDetails = !this.showDetails;
      }))
      .child(div().font_family(font).text_size(11.5).font_semibold().text_color(t.foreground)
        .child(d.uncommitted ? "Uncommitted changes" : (this.kind === "git" ? d.short : `r${d.rev}`)))
      .children(refs)
      .when(Boolean(d.author), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(d.author)))
      .child(div().flex_1())
      .child(div().text_size(10.5).text_color(t.dim).child(`${d.files?.length ?? 0} files`));
    if (!this.showDetails) return v_flex().flex_none().relative()
      .when(this.region === 2, (el) => el.child(div().absolute().top(0).left(0).right(0).h(2).bg(t.accent)))
      .child(head);
    if (d.uncommitted) {
      return v_flex().when(fill, (el) => el.flex_1()).when(!fill, (el) => el.flex_none().h(this.detailsH + 30)).relative()
        .when(this.region === 2, (el) => el.child(div().absolute().top(0).left(0).right(0).h(2).bg(t.accent)))
        .child(head)
        .child(v_flex().flex_1().min_h(0).px(10).py(8).gap(6)
          .child(div().flex_1().min_h(0).px(6).py(3).border_1().border_color(t.input).bg(t.background)
            .on_hover((hovered) => { this.inputHover = hovered; })
            .child(Textarea.new(this.ta).w_full().h_full().text_size(12).text_color(t.foreground)))
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().text_size(10).text_color(t.dim).truncate()
              .child(this.kind === "git" ? `${this.stagedCount} staged · ${this.workingCount} working` : `${this.files.length} changed`))
            .child(h_flex().items_center().id("vcs-commit").h(24).px(10).rounded(0).bg(t.solid)
              .text_color(t.solid_foreground).text_size(11).cursor_pointer().hover((x) => x.opacity(0.88))
              .on_click((_e, cx) => { cx.stop_propagation(); this.commit(cx); }).child("Commit"))));
    }
    const message = (d.message ?? "").split("\n");
    const isHead = this.isHeadCommit(d);
    return v_flex().when(fill, (el) => el.flex_1()).when(!fill, (el) => el.flex_none().h(this.detailsH + 30)).relative()
      .when(this.region === 2, (el) => el.child(div().absolute().top(0).left(0).right(0).h(2).bg(t.accent)))
      .child(head)
      .when(this.amend, (el) => el
        .child(v_flex().flex_1().min_h(0).px(10).py(8).gap(6)
          .child(div().flex_1().min_h(0).px(6).py(3).border_1().border_color(t.input).bg(t.background)
            .on_hover((hovered) => { this.inputHover = hovered; })
            .child(Textarea.new(this.ta).w_full().h_full().text_size(12).text_color(t.foreground)))
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().text_size(10).text_color(t.dim)
              .child(isHead ? "Edit the HEAD commit message" : "Only the HEAD commit can be edited"))
            .child(h_flex().items_center().id("vcs-amend-cancel").h(24).px(10).rounded(0).bg(t.raised)
              .text_size(11).cursor_pointer().on_click((_e, cx) => {
                this.amend = false;
                this.ta.set_value("");
                this.handle.focus();
                cx.notify();
              }).child("Cancel"))
            .child(h_flex().items_center().id("vcs-amend").h(24).px(10).rounded(0)
              .bg(isHead ? t.solid : t.raised).text_color(isHead ? t.solid_foreground : t.dim)
              .text_size(11).cursor_pointer()
              .on_click((_e, cx) => { if (this.isHeadCommit(d)) this.amendCommit(cx); }).child("Amend")))))
      .when(!this.amend, (el) => el
        .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().px(10).py(6).gap(2)
          .when(this.kind === "git" && d.parents?.length > 1, (x) => x
            .child(div().text_size(10.5).text_color(t.dim).child(`merge ${d.parents.map((p) => p.slice(0, 7)).join(" ")}`)))
          .children(this.messageLines(t, font, message))));
  }

  messageLines(t, font, lines) {
    const sel = this.msgSel;
    const norm = sel ? (() => {
      const a = sel.a;
      const f = sel.f;
      const forward = a.row < f.row || (a.row === f.row && a.col <= f.col);
      return { start: forward ? a : f, end: forward ? f : a };
    })() : null;
    const charW = this.charW || 7;
    return lines.map((line, i) => {
      const text = line || " ";
      let start = 0;
      let end = 0;
      if (norm && i >= norm.start.row && i <= norm.end.row) {
        start = i === norm.start.row ? norm.start.col : 0;
        end = i === norm.end.row ? norm.end.col : text.length;
      }
      const selected = end > start;
      const piece = (chunk, bg) => div().flex_none().whitespace_nowrap().font_family(font).text_size(11.5)
        .text_color(t.foreground).when(Boolean(bg), (el) => el.bg(bg))
        .child(chunk.replace(/ /g, "\u00a0"));
      const caret = sel && sel.a.row === sel.f.row && sel.f.row === i ? sel.f.col : -1;
      return h_flex().h(18).flex_none().items_center().relative()
        .when(selected, (el) => el)
        .child(piece(text.slice(0, start), null))
        .when(selected, (el) => el.child(piece(text.slice(start, end), t.selection)))
        .child(piece(text.slice(end), null))
        .when(caret >= 0, (el) => el
          .child(div().absolute().left(textWidth(text.slice(0, caret)) * charW).top(1).w(2).h(16).bg(t.accent)));
    });
  }

  msgKey(k, e, cx) {
    const d = this.detail;
    if (!d || d.uncommitted) { if (d?.uncommitted) this.ta.focus(); return; }
    const lines = (d.message ?? "").split("\n");
    if (!this.msgSel) this.msgSel = { a: { row: 0, col: 0 }, f: { row: 0, col: 0 } };
    const ts = this.msgSel;
    const len = (row) => (lines[row] ?? "").length;
    const move = (row, col, extend) => {
      const r = Math.max(0, Math.min(lines.length - 1, row));
      const c = Math.max(0, Math.min(len(r), col));
      ts.f = { row: r, col: c };
      if (!extend) ts.a = { row: r, col: c };
      cx.notify();
    };
    const extend = (e) => this.msgVisual || Boolean(e.modifiers?.shift);
    if (k === "down" || k === "j") return move(ts.f.row + 1, ts.f.col, extend(e));
    if (k === "up" || k === "k") return move(ts.f.row - 1, ts.f.col, extend(e));
    if (k === "left" || k === "h") return move(ts.f.row, ts.f.col - 1, extend(e));
    if (k === "right" || k === "l") return move(ts.f.row, ts.f.col + 1, extend(e));
    if (k === "home" || k === "0") return move(ts.f.row, 0, extend(e));
    if (k === "^") {
      const at = (lines[ts.f.row] ?? "").search(/\S/);
      return move(ts.f.row, at >= 0 ? at : 0, extend(e));
    }
    if (k === "end" || k === "$") return move(ts.f.row, len(ts.f.row), extend(e));
    if (k === "f" || k === "F") { this.pendingFindMsg = k === "f" ? 1 : -1; return; }
    if (k === "w" || k === "b" || k === "e") {
      const isw = (c) => /[A-Za-z0-9_$]/.test(c ?? "");
      let row = ts.f.row;
      let col = ts.f.col;
      const textAt = (i) => lines[i] ?? "";
      let text = textAt(row);
      if (k === "w") {
        while (true) {
          if (col < text.length && isw(text[col])) { while (col < text.length && isw(text[col])) col++; }
          else while (col < text.length && !isw(text[col])) col++;
          if (col < text.length) break;
          if (row >= lines.length - 1) break;
          row++; col = 0; text = textAt(row);
        }
      } else if (k === "b") {
        while (true) {
          if (col > 0) col--;
          else {
            if (row <= 0) break;
            row--; text = textAt(row); col = text.length;
            if (!text.length) continue;
            col = Math.max(0, col - 1);
          }
          if (col === 0 || !isw(text[col - 1])) {
            while (col > 0 && !isw(text[col - 1])) col--;
            while (col > 0 && isw(text[col - 1])) col--;
            break;
          }
        }
      } else {
        while (true) {
          if (col < text.length && isw(text[col])) { while (col < text.length && isw(text[col])) col++; }
          else while (col < text.length && !isw(text[col])) col++;
          if (col < text.length) { col = Math.min(text.length, col); break; }
          if (row >= lines.length - 1) break;
          row++; col = 0; text = textAt(row);
        }
      }
      return move(row, col, extend(e));
    }
    if (k === "{" || k === "}") {
      let row = ts.f.row;
      if (k === "}") {
        let i = row + 1;
        while (i < lines.length && lines[i] !== "") i++;
        while (i < lines.length && lines[i] === "") i++;
        row = Math.min(i, Math.max(0, lines.length - 1));
      } else {
        let i = row - 1;
        while (i >= 0 && lines[i] !== "") i--;
        if (i < 0) { row = 0; } else { while (i < lines.length && lines[i] === "") i++; row = Math.min(i, lines.length - 1); }
      }
      return move(row, 0, extend(e));
    }
    if (k === "E") {
      this.amend = true;
      this.ta.set_value(d.message ?? "");
      this.ta.focus();
      cx.notify();
      return;
    }
    if (k === "G") return move(lines.length - 1, 0, false);
    if (k === "g") {
      const now = Date.now();
      if (now - this.lastG < 500) { this.lastG = 0; return move(0, 0, false); }
      this.lastG = now;
      return;
    }
    if (k === "v") {
      this.msgVisual = !this.msgVisual;
      ts.a = { ...ts.f };
      cx.notify();
      return;
    }
    if (k === "y" || e.keystroke === "ctrl-c") {
      const now = Date.now();
      if (now - (this.lastY ?? 0) < 600) { this.lastY = 0; this.yankMsgLine(cx); return; }
      this.lastY = now;
      this.copyMessage(cx);
      return;
    }
  }

  copyMessage(cx) {
    const d = this.detail;
    if (!d) return;
    const lines = (d.message ?? "").split("\n");
    const ts = this.msgSel;
    let text;
    if (!ts) text = lines.join("\n");
    else {
      const a = ts.a;
      const f = ts.f;
      const forward = a.row < f.row || (a.row === f.row && a.col <= f.col);
      const start = forward ? a : f;
      const end = forward ? f : a;
      const out = [];
      for (let i = start.row; i <= Math.min(end.row, lines.length - 1); i++) {
        const line = lines[i] ?? "";
        out.push(line.slice(i === start.row ? start.col : 0, i === end.row ? end.col : line.length));
      }
      text = out.join("\n");
    }
    cx.write_to_clipboard(text + (text.endsWith("\n") ? "" : "\n"));
    notify({ title: "Copied commit message", body: text.split("\n")[0] });
  }

  chevron(t, id, open, toggle) {
    return div().id(id).w(14).flex_none().text_size(10).text_color(t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); toggle(); cx.notify(); })
      .child(open ? "\uf078" : "\uf054");
  }

  treeSection(t, font, cx, fill) {
    const rows = this.treeRows();
    const uncommitted = Boolean(this.detail?.uncommitted);
    const file = this.currentFiles().find((f) => f.path === this.dsel);
    const head = h_flex().h(28).flex_none().px(8).gap(6).items_center().border_t(1).border_color(t.border).bg(this.region === 3 ? t.selected : t.chrome)
      .child(this.regionChip(t, 3))
      .child(this.chevron(t, "vcs-tree-toggle", this.showTree, () => { this.showTree = !this.showTree; }))
      .child(div().text_size(11).font_semibold().text_color(t.muted).child("Files"))
      .child(div().text_size(10).text_color(t.dim).child(String(this.currentFiles().length)))
      .child(div().flex_1())
      .when(uncommitted && file, (el) => el
        .when(this.kind === "git" && (file.untracked || file.dirty), (x) => x
          .child(this.smallButton(t, "vcs-file-stage", "Stage", () => this.runAction("stage", cx))))
        .when(this.kind === "git" && file.staged, (x) => x
          .child(this.smallButton(t, "vcs-file-unstage", "Unstage", () => this.runAction("unstage", cx))))
        .when(this.kind === "svn" && file.untracked, (x) => x
          .child(this.smallButton(t, "vcs-file-add", "Add", () => this.runAction("stage", cx))))
        .when(!file.untracked, (x) => x
          .child(this.smallButton(t, "vcs-file-revert", "Revert", () => this.runAction("revert", cx), true)))
        .when(this.kind === "git" && !file.untracked && !this.on, (x) => x
          .child(this.smallButton(t, "vcs-hunk-revert", "⟲ hunk", () => this.revertHunk(cx), true))))
      .child(div().w(120).h(20).px(6).flex().items_center().border_1().border_color(t.input).bg(t.background)
        .on_mouse_down("left", (e, cx) => cx.stop_propagation())
        .child(Input.new(this.filterInput).w_full().h_full().text_size(10).text_color(t.foreground)));
    if (!this.showTree) return v_flex().flex_none().relative()
      .when(this.region === 3, (el) => el.child(div().absolute().top(0).left(0).right(0).h(2).bg(t.accent)))
      .child(head);
    return v_flex().when(fill, (el) => el.flex_1()).when(!fill, (el) => el.flex_none().h(this.treeH + 28)).relative()
      .when(this.region === 3, (el) => el.child(div().absolute().top(0).left(0).right(0).h(2).bg(t.accent)))
      .child(head)
      .child(div().flex_1().min_h(0).relative()
        .when(rows.length === 0, (el) => el
          .child(div().p(8).text_size(11.5).text_color(t.dim)
            .child(uncommitted ? (this.files.length ? "No files match" : "No changes") : "No files")))
        .when(rows.length > 0, (el) => el
          .child(v_virtual_list("vcs-tree", rows.length, 24, (i) => rows[i].kind === "dir" ? `d:${rows[i].path}` : `f:${rows[i].file.path}`,
            (range) => rows.slice(range.start, range.end).map((r) => this.treeRow(t, font, r)))
            .track_scroll(this.treeScroll)
            .on_item_click((key, cx) => this.treeClick(key, cx))
            .size_full())
          .child(Scrollbar.vertical("vcs-tree").viewport_from_layout().absolute().inset(0))))
      .when(this.menu?.kind === "tree", (el) => el.child(this.menuView(t)));
  }

  treeRow(t, font, r) {
    if (r.kind === "dir") {
      return h_flex().h(24).flex_none().items_center().gap(6).cursor_pointer()
        .pl(8 + r.depth * 14)
        .when(this.region === 3 && this.treeSel === r.path, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .child(div().font_family(font).text_size(10).text_color(t.dim).child(r.collapsed ? "\uf054" : "\uf078"))
        .child(div().font_family(font).text_size(11.5).text_color(t.muted).child(r.name));
    }
    const f = r.file;
    const on = this.region === 3 && this.treeSel === f.path;
    const status = this.kind === "git" ? (f.untracked ? "?" : (f.staged ? f.x : f.y)?.trim() || (f.x === "M" ? "M" : "M")) : (f.code ?? f.status ?? "M");
    const color = status === "A" || status === "?" ? t.ansi2
      : status === "D" ? t.ansi1
        : status === "R" ? t.ansi4 : t.ansi3;
    return h_flex().h(24).flex_none().items_center().gap(8).cursor_pointer()
      .pl(8 + r.depth * 14).pr(8)
      .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .child(div().w(14).flex_none().font_family(font).text_size(10.5).font_semibold().text_color(color).child(status))
      .child(div().flex_1().min_w(0).truncate().font_family(font).text_size(11.5).text_color(t.foreground).child(f.name ?? f.path.split("/").pop()))
      .when(f.add != null, (el) => el.child(div().font_family(font).text_size(10).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del != null, (el) => el.child(div().font_family(font).text_size(10).text_color(t.ansi1).child(`-${f.del}`)));
  }

  treeClick(key, cx) {
    this.region = 3;
    this.handle.focus();
    const at = key.indexOf(":");
    const kind = key.slice(0, at);
    const path = key.slice(at + 1);
    if (kind === "d") {
      if (this.collapsed.has(path)) this.collapsed.delete(path);
      else this.collapsed.add(path);
      this.collapsedVersion = (this.collapsedVersion ?? 0) + 1;
      cx.notify();
      return;
    }
    this.dsel = path;
    this.treeSel = path;
    if (this.detail?.uncommitted) {
      cx.spawn(async (cx) => this.loadMainFile(cx));
      cx.notify();
    } else {
      this.pickFile(path, cx);
    }
  }

  diffSection(t, font, cx) {
    const uncommitted = Boolean(this.detail?.uncommitted);
    const file = this.currentFiles().find((f) => f.path === this.dsel) ?? null;
    const model = uncommitted ? this.mainModel : this.detailModel;
    const count = this.selCount();
    const path = this.dsel ?? "";
    const stats = file && (file.add != null || file.del != null)
      ? h_flex().gap(4).child(div().text_size(10).text_color(t.ansi2).child(file.add ? `+${file.add}` : ""))
        .child(div().text_size(10).text_color(t.ansi1).child(file.del ? `-${file.del}` : ""))
      : div();
    const toolbar = h_flex().h(28).flex_none().px(6).gap(4).items_center().border_t(1).border_color(t.border).bg(this.region === 4 ? t.selected : t.chrome)
      .child(this.regionChip(t, 4))
      .child(this.tabButton(t, "vcs-unified", "Unified", this.view === "unified", () => {
        this.view = this.view === "split" ? "unified" : "split";
        this.tsel = null;
        cx.notify();
      }))
      .child(this.tabButton(t, "vcs-split", "Split", this.view === "split", () => {
        this.view = this.view === "split" ? "unified" : "split";
        this.tsel = null;
        cx.notify();
      }))
      .child(div().flex_1().min_w(0).flex().gap(4).items_center().px(4)
        .child(div().flex_1().min_w(0).truncate().font_family(font).text_size(11).text_color(t.muted).child(path))
        .child(stats))
      .when(this.lineOpen, (el) => el
        .child(div().w(72).h(20).px(6).flex().items_center().border_1()
          .border_color(t.accent).bg(t.background).font_family(font).text_size(10.5)
          .text_color(t.foreground).child(`:${this.lineText}`)))
      .when(this.searchOpen || this.query, (el) => el
        .child(div().w(130).h(20).px(6).flex().items_center().border_1()
          .border_color(this.searchOpen ? t.accent : t.input).bg(t.background)
          .on_hover((hovered) => { this.searchHover = hovered; })
          .child(Input.new(this.searchInput).w_full().h_full().text_size(10).text_color(t.foreground))));
    const empty = !file ? "Select a file"
      : (model && (this.view === "split" ? model.split : model.rows).length
        ? ""
        : "No textual diff (binary, new empty file, or ignored whitespace)");
    return v_flex().flex_1().min_h(0).relative()
      .when(this.region === 4, (el) => el.child(div().absolute().top(0).left(0).right(0).h(2).bg(t.accent)))
      .child(toolbar)
      .child(this.dbusy || this.diffBusy
        ? div().p(10).text_size(11.5).text_color(t.dim).child("Working…")
        : this.diffView(t, font, uncommitted ? "main" : "detail", model, empty));
  }

  // ---- changes drawing
  // ---- changes drawing

  treeRows() {
    const detailKey = this.detail ? (this.detail.hash ?? this.detail.rev ?? (this.detail.uncommitted ? "u" : "?")) : "";
    const key = `${this.filesKey ?? 0}|${detailKey}|${this.filterText}|${this.collapsedVersion ?? 0}`;
    if (this.treeCache?.key === key) return this.treeCache.rows;
    const needle = this.filterText.trim().toLowerCase();
    const files = [...this.currentFiles()]
      .filter((f) => typeof f?.path === "string" && f.path)
      .filter((f) => !needle || f.path.toLowerCase().includes(needle))
      .sort((a, b) => a.path.localeCompare(b.path));
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts.slice(0, i + 1).join("/");
        if (!node.dirs.has(key)) node.dirs.set(key, { name: parts[i], path: key, dirs: new Map(), files: [] });
        node = node.dirs.get(key);
      }
      node.files.push(f);
    }
    const rows = [];
    const walk = (node, depth) => {
      for (const key of [...node.dirs.keys()].sort()) {
        const dir = node.dirs.get(key);
        rows.push({ kind: "dir", path: dir.path, name: dir.name, depth, collapsed: this.collapsed.has(dir.path) });
        if (!this.collapsed.has(dir.path)) walk(dir, depth + 1);
      }
      for (const f of node.files) rows.push({ kind: "file", file: f, depth });
    };
    walk(root, 0);
    this.treeCache = { key, rows };
    return rows;
  }

  wordDiff(a, b) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return { aPre: a.slice(0, p), aMid: a.slice(p, a.length - s), aSuf: a.slice(a.length - s),
      bPre: b.slice(0, p), bMid: b.slice(p, b.length - s), bSuf: b.slice(b.length - s) };
  }

  // Parses a diff once: numbers, word highlights, hunk boundaries and the
  // patch text each hunk needs to be reverted, for both views.
  buildModel(lines, keyBase, lang, fileLines) {
    const uni = [];
    const split = [];
    const hunks = [];
    const headerLines = [];
    let width = 320;
    let hunk = -1;
    const clean = (text) => {
      const shown = text.replace(/\t/g, "    ");
      return shown.length > 2000 ? shown.slice(0, 2000) + "…" : shown;
    };
    const measure = (text) => { width = Math.max(width, Math.min(text.length, 400) * 7.2 + 110); };
    let oldNo = 0;
    let newNo = 0;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line === "") { i++; continue; }
      const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunkMatch) {
        oldNo = Number(hunkMatch[1]);
        newNo = Number(hunkMatch[2]);
        hunk++;
        const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        hunks.push({
          header: line, lines: [line], hunk,
          uniRow: uni.length, splitRow: split.length,
          oldStart: Number(hm[1]), oldCount: hm[2] == null ? 1 : Number(hm[2]),
          newStart: Number(hm[3]), newCount: hm[4] == null ? 1 : Number(hm[4]),
        });
        const row = { kind: "@", text: line, h: hunk, foldKey: `${keyBase}#${line}` };
        uni.push(row);
        split.push(row);
        measure(line);
        i++;
        continue;
      }
      if (/^(diff |index |Index: |=====|Revision: |--- |\+\+\+ |new file |deleted file |similarity |rename |Binary files)/.test(line)) {
        headerLines.push(line);
        i++;
        continue;
      }
      if (line.startsWith("\\")) {
        const row = { kind: "note", text: line };
        uni.push(row);
        split.push(row);
        if (hunk >= 0) hunks[hunk].lines.push(line);
        i++;
        continue;
      }
      const tag = (row) => { row.h = hunk; if (hunk >= 0 && row.raw != null) hunks[hunk].lines.push(row.raw); return row; };
      if (line.startsWith("-")) {
        const dels = [];
        while (i < lines.length && lines[i].startsWith("-") && !lines[i].startsWith("---")) {
          const text = clean(lines[i].slice(1));
          dels.push({ no: oldNo++, text, raw: lines[i] });
          measure(text);
          i++;
        }
        const adds = [];
        while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) {
          const text = clean(lines[i].slice(1));
          adds.push({ no: newNo++, text, raw: lines[i] });
          measure(text);
          i++;
        }
        const n = Math.max(dels.length, adds.length);
        for (let k = 0; k < n; k++) {
          const d = dels[k];
          const a = adds[k];
          const w = d && a && d.text.length < 400 && a.text.length < 400 ? this.wordDiff(d.text, a.text) : null;
          if (d) uni.push(tag({ kind: "-", no: d.no, text: d.text, word: w ? { pre: w.aPre, mid: w.aMid, suf: w.aSuf } : null, raw: d.raw }));
          if (a) uni.push(tag({ kind: "+", no: a.no, text: a.text, word: w ? { pre: w.bPre, mid: w.bMid, suf: w.bSuf } : null, raw: a.raw }));
          split.push(tag({ kind: "pair", del: d, add: a, word: w }));
        }
        continue;
      }
      if (line.startsWith("+")) {
        const text = clean(line.slice(1));
        measure(text);
        uni.push(tag({ kind: "+", no: newNo, text, raw: line }));
        split.push(tag({ kind: "pair", add: { no: newNo, text, raw: line } }));
        newNo++;
        i++;
        continue;
      }
      const text = clean(line.startsWith(" ") ? line.slice(1) : line);
      measure(text);
      uni.push(tag({ kind: " ", oldNo, newNo, text, raw: line }));
      split.push(tag({ kind: "ctx", oldNo, newNo, text }));
      oldNo++;
      newNo++;
      i++;
    }
    if (fileLines && fileLines.length && hunks.length) {
      const gap = (key, from, to, oldFrom) => {
        const items = [];
        const stop = Math.min(to, from + 2000 - 1, fileLines.length);
        for (let n = from; n <= stop; n++) items.push({ old: oldFrom + (n - from), new: n, text: fileLines[n - 1] ?? "" });
        return items.length ? { kind: "gap", key, items } : null;
      };
      for (let k = hunks.length - 1; k >= 0; k--) {
        const h = hunks[k];
        const prev = k > 0 ? hunks[k - 1] : null;
        const from = prev ? prev.newStart + prev.newCount : 1;
        const oldFrom = prev ? prev.oldStart + prev.oldCount : 1;
        const row = gap(`${keyBase}#g${k}`, from, h.newStart - 1, oldFrom);
        if (row) {
          uni.splice(h.uniRow, 0, row);
          split.splice(h.splitRow, 0, row);
        }
      }
      const last = hunks[hunks.length - 1];
      const tail = gap(`${keyBase}#g${hunks.length}`, last.newStart + last.newCount, fileLines.length, last.oldStart + last.oldCount);
      if (tail) { uni.push(tail); split.push(tail); }
    }
    return { rows: uni, split, splitBases: split.map((_x, i) => i), hunks, headerLines, lang: lang ?? null, width: Math.min(width, 6000) };
  }

  setMainLines(lines, fileLines) {
    this.mainLines = lines ?? [];
    this.mainModel = this.buildModel(this.mainLines, `m:${this.dsel ?? ""}`, LANG_OF(this.dsel), fileLines);
    this.tsel = null;
    this.menu = null;
    this.scrollY = 0;
    this.scrollX = 0;
  }

  setDetailLines(lines, fileLines) {
    this.detailLines = lines ?? [];
    const key = `d:${this.detail?.hash ?? this.detail?.rev ?? ""}:${this.dsel ?? ""}`;
    this.detailModel = this.buildModel(this.detailLines, key, LANG_OF(this.dsel), fileLines);
    this.tsel = null;
    this.menu = null;
    this.scrollY = 0;
    this.scrollX = 0;
  }

  currentFiles() {
    if (this.detail?.uncommitted) return this.files;
    if (this.detail?.files?.length) return this.detail.files;
    return this.files;
  }

  // One row: numbers, a sign, and the code, with the changed words marked.
  codeText(t, font, text) {
    return div().flex_none().whitespace_nowrap().font_family(font).text_size(11.5).text_color(t.foreground)
      .child(text.replace(/\t/g, "    ").replace(/ /g, "\u00a0") || " ");
  }

  codeSpans(t, font, word, tone) {
    const bg = tone === "add" ? t.ansi2 + "44" : t.ansi1 + "44";
    const piece = (text, mid) => div().flex_none().whitespace_nowrap().font_family(font).text_size(11.5)
      .text_color(t.foreground).when(Boolean(mid && text), (el) => el.bg(bg))
      .child(text.replace(/\t/g, "    ").replace(/ /g, "\u00a0") || " ");
    return h_flex().flex_none().items_center()
      .child(piece(word.pre, false)).child(piece(word.mid, true)).child(piece(word.suf, false));
  }

  gutter(t, font, no, width) {
    return div().w(width).flex_none().text_right().pr(6).font_family(font).text_size(10)
      .text_color(t.dim).child(no == null ? "" : String(no));
  }

  diffRow(t, font, row, split, selRange, lang) {
    if (row.kind === "@") {
      return h_flex().w_full().h(18).flex_none().items_center().px(6)
        .bg(t.raised).child(div().font_family(font).text_size(10.5).text_color(t.ansi6).child(row.text));
    }
    if (row.kind === "note") {
      return div().w_full().h(18).flex_none().flex().items_center().px(8)
        .font_family(font).text_size(10.5).text_color(t.dim).child(row.text);
    }
    if (row.kind === "gapbar") {
      return h_flex().w_full().h(18).flex_none().items_center().px(8).gap(6).bg(t.chrome).cursor_row_resize()
        .child(div().text_size(10).text_color(t.dim).child("⋮"))
        .child(div().font_family(font).text_size(10.5).text_color(t.muted).child(`⋯ ${row.count} unchanged lines`))
        .child(div().font_family(font).text_size(9.5).text_color(t.dim).child("drag to show"));
    }
    if (split) {
      const ctx = row.kind === "ctx";
      const left = ctx ? { no: row.oldNo, text: row.text } : row.del;
      const right = ctx ? { no: row.newNo, text: row.text } : row.add;
      const lw = !ctx && row.word ? { pre: row.word.aPre, mid: row.word.aMid, suf: row.word.aSuf } : null;
      const rw = !ctx && row.word ? { pre: row.word.bPre, mid: row.word.bMid, suf: row.word.bSuf } : null;
      const side = (entry, word, tone, range) => h_flex().flex_1().min_w(0).items_center().overflow_hidden()
        .when(!range && Boolean(entry) && tone === "del", (el) => el.bg(t.ansi1 + "14"))
        .when(!range && Boolean(entry) && tone === "add", (el) => el.bg(t.ansi2 + "14"))
        .child(this.gutter(t, font, entry?.no ?? null, 30))
        .child(div().w(14).flex_none().text_size(10.5).text_center()
          .text_color(tone === "del" ? t.ansi1 : tone === "add" ? t.ansi2 : t.dim)
          .child(entry ? (tone === "del" ? "−" : tone === "add" ? "+" : " ") : ""))
        .child(div().flex_1().min_w(0).overflow_hidden()
          .child(div().ml(-this.scrollX).child(this.codeWithSel(t, font, entry, range, word, tone, lang))));
      return h_flex().w_full().h(18).flex_none().items_center()
        .child(side(left, lw, ctx ? "ctx" : "del", selRange && selRange.side === "l" ? selRange : null))
        .child(div().w(1).h_full().flex_none().bg(t.border))
        .child(side(right, rw, ctx ? "ctx" : "add", selRange && selRange.side === "r" ? selRange : null));
    }
    const tone = row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : null;
    return h_flex().w_full().h(18).flex_none().items_center()
      .when(!selRange && Boolean(tone), (el) => el.bg(tone + "14"))
      .child(this.gutter(t, font, row.kind === "+" ? null : (row.oldNo ?? row.no), 32))
      .child(this.gutter(t, font, row.kind === "-" ? null : (row.newNo ?? row.no), 32))
      .child(div().w(14).flex_none().text_size(10.5).text_center().text_color(tone ?? t.dim)
        .child(row.kind === " " ? "" : row.kind))
      .child(div().flex_1().min_w(0).overflow_hidden()
        .child(div().ml(-this.scrollX).child(this.codeWithSel(t, font, row, selRange, row.word, row.kind === "+" ? "add" : "del", lang))));
  }

  // The code of one line: syntax colours from the tokenizer, plus the
  // changed-word tint or the selected range as backgrounds.
  codeWithSel(t, font, entry, range, word, tone, lang) {
    const text = entry?.text ?? "";
    const tokens = this.tokensOf(entry, text, lang);
    const ranges = [];
    if (range && range.end > range.start) {
      ranges.push({ start: range.start, end: range.end, bg: t.selection });
    }
    if (word && word.mid) {
      const from = (word.pre ?? "").length;
      ranges.push({ start: from, end: from + word.mid.length, bg: tone === "add" ? t.ansi2 + "44" : t.ansi1 + "44" });
    }
    const q = this.query.trim().toLowerCase();
    if (q) {
      const low = text.toLowerCase();
      let at = low.indexOf(q);
      while (at >= 0) {
        ranges.push({ start: at, end: at + q.length, bg: (t.warning ?? t.ansi3) + "66" });
        at = low.indexOf(q, at + q.length);
      }
    }
    if (!tokens) return this.codeText(t, font, text);
    return this.lineCode(t, font, text, tokens, ranges);
  }

  tokensOf(entry, text, lang) {
    if (!entry || !lang) return null;
    if (entry._lang === lang && entry._tok) return entry._tok;
    entry._lang = lang;
    entry._tok = tokenize(text, lang);
    return entry._tok;
  }

  lineCode(t, font, text, tokens, ranges) {
    const color = (k) => k === "keyword" ? t.ansi5 : k === "string" ? t.ansi2 : k === "comment" ? t.dim : k === "number" ? t.ansi1 : t.foreground;
    const row = h_flex().flex_none().items_center();
    let pos = 0;
    for (const tok of tokens) {
      const a = pos;
      const b = pos + tok.s.length;
      pos = b;
      const cuts = new Set([a, b]);
      for (const r of ranges) {
        if (r.start > a && r.start < b) cuts.add(r.start);
        if (r.end > a && r.end < b) cuts.add(r.end);
      }
      const xs = [...cuts].sort((x, y) => x - y);
      for (let i = 0; i < xs.length - 1; i++) {
        const from = xs[i];
        const to = xs[i + 1];
        const bg = ranges.find((r) => r.start <= from && to <= r.end)?.bg ?? null;
        const piece = text.slice(from, to);
        if (!piece) continue;
        row.child(div().flex_none().whitespace_nowrap().font_family(font).text_size(11.5)
          .text_color(color(tok.k)).when(Boolean(bg), (el) => el.bg(bg))
          .child(piece.replace(/ /g, "\u00a0")));
      }
    }
    return row;
  }

  codeText(t, font, text) {
    return div().flex_none().whitespace_nowrap().font_family(font).text_size(11.5).text_color(t.foreground)
      .child(text.replace(/ /g, "\u00a0") || " ");
  }

  // Rows as the current view shows them (folded hunks hidden in unified).
  viewRows(which) {
    const model = which === "main" ? this.mainModel : this.detailModel;
    if (!model) return { rows: [] };
    const split = this.view === "split";
    const base = split ? model.split : model.rows;
    const rows = [];
    for (const row of base) {
      if (row.kind === "@") continue;
      if (row.kind !== "gap") {
        rows.push(row);
        continue;
      }
      const shown = Math.max(0, Math.min(this.gaps.get(row.key) ?? 0, row.items.length));
      for (let k = 0; k < shown; k++) {
        const it = row.items[k];
        rows.push(split
          ? { kind: "ctx", oldNo: it.old, newNo: it.new, text: it.text }
          : { kind: " ", oldNo: it.old, newNo: it.new, text: it.text });
      }
      const rest = row.items.length - shown;
      if (rest > 0) rows.push({ kind: "gapbar", key: row.key, count: rest, total: row.items.length, shown });
    }
    return { rows };
  }

  diffHit(which, e) {
    const { rows } = this.viewRows(which);
    if (!rows.length) return null;
    const x = e.local_position?.x ?? 0;
    const y = (e.local_position?.y ?? 0) + this.scrollY;
    const row = Math.max(0, Math.min(rows.length - 1, Math.floor(y / 18)));
    const r = rows[row];
    if (!r) return null;
    if (this.view === "split") {
      const half = (this.diffW || 600) / 2;
      const side = x < half ? "l" : "r";
      const entry = side === "l"
        ? (r.del ?? (r.kind === "ctx" ? { text: r.text } : null))
        : (r.add ?? (r.kind === "ctx" ? { text: r.text } : null));
      const text = entry?.text ?? "";
      const textX = side === "l" ? 44 : half + 45;
      const col = Math.max(0, Math.min(text.length, Math.round((x - textX + this.scrollX) / this.charW)));
      return { row, col, side, text };
    }
    const text = r.kind === "@" || r.kind === "note" ? "" : (r.text ?? "");
    const col = Math.max(0, Math.min(text.length, Math.round((x - 78 + this.scrollX) / this.charW)));
    return { row, col, side: null, text };
  }

  diffDown(which, e, cx) {
    this.region = 4;
    if (!this.typing && !this.searchOpen && !this.hasKeyboard()) this.handle.focus();
    if (this.menu) {
      this.menu = null;
      cx.notify();
      return;
    }
    const hit = this.diffHit(which, e);
    if (!hit) return;
    const split = this.view === "split";
    const { rows } = this.viewRows(which);
    const row = rows[hit.row];
    if (row?.kind === "@") return;
    if (row?.kind === "gapbar") {
      if (e.click_count >= 2) {
        const cur = this.gaps.get(row.key) ?? 0;
        this.gaps.set(row.key, cur >= row.total ? 0 : row.total);
        this.gapDrag = null;
        cx.notify();
        return;
      }
      this.gapDrag = { key: row.key, y: e.position.y, start: row.shown, total: row.total };
      this.dragging = false;
      this.tsel = null;
      cx.notify();
      return;
    }
    if (e.modifiers?.shift && this.tsel && this.tsel.which === which) {
      this.tsel.focus = { row: hit.row, col: hit.col };
      this.dragging = true;
      cx.notify();
      return;
    }
    if (e.click_count === 2) {
      const [a, b] = this.wordRange(hit.text, hit.col);
      this.tsel = { which, view: split ? "s" : "u", side: hit.side, anchor: { row: hit.row, col: a }, focus: { row: hit.row, col: b } };
      this.dragging = false;
      cx.notify();
      return;
    }
    if (e.click_count >= 3) {
      this.tsel = { which, view: split ? "s" : "u", side: hit.side, anchor: { row: hit.row, col: 0 }, focus: { row: hit.row, col: hit.text.length } };
      this.dragging = false;
      cx.notify();
      return;
    }
    this.dragging = true;
    if (split && hit.side) this.splitSide = hit.side;
    this.tsel = { which, view: split ? "s" : "u", side: hit.side, anchor: { row: hit.row, col: hit.col }, focus: { row: hit.row, col: hit.col } };
    cx.notify();
  }

  diffMove(which, e, cx) {
    if (this.gapDrag) {
      const dy = e.position.y - this.gapDrag.y;
      const shown = Math.max(0, Math.min(this.gapDrag.total, this.gapDrag.start + Math.round(dy / 18)));
      if ((this.gaps.get(this.gapDrag.key) ?? 0) !== shown) {
        this.gaps.set(this.gapDrag.key, shown);
        cx.notify();
      }
      return;
    }
    if (!this.dragging || !this.tsel || this.tsel.which !== which) return;
    const hit = this.diffHit(which, e);
    if (!hit) return;
    if (this.view === "split" && this.tsel.side && hit.side !== this.tsel.side) {
      hit.side = this.tsel.side;
      const { rows } = this.viewRows(which);
      const r = rows[hit.row];
      const entry = this.tsel.side === "l"
        ? (r?.del ?? (r?.kind === "ctx" ? { text: r.text } : null))
        : (r?.add ?? (r?.kind === "ctx" ? { text: r.text } : null));
      hit.col = entry ? entry.text.length : 0;
    }
    this.tsel.focus = { row: hit.row, col: hit.col };
    const y = e.local_position?.y ?? 0;
    const h = this.viewportH || 320;
    if (y > h - 20) this.scrollY += 18;
    else if (y < 20 && this.scrollY > 0) this.scrollY -= 18;
    cx.notify();
  }

  diffRight(which, e, cx) {
    const hit = this.diffHit(which, e);
    if (!hit) return;
    const has = this.tsel && this.tsel.which === which && this.selCount() > 0;
    if (!has) {
      this.tsel = { which, view: this.view === "split" ? "s" : "u", side: hit.side, anchor: { row: hit.row, col: 0 }, focus: { row: hit.row, col: hit.text.length } };
    }
    const w = this.diffW || 600;
    const h = this.viewportH || 300;
    this.menu = {
      kind: "diff",
      which,
      x: Math.max(4, Math.min(e.local_position?.x ?? 0, w - 200)),
      y: Math.max(4, Math.min(e.local_position?.y ?? 0, h - 76)),
      index: 0,
      items: [
        { label: "Quote to clipboard", action: (cx) => { this.menu = null; this.quote(cx); } },
        { label: "Send to agent", action: (cx) => { this.menu = null; this.askAgent(cx); } },
      ],
    };
    // The menu is a sub-focus layer: it rides on this pane's keyboard, so take
    // it on the click that opened it rather than hoping it is still ours.
    this.handle.focus();
    cx.notify();
  }

  diffTarget() {
    return this.detail?.uncommitted ? "main" : "detail";
  }

  selectAllDiff(cx) {
    const which = this.diffTarget();
    const { rows } = this.viewRows(which);
    const usable = rows.map((r, i) => r.kind === "@" ? -1 : i).filter((i) => i >= 0);
    if (!usable.length) return;
    const view = this.view === "split" ? "s" : "u";
    let side = null;
    if (view === "s") {
      const first = rows[usable[0]];
      side = first.del ? "l" : "r";
    }
    const last = usable[usable.length - 1];
    const lastText = this.rowText({ view, side }, rows[last]);
    this.tsel = { which, view, side, anchor: { row: usable[0], col: 0 }, focus: { row: last, col: lastText.length } };
    this.menu = null;
    cx.notify();
  }

  moveCaret(cx, key, extend) {
    const ts = this.tsel;
    if (!ts) return;
    const { rows } = this.viewRows(ts.which);
    let row = ts.focus.row;
    let col = ts.focus.col;
    const len = (r) => this.rowText(ts, rows[r]).length;
    if (key === "left") col = Math.max(0, col - 1);
    else if (key === "right") col = Math.min(len(row), col + 1);
    else if (key === "home") col = 0;
    else if (key === "end") col = len(row);
    else if (key === "up") { row = Math.max(0, row - 1); col = Math.min(col, len(row)); }
    else if (key === "down") { row = Math.min(rows.length - 1, row + 1); col = Math.min(col, len(row)); }
    else if (key === "pageup") { row = Math.max(0, row - 10); col = Math.min(col, len(row)); }
    else if (key === "pagedown") { row = Math.min(rows.length - 1, row + 10); col = Math.min(col, len(row)); }
    this.tsel.focus = { row, col };
    if (!extend) this.tsel.anchor = { row, col };
    const top = row * 18;
    const h = this.viewportH || 320;
    if (top < this.scrollY) this.scrollY = top;
    else if (top > this.scrollY + h - 36) this.scrollY = Math.max(0, top - h + 36);
    this.keepCaretX(col);
    cx.notify();
  }

  wordRange(text, col) {
    const word = (c) => /[A-Za-z0-9_$]/.test(c ?? "");
    let start = Math.min(col, text.length);
    let end = start;
    while (start > 0 && word(text[start - 1])) start--;
    while (end < text.length && word(text[end])) end++;
    if (start === end) {
      start = Math.min(col, Math.max(0, text.length - 1));
      end = Math.min(text.length, start + 1);
    }
    return [start, end];
  }

  rowText(ts, row) {
    if (!row || row.kind === "@" || row.kind === "note") return "";
    if (ts.view === "s") {
      const entry = ts.side === "l"
        ? (row.del ?? (row.kind === "ctx" ? { text: row.text } : null))
        : (row.add ?? (row.kind === "ctx" ? { text: row.text } : null));
      return entry?.text ?? "";
    }
    return row.text ?? "";
  }

  selCount() {
    const ts = this.tsel;
    if (!ts) return 0;
    return Math.abs(ts.focus.row - ts.anchor.row) + 1;
  }

  selCols(ts, rowIndex, rows) {
    if (!ts) return null;
    const a = ts.anchor;
    const f = ts.focus;
    const forward = a.row < f.row || (a.row === f.row && a.col <= f.col);
    const start = forward ? a : f;
    const end = forward ? f : a;
    if (rowIndex < start.row || rowIndex > end.row) return null;
    const row = rows[rowIndex];
    if (!row || row.kind === "@") return null;
    if (ts.view === "s") {
      const side = ts.side;
      const entry = side === "l"
        ? (row.del ?? (row.kind === "ctx" ? { text: row.text } : null))
        : (row.add ?? (row.kind === "ctx" ? { text: row.text } : null));
      const len = entry?.text.length ?? 0;
      const begin = rowIndex === start.row ? Math.min(start.col, len) : 0;
      const finish = rowIndex === end.row ? Math.min(end.col, len) : len;
      return { side, start: Math.min(begin, finish), end: Math.max(begin, finish) };
    }
    const len = (row.text ?? "").length;
    const begin = rowIndex === start.row ? Math.min(start.col, len) : 0;
    const finish = rowIndex === end.row ? Math.min(end.col, len) : len;
    return { start: Math.min(begin, finish), end: Math.max(begin, finish) };
  }


  // Drag selects text; the list is drawn for the viewport only, so a wheel
  // scroll is ours to keep.
  masterInfo(which) {
    const model = which === "main" ? this.mainModel : this.detailModel;
    if (!model) return null;
    const base = this.view === "split" ? model.split : model.rows;
    const gaps = base.filter((row) => row.kind === "gap" && row.items.length)
      .map((g) => ({ key: g.key, total: g.items.length }));
    if (!gaps.length) return null;
    return { gaps, expanded: gaps.some((g) => (this.gaps.get(g.key) ?? 0) > 0) };
  }

  masterBar(t, font, which, info) {
    return h_flex().h(18).flex_none().items_center().px(8).gap(6).bg(t.chrome).cursor_pointer()
      .on_mouse_down("left", (e, cx) => {
        if (e.click_count < 2) return;
        for (const g of info.gaps) this.gaps.set(g.key, info.expanded ? 0 : g.total);
        const after = this.viewRows(which).rows.length;
        this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, after * 18 - (this.viewportH || 320))));
        cx.notify();
      })
      .child(div().text_size(10).text_color(t.dim).child("⋮"))
      .child(div().font_family(font).text_size(10).text_color(t.muted)
        .child(info.expanded ? "⋯ all context — double-click to collapse" : "⋯ all context — double-click to expand"));
  }

  diffView(t, font, which, model, empty) {
    const split = this.view === "split";
    const { rows } = this.viewRows(which);
    if (!rows.length) return div().p(10).text_size(11.5).text_color(t.dim).child(empty);
    const height = this.viewportH || 900;
    const contentH = rows.length * 18;
    const maxScroll = Math.max(0, contentH - height);
    const scrollY = Math.min(this.scrollY, maxScroll);
    const first = Math.max(0, Math.floor(scrollY / 18));
    const last = Math.min(rows.length, Math.ceil((scrollY + height) / 18) + 1);
    const ts = this.tsel && this.tsel.which === which ? this.tsel : null;
    const labels = this.jumpMode ? this.jumpLabels : null;
    const labelByRow = new Map();
    if (labels) for (const [label, at] of labels) labelByRow.set(at.row, label);
    const caret = ts && ts.anchor.row === ts.focus.row && ts.anchor.col === ts.focus.col && this.region === 4 ? ts : null;
    const caretRow = caret ? caret.focus.row : -1;
    const half = (this.diffW || 600) / 2;
    const charW = this.charW || 7;
    const caretText = caret ? this.rowText(ts, rows[caret.focus.row]) : "";
    const caretX = caret
      ? (split ? (caret.side === "l" ? 45 : half + 45) : 78) + textWidth(caretText.slice(0, caret.focus.col)) * charW - this.scrollX
      : 0;
    const visible = rows.slice(first, last).map((r, k) => {
      const ri = first + k;
      const el = this.diffRow(t, font, r, split, ts ? this.selCols(ts, ri, rows) : null, model?.lang ?? null);
      const label = labelByRow.get(ri);
      if (!label && ri !== caretRow) return el;
      return h_flex().w_full().h(18).flex_none().items_center().relative().overflow_hidden()
        .when(ri === caretRow, (x) => x.bg(t.hover))
        .when(Boolean(label), (x) => x.child(div().w(18).flex_none().text_center().text_size(10).font_semibold()
          .bg(t.accent).text_color(t.accent_foreground).child(label)))
        .child(el)
        .when(ri === caretRow, (x) => x.child(div().absolute().left(caretX).top(1)
          .w(Math.max(6, Math.round(charW))).h(16).bg(t.accent).opacity(0.45)));
    });
    const thumbH = Math.max(24, height * (height / contentH));
    const thumbTop = maxScroll > 0 ? (scrollY / maxScroll) * (height - thumbH) : 0;
    const info = this.masterInfo(which);
    return v_flex().flex_1().min_h(0)
      .when(Boolean(info), (el) => el.child(this.masterBar(t, font, which, info)))
      .child(div().flex_1().min_h(0).relative().overflow_hidden().font_family(font).text_size(11.5)
      .on_size_change((size, cx) => {

        if (Math.abs(size.height - (this.viewportH ?? 0)) <= 2 && Math.abs(size.width - (this.diffW ?? 0)) <= 2) return;
        this.viewportH = size.height;
        this.diffW = size.width;
        if (this.sizePending) return;
        this.sizePending = true;
        cx.timer.after(16, (cx) => {
          this.sizePending = false;
          cx.notify();
        });
      })
      .on_scroll_wheel((e, cx) => {
        const delta = e.delta_lines ? e.delta_lines.y * 18 : e.delta.y;
        const maxX = Math.max(0, (model?.width ?? 400) - (this.view === "split" ? Math.max(200, (this.diffW || 600) / 2) : (this.diffW || 600)));
        if (e.delta.x) this.scrollX = Math.max(0, Math.min(maxX, this.scrollX - e.delta.x));
        if (e.modifiers?.shift) this.scrollX = Math.max(0, Math.min(maxX, this.scrollX - delta));
        else this.scrollY = Math.max(0, Math.min(maxScroll, this.scrollY - delta));
        if (this.menu) this.menu = null;
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => this.diffDown(which, e, cx))
      .on_mouse_down("right", (e, cx) => this.diffRight(which, e, cx))
      .on_mouse_move((e, cx) => this.diffMove(which, e, cx))
      .on_mouse_up("left", (e, cx) => {
        if (this.gapDrag) {
          this.gapDrag = null;
          cx.notify();
          return;
        }
        if (this.dragging) {
          this.dragging = false;
          cx.notify();
        }
      })
      .child(div().absolute().top(0).left(0).right(0).bottom(0).overflow_hidden()
        .child(div().absolute().top(first * 18 - scrollY).left(0).right(0).children(visible)))
      .when(contentH > height, (el) => el
        .child(div().absolute().right(2).top(thumbTop).w(4).h(thumbH).rounded(2).bg(t.border)))
      .child(div().absolute().top(0).left(-2000)
        .child(div().font_family(font).text_size(11.5).child("M".repeat(40)))
        .on_size_change((size, cx) => {
          const w = size.width / 40;
          if (w > 2 && Math.abs(w - this.charW) > 0.02) {
            this.charW = w;
            cx.notify();
          }
        }))
      .when(Boolean(this.menu?.kind === "diff" && this.menu.which === which), (el) => el.child(this.menuView(t))));
  }

  isHeadCommit(d) {
    if (!d) return false;
    if (d.head) return true;
    if ((d.refs ?? []).some((r) => r.kind === "head")) return true;
    const first = this.rows.find((r) => !r.uncommitted);
    return Boolean(first && (first.full === d.hash || first.hash === d.hash));
  }

  amendCommit(cx) {
    const d = this.detail;
    const message = (this.ta?.value() ?? "").trim();
    if (!d || !this.isHeadCommit(d)) { notify({ title: "Amend", body: "Only the HEAD commit can be edited", level: "warning" }); return; }
    if (!message) { notify({ title: "Amend", body: "Empty message", level: "warning" }); return; }
    cx.spawn(async (cx) => {
      try {
        const r = await hcExec("git", ["-C", this.root, "commit", "--amend", "--only", "-m", message], { on: this.on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "git commit --amend failed").trim());
        notify({ title: "Amended", body: message.split("\n")[0], level: "success" });
        this.amend = false;
        this.ta.set_value("");
        await this.load(cx);
      } catch (err) {
        notify({ title: "Amend failed", body: String(err?.message ?? err), level: "error" });
      }
    });
  }

  jumpToLine(n, cx) {
    this.ensureCaret(cx);
    const ts = this.tsel;
    if (!ts) return;
    const { rows } = this.viewRows(ts.which);
    const split = this.view === "split";
    const side = ts.side ?? this.splitSide;
    let at = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.kind === "@") continue;
      const no = split ? (side === "l" ? (r.oldNo ?? r.no) : (r.newNo ?? r.no)) : (r.newNo ?? r.no);
      if (no === n) { at = i; break; }
    }
    if (at < 0) {
      notify({ title: "No such line", body: `${split ? (side === "l" ? "old" : "new") : "new"} line ${n}`, level: "warning" });
      return;
    }
    ts.focus = { row: at, col: 0 };
    ts.anchor = { row: at, col: 0 };
    this.visual = false;
    const top = at * 18;
    const h = this.viewportH || 320;
    if (top < this.scrollY) this.scrollY = top;
    else if (top > this.scrollY + h - 36) this.scrollY = Math.max(0, top - h + 36);
    cx.notify();
  }

  jumpHunk(dir, cx) {
    this.ensureCaret(cx);
    const ts = this.tsel;
    if (!ts) return;
    const { rows } = this.viewRows(ts.which);
    const isChange = (r) => r && (r.kind === "+" || r.kind === "-");
    const starts = [];
    for (let i = 0; i < rows.length; i++) {
      if (!isChange(rows[i])) continue;
      if (i === 0 || !isChange(rows[i - 1])) starts.push(i);
    }
    if (!starts.length) return;
    const at = ts.focus.row;
    const target = dir > 0
      ? starts.find((i) => i > at)
      : [...starts].reverse().find((i) => i < at);
    if (target == null) return;
    ts.focus = { row: target, col: 0 };
    ts.anchor = { row: target, col: 0 };
    this.visual = false;
    const top = target * 18;
    const h = this.viewportH || 320;
    if (top < this.scrollY) this.scrollY = top;
    else if (top > this.scrollY + h - 36) this.scrollY = Math.max(0, top - h + 36);
    cx.notify();
  }

  // The selected text as a quote an agent can act on: path:lines, markers kept.
  quoteText() {
    const ts = this.tsel;
    if (!ts || this.selCount() === 0) return "";
    const { rows } = this.viewRows(ts.which);
    const split = ts.view === "s";
    const forward = ts.anchor.row < ts.focus.row || (ts.anchor.row === ts.focus.row && ts.anchor.col <= ts.focus.col);
    const start = forward ? ts.anchor : ts.focus;
    const end = forward ? ts.focus : ts.anchor;
    const path = this.dsel ?? "";
    const blocks = [];
    for (let ri = start.row; ri <= end.row; ri++) {
      const r = rows[ri];
      if (!r || r.kind === "@") continue;
      let text, marker, no;
      if (split) {
        const entry = ts.side === "l"
          ? (r.del ?? (r.kind === "ctx" ? { no: r.oldNo, text: r.text } : null))
          : (r.add ?? (r.kind === "ctx" ? { no: r.newNo, text: r.text } : null));
        if (!entry) continue;
        text = entry.text;
        no = entry.no;
        marker = r.kind === "ctx" ? " " : (ts.side === "l" ? "-" : "+");
      } else {
        text = r.text ?? "";
        no = r.newNo ?? r.oldNo ?? r.no;
        marker = r.kind === " " ? " " : r.kind;
      }
      const from = ri === start.row ? start.col : 0;
      const to = ri === end.row ? end.col : text.length;
      const piece = text.slice(Math.max(0, Math.min(from, to)), Math.max(0, Math.max(from, to))).replace(/ +$/, "");
      let cur = blocks[blocks.length - 1];
      if (!cur || ri !== cur.end + 1) {
        cur = { end: ri, lines: [], nos: [] };
        blocks.push(cur);
      }
      cur.end = ri;
      cur.lines.push(`${marker}${piece}`);
      cur.nos.push(no);
    }
    if (!blocks.length) return "";
    return blocks.map((b) => {
      const nums = b.nos.filter((n) => n != null);
      const first = nums[0];
      const last = nums[nums.length - 1];
      const where = first == null ? path : (first === last ? `${path}:${first}` : `${path}:${first}-${last}`);
      return `@ ${where}\n${b.lines.join("\n")}`;
    }).join("\n\n");
  }

  findCharInLine(ch, dir, cx) {
    const ts = this.tsel;
    if (!ts) return;
    const rows = this.viewRows(ts.which).rows;
    const text = this.rowText(ts, rows[ts.focus.row]);
    const at = dir > 0 ? text.indexOf(ch, ts.focus.col + 1) : text.lastIndexOf(ch, Math.max(0, ts.focus.col - 1));
    if (at < 0) return;
    ts.focus = { row: ts.focus.row, col: at };
    if (!this.visual) ts.anchor = { ...ts.focus };
    cx.notify();
  }

  findCharInMsg(ch, dir, cx) {
    const d = this.detail;
    if (!d || !this.msgSel) return;
    const lines = (d.message ?? "").split("\n");
    const ts = this.msgSel;
    const text = lines[ts.f.row] ?? "";
    const at = dir > 0 ? text.indexOf(ch, ts.f.col + 1) : text.lastIndexOf(ch, Math.max(0, ts.f.col - 1));
    if (at < 0) return;
    ts.f = { row: ts.f.row, col: at };
    cx.notify();
  }

  selectedText() {
    const ts = this.tsel;
    if (!ts) return "";
    const { rows } = this.viewRows(ts.which);
    const forward = ts.anchor.row < ts.focus.row || (ts.anchor.row === ts.focus.row && ts.anchor.col <= ts.focus.col);
    const start = forward ? ts.anchor : ts.focus;
    const end = forward ? ts.focus : ts.anchor;
    const out = [];
    for (let i = start.row; i <= Math.min(end.row, rows.length - 1); i++) {
      const text = this.rowText(ts, rows[i]);
      out.push(text.slice(i === start.row ? start.col : 0, i === end.row ? end.col : text.length));
    }
    return out.join("\n");
  }

  yankDiffLine(cx) {
    const ts = this.tsel;
    if (!ts) return;
    const rows = this.viewRows(ts.which).rows;
    const text = this.rowText(ts, rows[ts.focus.row]);
    cx.write_to_clipboard(text + "\n");
    notify({ title: "Copied line", body: text.trim().slice(0, 80) });
  }

  yankMsgLine(cx) {
    const d = this.detail;
    if (!d) return;
    const lines = (d.message ?? "").split("\n");
    const text = lines[this.msgSel?.f.row ?? 0] ?? "";
    cx.write_to_clipboard(text + "\n");
    notify({ title: "Copied line", body: text.slice(0, 80) });
  }

  openDiffMenuAtCaret(cx) {
    const ts = this.tsel;
    if (!ts) return;
    const split = this.view === "split";
    const half = (this.diffW || 600) / 2;
    const charW = this.charW || 7;
    const base = split ? (ts.side === "l" ? 45 : half + 45) : 78;
    const x = Math.max(4, Math.min(base + ts.focus.col * charW - this.scrollX, (this.diffW || 600) - 220));
    const y = Math.max(4, Math.min(ts.focus.row * 18 - this.scrollY + 20, (this.viewportH || 300) - 80));
    this.menu = { kind: "diff", which: ts.which, x, y, index: 0, items: [
      { label: "Quote to clipboard", action: (cx) => { this.menu = null; this.quote(cx); } },
      { label: "Send to agent", action: (cx) => { this.menu = null; this.askAgent(cx); } },
    ] };
    cx.notify();
  }

  openCommitMenu(cx) {
    const row = this.rows[this.gsel];
    if (!row || row.uncommitted) return;
    const hash = row.full;
    this.menu = { kind: "commit", x: 12, y: 24 + Math.max(0, this.gsel) * 24, index: 0, items: [
      { label: "Copy hash", action: (cx) => { cx.write_to_clipboard(String(hash)); this.menu = null; notify({ title: "Copied hash", body: String(hash).slice(0, 12) }); } },
      { label: "Revert commit", action: (cx) => { this.menu = null; this.revertCommit(hash, cx); } },
    ] };
    cx.notify();
  }

  openTreeMenu(cx) {
    const rows = this.treeRows();
    const at = rows.findIndex((r) => (r.kind === "dir" ? r.path : r.file?.path) === this.treeSel);
    const target = rows[at];
    const path = target ? (target.kind === "dir" ? target.path : target.file.path) : null;
    this.menu = { kind: "tree", x: 8, y: 30 + Math.max(0, at) * 24, index: 0, items: [
      { label: "Toggle add", action: (cx) => { this.menu = null; if (path) this.fileAction("toggleAdd", path, cx); } },
      { label: "Add all / unstage all", action: (cx) => { this.menu = null; this.fileAction("toggleAll", null, cx); } },
      { label: "Revert file", action: (cx) => { this.menu = null; if (path) this.fileAction("revert", path, cx); } },
    ] };
    cx.notify();
  }

  revertCommit(hash, cx) {
    if (this.kind !== "git") { notify({ title: "Revert", body: "Only for git", level: "warning" }); return; }
    cx.spawn(async (cx) => {
      try {
        const r = await hcExec("git", ["-C", this.root, "revert", "--no-edit", hash], { on: this.on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "git revert failed").trim());
        notify({ title: "Reverted", body: String(hash).slice(0, 12), level: "success" });
        await this.load(cx);
      } catch (err) {
        notify({ title: "Revert failed", body: String(err?.message ?? err), level: "error" });
      }
    });
  }

  menuView(t) {
    const m = this.menu;
    if (!m) return null;
    return div().absolute().left(m.x).top(m.y).w(210).p(4).rounded(0).bg(t.popover)
      .border(1).border_color(t.border).flex().flex_col().gap(1)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children((m.items ?? []).map((item, i) => h_flex().h(26).px(8).items_center().cursor_pointer()
        .when(i === m.index, (el) => el.bg(t.selected)).when(i !== m.index, (el) => el.hover((x) => x.bg(t.hover)))
        .on_mouse_down("left", (e, cx) => { e && cx.stop_propagation(); m.index = i; item.action(cx); })
        .child(div().text_size(11.5).text_color(t.foreground).child(item.label))));
  }

  quote(cx) {
    const text = this.quoteText();
    if (!text) { notify({ title: "Select diff text first", level: "warning" }); return; }
    cx.write_to_clipboard(text + "\n");
    notify({ title: "Copied", body: `${this.selCount()} lines as path:line + diff` });
  }

  askAgent(cx) {
    const text = this.quoteText();
    if (!text) { notify({ title: "Select diff text first", level: "warning" }); return; }
    cx.write_to_clipboard(text + "\n\n");
    const list = agents();
    const target = list.find((a) => a.focused) ?? list.find((a) => a.status === "idle") ?? list[0];
    if (!target) {
      notify({ title: "Copied", body: "No agent pane open — paste it into one" });
      return;
    }
    run("agent.focus", { terminal: target.address });
    cx.timer.after(250, () => run("terminal.paste"));
    notify({ title: `Pasted into ${target.app ?? target.title}`, body: "Add your comment, then send" });
  }

  selectedHunk() {
    const ts = this.tsel;
    if (!ts) return 0;
    const { rows } = this.viewRows("main");
    const r = rows[Math.min(ts.anchor.row, ts.focus.row)];
    return r?.h != null && r.h >= 0 ? r.h : 0;
  }

  async revertHunk(cx) {
    const file = this.files.find((f) => f.path === this.dsel);
    if (this.kind !== "git" || !this.detail?.uncommitted || !file || file.untracked || this.on) {
      notify({ title: "Revert hunk", body: "Only for tracked, local git changes", level: "warning" });
      return;
    }
    const model = this.mainModel;
    if (!model) return;
    const h = model.hunks[this.selectedHunk()];
    if (!h) return;
    const patch = [...model.headerLines, ...h.lines].join("\n") + "\n";
    // A fresh name each time: writeTextFile only creates a missing file, and
    // one stale patch from an earlier revert must not block this one.
    const patchPath = `${appHome()}/vcs-revert-${Date.now()}.patch`;
    try {
      await writeTextFile(patchPath, patch, null);
      const r = await hcExec("git", ["-C", this.root, "apply", "-R", "--recount", "--whitespace=nowarn", patchPath], { on: this.on });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || "git apply failed").trim());
      notify({ title: "Reverted hunk", level: "success" });
      await this.load(cx);
    } catch (err) {
      notify({ title: "Revert hunk failed", body: String(err?.message ?? err), level: "error" });
    } finally {
      await fs.unlink(patchPath).catch(() => {});
    }
  }

  tabButton(t, id, label, on, action) {
    return h_flex().items_center().id(id).h(22).px(8).rounded(0).cursor_pointer().text_size(11)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); action(); }).child(label);
  }

  smallButton(t, id, label, action, danger) {
    return h_flex().items_center().id(id).h(22).px(8).rounded(0).text_size(11).cursor_pointer()
      .bg(t.raised).text_color(danger ? t.blocked : t.foreground)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); action(); }).child(label);
  }

  render(cx) {
    this.observePaneFocus(cx);
    const t = theme();
    const font = settings().font_family ?? "JetBrains Mono";
    return v_flex()
      .id("vcs")
      .size_full()
      .bg(t.background)
      .font_family(font)
      .text_size(12)
      .track_focus(this.handle)
      .on_mouse_down("left", (_e, cx) => {
        if (!this.typing && !this.searchOpen && !this.filterNative && !this.inputHover && !this.searchHover && !this.hasKeyboard()) this.handle.focus();
      })
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_move((e, cx) => this.onDragMove(e, cx))
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag) {
          this.drag = null;
          cx.notify();
        }
      })
      .on_size_change((size, cx) => {
        // Native focus is meaningful only after this element is laid out.
        // The headless CLI check never mounts a window or calls this handler.
        if (!this.focusMounted) {
          this.focusMounted = true;
          this.bindPaneIdentity(cx);
          this.observePaneFocus(cx);
        }
        this.paneH = size.height;
        if (Math.abs(size.width - (this.width ?? 0)) > 8) {
          this.width = size.width;
          cx.notify();
        }

      })
      .child(this.header(t, font, cx))
      .child(
        this.maxRegion === 1 ? this.regionBox(this.sidebar(t, font, cx), 1)
          : this.maxRegion === 2 ? this.regionBox(this.detailsSection(t, font, true), 2)
            : this.maxRegion === 3 ? this.regionBox(this.treeSection(t, font, cx, true), 3)
              : this.maxRegion === 4 ? this.regionBox(this.diffSection(t, font, cx), 4)
                : h_flex().flex_1().min_h(0)
                  .child(v_flex().w(this.leftW).flex_none().h_full().min_w(0).child(this.regionBox(this.sidebar(t, font, cx), 1)))
                  .child(this.splitter(t, "w"))
                  .child(v_flex().flex_1().min_w(0).h_full().min_h(0)
                    .child(this.regionBox(this.detailsSection(t, font), 2))
                    .when(this.showDetails, (el) => el.child(this.splitter(t, "details")))
                    .child(this.regionBox(this.treeSection(t, font, cx), 3))
                    .when(this.showTree, (el) => el.child(this.splitter(t, "tree")))
                    .child(this.regionBox(this.diffSection(t, font, cx), 4))),
      )
      .when(Boolean(this.drag), (el) => el.child(
        div().absolute().top(0).left(0).right(0).bottom(0)
          .when(this.drag?.kind === "w", (x) => x.cursor_col_resize())
          .when(this.drag?.kind !== "w", (x) => x.cursor_row_resize())
          .on_mouse_move((ev, cx) => this.onDragMove(ev, cx))
          .on_mouse_up("left", (_ev, cx) => {
            this.drag = null;
            cx.notify();
          })));
  }

  header(t, font, cx) {
    return h_flex().h(32).flex_none().px(10).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      // Click the chip to use the other working copy in the same folder; the
      // ⇄ only appears when one is really there.
      .child(h_flex().id("vcs-kind").h(22).px(6).gap(8).items_center().rounded(0).bg(t.selected).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.switchVcs(cx); })
        .child(div().text_size(10.5).font_semibold().text_color(t.accent)
          .child(this.kind ? this.kind.toUpperCase() : "?"))
        .when(this.kinds.length > 1, (el) => el.child(div().text_size(10).text_color(t.dim)
          .child(`⇄ ${this.kinds.filter((k) => k.kind !== this.kind).map((k) => k.kind.toUpperCase()).join("/")}`))))
      .child(div().text_size(12).text_color(t.foreground).truncate().child(this.label ?? ""))
      // The address is fixed: click it to point the pane somewhere else.
      .child(div().id("vcs-repo").text_size(11).text_color(t.dim).truncate().cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).child(tilde(this.root ?? ""))
        .on_click((_e, cx) => { cx.stop_propagation(); this.changeRepo(cx); }))
      .child(div().flex_1())
      .child(h_flex().gap(2).items_center()
        .child(this.layoutButton(t, null, "All"))
        .child(this.layoutButton(t, 1, "1"))
        .child(this.layoutButton(t, 2, "2"))
        .child(this.layoutButton(t, 3, "3"))
        .child(this.layoutButton(t, 4, "4")))
      .child(div().text_size(11).text_color(t.dim)
        .child(`${this.commits} ${this.kind === "svn" ? "revs" : "commits"}`))
      .child(div().id("vcs-zoom").h(22).px(6).flex().items_center().rounded(0).text_size(13).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run("pane.zoom")).child("⤢"))
      .child(div().id("vcs-refresh").h(22).px(6).flex().items_center().rounded(0).text_size(13).text_color(t.muted)
        .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.load(cx)).child("↻"));
  }

  splitter(t, kind) {
    return div().id(`vcs-split-${kind}`)
      .when(kind === "w", (el) => el.w(6).h_full().cursor_col_resize())
      .when(kind !== "w", (el) => el.h(6).w_full().cursor_row_resize())
      .flex_none().bg(t.border).hover((s) => s.bg(t.accent))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.drag = { kind, x: e.position.x, y: e.position.y, w: this.leftW, d: this.detailsH, t: this.treeH };
      });
  }

  onDragMove(e, cx) {
    if (!this.drag) return;
    const d = this.drag;
    const dy = e.position.y - d.y;
    if (d.kind === "w") {
      this.leftW = Math.max(240, Math.min((this.width || 900) - 300, d.w + e.position.x - d.x));
    } else {
      const room = Math.max(160, (this.paneH || 800) - 200);
      if (d.kind === "details") this.detailsH = Math.max(40, Math.min(room - this.treeH, d.d + dy));
      else this.treeH = Math.max(40, Math.min(room - this.detailsH, d.t + dy));
    }
    cx.notify();
  }

  sidebar(t, font, cx) {
    return v_flex().flex_1().min_h(0).relative()
      .when(this.region === 1, (el) => el.child(div().absolute().top(0).left(0).right(0).h(2).bg(t.accent)))
      .child(h_flex().h(18).flex_none().px(8).gap(8).items_center().bg(this.region === 1 ? t.selected : t.chrome)
        .child(this.regionChip(t, 1))
        .child(div().text_size(10).text_color(t.dim)
          .child(`${this.commits} ${this.kind === "svn" ? "revs" : "commits"}`)))
      .child(this.graphList(t, font, cx))
      .when(this.menu?.kind === "commit", (el) => el.child(this.menuView(t)));
  }

  graphList(t, font, cx) {
    const empty = Boolean(this.error) || this.rows.length === 0;
    const head = this.rows[0]?.uncommitted ? this.rows[0] : null;
    const offset = head ? 1 : 0;
    const rest = this.rows.slice(offset);
    const keyOf = (i) => {
      const row = this.raw[i];
      return row ? String(row.full ?? row.rev ?? i) : String(i);
    };
    return v_flex().flex_1().min_h(0)
      .when(empty, (el) => el.child(div().p(10).text_size(12).text_color(t.dim)
        .child(this.error || (this.loading || this.gbusy ? "Loading…" : "No commits"))))
      .when(Boolean(head), (el) => el
        .child(this.rowEl(t, font, this.raw[0], head, 0).id("vcs-uncommitted").cursor_pointer()
          .on_click((_e, cx) => { this.region = 1; this.select(0, cx); })))
      .child(div().flex_1().min_h(0).relative()
        .when(!empty && rest.length > 0, (el) => el
          .child(v_virtual_list("vcs-graph-list", rest.length, ROW, (i) => keyOf(i + offset),
            (range) => rest.slice(range.start, range.end)
              .map((r, k) => this.rowEl(t, font, this.raw[range.start + k + offset], r, range.start + k + offset)))
            .track_scroll(this.graphScroll)
            .on_item_click((key, cx) => {
              const index = this.raw.findIndex((row) => String(row.full ?? row.rev ?? "") === key);
              if (index >= 0) { this.region = 1; this.select(index, cx); }
            })
            .size_full())
          .child(Scrollbar.vertical("vcs-graph-list").viewport_from_layout().absolute().inset(0))));
  }
}

