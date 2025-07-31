// Import ethers and other necessary modules
const { ethers } = require("ethers");
const sfSubgraph = require("./superfluid-subgraph");
const sfMeta = require("@superfluid-finance/metadata");
const SuperfluidABI = require("@superfluid-finance/js-sdk/src/abi");
//const MAX_PARALLEL_REQUESTS = process.env.MAX_PARALLEL_REQUESTS || 10;

const depositConsumedPctThreshold = process.env.DEPOSIT_CONSUMED_PCT_THRESHOLD !== undefined ? Number(process.env.DEPOSIT_CONSUMED_PCT_THRESHOLD) : 30;
const debtUSDWarnThreshold = process.env.DEBT_USD_WARN_THRESHOLD !== undefined ? Number(process.env.DEBT_USD_WARN_THRESHOLD) : 2;
const streamCloserUrl = process.env.STREAM_CLOSER_URL || "https://cloudflare-ipfs.com/ipns/k2k4r8mh72qtu8510x7okj8c78nijugxr53edj7nxs8yecqy7zlyh4rz/stream-closer.html";

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

function debugLog(msg) {
    if (process.env.DEBUG) {
        infoLog(msg);
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

/*
Return the token price as BigInt in 
we have an api for getting token prices. Example call:
curl https://token-prices-api.superfluid.dev/v1/base-mainnet/0x46fd5cfB4c12D87acD3a13e92BAa53240C661D93
{"price":2607.99,"last_updated":"2025-05-16T09:41:43.599Z"}
This function shall get the price form the api and cache it locally (just in memory)
If a price is in the cache, return it. Otherwise, get it from the api and cache it.
*/
const TOKEN_PRICES_API_URL_BASE = "https://token-prices-api.superfluid.dev/v1";
// Cache for both completed prices and pending promises
const tokenPriceCache = {};

// returns the price as BigInt in micro USD
async function getTokenPrice(networkName, tokenId) {
    const cacheKey = `${networkName}-${tokenId}`;
    
    // Return the cached value or pending promise if it exists
    if (tokenPriceCache[cacheKey] !== undefined) {
        debugLog(`Using cached result for ${cacheKey}`);
        return tokenPriceCache[cacheKey];
    }

    // Create and cache the promise for this request
    debugLog(`Initiating fetch for token price ${cacheKey}`);
    tokenPriceCache[cacheKey] = fetch(`${TOKEN_PRICES_API_URL_BASE}/${networkName}/${tokenId}`)
        .then(response => response.json())
        .then(data => {
            // Check if we have price data
            if (!data || data.price === undefined) {
                debugLog(`Missing price data for ${cacheKey}: ${JSON.stringify(data)}`);
                // Store null in cache to prevent retries
                tokenPriceCache[cacheKey] = null;
                return null;
            }
            
            // Convert to BigInt (price in micro USD)
            const microUsdPrice = BigInt(Math.floor(data.price * 1000000));
            tokenPriceCache[cacheKey] = microUsdPrice;
            debugLog(`Token price for ${cacheKey} fetched: ${data.price} (${microUsdPrice} microUSD)`);
            return microUsdPrice;
        })
        .catch(error => {
            // Store null in cache to prevent retries
            debugLog(`Error fetching token price for ${cacheKey}: ${error.message}`);
            tokenPriceCache[cacheKey] = null;
            return null;
        });

    return tokenPriceCache[cacheKey];
}

async function getCriticalAccounts(networkName, config = undefined) {
    const network = sfMeta.getNetworkByName(networkName);
    if (!network) {
        throw new Error(`Unknown network ${networkName}`);
    }

    if (network.contractsV1.gdaV1) {
        debugLog(`network with GDA at ${network.contractsV1.gdaV1}`);
    }

    const subgraphUrl = config?.subgraphUrl || `https://${network.name}.subgraph.x.superfluid.dev`;
    const rpcUrl = config?.rpcUrl || `https://${network.name}.rpc.x.superfluid.dev?app=fast-solvency-checker`;
    infoLog(`Using subgraph ${subgraphUrl}, rpc ${rpcUrl}`);

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    sfSubgraph.init(subgraphUrl);

    const now = Math.floor(Date.now() / 1000);
    // get accounts with net negative flowrate and which may be critical now according to subgraph accounting
    const maybeCriticalAccounts = await sfSubgraph.getAccountsCriticalAt(now);
    debugLog(`Found ${maybeCriticalAccounts.length} potentially critical accounts`);

    // now get those actually critical by checking their state via RPC
    // this closure takes a maybeCriticalAccount (mca) object and queries its on-chain state.
    // it returns null if the account is not critical, otherwise it returns the mca object with on-chain state added
    const getEnrichedAccountStateIfCritical = async (mca) => {
        const { critical, insolvent, availableBalance, deposit } = await getAccountStatusFromRpc(provider, mca.token.id, mca.account.id);
        if (availableBalance >= 0n || deposit === 0n) {
            debugLog(`  solvent acc ${mca.account.id} has positive balance or no deposit (flows), skipping...`);
            return null;
        }
        const depositConsumedPct = Number(-availableBalance * 100n / deposit);
        //const tokenPrice = tokenPrices[networkName]?.[mca.token.id];
        //const tokenPrice = tokenPrices[networkName]?.[mca.token.id];
        const tokenPrice = await getTokenPrice(networkName, mca.token.id);
        const availableBalanceUSD = tokenPrice ? Number(availableBalance * BigInt(tokenPrice) / 1000000000000000000n) / 1000000 : undefined;

        debugLog(`  critical acc ${mca.account.id}, token ${mca.token.id} (${mca.token.symbol}): balance ${ethers.formatEther(availableBalance)}, deposit ${ethers.formatEther(deposit)} (${depositConsumedPct}% consumed) |${mca.isLiquidationEstimateOptimistic ? " optimistic" : ""} ${critical ? "critical" : ""} ${insolvent ? "insolvent" : ""}`);

        if (depositConsumedPct < depositConsumedPctThreshold) {
            debugLog(`  acc ${mca.account.id} deposit consumed ${depositConsumedPct}% below threshold ${depositConsumedPctThreshold}, skipping...`);
            return null;
        }

        return {
            ...mca,
            availableBalance,
            availableBalanceUSD,
            deposit,
            // deposit consumed percentage, as Number
            depositConsumedPct,
            debtUSD: Math.floor(depositConsumedPct < 100 ? 0 : -availableBalanceUSD * (depositConsumedPct - 100)) / 100
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
    const network = sfMeta.getNetworkByName(networkName);

    function formatNumber(num, digits) {
        return parseFloat(num).toFixed(digits);
    }

    (async () => {
        try {
            infoLog(`Checking ${networkName} using the fast solvency checker | alert threshold: ${depositConsumedPctThreshold}% deposit consumed`);

            const criticalAccounts = await getCriticalAccounts(networkName);

            if (criticalAccounts.length === 0) {
                infoLog(`No critical accounts hitting the deposit consumed threshold`);
            } else {
                let nrCfaFlows = 0;
                let nrGdaFlows = 0;
                let nrAlertAccs = 0;
                for (const acc of criticalAccounts) {
                    let extraInfo = "";
                    const cfaFlows = await sfSubgraph.getAllOutFlows(acc.token.id, acc.account.id);
                    const gdaFlows = await sfSubgraph.getAllOutFlowDistributions(acc.token.id, acc.account.id);
                    nrCfaFlows += cfaFlows.length;
                    nrGdaFlows += gdaFlows.length;
                    if (process.env.PRINT_CFA_FLOWS_CSV) {
                        console.log("token,sender,receiver");
                        for (const flow of cfaFlows) {
                            console.log(`${flow.split("-")[2]},${flow.split("-")[0]},${flow.split("-")[1]}`);
                        }
                    }
                    if (process.env.PRINT_CFA_FLOWS_LINKS) {
                        const cfaCloseLinks = cfaFlows.map(f => f.split("-")[1]) // get the receiver from the id
                            .map(receiver => `${streamCloserUrl}?chainId=${network.chainId}&token=${acc.token.id}&sender=${acc.account.id}&receiver=${receiver}`);
                        extraInfo += cfaCloseLinks.map((link, i) => `<${link}|Close${i+1}>`).join(", ");
                    }
                    if (acc.availableBalanceUSD !== undefined) {
                        // assumption: if we have a price, we only need the token symbol, not address
                        const logStr = `token ${acc.token.symbol}, account ${acc.account.id}: balance ${formatNumber(ethers.formatEther(acc.availableBalance), 8)} (${acc.availableBalanceUSD}$), ${acc.depositConsumedPct}% deposit consumed, ${cfaFlows.length} CFAFlows, ${gdaFlows.length} GDAFlows` + (acc.debtUSD > 0 ? `, ${acc.debtUSD}$ debt` : "")  + (extraInfo !== "" ? ` | ${extraInfo}` : "");
                        // warn if more debt than configured is accumulated, or negative balance exceeds 10x that, or 10x+ of the deposit is consumed
                        if (acc.debtUSD > debtUSDWarnThreshold || acc.availableBalanceUSD < -debtUSDWarnThreshold*10 || acc.depositConsumedPct >= 1000) {
                            warnLog(logStr);
                            if (acc.token.isListed) {
                                nrAlertAccs++;
                            }
                        } else {
                            debugLog(logStr);
                        }
                    } else {
                        warnLog(`token ${acc.token.isListed ? "" : "(unlisted) "}${acc.token.id} (${acc.token.symbol}), account ${acc.account.id}: balance ${formatNumber(ethers.formatEther(acc.availableBalance), 8)}, deposit ${formatNumber(ethers.formatEther(acc.deposit), 8)} (${acc.depositConsumedPct}%) consumed), ${cfaFlows.length} CFAFlows, ${gdaFlows.length} GDAFlows` + (extraInfo !== "" ? ` | ${extraInfo}` : ""));
                        if (acc.token.isListed) {
                            nrAlertAccs++; // we don't know the value of the deposit, so err on the safe side and trigger an alert
                        }
                    }
                }

                warnLog(`${networkName}: ${criticalAccounts.length} negative accounts detected with a total of ${nrCfaFlows} CFA outflows and ${nrGdaFlows} GDA outflowdistributions.`);
                if (nrAlertAccs > 0) {
                    warnLog(`:rotating_light: <!channel> ${nrAlertAccs} accounts met alarm conditions: debt > ${debtUSDWarnThreshold}$ or negative balance > ${10*debtUSDWarnThreshold}$ or > 10x buffer consumed.`);
                }
            }
        } catch (error) {
            console.error(error.message);
        }
    })();
}
