import { Octokit } from "@octokit/rest";

export interface CommitVaultResult {
  path: string;
  commitSha: string;
}

export async function commitMarkdownToVault(params: {
  path: string;
  content: string;
  commitMessage: string;
}): Promise<CommitVaultResult> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const owner = process.env.GITHUB_OWNER?.trim();
  const repo = process.env.GITHUB_REPO?.trim();
  const branch = process.env.GITHUB_BRANCH?.trim() || "main";

  if (!token || !owner || !repo) {
    throw new Error(
      "Missing GitHub vault configuration (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)",
    );
  }

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
