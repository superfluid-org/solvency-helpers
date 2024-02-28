// Import ethers and other necessary modules
const express = require('express');
const { ethers } = require("ethers");
const sfSubgraph = require("./superfluid-subgraph");
const sfMeta = require("@superfluid-finance/metadata");
const SuperfluidABI = require("@superfluid-finance/js-sdk/src/abi");
//const MAX_PARALLEL_REQUESTS = process.env.MAX_PARALLEL_REQUESTS || 10;
const { register } = require('prom-client');
const promClient = require('prom-client');
const fs = require('fs');

// Create an Express app
const app = express();


// Constants
const depositConsumedPctThreshold = process.env.DEPOSIT_CONSUMED_PCT_THRESHOLD !== undefined ? Number(process.env.DEPOSIT_CONSUMED_PCT_THRESHOLD) : 20;
const PORT = process.env.PORT || 3000;

// Read the JSON file containing network names and configurations
const networksConfig = JSON.parse(fs.readFileSync('networks.json', 'utf8'));

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

async function getCriticalAccounts(networkName, config = undefined) {
    // Try block so errors from subgraph/rpcs won't cause exit
    try {
        const network = sfMeta.getNetworkByName(networkName);
        if (!network) {
            throw new Error(`Unknown network ${networkName}`);
        }

        if (network.contractsV1.gdaV1) {
            infoLog(`Network with GDA at ${network.contractsV1.gdaV1}`);
        }

        const subgraphUrl = config?.subgraphUrl || `https://${network.name}.subgraph.x.superfluid.dev`;
        const rpcUrl = config?.rpcUrl || `https://${network.name}.rpc.x.superfluid.dev?app=fast-solvency-checker`;
        infoLog(`Using subgraph ${subgraphUrl}, rpc ${rpcUrl}`);

        const provider = new ethers.JsonRpcProvider(rpcUrl);

        sfSubgraph.init(subgraphUrl);

        const now = Math.floor(Date.now() / 1000);
        const maybeCriticalAccounts = await sfSubgraph.getAccountsCriticalAt(now);
        infoLog(`Found ${maybeCriticalAccounts.length} potentially critical accounts`);

        // Define an array to store critical accounts
        const criticalAccounts = [];

        // now get those actually critical by checking their state via RPC
        // this closure takes a maybeCriticalAccount (mca) object and queries its on-chain state.
        // it returns null if the account is not critical, otherwise it returns the mca object with on-chain state added
        const getEnrichedAccountStateIfCritical = async (mca) => {
            try {
                const { critical, insolvent, availableBalance, deposit } = await getAccountStatusFromRpc(provider, mca.token.id, mca.account.id);
                infoLog(`Account ${mca.account.id}, Token ${mca.token.id} (${mca.token.symbol}): Balance ${ethers.formatEther(availableBalance)}, Deposit ${ethers.formatEther(deposit)} |${mca.isLiquidationEstimateOptimistic ? " optimistic" : ""} ${critical ? "critical" : ""} ${insolvent ? "insolvent" : ""}`);

                if (availableBalance >= 0n || deposit === 0n) {
                    infoLog(`Account ${mca.account.id} has a positive balance or no deposit, skipping...`);
                    return;
                }

                if (insolvent) {
                    insolventMetric.inc({ network: networkName, service: 'solvency-checker' });
                }
        
                // Update deposit consumed percentage histogram
                depositConsumedPctHistogram.observe({ network: networkName, service: 'solvency-checker' }, Number(availableBalance * 100n / deposit));

                const depositConsumedPct = Number(availableBalance * 100n / deposit);
                if (depositConsumedPct < depositConsumedPctThreshold) {
                    infoLog(`Account ${mca.account.id} deposit consumed ${depositConsumedPct}% below threshold ${depositConsumedPctThreshold}, skipping...`);
                    return;
                }

                // Add critical account to the array
                criticalAccounts.push({
                    ...mca,
                    availableBalance,
                    deposit,
                    // deposit consumed percentage, as Number
                    depositConsumedPct: Number(availableBalance * 100n / deposit)
                });
            } catch (error) {
                console.error(`Error processing account ${mca.account.id}:`, error.message);
            }
        };

        // TODO: add throttling to avoid overloading the RPC if the number of candidates gets large
        await Promise.all(maybeCriticalAccounts.map(getEnrichedAccountStateIfCritical));

        return criticalAccounts;
    } catch (error) {
        console.error(`Error fetching critical accounts for ${networkName}:`, error.message);
        return []; // Return an empty array if an error occurs
    }
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
const totalCriticalMetric = new promClient.Gauge({
    name: 'nr_critical_accounts',
    help: 'Total critical accounts detected during the script execution',
    labelNames: ['network', 'service'] // Added labels
});

const insolventMetric = new promClient.Gauge({
    name: 'nr_insolvent_accounts',
    help: 'Total number of accounts detected as insolvent during the script execution',
    labelNames: ['network', 'service'] // labels
});

const depositConsumedPctHistogram = new promClient.Histogram({
    name: 'nr_accounts_by_deposit_consumed_pct_histogram',
    help: 'Histogram of deposit consumed percentage for critical accounts',
    labelNames: ['network', 'service'], // labels
    buckets: [-Infinity, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] // bucket ranges
});

// Expose Prometheus metrics endpoint
app.get('/metrics', async (req, res, next) => {
    res.set('Content-Type', register.contentType);
    try {
        const metrics = await register.metrics(); // Wait for the asynchronous operation to complete
        res.end(metrics);
    } catch (error) {
        next(error); // Pass error to the next error handling middleware
    }
});

// Start Express app to listen on the default port
const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Allow script to be run periodically
async function executeScript(networks) {
    // Iterate over the network names
    for (const network of networks) {
        console.log(`Checking ${network}...`);

        // Retrieve critical accounts for the current network
        const criticalAccounts = await getCriticalAccounts(network);

        // Update Prometheus metrics for the current network
        totalCriticalMetric.set({ network, service: "solvency-checker" }, criticalAccounts.length);

        // Log critical accounts and metrics
        if (criticalAccounts.length === 0) {
            console.log(`No critical accounts hitting the deposit consumed threshold for ${network}`);
        } else {
            criticalAccounts.forEach(account => {
                console.log(`Deposit consumed percentage for account ${account.account.id}: ${account.depositConsumedPct}%`);

                // Convert BigInt to number
                const availableBalanceNumber = Number(account.availableBalance);

            });

            console.warn(`:rotating_light: <!channel> ${network}: NEGATIVE ACCOUNTS DETECTED! They might still be within the liquidation period.`);
        }

       // Update insolventMetric based on criticalAccounts
        const insolventCount = criticalAccounts.filter(account => account.insolvent).length;
        insolventMetric.labels(network, 'solvency-checker').inc(insolventCount);

        // Update depositConsumedPctHistogram based on criticalAccounts
        const depositConsumedPcts = criticalAccounts.map(account => account.depositConsumedPct);
        depositConsumedPcts.forEach(depositConsumedPct => {
            depositConsumedPctHistogram.labels(network, 'solvency-checker').observe(depositConsumedPct);
        });

        // Log total critical accounts for the current network
        console.log(`Total critical accounts for ${network}: ${criticalAccounts.length}`);
    }

    // Schedule the next execution
    setTimeout(() => executeScript(networks), 60000);
}

// Extract network names from the JSON file
const networkNames = networksConfig.flatMap(config => Object.keys(config));

// Execute script every 1 minute
setImmediate(() => executeScript(networkNames), 60000);
