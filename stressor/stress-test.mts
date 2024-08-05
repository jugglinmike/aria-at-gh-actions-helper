import * as http from "node:http";
import ngrok from "ngrok";
import { Octokit } from "@octokit/rest";
import { diff } from "jest-diff";

const testPlans = [
  "tests/menu-button-actions-active-descendant",
  "tests/alert",
  "tests/horizontal-slider",
  // "tests/command-button",
  // "tests/disclosure-navigation",
  // "tests/link-span-text",
  // "tests/dialog",
  // "tests/menu-button-navigation",
  // "tests/radiogroup-aria-activedescendant",
  // "tests/toggle-button/toggle-button-navigation",
];
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
const numRuns = 2;
const testContinueTimeoutMs = 30_000;

interface WorkflowCallbackPayload {
  status: string;
  testCsvRow: number;
  responses: Array<string>;
}

interface TestCombination {
  workflowId: string;
  workflowBrowser: string;
  workflowTestPlan: string;
}

type WorkflowRunResults = Array<{
  screenreaderResponses: Array<string>;
  testCsvRow: number;
}>;

/**
 * Creates a unique key for a workflow run, given the test combo and run index
 * The key is used to identify the callbacks for a given test combo run
 */
function getWorkflowRunKey(combination: TestCombination, runIndex: number) {
  const { workflowId, workflowBrowser, workflowTestPlan } = combination;
  return `${runIndex}-${workflowId}-${workflowBrowser}-${workflowTestPlan}`;
}

/**
 * Creates a string representation of a test combo, for logging and debugging
 */
function testComboToString(combination: TestCombination) {
  const { workflowId, workflowBrowser, workflowTestPlan } = combination;
  return `Test plan: ${workflowTestPlan}, workflow: ${workflowId}, browser: ${workflowBrowser}`;
}

/**
 * Creates a list of test combinations, given the testing matrix and test plans
 */
function enumerateTestCombinations(
  matrix: typeof testingMatrix,
  testPlans: string[]
): Array<TestCombination> {
  return matrix.flatMap(({ workflowId, browsers }) =>
    browsers.flatMap((browser) =>
      testPlans.map((testPlan) => ({
        workflowId,
        workflowBrowser: browser,
        workflowTestPlan: testPlan,
      }))
    )
  );
}

/**
 * Sets up a listener on the node server for a single run of a test combo.
 * @returns a promise that resolves when the workflow run is complete.
 */
async function setUpTestComboCallbackListener(
  testCombination: TestCombination,
  runIndex: number
) {
  console.log(
    `Setting up listener for ${getWorkflowRunKey(testCombination, runIndex)}.`
  );
  const promise = new Promise<WorkflowRunResults>((resolvePromise) => {
    const uniqueWorkflowHeaderValue = `${getWorkflowRunKey(
      testCombination,
      runIndex
    )}`;
    const results: WorkflowRunResults = [];
    let timeoutId: NodeJS.Timeout;
    let timeoutStartTime: number;
    const requestListener = (
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) => {
      let body = "";
      if (req.headers?.[workflowHeaderKey] === uniqueWorkflowHeaderValue) {
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", () => {
          const parsedBody: WorkflowCallbackPayload = JSON.parse(body);

          if (parsedBody.status === "RUNNING") {
            // Turns out there are more results coming
            clearTimeout(timeoutId);
          }
          if (parsedBody.status === "COMPLETED") {
            results.push({
              screenreaderResponses: parsedBody.responses,
              testCsvRow: parsedBody.testCsvRow,
            });
            // We don't get an explicit signal when all the tests come in,
            // so we wait to see if we another "RUNNING" message.
            clearTimeout(timeoutId);
            timeoutStartTime = Date.now();
            timeoutId = setTimeout(() => {
              console.log(
                `Workflow run ${getWorkflowRunKey(
                  testCombination,
                  runIndex
                )} seems to be done.`
              );
              resolvePromise(results);
              server.removeListener("request", requestListener);
            }, testContinueTimeoutMs);
          }
          res.end();
        });
      }
    };
    server.on("request", requestListener);
  });

  return promise;
}

/**
 * Dispatches a workflow run on GitHub Actions for a single test combo.
 * @returns true if successful, false otherwise.
 */
async function dispatchWorkflowForTestCombo(
  testCombo: TestCombination,
  runIndex: number
): Promise<boolean> {
  const { workflowId, workflowTestPlan } = testCombo;
  try {
    await octokitClient.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowId,
      ref: defaultBranch,
      inputs: {
        work_dir: workflowTestPlan,
        callback_url: ngrokUrl,
        callback_header: `${workflowHeaderKey}:${getWorkflowRunKey(
          testCombo,
          runIndex
        )}`,
      },
    });
    return true;
  } catch (e) {
    console.log(
      `Run ${runIndex} of ${testComboToString(testCombo)} failed to dispatch.`
    );
    console.error(e);
    return false;
  }
}

/**
 * Checks if all the results in a set of workflow runs are the same and non-empty
 * @returns true if all the results are the same and non-empty, false otherwise
 */
function checkRunSetResults(results: Array<WorkflowRunResults>) {
  const isAllPopulated = results.reduce((allPopulated, workflowResults) => {
    return (
      allPopulated &&
      workflowResults.reduce((rowPopulated, row) => {
        if (
          row.screenreaderResponses.length > 0 &&
          row.screenreaderResponses.every(
            (s: string) => s !== null && s.trim().length !== 0
          )
        ) {
          return rowPopulated;
        } else {
          console.error(
            `Test CSV row ${row.testCsvRow} has a blank response from screenreader`
          );
          console.debug(row.screenreaderResponses);
          return false;
        }
      }, true)
    );
  }, true);
  console.log("All screenreader responses populated: ", isAllPopulated);

  const isAllEqual = results.reduce((allEqual, workflowResults) => {
    return (
      allEqual &&
      workflowResults.reduce((responsesEqual, run, runIndex) => {
        if (runIndex === 0) return responsesEqual; // First run is the reference
        if (
          run.screenreaderResponses.every(
            (a: string, j: number) =>
              a === workflowResults[0].screenreaderResponses[j]
          )
        ) {
          return responsesEqual;
        } else {
          console.error(
            `Run #${runIndex} of Test CSV row ${run.testCsvRow} has screenreader responses different from Run 0`
          );
          console.debug(
            diff(
              run.screenreaderResponses,
              workflowResults[0].screenreaderResponses
            )
          );
          return false;
        }
      }, true)
    );
  }, true);
  console.log("All sets equal: ", isAllEqual);

  if (!isAllEqual || !isAllPopulated) {
    console.debug("All results:");
    console.debug(results);
  }
  return isAllEqual && isAllPopulated;
}

// Get all the test combos
const testCombinations = enumerateTestCombinations(testingMatrix, testPlans);
console.debug("Test Plans:\n", testPlans);
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

// Step through testPlans, waiting for those CI runs to finish before the next begin
for (const testPlan of testPlans) {
  console.log(
    `==========\nRunning tests for test plan ${testPlan}.\n==========`
  );
  // Filter the list of test combos to only those for this test plan
  const testCombosForTestPlan = testCombinations.filter(
    (testCombo) => testCombo.workflowTestPlan === testPlan
  );
  // For each test plan, run each test combo in parallel
  const testCombinationResults = await Promise.all(
    testCombosForTestPlan.map(async (testCombo: TestCombination) => {
      const runPromises = [];
      for (let runIndex = 0; runIndex < numRuns; runIndex++) {
        const dispatched = await dispatchWorkflowForTestCombo(
          testCombo,
          runIndex
        );
        if (dispatched) {
          const listenerPromise = setUpTestComboCallbackListener(
            testCombo,
            runIndex
          );
          runPromises.push(listenerPromise);
        }
      }

      console.log(
        `Dispatched ${
          runPromises.length
        } workflow runs for combination ${testComboToString(testCombo)}.`
      );

      // Wait to get all results from parallel runs of the same test combo
      const runResults = await Promise.all(runPromises);

      // Check if all the results are good
      console.log(
        `Checking results for test combo ${testComboToString(testCombo)}.`
      );
      const isGoodResults = checkRunSetResults(runResults);
      console.log(
        `Results for test combination ${testComboToString(testCombo)}: ${
          isGoodResults ? "PASS" : "FAIL"
        }`
      );
      return isGoodResults;
    })
  );

  // Check if all the test combos passed
  const isAllGoodResults = testCombinationResults.every((result) => result);
  console.log(
    `All results passing for test plan ${testPlan}: ${isAllGoodResults}.`
  );
}

process.exit(0);
