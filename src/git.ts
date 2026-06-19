/**
 * Resolve a working folder to its git repository identity — "owner/repo" from
 * the origin remote, plus a display label that names the worktree for linked
 * worktrees (so several checkouts of one repo stay distinguishable). Used to
 * show repos instead of long paths, and to collapse the issue picker by repo.
 * Cached per cwd; returns empty strings for non-git folders.
 */
interface RepoInfo {
  slug: string; // owner/repo (origin) or repo dir name; "" if not a git repo
  label: string; // slug, or "slug ⑂ worktree" for a linked worktree
  worktree: string; // linked-worktree name, else ""
  github: boolean; // true iff the origin remote points at GitHub (gh can act on it)
}

const cache = new Map<string, RepoInfo>();
const EMPTY: RepoInfo = { slug: "", label: "", worktree: "", github: false };

/** owner/repo from a git remote URL (ssh, scp-like or https), else "". */
export function parseRemote(url: string): string {
  const u = url.trim().replace(/\.git$/, "");
  // git@host:owner/repo · ssh://git@host/owner/repo · https://host/owner/repo
  const m = u.match(/[:/]([^/:]+\/[^/:]+)$/);
  return m ? m[1] : "";
}

/** Host portion of a git remote URL (scp-like `git@host:` or `scheme://[user@]host/`), else "". */
function remoteHost(url: string): string {
  const u = url.trim();
  let m = u.match(/^[^/@]+@([^:/]+):/); // scp-like: git@host:path
  if (m) return m[1];
  m = u.match(/^[a-z]+:\/\/(?:[^/@]+@)?([^/:]+)/i); // scheme://[user@]host/path
  return m ? m[1] : "";
}

/** True iff a remote URL targets GitHub (github.com or a GitHub Enterprise host). */
export function isGitHubRemote(url: string): boolean {
  return /github/i.test(remoteHost(url));
}

function git(cwd: string, args: string[]): string {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
    return r.success ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

export function repoInfo(cwd: string): RepoInfo {
  if (!cwd) return EMPTY;
  const hit = cache.get(cwd);
  if (hit) return hit;
  let info = EMPTY;
  const rp = git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
  if (rp) {
    const [top = "", absGit = ""] = rp.split("\n");
    // a linked worktree's git dir lives under <repo>/.git/worktrees/<name>;
    // its toplevel is the worktree, so derive the real repo root from the git dir.
    const linked = absGit.includes("/worktrees/");
    const repoRoot = linked ? absGit.replace(/\/\.git\/worktrees\/.*$/, "") : top;
    const originUrl = git(cwd, ["config", "--get", "remote.origin.url"]);
    const remoteSlug = parseRemote(originUrl);
    const slug = remoteSlug || repoRoot.split("/").pop() || "";
    const wt = top.split("/").pop() || "";
    info = { slug, label: linked && wt ? `${slug} ⑂ ${wt}` : slug, worktree: linked ? wt : "", github: !!remoteSlug && isGitHubRemote(originUrl) };
  }
  cache.set(cwd, info);
  return info;
}

/** A checkout of a repo on disk: the main worktree and any linked ones. */
export interface Worktree {
  path: string; // absolute toplevel of the checkout
  branch: string; // short branch name, or "" when detached
  head: string; // commit sha (short), "" if unknown
}

/** Parse `git worktree list --porcelain` for the repo containing `cwd`. [] on non-git/failure. */
export function listWorktrees(cwd: string): Worktree[] {
  const out = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const trees: Worktree[] = [];
  let cur: Partial<Worktree> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) trees.push({ path: cur.path, branch: cur.branch ?? "", head: cur.head ?? "" });
      cur = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length, "HEAD ".length + 8);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.branch = "";
    }
  }
  if (cur.path) trees.push({ path: cur.path, branch: cur.branch ?? "", head: cur.head ?? "" });
  return trees;
}

export const repoSlug = (cwd: string): string => repoInfo(cwd).slug;
export const repoLabel = (cwd: string): string => repoInfo(cwd).label;
/** True iff the folder's origin remote points at GitHub — i.e. `gh` can act on it. */
export const repoIsGitHub = (cwd: string): boolean => repoInfo(cwd).github;
/** { repo, worktree } for two-column display; repo is the slug, worktree "" if none. */
export const repoParts = (cwd: string): { repo: string; worktree: string } => {
  const i = repoInfo(cwd);
  return { repo: i.slug, worktree: i.worktree };
};
