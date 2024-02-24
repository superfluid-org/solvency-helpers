#!/bin/bash

# usage: <cmd> <testnets|mainnets>
# returns messages suited to be sent to slack if the sentinel for a network is down.

kind=$1

# using metadata
curl -sf https://raw.githubusercontent.com/superfluid-finance/protocol-monorepo/dev/packages/metadata/networks.json > sf_networks.json

if [[ "$kind" == "mainnets" ]]; then
  ids=$(jq '.[] | select(.isTestnet == false and .isDeprecated == null) | .chainId' sf_networks.json)
  domain="http://mainnet-sentinels.x.superfluid.dev"
elif [[ "$kind" == "testnets" ]]; then
  ids=$(jq '.[] | select(.isTestnet == true and .isDeprecated == null) | .chainId' sf_networks.json)
  domain="http://testnet-sentinels.x.superfluid.dev"
else
  echo "usage: <cmd> <testnets|mainnets>"
  exit 1
fi

for id in $ids; do
  # Remove the quotes from the ID string and convert to integer
  idInt=$(( ${id//\"/} ))
  # Calculate the port
  port=$(( idInt % 50000 + 10000))

  metricsUrl="$domain:$port"
  #echo "checking chainId $idInt, metrics url $port..."

  healthy=$(curl -fs $metricsUrl | jq ".healthy")
  if [[ $healthy != true ]]; then
    echo "<!channel> SF sentinel for chainId $idInt not healthy - see $metricsUrl (may be down if the process is dead)"
  fi
done
