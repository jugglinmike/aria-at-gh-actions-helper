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

interface WorkflowCallbackPayload {
  status: string;
  responses: Array<string>;
}

interface TestCombination {
  workflowId: string;
  workflowBrowser: string;
  workflowTestPlan: string;
}

function getWorkflowRunKey(combination: TestCombination, runIndex: number) {
  const { workflowId, workflowBrowser, workflowTestPlan } = combination;
  return `${runIndex}-${workflowId}-${workflowBrowser}-${workflowTestPlan}`;
}

function testComboToString(combination: TestCombination) {
  const { workflowId, workflowBrowser, workflowTestPlan } = combination;
  return `Test plan: ${workflowTestPlan}, workflow: ${workflowId}, browser: ${workflowBrowser}`;
}

function generateTestCombinations(
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

function checkRunSetResults(results: Array<Array<string>>) {
  const isAllPopulated = results.every((arr, i) => {
    if (
      arr.length > 0 &&
      arr.every((s) => s !== null && s.trim().length !== 0)
    ) {
      return true;
    } else {
      console.error(`${i}th array has a blank response from screenreader`);
      return false;
    }
  });
  console.log("All populated: ", isAllPopulated);

  const isAllEqual = results.every((arr, i) => {
    if (arr.every((a, j) => a == results[0][j])) {
      return true;
    } else {
      console.error(`${i}th array of screenreader responses is different`);
      console.debug(diff(arr, results[0]));
      return false;
    }
  });
  console.log("All the same: ", isAllEqual);

  if (!isAllEqual || !isAllPopulated) {
    console.debug("All results:");
    console.debug(results);
  }
  return isAllEqual && isAllPopulated;
}

const testCombinations = generateTestCombinations(testingMatrix, testPlans);
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

async function setUpTestComboCallbackListener(
  testCombination: TestCombination,
  runIndex: number
) {
  const { workflowId, workflowBrowser, workflowTestPlan } = testCombination;
  const promise = new Promise<Array<string>>((resolvePromise) => {
    const uniqueWorkflowHeaderValue = `${getWorkflowRunKey(
      testCombination,
      runIndex
    )}`;
    let requestListener = (
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
          console.debug(uniqueWorkflowHeaderValue);
          console.debug("Parsed body: ", parsedBody);

          if (parsedBody.status === "COMPLETED") {
            console.log(
              `Received result for test plan ${workflowTestPlan} on workflow ${workflowId} and browser ${workflowBrowser}, run ${runIndex}.`
            );
            resolvePromise(parsedBody.responses);
          }
          res.end();
          server.removeListener("request", requestListener);
        });
      }
    };
    server.on("request", requestListener);
  });
  return promise;
}

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
    console.debug(
      `Dispatched run ${runIndex} of ${testComboToString(testCombo)}.`
    );
    return true;
  } catch (e) {
    console.log(
      `Run ${runIndex} of ${testComboToString(testCombo)} failed to dispatch.`
    );
    console.error(e);
    return false;
  }
}

// Step through testPlans, waiting for those CI runs to finish before the next begin
for (const testPlan of testPlans) {
  const testCombosForTestPlan = testCombinations.filter(
    (testCombo) => testCombo.workflowTestPlan === testPlan
  );
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
        } workflow runs for combination ${testComboToString(testCombo)}:.`
      );

      const runResults = await Promise.all(runPromises);

      const isGoodResults = checkRunSetResults(runResults);
      console.log(
        `Results for test combination ${testComboToString(testCombo)}: ${
          isGoodResults ? "PASS" : "FAIL"
        }`
      );
      return isGoodResults;
    })
  );

  const isAllGoodResults = testCombinationResults.every((result) => result);
  console.log(
    `All results passing for test plan ${testPlan}: ${isAllGoodResults}.`
  );
}

process.exit(0);
