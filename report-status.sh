#!/bin/bash

set -euo pipefail

read -r -d '' request_body <<HERE || true
{
  "status": "${1}",
  ${2}
  "externalLogsUrl": "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
}
HERE

curl \
  --header "${ARIA_AT_CALLBACK_HEADER}" \
  --header 'Content-Type: application/json' \
  --data "${request_body}" \
  "${ARIA_AT_STATUS_URL}"
