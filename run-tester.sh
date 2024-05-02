#!/bin/bash

set -e

/usr/bin/safaridriver --port 4444 > webdriver.log 2>&1 &

safaridriver_pid=$!

aria-at-automation-driver/package/bin/at-driver serve --port 3031 > at-driver.log 2>&1 &

atdriver_pid=$!

function clean_up {
  kill -9 ${safaridriver_pid}
  kill -9 ${atdriver_pid}
}
trap clean_up EXIT

node aria-at-automation-harness/bin/host.js run-plan \
  --plan-workingdir aria-at/build/${ARIA_AT_WORK_DIR} \
  --debug \
  --agent-web-driver-url=http://127.0.0.1:4444 \
  --agent-at-driver-url=ws://127.0.0.1:3031/command \
  --reference-hostname=127.0.0.1 \
  --agent-web-driver-browser=${BROWSER} \
  ${ARIA_AT_TEST_PATTERN} | \
    tee harness-run.log
