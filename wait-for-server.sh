#!/bin/bash

set -e

max_attempts=20
temp_file=$(mktemp)

echo temp file: ${temp_file}

function clean_up {
  rm ${temp_file}
}
trap clean_up EXIT

for attempt in $(seq ${max_attempts}); do
  echo Trying ${attempt} of ${max_attempts}.

  ./bin/at-driver serve > ${temp_file} &
  sleep 3
  say This text came from the say command.
  sleep 1
  kill %%

  if grep --silent 'This text came from the say command.' ${temp_file}; then
    break
  fi

  if [ ${attempt} == ${max_attempts} ]; then
    echo Failed after ${attempt} attempts. >&2
    exit 1
  fi
done

echo The server is ready.
