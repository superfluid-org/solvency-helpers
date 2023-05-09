const fs = require("fs");
const async = require("async");
const Web3 = require("web3");
const SuperfluidABI = require("@superfluid-finance/js-sdk/src/abi");
const sfSubgraph = require("./superfluid-subgraph");
const { toWad, wad4human } = require("@decentral.ee/web3-helpers");
const printf = require("printf");
const sfMetaPromise = import("@superfluid-finance/metadata");

// for using in a bash script which forwards to a Slack hook:
/*
for n in xdai matic; do
    curl -s -X POST -H 'Content-type: application/json' --data "$(NETWORK_NAME=$n node solvency-checker.js | jq -MRn '[inputs] | { "text": join("\n") }')" $SLACK_WEBHOOK -o /dev/null
done
*/

const MAX_REQUESTS = process.env.MAX_REQUESTS || 200;
const RPC_DRIFT_WARN_THRESHOLD = process.env.RPC_DRIFT_WARN_THRESHOLD || 900; // seconds
const SENTINEL_ACCOUNT = process.env.SENTINEL_ACCOUNT; // optional
const STREAM_CLOSER_URL = process.env.STREAM_CLOSER_URL || "https://ipfs.io/ipfs/QmRo8TSehXq5Q7Lj4HWAEzrFbcW2hyAHg4Vh7Xszm1Nwp3/stream-closer.html";
const NETWORK_NAME = process.env.NETWORK_NAME;
const CACHE_FILE_PREFIX=`./cache/${NETWORK_NAME}.${Math.floor(Date.now() / 1000)}`;
const TOKEN_ALERT_SKIP_LIST=process.env.TOKEN_ALERT_SKIP_LIST?.split() || [];

/*
How the dust filter works:
If the file exists, we take the flowrate thresholds and interpolate them to 1 year.
That's because we're not iterating through all streams, but through all accounts.
We assume the threshold values to be so low (such that even in 100 years an insolvent stream can't create any systematically meaningful debt)
that ignoring accounts having a debt of less than 1 year of the threshold flowrate is safe.
*/
const THRESHOLDS_FILE="./solvency-thresholds.json"
const DUST_THRESHOLD_FR_MULTIPLIER = 3600 * 24 * 10; // 10 years

let triggerAlert = false;
let errExists = false;
let nrAccs = 0;
let nrAccsWithNegFlow = 0;
let nrAccsCritical = 0;
let nrAccsP1 = 0; // in patrician period
let nrAccsInsolvent = 0;
let nrAccsInsolventBelowThreshold = 0;

function truncateStr (str, maxLen, end = '…')  {
    return str.length() <= maxLen ? str : str.substring(0, maxLen).concat(end);
}

function pppPeriodName(pppPeriodId) {
    switch(pppPeriodId) {
        case 1: return "patrician";
        case 2: return "pleb";
        case 3: return "pirate";
        default: throw "invalid id";
    }
}

// returns an array of links to the stream closer Dapp with params set for specific streams
// falls back to a single link with no receiver set if the graph query for outFlows fails
async function getCloseLinks(chainId, token, account) {
    let closeLinks = [];
    closeLinks[0] = `${STREAM_CLOSER_URL}?chainId=${chainId}&token=${token}&sender=${account}`;

    // if something fails here, we provide a single link without receiver set
    try {
        const outFlows = await sfSubgraph.getAllOutFlows(account);
        const flowReceivers = outFlows
            .filter(f => f.split("-")[2] === token) // only streams for the current token
            .map(f => f.split("-")[1]); // get the receiver from the id

        closeLinks = flowReceivers.map(receiver => `${STREAM_CLOSER_URL}?chainId=${chainId}&token=${token}&sender=${account}&receiver=${receiver}`);
    } catch(e) {
        console.error("getting outFlows failed: ", e);
    }
    return closeLinks;
}

(async () => {
    //console.log("```");

    const sfMeta = (await sfMetaPromise).default;

    const network = sfMeta.getNetworkByName(NETWORK_NAME);
    if (network === undefined) {
        console.error(`ERR: network ${NETWORK_NAME} not found in metadata. Check value of env var NETWORK_NAME`);
        process.exit(1);
    }

    const rpcUrlOverride = process.env[`${network.uppercaseName}_PROVIDER_URL`];
    const rpcUrl = rpcUrlOverride ? rpcUrlOverride : `https://${network.name}.sfrpc.x.superfluid.dev?app=solvency-checker`;
    const reportCriticalAfter = process.env.REPORT_CRITIAL_AFTER || 600; // seconds

    sfSubgraph.init(network.subgraphV1.hostedEndpoint);
    const web3 = new Web3(rpcUrl);

    // patch web3 to count RPC calls
    let rpcRequestCount = 0;
    const originalSend = web3.currentProvider.send;
    web3.currentProvider.send = async function () {
        rpcRequestCount++;
        return originalSend.apply(this, arguments);
    };

    const superTokens = await sfSubgraph.getAllSuperTokens();
    fs.writeFileSync(`${CACHE_FILE_PREFIX}.tokens.json`, JSON.stringify(superTokens, null, 2));
    console.log(`Checking ${superTokens.length} ${NETWORK_NAME} tokens… (RPC: ${rpcUrl})`);
    
    // check chain/RPC health
    const chainId = await web3.eth.getChainId();
    const curBlockNr = await web3.eth.getBlockNumber();
    const curBlock = await web3.eth.getBlock(curBlockNr);
    const rpcDriftS = Math.floor(Date.now() / 1000) - curBlock.timestamp;
    console.log(`last block: ${curBlock.number}, RPC drift: ${rpcDriftS} s ${rpcDriftS > RPC_DRIFT_WARN_THRESHOLD ? "<- :rotating_light: <!channel>" : ""}`);
    
    // returns undefined or an array of `{ address, above }` where `address` is the SuperToken and`above` is a flowrate
    let dustFilter = fs.existsSync(THRESHOLDS_FILE) ? require(THRESHOLDS_FILE).networks[chainId]?.thresholds : undefined;
    if (dustFilter !== undefined) {
        console.log(`using dust filter: ${JSON.stringify(dustFilter)}`);
    }

    // check SF sentinels balances
    if (SENTINEL_ACCOUNT !== undefined) {
        sentinelBal = await web3.eth.getBalance(SENTINEL_ACCOUNT);
        console.log(`sentinel ${SENTINEL_ACCOUNT} balance: ${wad4human(sentinelBal)}`);
    }
    
    let errCnt = 0;
    for (let i = 0; i < superTokens.length; ++i) {
        let innerErrCnt = 0;
        try {
            const superToken = new web3.eth.Contract(SuperfluidABI.ISuperToken, superTokens[i]);
            const symbol = await superToken.methods.symbol().call();
            const totalSupply = await superToken.methods.totalSupply().call();
            const accounts = await sfSubgraph.getAllAccounts(superTokens[i]);
            // 1 year of flowrate
            const warningThresh = parseInt(dustFilter?.filter(e => e.address.toLowerCase() === superTokens[i].toLowerCase())[0]?.above) * 86400 * 365 || 0;

            fs.writeFileSync(`${CACHE_FILE_PREFIX}.${superTokens[i]}.accounts.json`, JSON.stringify(accounts, null, 2));
            nrAccs += accounts.length;
            const cfa = new web3.eth.Contract(SuperfluidABI.IConstantFlowAgreementV1, network.contractsV1.cfaV1);
            // skip wrong host version tokens
            if ((await superToken.methods.getHost().call()).toLowerCase() !== network.contractsV1.host.toLowerCase()) continue;
            const accountStates = (await async.mapLimit(accounts, MAX_REQUESTS, async (account) => {
                try {
                    const rtb = await superToken.methods.realtimeBalanceOfNow(account).call();
                    const availBalBN = web3.utils.toBN(rtb.availableBalance);
                    const netFlow = web3.utils.toBN(await cfa.methods.getNetFlow(superTokens[i], account).call());
                    let pppPeriod = 2; // default plebs
                    let belowWarningThreshold = false; // true suppresses warnings (mute insolvent dust streams)
                    if (netFlow.ltn(0)) {
                        nrAccsWithNegFlow++;
                    }
                    if (availBalBN.ltn(0)) {
                        nrAccsCritical++;
                        // figure out if there's open streams by looking at the deposit
                        if (rtb.deposit !== "0" || rtb.owedDeposit !== "0") {
                            if (await cfa.methods.isPatricianPeriodNow(superTokens[i], account).call()) {
                                pppPeriod = 1;
                                nrAccsP1++;
                            }
                        } // else: critical, but no open agreements which could be liquidated
                        
                        if (! await superToken.methods.isAccountSolventNow(account).call()) {
                            pppPeriod = 3;
                            nrAccsInsolvent++;
                            nrAccsCritical--;
                            if (availBalBN.neg().lt(new web3.utils.BN(String(warningThresh)))) {
                                nrAccsInsolventBelowThreshold++;
                                belowWarningThreshold = true;
                                //console.log(`below threshold: ${account}`);
                            }
                        }
                    }
                    return {
                        account,
                        availableBalance: availBalBN.toString(),
                        criticalForSeconds: parseInt((availBalBN.ltn(0) && netFlow.ltn(0)
                            ? availBalBN.div(netFlow).toString()
                            : "0")),
                        criticalFor: (availBalBN.ltn(0) && netFlow.ltn(0)
                            ? availBalBN.div(netFlow).toString()
                            : "0")/3600 + " hours",
                        pppPeriod,
                        belowWarningThreshold
                    };
                } catch (e) {
                    //console.error(`${symbol} ${account}: ${e}`);
                    innerErrCnt++;
                }
            }));
            fs.writeFileSync(`${CACHE_FILE_PREFIX}.${superTokens[i]}.accountStates.json`, JSON.stringify(accountStates, null, 2));
            if (innerErrCnt > 0) {
                console.log(`ERR: ${symbol}: ${innerErrCnt}/${accounts.length} queries failed`);
                errExists = true;
            }
            
            const balancesSum = accountStates.reduce((acc, cur) => {
                return acc.add(web3.utils.toBN(cur.availableBalance));
            }, web3.utils.toBN(0));

            const badAccountStates = accountStates.filter(
                account => account.criticalForSeconds > reportCriticalAfter
                && account.pppPeriod > 1
                && !account.belowWarningThreshold
            );
            if (badAccountStates.length > 0) {
                console.log(`Negative accounts for token ${symbol} (${superTokens[i]}) for longer than ${reportCriticalAfter} seconds outside patrician period`);
                const outputStr = await Promise.all(badAccountStates.map(async a => {
                    const closeLinks = await getCloseLinks(chainId, superTokens[i], a.account);
                    const closeLinksStr = closeLinks.map((link, i) => `<${link}|Close${i+1}>`).join(", ");
                    return `  acc ${a.account}, availableBalance ${a.availableBalance / 1e18}, pppPeriod ${pppPeriodName(a.pppPeriod)}, critical for ${a.criticalFor} | ${closeLinksStr}`
                }));
                console.log(outputStr);
                triggerAlert = true;
                if (TOKEN_ALERT_SKIP_LIST.some(e => e.toLowerCase() === superTokens[i])) {
                    // token is flagged as not triggering alerts
                    triggerAlert = false;
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (e) {
            console.error(e);
            errCnt++;
        }
    }
    if (errCnt > 0) {
        console.log(`ERR: ${errCnt} non-balance queries failed`);
        errExists = true;
    }
    //console.log("```");
    console.log(`Checked ${superTokens.length} tokens, ${nrAccs} accs, ${nrAccsWithNegFlow} w neg flowrate, ${nrAccsCritical} critical (of which ${nrAccsP1} in patrician period), ${nrAccsInsolvent} insolvent (of which ${nrAccsInsolventBelowThreshold} below threshold) | ${rpcRequestCount} RPC requests made`);

    if (triggerAlert) {
        console.log(`:rotating_light: <!channel> ${NETWORK_NAME}: NEGATIVE ACCOUNTS DETECTED! They might be still with-in liquidation period.`);
    } else {
        console.log(`${errExists ? ":warning:" : ":white_check_mark:"} ${NETWORK_NAME}: No neg. accs detected`);
    }
})();

