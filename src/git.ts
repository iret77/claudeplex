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
}

const cache = new Map<string, RepoInfo>();
const EMPTY: RepoInfo = { slug: "", label: "", worktree: "" };

/** owner/repo from a git remote URL (ssh, scp-like or https), else "". */
export function parseRemote(url: string): string {
  const u = url.trim().replace(/\.git$/, "");
  // git@host:owner/repo · ssh://git@host/owner/repo · https://host/owner/repo
  const m = u.match(/[:/]([^/:]+\/[^/:]+)$/);
  return m ? m[1] : "";
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
    const slug = parseRemote(git(cwd, ["config", "--get", "remote.origin.url"])) || repoRoot.split("/").pop() || "";
    const wt = top.split("/").pop() || "";
    info = { slug, label: linked && wt ? `${slug} ⑂ ${wt}` : slug, worktree: linked ? wt : "" };
  }
  cache.set(cwd, info);
  return info;
}

export const repoSlug = (cwd: string): string => repoInfo(cwd).slug;
export const repoLabel = (cwd: string): string => repoInfo(cwd).label;
/** { repo, worktree } for two-column display; repo is the slug, worktree "" if none. */
export const repoParts = (cwd: string): { repo: string; worktree: string } => {
  const i = repoInfo(cwd);
  return { repo: i.slug, worktree: i.worktree };
};
