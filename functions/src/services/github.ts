import { Octokit } from "@octokit/rest";

export interface CommitVaultResult {
  path: string;
  commitSha: string;
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
  const { token, owner, repo, branch } = readGitHubEnv();
  const octokit = new Octokit({ auth: token });

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
}
