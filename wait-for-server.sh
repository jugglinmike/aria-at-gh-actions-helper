#!/bin/bash

set -e

max_attempts=20
temp_file=$(mktemp)

function clean_up {
  rm ${temp_file}
}
trap clean_up EXIT

for attempt in $(seq ${max_attempts}); do
  echo "Testing for server availability (trial ${attempt} of ${max_attempts})."

  ./bin/at-driver serve 2> ${temp_file} &
  sleep 3
  say This text came from the say command.
  sleep 1
  kill -9 %%

  if grep --silent 'This text came from the say command.' ${temp_file}; then
    echo The server is ready.
    break
  fi

  echo The server is not ready. Text observed:
  echo
  cat ${temp_file} | sed 's/^/> /'
  echo

  if [ ${attempt} == ${max_attempts} ]; then
    echo Failed after ${attempt} attempts. >&2
    exit 1
  fi
done
