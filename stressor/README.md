# Stress Test Script

This node script dispatches multiple runs of each workflow with each supported browser for the list of test plans defined at the top of [./stress-test.mts](./stress-test.mts).

It works sequentially through the list of test plans, completing the runs for one before beginning the next.

## Setup

1. Install dependencies with `npm i`
2. set an environment variable `GITHUB_TOKEN` with an access token. To generate a new token:

* https://github.com/settings/personal-access-tokens/new
* Generate a new token, make sure it has access to the repo you'll be running the stress actions on, and give it Read & Write "Actions" permissions (everything else can stay default).
* For more information see [these docs](https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event) for which token needs which auth scopes and how to generate them.

## Running

1. It is prefered for you to run the stress test against your own personal "non-fork" of this repo (create a personal repo and push to it instead of using "fork" so it isn't part of the "network") to limit the number of action runs against the main branch.
2. Run it with the following command (replacing `myUser` and `myRepo` with the owner and name of your repository):

      $ npx tsx stress-test.mts --owner myUser --repo myRepo | tee some-output-file.md
3. Running the script can take a while, as it is constrained by GitHub Actions availability and speed.
Will need the occasional manual job restart on GitHub when the ngrok tunnel sometimes fails (maybe 1 out of 20 runs).

Set an environment variable `DEBUG` to `1` or `true` to get extra logging
