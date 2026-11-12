#!/usr/bin/env bash
# Runs one live probe. The probes exit 4 when the outside service (NEAR testnet RPC, the indexer, 1Click) did not
# answer, and anything else non-zero when it answered wrong. Silence out there is a warning; a wrong answer fails.
set -u
timeout 10m "$@"
code=$?
if [ "$code" -eq 4 ] || [ "$code" -eq 124 ]; then
  echo "::warning::The outside service did not answer (exit $code): $*"
  exit 0
fi
exit "$code"
