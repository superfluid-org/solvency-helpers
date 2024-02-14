// Import ethers and other necessary modules
const { ethers } = require("ethers");
const sfSubgraph = require("./superfluid-subgraph");
const sfMeta = require("@superfluid-finance/metadata");
const SuperfluidABI = require("@superfluid-finance/js-sdk/src/abi");
//const MAX_PARALLEL_REQUESTS = process.env.MAX_PARALLEL_REQUESTS || 10;

// Add BigInt support for JSON serialization
BigInt.prototype.toJSON = function () {
    return this.toString();
};

async function getCriticalAccounts(networkName, config = undefined) {
    const network = sfMeta.getNetworkByName(networkName);
    if (!network) {
        throw new Error(`Unknown network ${networkName}`);
    }

    if (network.contractsV1.gdaV1) {
        console.log(`network with GDA at ${network.contractsV1.gdaV1}`);
    }

    const subgraphUrl = config?.subgraphUrl || `https://${network.name}.subgraph.x.superfluid.dev`;
    const rpcUrl = config?.rpcUrl || `https://${network.name}.rpc.x.superfluid.dev?app=fast-solvency-checker`;
    console.log(`Using subgraph ${subgraphUrl}, rpc ${rpcUrl}`);

    const provider = new ethers.JsonRpcProvider(rpcUrl);

    sfSubgraph.init(subgraphUrl);

    const now = Math.floor(Date.now() / 1000);
    console.log(`now: ${now}`);

    const maybeCriticalAccounts = await sfSubgraph.getAccountsCriticalAt(now);
    console.log(`Found ${maybeCriticalAccounts.length} potentially critical accounts`);

    // now get those actually critical by checking their state via RPC
    // this closure takes a maybeCriticalAccount (mca) object and queries its on-chain state.
    // it returns null if the account is not critical, otherwise it returns the mca object with on-chain state added
    const getEnrichedAccountStateIfCritical = async (mca) => {
        const { critical, insolvent, availableBalance, deposit } = await getAccountStatusFromRpc(provider, mca.token.id, mca.account.id);
        console.log(`acc ${mca.account.id}, token ${mca.token.id} (${mca.token.symbol}): balance ${ethers.formatEther(availableBalance)}, deposit ${ethers.formatEther(deposit)} |${mca.isLiquidationEstimateOptimistic ? " optimistic" : ""} ${critical ? "critical" : ""} ${insolvent ? "insolvent" : ""}`);

        if (availableBalance >= 0n || deposit === 0n) {
            console.log(`acc ${mca.account.id} has positive balance or no deposit, skipping...`);
            return null;
        } else {
            console.log(`acc ${mca.account.id} is critical, adding to critical accounts`);
        }

        return {
            ...mca,
            availableBalance,
            deposit,
            // deposit consumed percentage, as Number
            depositConsumedPct: Number(availableBalance * 100n / deposit)
        };
    };

    // TODO: add throttling to avoid overloading the RPC if the number of candidates gets large
    return (await Promise.all(maybeCriticalAccounts.map(getEnrichedAccountStateIfCritical)))
        .filter(Boolean); // remove null items
}

async function getAccountStatusFromRpc(provider, superTokenAddr, accountAddr) {
    const superToken = new ethers.Contract(superTokenAddr, SuperfluidABI.ISuperToken, provider);
    const isCritical = await superToken.isAccountCriticalNow(accountAddr);
    const isSolvent = isCritical ? await superToken.isAccountSolventNow(accountAddr) : true;
    const rtb = await superToken.realtimeBalanceOfNow(accountAddr);
    return {
        critical: isCritical,
        insolvent: !isSolvent,
        availableBalance: rtb.availableBalance,
        deposit: rtb.deposit
    };
}

// Make getCriticalAccounts available for import
module.exports = { getCriticalAccounts };

// Allow script to be run directly
if (require.main === module) {
    const networkName = process.argv[2];
    if (!networkName) {
        console.error("Usage: node subgraph-solvency-checker.js <network-name>");
        process.exit(1);
    }

    getCriticalAccounts(networkName)
        .then(criticalAccounts => console.log(`Critical accounts: ${JSON.stringify(criticalAccounts)}`))
        .catch(error => console.error(error.message));
}
