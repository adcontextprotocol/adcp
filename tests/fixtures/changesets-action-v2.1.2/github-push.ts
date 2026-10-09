// Exact push helper excerpt from changesets/action src/github.ts at
// ae32849d5ba541f9ae29e40e22a623bc13562f51 (v2.1.2), MIT licensed.
// https://github.com/changesets/action/blob/ae32849d5ba541f9ae29e40e22a623bc13562f51/src/github.ts
const push = async (branch: string, options: GitOptions) => {
  await exec("git", ["push", "origin", `HEAD:${branch}`, "--force"], options);
};

// Exact identity-probe calls from ensureGitUser in the same pinned source.
const authorIdentity = await getExecOutput(
  "git",
  ["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"],
  { cwd: this.cwd, ignoreReturnCode: true, silent: true },
);
const committerIdentity = await getExecOutput(
  "git",
  ["-c", "user.useConfigOnly=true", "var", "GIT_COMMITTER_IDENT"],
  { cwd: this.cwd, ignoreReturnCode: true, silent: true },
);
