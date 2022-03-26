const fs = require("fs");
const async = require("async");
const Web3 = require("web3");
const SuperfluidABI = require("@superfluid-finance/js-sdk/src/abi");
const { asleep, selectNetwork, getAllSuperTokens, getAllAccounts, getAllOutFlows } = require("./superfluid-subgraph");
const { toWad, wad4human } = require("@decentral.ee/web3-helpers");
const printf = require("printf");

// for using in a bash script which forwards to a Slack hook:
/*
for n in xdai matic; do
    curl -s -X POST -H 'Content-type: application/json' --data "$(NETWORK_NAME=$n node solvency-checker.js | jq -MRn '[inputs] | { "text": join("\n") }')" $SLACK_WEBHOOK -o /dev/null
done
*/

const MAX_REQUESTS = process.env.MAX_REQUESTS || 200;
const RPC_DRIFT_WARN_THRESHOLD = process.env.RPC_DRIFT_WARN_THRESHOLD || 900; // seconds
const SENTINEL_ACCOUNT = process.env.SENTINEL_ACCOUNT; // optional
const STREAM_CLOSER_URL = process.env.STREAM_CLOSER_URL || "https://ipfs.io/ipfs/QmQjpDNp7NDkvckmbEKkQdzPs4HLKD8r1TjGx472ge6azn/stream-closer.html";
const CACHE_FILE_PREFIX=`./cache/${process.env.NETWORK_NAME}.${Math.floor(Date.now() / 1000)}`;

let triggerAlert = false;
let errExists = false;
let nrAccs = 0;
let nrAccsWithNegFlow = 0;
let nrAccsCritical = 0;
let nrAccsP1 = 0; // in patrician period
let nrAccsInsolvent = 0;

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
        const outFlows = await getAllOutFlows(account);
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
    const network = selectNetwork(process.env.NETWORK_NAME);
    const reportCriticalAfter = process.env.REPORT_CRITIAL_AFTER || 600; // seconds

    const superTokens = await getAllSuperTokens();
    fs.writeFileSync(`${CACHE_FILE_PREFIX}.tokens.json`, JSON.stringify(superTokens, null, 2));
    console.log(`Checking ${superTokens.length} ${process.env.NETWORK_NAME} tokens… (RPC: ${network.web3ProviderUrl})`);
    const web3 = new Web3(network.web3ProviderUrl);
    
    // check chain/RPC health
    const chainId = await web3.eth.getChainId();
    const curBlockNr = await web3.eth.getBlockNumber();
    const curBlock = await web3.eth.getBlock(curBlockNr);
    const rpcDriftS = Math.floor(Date.now() / 1000) - curBlock.timestamp;
    console.log(`last block: ${curBlock.number}, RPC drift: ${rpcDriftS} s ${rpcDriftS > RPC_DRIFT_WARN_THRESHOLD ? "<- :rotating_light: <!channel>" : ""}`);
    
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
            const accounts = await getAllAccounts(superTokens[i]);
            fs.writeFileSync(`${CACHE_FILE_PREFIX}.${superTokens[i]}.accounts.json`, JSON.stringify(accounts, null, 2));
            nrAccs += accounts.length;
            const cfa = new web3.eth.Contract(SuperfluidABI.IConstantFlowAgreementV1, network.cfaAddress);
            // skip wrong host version tokens
            if ((await superToken.methods.getHost().call()).toLowerCase() !== network.hostAddress.toLowerCase()) continue;
            const accountStates = (await async.mapLimit(accounts, MAX_REQUESTS, async (account) => {
                try {
                    const rtb = await superToken.methods.realtimeBalanceOfNow(account).call();
                    const availBalBN = web3.utils.toBN(rtb.availableBalance);
                    const netFlow = web3.utils.toBN(await cfa.methods.getNetFlow(superTokens[i], account).call());
                    let pppPeriod = 2; // default plebs
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
                        pppPeriod
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

            const badAccountStates = accountStates.filter(account => account.criticalForSeconds > reportCriticalAfter && account.pppPeriod > 1);
            if (badAccountStates.length > 0) {
                console.log(`Negative accounts for token ${symbol} (${superTokens[i]}) for longer than ${reportCriticalAfter} seconds outside patrician period`);
                
                const closeLinks = await Promise.all(badAccountStates.map(async (a) => await getCloseLinks(chainId, superTokens[i], a.account)));
                
                console.log(badAccountStates.map(a => {
                    const closeLinksStr = closeLinks
                        .map((link, i) => `<${link}|Close${i+1}>`).join(", ");
                    return `  acc ${a.account}, availableBalance ${a.availableBalance / 1e18}, pppPeriod ${pppPeriodName(a.pppPeriod)}, critical for ${a.criticalFor} | ${closeLinksStr}`
                }));
                triggerAlert = true;
            }

            await asleep(1000);
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
    console.log(`Checked ${superTokens.length} tokens, ${nrAccs} accs, ${nrAccsWithNegFlow} w neg flowrate, ${nrAccsCritical} critical (of which ${nrAccsP1} in patrician period), ${nrAccsInsolvent} insolvent`);

    if (triggerAlert) {
        console.log(`:rotating_light: <!channel> ${process.env.NETWORK_NAME}: NEGATIVE ACCOUNTS DETECTED! They might be still with-in liquidation period.`);
    } else {
        console.log(`${errExists ? ":warning:" : ":white_check_mark:"} ${process.env.NETWORK_NAME}: No neg. accs detected`);
    }
})();

