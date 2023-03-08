#!/bin/bash

# first. update the manifest file:
curl -sf https://raw.githubusercontent.com/superfluid-finance/superfluid-sentinel/master/manifest.json > manifest.json

# Run the jq command to extract the chainIds
ids=$(jq '.networks | keys[]' manifest.json)

for id in $ids; do
  # Remove the quotes from the ID string and convert to integer
  idInt=$(( ${id//\"/} ))
  # Calculate the port
  port=$(( idInt % 50000 + 10000))

  metricsUrl="http://solvency-dev.x.superfluid.dev:$port"
#  echo "checking chainId $idInt, metrics url $port..."
  
  healthy=$(curl -fs $metricsUrl | jq ".healthy")
  if [[ $healthy != true ]]; then
    echo "<!channel> SF sentinel for chainId $idInt not healthy - see $metricsUrl (may be down if the process is dead)"
  fi
done
