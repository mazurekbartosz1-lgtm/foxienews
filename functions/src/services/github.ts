import { Octokit } from "@octokit/rest";

export interface CommitVaultResult {
  path: string;
  commitSha: string;
}

export interface RepoTreeEntry {
  path: string;
  sha: string;
  type: "blob" | "tree";
}

export interface AtomicFileChange {
  path: string;
  content: string | null;
}

export interface AtomicCommitResult {
  commitSha: string;
  treeSha: string;
  branch: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
  branch: string;
}

export interface GitHubVaultClient {
  listTree(ref?: string): Promise<RepoTreeEntry[]>;
  fetchFile(path: string, ref?: string): Promise<string | null>;
  commitAtomicChanges(params: {
    changes: AtomicFileChange[];
    commitMessage: string;
    branch?: string;
  }): Promise<AtomicCommitResult>;
  createBranch(params: { branchName: string; fromBranch?: string }): Promise<string>;
  findOpenPullRequest(headBranch: string): Promise<PullRequestResult | null>;
  createPullRequest(params: {
    title: string;
    body: string;
    head: string;
    base?: string;
  }): Promise<PullRequestResult>;
}

function readGitHubEnv() {
  const token = process.env.GITHUB_TOKEN?.trim();
  const owner = process.env.GITHUB_OWNER?.trim();
  const repo = process.env.GITHUB_REPO?.trim();
  const branch = process.env.GITHUB_BRANCH?.trim() || "main";

  if (!token || !owner || !repo) {
    throw new Error(
      "Missing GitHub vault configuration (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)",
    );
  }

  return { token, owner, repo, branch };
}

export function createGitHubVaultClient(): GitHubVaultClient {
  const { token, owner, repo, branch } = readGitHubEnv();
  const octokit = new Octokit({ auth: token });

  async function resolveBranchHead(targetBranch: string): Promise<{
    headCommitSha: string;
    baseTreeSha: string;
  }> {
    const refData = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${targetBranch}`,
    });
    const headCommitSha = refData.data.object.sha;
    const commitData = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: headCommitSha,
    });
    return {
      headCommitSha,
      baseTreeSha: commitData.data.tree.sha,
    };
  }

  return {
    async listTree(ref?: string): Promise<RepoTreeEntry[]> {
      const targetRef = ref || branch;
      const { baseTreeSha } = await resolveBranchHead(targetRef);
      const treeRes = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: baseTreeSha,
        recursive: "true",
      });

      const entries: RepoTreeEntry[] = [];
      for (const item of treeRes.data.tree) {
        if (!item.path || !item.sha) continue;
        if (item.type === "blob" || item.type === "tree") {
          entries.push({
            path: item.path,
            sha: item.sha,
            type: item.type,
          });
        }
      }
      return entries;
    },

    async fetchFile(path: string, ref?: string): Promise<string | null> {
      try {
        const response = await octokit.rest.repos.getContent({
          owner,
          repo,
          path,
          ref: ref || branch,
        });

        if (Array.isArray(response.data) || response.data.type !== "file") {
          return null;
        }
        if (typeof response.data.content !== "string") {
          return null;
        }
        return Buffer.from(response.data.content, "base64").toString("utf8");
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 404) {
          return null;
        }
        throw err;
      }
    },

    async commitAtomicChanges(params: {
      changes: AtomicFileChange[];
      commitMessage: string;
      branch?: string;
    }): Promise<AtomicCommitResult> {
      const targetBranch = params.branch?.trim() || branch;
      const { headCommitSha, baseTreeSha } = await resolveBranchHead(targetBranch);

      type TreeItem = {
        path: string;
        mode: "100644";
        type: "blob";
        sha: string | null;
      };
      const treeEntries: TreeItem[] = [];

      for (const change of params.changes) {
        if (change.content === null) {
          treeEntries.push({
            path: change.path,
            mode: "100644",
            type: "blob",
            sha: null,
          });
          continue;
        }

        const blob = await octokit.rest.git.createBlob({
          owner,
          repo,
          content: Buffer.from(change.content, "utf8").toString("base64"),
          encoding: "base64",
        });

        treeEntries.push({
          path: change.path,
          mode: "100644",
          type: "blob",
          sha: blob.data.sha,
        });
      }

      const nextTree = await octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        // Octokit's generated type omits `sha: null`, which Git Data API requires to delete a blob.
        tree: treeEntries as unknown as Array<{
          path?: string;
          mode?: "100644";
          type?: "blob";
          sha?: string;
          content?: string;
        }>,
      });

      const nextCommit = await octokit.rest.git.createCommit({
        owner,
        repo,
        message: params.commitMessage,
        tree: nextTree.data.sha,
        parents: [headCommitSha],
      });

      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${targetBranch}`,
        sha: nextCommit.data.sha,
      });

      return {
        commitSha: nextCommit.data.sha,
        treeSha: nextTree.data.sha,
        branch: targetBranch,
      };
    },

    async createBranch(params: { branchName: string; fromBranch?: string }): Promise<string> {
      const baseBranch = params.fromBranch?.trim() || branch;
      const { headCommitSha } = await resolveBranchHead(baseBranch);
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${params.branchName}`,
        sha: headCommitSha,
      });
      return headCommitSha;
    },

    async findOpenPullRequest(headBranch: string): Promise<PullRequestResult | null> {
      const res = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        head: `${owner}:${headBranch}`,
        per_page: 5,
      });
      const first = res.data[0];
      if (!first) return null;
      return {
        number: first.number,
        url: first.html_url,
        branch: headBranch,
      };
    },

    async createPullRequest(params: {
      title: string;
      body: string;
      head: string;
      base?: string;
    }): Promise<PullRequestResult> {
      const pr = await octokit.rest.pulls.create({
        owner,
        repo,
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base?.trim() || branch,
      });
      return {
        number: pr.data.number,
        url: pr.data.html_url,
        branch: params.head,
      };
    },
  };
}

export async function commitMarkdownToVault(params: {
  path: string;
  content: string;
  commitMessage: string;
}): Promise<CommitVaultResult> {
  const { token, owner, repo, branch } = readGitHubEnv();
  const octokit = new Octokit({ auth: token });
  const encodedContent = Buffer.from(params.content, "utf8").toString("base64");

  const response = await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    branch,
    path: params.path,
    message: params.commitMessage,
    content: encodedContent,
  });

  return {
    path: response.data.content?.path ?? params.path,
    commitSha: response.data.commit.sha ?? "",
  };
}

export async function fetchVaultFileFromGitHub(
  path: string,
  ref?: string,
): Promise<string | null> {
  return createGitHubVaultClient().fetchFile(path, ref);
}
