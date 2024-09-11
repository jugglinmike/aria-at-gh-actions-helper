import { Octokit } from "@octokit/rest";

const username = "";
const repoName = "aria-at-gh-actions-helper";

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

/**
 * Cancels all incomplete runs of all GitHub Actions workflows in the given repository.
 * Limited to the last 30 runs by GitHub's API pagination.
 */
async function cancelAllWorkflows(owner: string, repo: string) {
  const workflows = await octokit.actions.listRepoWorkflows({
    owner,
    repo,
  });

  for (const workflow of workflows.data.workflows) {
    const runs = await octokit.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflow.id,
    });

    for (const run of runs.data.workflow_runs) {
      if (run.status !== "completed") {
        await octokit.actions.cancelWorkflowRun({
          owner,
          repo,
          run_id: run.id,
        });
        console.log(`Cancelled workflow run ${run.id} (${run.status})`);
      }
    }
  }
}

cancelAllWorkflows(username, repoName);
