#!/bin/bash

set -euo pipefail

# This URL is used for firefox and chrome, and is only a placeholder for safari.
# When run in macOS, the test harness does not use WebDriver because
# SafariDriver's "glass pane" feature interferes with testing.
webdriver_url=http://127.0.0.1:4444

# Initialize so we can set up trap right away
webdriver_pid=0
atdriver_pid=0

function clean_up {
  if [[ ${webdriver_pid} -ne 0 ]]; then
    kill -9 ${webdriver_pid} || true
  fi
  if [[ ${atdriver_pid} -ne 0 ]]; then
    kill -9 ${atdriver_pid} || true
  fi
}
trap clean_up EXIT

aria-at-automation-driver/package/bin/at-driver serve --port 3031 > at-driver.log 2>&1 &
atdriver_pid=$!

poll_url() {
  local url="$1"
  local attempt=0
  echo "Polling ${url}"

  while [ ${attempt} -lt 30 ]; do
    ((attempt++))

    response=$(curl -s -o /dev/null -w "%{http_code}" -m 2 "$url" || true)

    if [ ${response:--1} -ge 99 ]; then
      echo "Success: ${response} after ${attempt} tries"
      return 0
    else
      echo "Attempt ${attempt}: URL ${url} returned HTTP ${response}. Retrying in 1 second..." >&2
      sleep 1
    fi
  done

  echo "Error: Max attempts reached. ${url} is not responding."
  exit 1
}

case ${BROWSER} in
  chrome)
    echo "Starting chromedriver"
    chromedriver --port=4444 --log-level=INFO > webdriver.log 2>&1 &
    webdriver_pid=$!
    echo "Started chromedriver"
    poll_url $webdriver_url
    ;;

  firefox)
    echo "Starting geckodriver"
    geckodriver/geckodriver > webdriver.log 2>&1 &
    webdriver_pid=$!
    echo "Started geckodriver"
    poll_url $webdriver_url
    ;;

  safari)
    ;;

  *)
    echo "Unknown browser (${BROWSER})"
    exit 1
    ;;
esac

node aria-at-automation-harness/bin/host.js run-plan \
  --plan-workingdir aria-at/build/${ARIA_AT_WORK_DIR} \
  --debug \
  --web-driver-url=${webdriver_url} \
  --at-driver-url=ws://127.0.0.1:3031/session \
  --reference-hostname=127.0.0.1 \
  --web-driver-browser=${BROWSER} \
  '{reference/**,test-*-voiceover_macos.*}' 2>&1 | \
    tee harness-run.log
