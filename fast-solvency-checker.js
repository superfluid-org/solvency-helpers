// Import ethers and other necessary modules
const express = require('express');
const { ethers } = require("ethers");
const sfSubgraph = require("./superfluid-subgraph");
const sfMeta = require("@superfluid-finance/metadata");
const SuperfluidABI = require("@superfluid-finance/js-sdk/src/abi");
const { collectDefaultMetrics, register } = require('prom-client');
const promClient = require('prom-client');
const PORT = process.env.PORT || 3000;

// Create an Express app
const app = express();

// Initialize default metrics collection
collectDefaultMetrics();

// Constants
const depositConsumedPctThreshold = process.env.DEPOSIT_CONSUMED_PCT_THRESHOLD !== undefined ? Number(process.env.DEPOSIT_CONSUMED_PCT_THRESHOLD) : 20;

// Add BigInt support for JSON serialization
BigInt.prototype.toJSON = function () {
    return this.toString();
};

// in introvert mode, keep what would have been logged in case all is not right and a report is needed anyway
let deferredLog = "";
let warnMode = false; // toggles to true on first warning raised
// this is reported if INTROVERT is not set
function infoLog(msg) {
    if (!process.env.INTROVERT || warnMode) {
        console.log(msg);
    } else {
        deferredLog += msg;
    }
}

// this is reported
function warnLog(msg) {
    if (deferredLog !== "") {
        console.log(deferredLog);
        deferredLog = "";
    }
    console.log(msg);
    warnMode = true;
}

// Function getCriticalAccounts
async function getCriticalAccounts(networkName, config = undefined) {
    const network = sfMeta.getNetworkByName(networkName);
    if (!network) {
        throw new Error(`Unknown network ${networkName}`);
    }

    if (network.contractsV1.gdaV1) {
        infoLog(`network with GDA at ${network.contractsV1.gdaV1}`);
    }

    const subgraphUrl = config?.subgraphUrl || `https://${network.name}.subgraph.x.superfluid.dev`;
    const rpcUrl = config?.rpcUrl || `https://${network.name}.rpc.x.superfluid.dev?app=fast-solvency-checker`;
    infoLog(`Using subgraph ${subgraphUrl}, rpc ${rpcUrl}`);

    const provider = new ethers.JsonRpcProvider(rpcUrl);

    sfSubgraph.init(subgraphUrl);

    const now = Math.floor(Date.now() / 1000);
    const maybeCriticalAccounts = await sfSubgraph.getAccountsCriticalAt(now);
    infoLog(`Found ${maybeCriticalAccounts.length} potentially critical accounts`);

    // now get those actually critical by checking their state via RPC
    // this closure takes a maybeCriticalAccount (mca) object and queries its on-chain state.
    // it returns null if the account is not critical, otherwise it returns the mca object with on-chain state added
    const getEnrichedAccountStateIfCritical = async (mca) => {
        const { critical, insolvent, availableBalance, deposit } = await getAccountStatusFromRpc(provider, mca.token.id, mca.account.id);
        infoLog(`acc ${mca.account.id}, token ${mca.token.id} (${mca.token.symbol}): balance ${ethers.formatEther(availableBalance)}, deposit ${ethers.formatEther(deposit)} |${mca.isLiquidationEstimateOptimistic ? " optimistic" : ""} ${critical ? "critical" : ""} ${insolvent ? "insolvent" : ""}`);

        if (availableBalance >= 0n || deposit === 0n) {
            infoLog(`acc ${mca.account.id} has positive balance or no deposit, skipping...`);
            return null;
        } else {
            infoLog(`acc ${mca.account.id} is critical, adding to critical accounts`);
        }
        const depositConsumedPct = Number(-availableBalance * 100n / deposit);
        if (depositConsumedPct < depositConsumedPctThreshold) {
            infoLog(`acc ${mca.account.id} deposit consumed ${depositConsumedPct}% below threshold ${depositConsumedPctThreshold}, skipping...`);
            return null;
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

// Define Prometheus metrics
const totalPotentiallyCriticalMetric = new promClient.Gauge({
    name: 'total_potentially_critical_accounts',
    help: 'Total potentially critical accounts found during the script execution',
});

const totalCriticalMetric = new promClient.Gauge({
    name: 'total_critical_accounts',
    help: 'Total critical accounts detected during the script execution',
});

const totalSkippedMetric = new promClient.Gauge({
    name: 'total_skipped_accounts',
    help: 'Total skipped accounts during the script execution',
});

// Expose Prometheus metrics endpoint
app.get('/metrics', (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(register.metrics());
});

// Allow script to be run periodically
async function executeScript() {
    const networkName = process.argv[2];
    if (!networkName) {
        console.error("Usage: node subgraph-solvency-checker.js <network-name>");
        process.exit(1);
    }

    console.log(`Checking ${networkName} using the fast solvency checker | alert threshold: ${depositConsumedPctThreshold}% deposit consumed`);

    try {
        // Retrieve critical accounts
        const criticalAccounts = await getCriticalAccounts(networkName);

        // Set Prometheus metrics
        totalCriticalMetric.set(criticalAccounts.length);
        totalSkippedMetric.set(totalPotentiallyCriticalMetric.get() - criticalAccounts.length);

        // Log critical accounts and metrics
        if (criticalAccounts.length === 0) {
            console.log(`No critical accounts hitting the deposit consumed threshold`);
        } else {
            criticalAccounts.forEach(account => {
                console.log(`Deposit consumed percentage for account ${account.account.id}: ${account.depositConsumedPct}%`);
            });

            console.warn(`:rotating_light: <!channel> ${networkName}: NEGATIVE ACCOUNTS DETECTED! They might be still within liquidation period.`);
        }

        console.log(`Total potentially critical accounts: ${totalPotentiallyCriticalMetric.get()}`);
        console.log(`Total critical accounts: ${totalCriticalMetric.get()}`);
        console.log(`Total skipped accounts: ${totalSkippedMetric.get()}`);
    } catch (error) {
        console.error(error.message);
    }
}

// Execute script every 1 minute
setInterval(executeScript, 60000);
