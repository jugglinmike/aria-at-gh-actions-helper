import * as http from "node:http";
import ngrok from "ngrok";
import { Octokit } from "@octokit/rest";

// tests that are currently in working order
// TODO: Make into array
const work_dir = process.env.ARIA_AT_WORK_DIR ?? "";
const owner = "bocoup",
  repo = "aria-at-gh-actions-helper";
const defaultBranch = "main";
const testingMatrix = [
  {
    workflowId: "voiceover-test.yml",
    browsers: ["chrome", "firefox", "safari"],
  },
  {
    workflowId: "nvda-test.yml",
    browsers: ["chrome", "firefox"],
  },
];
const port = 8888;
const workflowHeaderKey = "x-workflow-key";
const numRuns = 3;

interface WorkflowCallbackPayload {
  status: string;
  responses: Array<string>;
}

interface TestCombination {
  workflowId: string;
  workflowBrowser: string;
  workflowTestPlan: string;
}

const expectedWorkflowCallbacksStore: { [key: string]: number } = {};

function getWorkflowKey(combination: TestCombination) {
  const { workflowId, workflowBrowser, workflowTestPlan } = combination;
  return `${workflowId}-${workflowBrowser}-${workflowTestPlan}`;
}

function generateTestCombinations(
  matrix: typeof testingMatrix
): Array<TestCombination> {
  return matrix.flatMap(({ workflowId, browsers }) =>
    browsers.map((browser) => ({
      workflowId,
      workflowBrowser: browser,
      workflowTestPlan: work_dir,
    }))
  );
}

function checkRunSetResults(results: Array<Array<string>>) {
  const isAllEqual = results.every((arr, i) => {
    if (arr.every((a, j) => a == results[0][j])) {
      return true;
    } else {
      console.error(`${i}th array of screenreader responses is different`);
      // TODO: use diff lib to print the diff
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

const testCombinations = generateTestCombinations(testingMatrix);
console.debug("Test Plans:\n", work_dir);
console.debug("Testing Matrix:\n", testingMatrix);
console.log(
  `Will dispatch ${
    testCombinations.length
  } test combinations ${numRuns} times, for a total of ${
    testCombinations.length * numRuns
  } workflow runs.`
);

const server = http.createServer();
server.listen(port);
console.log(`Local server started at port ${port}`);

const ngrokUrl = await ngrok.connect({
  port,
});
console.log(`Ngrok tunnel started at ${ngrokUrl}`);

process.on("beforeExit", (code) => {
  server.close();
  ngrok.kill();
  console.log("Exiting with code: ", code);
});

const octokitClient = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

function setUpTestComboCallbackListener(testCombination: TestCombination) {
  const { workflowId, workflowBrowser, workflowTestPlan } = testCombination;
  return new Promise<boolean>((resolvePromise) => {
    let screenReaderResponses: Array<Array<string>> = [];
    server.on("request", (req, res) => {
      let body = "";
      if (
        req.headers?.[workflowHeaderKey] === getWorkflowKey(testCombination)
      ) {
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
            expectedWorkflowCallbacksStore[getWorkflowKey(testCombination)]
          ) {
            console.log(
              `Received ${screenReaderResponses.length} results for test plan ${workflowTestPlan} on workflow ${workflowId} and browser ${workflowBrowser}. Checking results.`
            );
            resolvePromise(checkRunSetResults(screenReaderResponses));
          }
          res.end();
        });
      }
    });
  });
}

async function dispatchWorkflowsForTestCombo(testCombo: TestCombination) {
  const { workflowId, workflowBrowser, workflowTestPlan } = testCombo;
  let successfulDispatches = 0;
  for (let run = 0; run < numRuns; run++) {
    try {
      await octokitClient.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: workflowId,
        ref: defaultBranch,
        inputs: {
          callback_url: ngrokUrl,
          callback_header: `${workflowHeaderKey}:${getWorkflowKey(testCombo)}`,
        },
      });
      successfulDispatches += 1;
    } catch (e) {
      console.log(
        `A run of workflow ${workflowId} on ${workflowBrowser} failed to dispatch.`
      );
      console.error(e);
    }
  }
  return successfulDispatches;
}

const testCombinationRun = testCombinations.map(
  async (testCombo: TestCombination) => {
    const completedPromise = setUpTestComboCallbackListener(testCombo);
    // kick off runs for test combo
    const successfulDispatches = await dispatchWorkflowsForTestCombo(testCombo);
    console.log(
      `Dispatched ${successfulDispatches} runs of ${testCombo.workflowId} on ${testCombo.workflowBrowser}.`
    );
    expectedWorkflowCallbacksStore[getWorkflowKey(testCombo)] =
      successfulDispatches;
    return completedPromise;
  }
);

const results = await Promise.all(testCombinationRun);
const isgoodResults = results.every((r) => r);
console.log(`Results passing: ${isgoodResults}. Exiting.`);
process.exit(isgoodResults ? 0 : 1);
