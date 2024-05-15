#!/bin/bash

set -euo pipefail

# When run in macOS, the test harness does not use WebDriver because
# SafariDriver's "glass pane" feature interferes with testing. Provide a valid
# URL simply as a placeholder.
url_placeholder=http://example.com

aria-at-automation-driver/package/bin/at-driver serve --port 3031 > at-driver.log 2>&1 &

atdriver_pid=$!

function clean_up {
  kill -9 ${atdriver_pid} || true
}
trap clean_up EXIT

node aria-at-automation-harness/bin/host.js run-plan \
  --plan-workingdir aria-at/build/${ARIA_AT_WORK_DIR} \
  --debug \
  --agent-web-driver-url=${url_placeholder} \
  --agent-at-driver-url=ws://127.0.0.1:3031/session \
  --reference-hostname=127.0.0.1 \
  --agent-web-driver-browser=safari \
  '{reference/**,test-*-voiceover_macos.*}' 2>&1 | \
    tee harness-run.log
