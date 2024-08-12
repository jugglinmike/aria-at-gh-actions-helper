import * as http from "node:http";
import ngrok from "ngrok";
import { Octokit } from "@octokit/rest";
import { diff } from "jest-diff";

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

const testPlans = [
  "tests/menu-button-actions-active-descendant",
  "tests/alert",
  "tests/horizontal-slider",
  "tests/command-button",
  "tests/disclosure-navigation",
  "tests/link-span-text",
  "tests/dialog",
  "tests/menu-button-navigation",
  "tests/radiogroup-aria-activedescendant",
  "tests/toggle-button/toggle-button-navigation",
];
const owner = "bocoup",
  repo = "aria-at-gh-actions-helper";
const defaultBranch = "main";
const testingMatrix = [
  {
    workflowId: "voiceover-test.yml",
    browsers: ["safari", "chrome", "firefox"],
  },
  {
    workflowId: "nvda-test.yml",
    browsers: ["chrome", "firefox"],
  },
];
const port = 8888;
const workflowHeaderKey = "x-workflow-key";
const numRuns = 3;
const testContinueTimeoutMs = 60_000;

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
 * Logs the message to the console if DEBUG is true
 */
const debugLog = (...args: Parameters<typeof console.debug>): void => {
  if (DEBUG) {
    console.debug(...args);
  }
};

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
            debugLog(
              `Workflow run ${getWorkflowRunKey(
                testCombination,
                runIndex
              )} is still running (${
                Date.now() - timeoutStartTime
              }ms elapsed since timeout start).`
            );
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
              debugLog(
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
 * Checks the results in a set of workflow runs for population and equality
 * @returns An object with percentages of populated and equal results
 */
function checkRunSetResults(results: Array<WorkflowRunResults>) {
  let totalRows = 0;
  let populatedRows = 0;
  let equalRows = 0;

  results.forEach((workflowResults, workflowIndex) => {
    totalRows += workflowResults.length;

    workflowResults.forEach((row, rowIndex) => {
      // Check for populated responses
      const isRowPopulated = row.screenreaderResponses.every(
        (s: string) => s !== null && s.trim().length !== 0
      );
      if (isRowPopulated) {
        populatedRows++;
      } else {
        console.error(
          `Test CSV row ${row.testCsvRow} has a blank response from screenreader`
        );
        console.error(row.screenreaderResponses);
      }

      // Check for equal responses (skip first workflow as it's the reference)
      if (workflowIndex > 0) {
        const isRowEqual = row.screenreaderResponses.every(
          (a: string, j: number) =>
            a === results[0][rowIndex].screenreaderResponses[j]
        );
        if (isRowEqual) {
          equalRows++;
        } else {
          console.error(
            `Run #${workflowIndex} of Test CSV row ${row.testCsvRow} has screenreader responses different from Run 0`
          );
          console.error(
            diff(
              row.screenreaderResponses,
              results[0][rowIndex].screenreaderResponses
            )
          );
        }
      }
    });
  });

  const totalRowsExcludingFirst = totalRows - results[0].length;
  const percentPopulated = ((totalRows - populatedRows) / totalRows) * 100;
  const percentEqual =
    ((totalRowsExcludingFirst - equalRows) / totalRowsExcludingFirst) * 100;

  console.log(
    `Percentage of rows with unpopulated responses: ${percentPopulated.toFixed(
      2
    )}%, (${totalRows - populatedRows} of ${totalRows})`
  );
  console.log(
    `Percentage of rows with unequal responses: ${percentEqual.toFixed(2)}%, (${
      totalRowsExcludingFirst - equalRows
    } of ${totalRowsExcludingFirst})`
  );

  return {
    percentUnpopulated: percentPopulated,
    percentUnequal: percentEqual,
  };
}

// Get all the test combos
const testCombinations = enumerateTestCombinations(testingMatrix, testPlans);
console.log("Test Plans:\n", testPlans);
console.log("Testing Matrix:\n", testingMatrix);
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
server.setMaxListeners(50);

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
    `===============\nRunning tests for test plan ${testPlan}.\n===============`
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
      debugLog(
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
      const runResultStats = checkRunSetResults(runResults);

      return { ...testCombo, ...runResultStats };
    })
  );

  console.log(
    `===============\nCompleted tests for test plan ${testPlan} with results: \n===============`
  );
  testCombinationResults.forEach((result) => {
    console.log(`${result.workflowId}: ${result.workflowBrowser}`);
    console.log(`Percent unpopulated: ${result.percentUnpopulated}`);
    console.log(`Percent unequal: ${result.percentUnequal}`);
  });
  console.log(`==============================`);
}

process.exit(0);
