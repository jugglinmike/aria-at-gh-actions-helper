import * as http from "node:http";
import ngrok from "ngrok";
import { Octokit } from "@octokit/rest";
import { diff } from "jest-diff";
import test, { run } from "node:test";
import wrap from "word-wrap";
import pLimit from "p-limit";
import isEqual from "lodash.isequal";
import { readFile, writeFile } from "node:fs/promises";
import { Command, InvalidArgumentError } from "commander";

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";
const limitWorkflows = pLimit(8);
function parseIntOption(value, dummyPrevious) {
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new InvalidArgumentError("Not a number.");
  }
  return parsedValue;
}
const program = new Command()
  .requiredOption("-o, --owner <string>", "repository owner")
  .requiredOption("-r, --repo <string>", "repository name")
  .option("-b, --branch <string>", "Git branch", "main")
  .option("-f, --results-from-file", "Load results from local 'allResults.json' file")
  .option("-n, --num-runs <int>", "Number of times to run each test plan", parseIntOption, 5)
  .option("-p, --port <int>", "Port number on which to bind the local results-accepting server", parseIntOption, 8888);
program.parse();
const options = program.opts();

const testPlans = [
  "tests/menu-button-actions-active-descendant",
  "tests/alert",
  "tests/horizontal-slider",
  "tests/command-button",
  "tests/disclosure-navigation",
  "tests/link-span-text",
  "tests/modal-dialog",
  "tests/menu-button-navigation",
  "tests/radiogroup-aria-activedescendant",
  "tests/toggle-button",
];

// ordered this way because voiceover usually finishes quicker, and when you only
// have 3 jobs left it matters... :)
const testingMatrix = [
  {
    workflowId: "nvda-test.yml",
    browsers: ["chrome", "firefox"],
  },
  {
    workflowId: "voiceover-test.yml",
    browsers: ["safari", "chrome", "firefox"],
  },
];

const workflowHeaderKey = "x-workflow-key";

interface WorkflowCallbackPayload {
  status: string;
  testCsvRow?: number;
  presentationNumber?: number;
  responses?: Array<string>;
  externalLogsUrl?: string;
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

type WorkflowRun = {
  runLogsUrl: string;
  results: WorkflowRunResults;
};

type ComparisonTestRunDifference = {
  runId: number;
  responses: Array<string>;
}

type ComparisonTestRunResult = {
  testCsvRow: number;
  baselineResponses: Array<string>;
  differences: Array<ComparisonTestRunDifference>;
};

interface ComparisonRunResult {
  percentUnequal: number;
  totalRows: number;
  equalRows: number;
  unequalRows: number;
  comparedResults: Array<ComparisonTestRunResult>;
}

type CompleteTestComboRunResult = ComparisonRunResult & TestCombination & {
  logUrls: Array<string>;
};

/**
 * Logs the message to the console if DEBUG is true
 */
const debugLog = (...args: Parameters<typeof console.debug>): void => {
  if (DEBUG) {
    // using console.error to print to STDERR
    console.error("[DEBUG]:", ...args);
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
  return `${workflowTestPlan}-${workflowId}-${workflowBrowser}-${runIndex}`;
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
  const promise = new Promise<WorkflowRun>((resolvePromise) => {
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
            debugLog(`${getWorkflowRunKey(testCombination, runIndex)}: received\n${body}`);
            // if results are included, then we collect them
            // if not, then we assume this is a status update and the test plan is done
            if (parsedBody.responses !== undefined) {
              results.push({
                screenreaderResponses: parsedBody.responses,
                testCsvRow:
                  parsedBody.testCsvRow ?? parsedBody.presentationNumber ?? -1,
              });
            } else {
              const runLogsUrl = parsedBody.externalLogsUrl ?? "url not collected";
              debugLog(
                `Workflow run ${getWorkflowRunKey(
                  testCombination,
                  runIndex
                )} finished.`
              );
              resolvePromise({results, runLogsUrl});
              server.removeListener("request", requestListener);
            }
          } else if (parsedBody.status === "ERROR") {
            // BELL in case the terminal supports it
            process.stderr.write('\u0007');
            console.error("[ERROR]:", `${getWorkflowRunKey(testCombination, runIndex)}: received\n${body}`);
          }
          res.end();
        });
      }
    };
    server.on("request", requestListener);
    debugLog(`Workflow run ${getWorkflowRunKey(testCombination, runIndex)} listener started.`);
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
      owner: options.owner,
      repo: options.repo,
      workflow_id: workflowId,
      ref: options.branch,
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
    debugLog(`Dispatched ${testComboToString(testCombo)} Run #${runIndex}`)
    return true;
  } catch (e) {
    console.error(
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
  runs: ReadonlyArray<WorkflowRun>
): WorkflowRunResults {
  // Group responses by testCsvRow
  const groupedResponses: Map<number, Array<Array<string>>> = new Map();

  runs.forEach((run) => {
    run.results.forEach((row) => {
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
function checkRunSetResults(runs: Array<WorkflowRun>): ComparisonRunResult {
  let totalRows = 0;
  let equalRows = 0;

  const comparisonWorkflowRunResults = findMostCommonRunResults(runs);
  const comparedResults: Array<ComparisonTestRunResult> = [];
  comparisonWorkflowRunResults.forEach((compTest) => {
    const { testCsvRow, screenreaderResponses: baselineResponses } = compTest;
    const differences: Array<ComparisonTestRunDifference> = [];
    runs.forEach((run, i) => {
      totalRows++;
      const resultResponses =
        run.results.findLast((l) => l.testCsvRow === compTest.testCsvRow)
          ?.screenreaderResponses ?? [];
      if (isEqual(resultResponses, baselineResponses)) {
        equalRows++;
      } else {
        differences.push({ runId: i, responses: resultResponses });
      }
    });
    comparedResults.push({ testCsvRow, baselineResponses, differences });
  });

  const percentUnequal = ((totalRows - equalRows) / totalRows) * 100;


  return {
    comparedResults,
    totalRows: totalRows,
    equalRows: equalRows,
    unequalRows: totalRows - equalRows,
    percentUnequal,
  };
}

const dispatchAndListen = async(testCombo: TestCombination, runIndex: number): Promise<WorkflowRun> => {
  const dispatched = await dispatchWorkflowForTestCombo(
    testCombo,
    runIndex
  );
  if (dispatched) {
    return await setUpTestComboCallbackListener(
      testCombo,
      runIndex
    );
  } else {
    throw new Error('dispatch failed');
  }
};

const spawnAndCollectWorkflows = async (testCombo: TestCombination): Promise<CompleteTestComboRunResult> => {
  const runPromises: Array<Promise<WorkflowRun>> = [];
  for (let runIndex = 0; runIndex < options.numRuns; runIndex++) {
      runPromises.push(limitWorkflows(() => dispatchAndListen(testCombo, runIndex)));
  }
  // Wait to get all results from parallel runs of the same test combo
  const runResults = await Promise.all(runPromises);
  // Check if all the results are good
  const runResultStats = checkRunSetResults(runResults);
  const comboResult: CompleteTestComboRunResult = { ...testCombo, ...runResultStats, logUrls: runResults.map(run => run.runLogsUrl) };
  debugLog(`${testComboToString(testCombo)} done`, comboResult);
  allResults.set(testCombo, comboResult);
  return comboResult;
}

// Get all the test combos
const testCombinations = enumerateTestCombinations(testingMatrix, testPlans);
debugLog("Test Plans:\n", testPlans);
debugLog("Testing Matrix:\n", testingMatrix);
debugLog(
  `Will dispatch ${
    testCombinations.length
  } test combinations ${options.numRuns} times, for a total of ${
    testCombinations.length * options.numRuns
  } workflow runs.`
);

const server = http.createServer();
server.listen(options.port);
debugLog(`Local server started at port ${options.port}`);
server.setMaxListeners(50);

const ngrokUrl = await ngrok.connect({
  port: options.port,
});
debugLog(`Ngrok tunnel started at ${ngrokUrl}`);

process.on("beforeExit", (code) => {
  server.close();
  ngrok.kill();
  console.error("Exiting with code: ", code);
});

const octokitClient = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});



const allResults: Map<TestCombination, CompleteTestComboRunResult> = new Map();

if (options.resultsFromFile) {
  const data = JSON.parse(await readFile("stressor-run.json", "utf-8"));
  for (const [key, value] of data) {
    allResults.set(key, value);
  }
} else {
  const logStatusInterval = setInterval(() => {
    // write direct to stderr to not get piped to markdown output.
    process.stderr.write(`Workflow queue status: ${limitWorkflows.activeCount} active, ${limitWorkflows.pendingCount} pending.\n`);
  }, 60000);

  try {
    // Step through testPlans, waiting for those CI runs to finish before the next begin
    await Promise.all(testPlans.flatMap(testPlan => {
      // Filter the list of test combos to only those for this test plan
      const testCombosForTestPlan = testCombinations.filter(
        (testCombo) => testCombo.workflowTestPlan === testPlan
      );
      // For each test plan, run each test combo in parallel
      return testCombosForTestPlan.map(spawnAndCollectWorkflows);
    }));
  }
  finally {
    clearInterval(logStatusInterval);
  }
}

const formatResultsForMD = (results: Map<TestCombination, CompleteTestComboRunResult>) => {
  const keys = [...results.keys()];
  const values = [...results.values()];

  const scoring = {
    workflowTestPlan: [...new Set(keys.map(key => key.workflowTestPlan))].sort(),
    workflowId: [...new Set(keys.map(key => key.workflowId))].sort(),
    workflowBrowser: [...new Set(keys.map(key => key.workflowBrowser))].sort(),
  };
  // generate a distinct ordering score for keys
  // browser - least significant
  // workflow - next most
  // test plan - most significant
  const score = (key: TestCombination) => (
    scoring.workflowBrowser.indexOf(key.workflowBrowser) +
    (scoring.workflowId.indexOf(key.workflowId) * scoring.workflowBrowser.length) +
    (scoring.workflowTestPlan.indexOf(key.workflowTestPlan) * scoring.workflowId.length * scoring.workflowBrowser.length)
  )
  keys.sort((a, b) => score(a) - score(b));

  console.log(`# Stress Test Run - Completed ${new Date().toISOString()}\n`);

  const generalSummary = values.reduce((memo, result) => {
    return {
      totalRuns: memo.totalRuns + result.totalRows,
      totalEqual: memo.totalEqual + result.equalRows,
    };
  }, { totalRuns: 0, totalEqual: 0 });


  console.log(`* __Total Tests:__ ${generalSummary.totalRuns}`);
  console.log(`* __Total Unequal %:__ ${((generalSummary.totalRuns - generalSummary.totalEqual) * 100 / generalSummary.totalRuns).toFixed(2)}%`)
  console.log(`* __Number of runs per combo:__ ${options.numRuns}`);
  console.log(`* __Maximum possible "Unequal %" based on number of runs:__ ${((options.numRuns - 1) * 100 / options.numRuns).toFixed(2)}%`);
  console.log(`* __Test Plans:__\n`);
  for (const plan of testPlans) {
    console.log(`  * ${plan}`)
  }
  console.log(`\n* __Test Matrix:__\n`);
  for (const entry of testingMatrix) {
    console.log(`  * ${entry.workflowId}`);
    for (const browser of entry.browsers) {
      console.log(`    * ${browser}`);
    }
  }

  type GenerateBy = (arg0: CompleteTestComboRunResult) => string;
  type Formatter = (arg0: string) => string;
  const generateSummary = (displayTitle: string, by: GenerateBy, formatter: Formatter = identity => identity) => {
    console.log(`\n## Summary by ${displayTitle}\n`);
    console.log(`| ${displayTitle} | Total Tests | Unequal Responses | Unequal % |`);
    console.log("| --- | --- | --- | --- |");
    const allKeys = new Set(values.map(by));
    for (const key of allKeys) {
      const { totalRuns, totalEqual } = values
        .filter((result) => by(result) === key)
        .reduce((memo, result) => {
          return {
            totalRuns: memo.totalRuns + result.totalRows,
            totalEqual: memo.totalEqual + result.equalRows,
          };
        }, { totalRuns: 0, totalEqual: 0 });
      const totalUnequal = totalRuns - totalEqual;
      console.log(`| ${formatter(key)} | ${totalRuns} | ${totalUnequal} | ${(totalUnequal * 100 / totalRuns).toFixed(2)}% |`);
    }
  }

  generateSummary('Test Plan', result => result.workflowTestPlan);
  generateSummary('AT', result => result.workflowId, workflowIdAsLabel);
  generateSummary('Browser', result => result.workflowBrowser);

  const generateHeaderTextForCombo = (combo: TestCombination):string =>
    `${combo.workflowTestPlan} ${workflowIdAsLabel(combo.workflowId)} ${combo.workflowBrowser}`;

  const generateHeaderLinkForCombo = (combo: TestCombination):string =>
    '#' + generateHeaderTextForCombo(combo)
      .replace(/[^\s\w-]/g, '')
      .replace(/\s+/g, '-')
      .toLowerCase();

  console.log(`\n## Summary by All\n`);
  console.log(`| Test Plan | AT | Browser | Total Tests | Unequal Responses | Unequal % | Heading Link |`);
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const combo of keys) {
    const comboResults = results.get(combo);
    // typescript insists this is possibly undefined
    if (comboResults) {
      console.log(`| ${comboResults.workflowTestPlan} | ${workflowIdAsLabel(comboResults.workflowId)} | ${comboResults.workflowBrowser} | ${comboResults.totalRows} | ${comboResults.unequalRows} | ${comboResults.percentUnequal.toFixed(2)}% | [#](${generateHeaderLinkForCombo(combo)}) |`)
    }
  }

  const formatResponses = (responses: Array<string>, newlineTab: string = '\n    '): string =>
    responses
      .map((response, index) => {
        const responseWrapped = response.split('\n').map(line => wrap(line, {width: 60, newline: newlineTab})).join(newlineTab);
        return `Response ${index+1}:${newlineTab}${responseWrapped}`;
      })
      .join('\n')
      .replace(/\n(\s*\n)+/g, '\n');

  for (const combo of keys) {
    const comboResults = results.get(combo);
    // typescript insists this is possibly undefined
    if (comboResults) {
      console.log(`\n## ${generateHeaderTextForCombo(combo)}\n`);
      console.log(`\n### Run Logs\n`);
      let logNumber = 0;
      for (const url of comboResults.logUrls) {
        console.log(`* [Run #${logNumber++}](${url})`);
      }
      for (const comparedResult of comboResults.comparedResults) {
        console.log(`\n### Test Number: ${comparedResult.testCsvRow}\n`);
        console.log(`__${combo.workflowTestPlan} ${workflowIdAsLabel(combo.workflowId)} ${combo.workflowBrowser}__`);
        console.log(`#### Most Common Responses:`);
        console.log("```");
        console.log(formatResponses(comparedResult.baselineResponses));
        console.log("```");
        for(const diverges of comparedResult.differences) {
          console.log(`#### Divergent responses from [Run ${diverges.runId}](${comboResults.logUrls[diverges.runId]}):`);
          console.log("```diff");
          console.log(diff(formatResponses(comparedResult.baselineResponses), formatResponses(diverges.responses)));
          console.log("```");
        }
      }
    }
    console.log(``)
  }
};

formatResultsForMD(allResults);

// Debug helper: write the needed "allResults" for this run to a json file
await writeFile("stressor-run.json", JSON.stringify([...allResults.entries()]), "utf-8");

process.exit(0);
