# Stress Test Script

This node script dispatches multiple runs of each workflow with each supported browser for the list of test plans defined at the top of [./stress-test.mts](./stress-test.mts).

It works sequentially through the list of test plans, completing the runs for one before beginning the next.

## Setup

1. Install dependencies with `npm i`
2. set an environment variable `GITHUB_TOKEN` with an access token. To generate a new token:

- https://github.com/settings/personal-access-tokens/new
- Generate a new token, make sure it has access to the repo you'll be running the stress actions on, and give it Read & Write "Actions" permissions (everything else can stay default).
- For more information see [these docs](https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event) for which token needs which auth scopes and how to generate them.

## Running

1. It is prefered for you to run the stress test against your own personal "non-fork" of this repo (create a personal repo and push to it instead of using "fork" so it isn't part of the "network") to limit the number of action runs against the main branch.
2. Update the stress-test.mts file `owner`, `repo`, and `defaultBranch` definitions near the top, as well as setting up the tests / matrix you want to test.
3. Run it with `npm run --silent stress-test | tee some-output-file.md`.
4. Running the script can take a while, as it is constrained by GitHub Actions availability and speed.
   Will need the occasional manual job restart on GitHub when the ngrok tunnel sometimes fails (maybe 1 out of 20 runs).

Set an environment variable `DEBUG` to `1` or `true` to get extra logging

### Running from a GitHub Codespace

It can be challenging to run this script (which can take hours to finish) from a laptop with intermittent internet access or batter saving settings. Here's how you can run it from a GitHub Codespace in the fork of this repo you create.

1. Create a codespace on `main` using the [config file in this folder](./devcontainer/devcontainer.json). (If you need to test changes on a different branch, be sure to create your codespace on that branch.) [See how.](https://docs.github.com/en/codespaces/developing-in-a-codespace/creating-a-codespace-for-a-repository?tool=webui)
2. Open your codespace or connect to it from your machine. [See how.](https://docs.github.com/en/codespaces/developing-in-a-codespace/opening-an-existing-codespace)
3. Follow the [setup instructions above](#setup) in your codespace. **Note:** GitHub codespaces come with $GITHUB_TOKEN set, but you'll need to override that because it will not have the right permissions to access GitHub Actions.
4. Set up ngrok authentication to use your [ngrok auth token](https://dashboard.ngrok.com/get-started/your-authtoken). (You will have to sign up for a free ngrok account if you don't already have one.)
5. Start the script per the [running instructions above](#running)
6. A popup will appear in the bottom right of your window. Click the "Make public" button to make sure the ngrok tunnel will work. (The ngrok tunnel is what lets the script receive results from the Actions workflows.)

#### A note on cost

The free plan on GitHub comes with a decent amount codespace usage, so it'll likely be free to use it to run this script. If you use codespaces for other personal projects and are over your free allotment it could cost up to a few dollars to run this script. See [codespaces billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces#monthly-included-storage-and-core-hours-for-personal-accounts) for more info.
