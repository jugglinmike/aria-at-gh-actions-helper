import * as http from "node:http";
import ngrok from "ngrok";
import { Octokit } from "@octokit/rest";

const owner = "bocoup",
  repo = "aria-at-gh-actions-helper";
const defaultBranch = "main";
const workflowIds = ["voiceover-test.yml", "nvda-test.yml"];
const port = 8888;
const workflowIdHeaderKey = "x-workflow-id";
const numRuns = 3;

const expectedWorkflowCallbacksNum: { [key: string]: number } =
  Object.fromEntries(workflowIds.map((id) => [id, 0]));

interface WorkflowCallbackPayload {
  status: string;
  responses: Array<string>;
}

function checkRunSetResults(results: Array<Array<string>>) {
  const isAllEqual = results.every((arr, i) => {
    if (arr.every((a, j) => a == results[0][j])) {
      return true;
    } else {
      console.error(`${i}th array of screenreader responses is different`);
      return false;
    }
  });
  console.log("All the same: ", isAllEqual);
  const isAllPopulated = results.every((arr, i) => {
    if (arr.every((s) => s.trim().length !== 0)) {
      return true;
    } else {
      console.error(`${i}th array has a blank response from screenreader`);
      return false;
    }
  });
  console.log("All populated: ", isAllPopulated);
  if (!isAllEqual || !isAllPopulated) {
    console.debug("All results:");
    console.debug(results);
  }
  return isAllEqual && isAllPopulated;
}

const server = http.createServer();
server.listen(port);

const ngrokUrl = await ngrok.connect({
  port,
});

process.on("beforeExit", (code) => {
  server.close();
  ngrok.kill();
  console.log("Exiting with code: ", code);
});

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const proms = workflowIds.map(async (workflowId) => {
  const completedPromise = new Promise<boolean>((resolvePromise) => {
    let screenReaderResponses: Array<Array<string>> = [];
    server.on("request", (req, res) => {
      let body = "";
      if (req.headers?.[workflowIdHeaderKey] === workflowId) {
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", () => {
          const parsedBody: WorkflowCallbackPayload = JSON.parse(body);

          if (parsedBody.status === "COMPLETED") {
            screenReaderResponses.push(parsedBody.responses);
          }

          if (
            screenReaderResponses.length ===
            expectedWorkflowCallbacksNum[workflowId]
          ) {
            console.log(
              `Received results for ${screenReaderResponses.length} runs of ${workflowId}. Checking results.`
            );
            resolvePromise(checkRunSetResults(screenReaderResponses));
          }
          res.end();
        });
      }
    });
  });

  // kick off runs for workflow
  for (let run = 0; run < numRuns; run++) {
    try {
      await octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: workflowId,
        ref: defaultBranch,
        inputs: {
          callback_url: ngrokUrl,
          callback_header: `${workflowIdHeaderKey}:${workflowId}`,
        },
      });
      expectedWorkflowCallbacksNum[workflowId] += 1;
    } catch (e) {
      console.log(`A run of workflow ${workflowId} failed to dispatch.`);
      console.error(e);
    }
  }
  console.log(
    `Dispatched ${expectedWorkflowCallbacksNum[workflowId]} runs of ${workflowId}.`
  );
  return completedPromise;
});

const results = await Promise.all(proms);
const isgoodResults = results.every((r) => r);
console.log(`Results passing: ${isgoodResults}. Exiting.`);
process.exit(isgoodResults ? 0 : 1);
