import * as http from "node:http";
import ngrok from "ngrok";
import { Octokit } from "@octokit/rest";
import { diff } from "jest-diff";

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

const testPlans = [
  // "tests/menu-button-actions-active-descendant",
  // "tests/alert",
  // "tests/horizontal-slider",
  // "tests/command-button",
  "tests/disclosure-navigation",
  // "tests/link-span-text",
  // "tests/modal-dialog",
  // "tests/menu-button-navigation",
  // "tests/radiogroup-aria-activedescendant",
  // "tests/toggle-button",
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
const numRuns = 5;

interface WorkflowCallbackPayload {
  status: string;
  testCsvRow?: number;
  presentationNumber?: number;
  responses?: Array<string>;
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

/*
 * Get a nice human readable string for the given GitHub workflow id
 */
function workflowIdAsLabel(workflowId: string): string {
  switch (workflowId) {
    case "voiceover-test.yml":
      return "VoiceOver";

    case "nvda-test.yml":
      return "NVDA";

    default:
      return workflowId;
  }
}

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

          if (parsedBody.status === "COMPLETED") {
            // if results are included, then we collect them
            // if not, then we assume this is a status update and the test plan is done
            if (parsedBody.responses !== undefined) {
              results.push({
                screenreaderResponses: parsedBody.responses,
                testCsvRow:
                  parsedBody.testCsvRow ?? parsedBody.presentationNumber ?? -1,
              });
            } else {
              debugLog(
                `Workflow run ${getWorkflowRunKey(
                  testCombination,
                  runIndex
                )} finished.`
              );
              resolvePromise(results);
              server.removeListener("request", requestListener);
            }
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
        status_url: ngrokUrl,
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
 * Find the most common set of screenreader responses for each test in this set of runs
 * In other words, it finds the most for results of the same testCsv number
 * within this collection of run results.
 *
 * @returns a synthetic results array where each element is the mode for its csvRow
 */
function findMostCommonRunResults(
  results: ReadonlyArray<WorkflowRunResults>
): WorkflowRunResults {
  // Group responses by testCsvRow
  const groupedResponses: Map<number, Array<Array<string>>> = new Map();

  results.forEach((workflowResult) => {
    workflowResult.forEach((row) => {
      if (!groupedResponses.has(row.testCsvRow)) {
        groupedResponses.set(row.testCsvRow, []);
      }
      groupedResponses.get(row.testCsvRow)!.push(row.screenreaderResponses);
    });
  });

  // Find mode for each testCsvRow
  const modeResponses: WorkflowRunResults = Array.from(
    groupedResponses.entries()
  ).map(([testCsvRow, responses]) => {
    const mode = findMode(responses);
    return {
      testCsvRow,
      screenreaderResponses: mode,
    };
  });

  return modeResponses;
}

function findMode(arr: Array<Array<string>>): Array<string> {
  const counts = new Map<string, number>();
  let maxCount = 0;
  let mode: Array<string> = [];

  arr.forEach((item) => {
    const key = JSON.stringify(item);
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);

    if (count > maxCount) {
      maxCount = count;
      mode = item;
    }
  });

  return mode;
}

/**
 * Checks the results in a set of workflow runs for population and equality
 * @returns An object with percentages of populated and equal results
 */
function checkRunSetResults(results: Array<WorkflowRunResults>) {
  let totalRows = 0;
  let equalRows = 0;

  const comparisonWorkflowRunResults = findMostCommonRunResults(results);

  comparisonWorkflowRunResults.forEach((compTest) => {
    console.log(`\n### TestId ${compTest.testCsvRow}\n`);
    console.log(`\n#### Comparison Set\n`);
    console.log(`\`\`\`\n${compTest.screenreaderResponses}\n\`\`\``);
    console.log(`\n#### Mismatches\n`);
    results.forEach((result, i) => {
      totalRows++;
      const resultResponses =
        result.find((l) => l.testCsvRow === compTest.testCsvRow)
          ?.screenreaderResponses ?? [];
      const isRowEqual =
        JSON.stringify(resultResponses) ===
        JSON.stringify(compTest.screenreaderResponses);
      if (isRowEqual) {
        equalRows++;
      } else {
        console.error(`\n##### Run #${i}\n`);
        console.error(
          `\`\`\`diff\n${diff(
            compTest.screenreaderResponses,
            resultResponses
          )}\n\`\`\``
        );
      }
    });
  });

  const percentUnequal = ((totalRows - equalRows) / totalRows) * 100;

  console.log(`\n#### Stats\n`);
  console.log(`- Total Rows: ${totalRows}`);
  console.log(`- Unequal Rows: ${totalRows - equalRows}`);
  console.log(`- Percentage Unequal: ${percentUnequal.toFixed(2)}%`);

  return {
    percentUnequal,
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
  console.log(`# Test plan: ${testPlan}\n`);
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
        `## ${workflowIdAsLabel(testCombo.workflowId)} on ${
          testCombo.workflowBrowser
        }.`
      );
      const runResultStats = checkRunSetResults(runResults);

      return { ...testCombo, ...runResultStats };
    })
  );

  console.log(`\n## Summary\n`);
  testCombinationResults.forEach((result) => {
    console.log(`${result.workflowId} + ${result.workflowBrowser}`);
    console.log(
      `Unequal responses between all ${numRuns} runs: ${result.percentUnequal.toFixed(
        2
      )}%`
    );
  });
}

process.exit(0);
