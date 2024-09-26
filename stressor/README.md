# Stress Test Script

This node script dispatches multiple runs of each workflow with each supported browser for the list of test plans defined at the top of [./stress-test.mts](./stress-test.mts).

It works sequentially through the list of test plans, completing the runs for one before beginning the next.

## Setup

1. Install dependencies with `npm i`
2. set an environment variable `GITHUB_TOKEN` with an access token. See [these docs](https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event) for which token needs which auth scopes and how to generate them.

## Running

Run it with `npm run --slient stress-test | tee some-output-file.md`.

Running the script can take a while, as it is constrained by GitHub Actions availability and speed.
Will need the occasional manual job restart on GitHub when the ngrok tunnel sometimes fails (maybe 1 out of 20 runs).

Set an environment variable `DEBUG` to `1` or `true` to get extra logging
