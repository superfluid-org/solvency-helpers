const async = require("async");
const Web3 = require("web3");
const SuperfluidABI = require("@superfluid-finance/js-sdk/src/abi");
const { asleep, selectNetwork, getAllSuperTokens, getAllAccounts } = require("./superfluid-subgraph");
const { toWad, wad4human } = require("@decentral.ee/web3-helpers");
const printf = require("printf");

// for using in a bash script which forwards to a Slack hook:
/*
for n in xdai matic; do
    curl -s -X POST -H 'Content-type: application/json' --data "$(NETWORK_NAME=$n node solvency-checker.js | jq -MRn '[inputs] | { "text": join("\n") }')" $SLACK_WEBHOOK -o /dev/null
done
*/

const MAX_REQUESTS = process.env.MAX_REQUESTS || 200;

let negativeExists = false;

function truncateStr (str, maxLen, end = '…')  {
    return str.length() <= maxLen ? str : str.substring(0, maxLen).concat(end);
}

(async () => {
    //console.log("```");
    const network = selectNetwork(process.env.NETWORK_NAME);
    const reportCriticalAfter = process.env.REPORT_CRITIAL_AFTER || 600; // seconds
    
    const superTokens = await getAllSuperTokens();
    console.log(`NETWORK: ${process.env.NETWORK_NAME} - ${superTokens.length} Super Tokens`);
    const web3 = new Web3(network.web3ProviderUrl);
    const block = await web3.eth.getBlock("latest");
    //console.log("\` ------------------------------------------------------------------------------------------------\`")
    console.log("\` TOKEN SYMBOL | NR ACCS | REWARD ACC BAL |   SUM BALANCES   |   TOTAL SUPPLY   | SUPPLY - SUM BAL\`");
    console.log("\` ------------------------------------------------------------------------------------------------\`")
    for (let i = 0; i < superTokens.length; ++i) {
        //console.log("---");
        const superToken = new web3.eth.Contract(SuperfluidABI.ISuperToken, superTokens[i]);
        const symbol = await superToken.methods.symbol().call();
        const totalSupply = await superToken.methods.totalSupply().call();
        //console.log("Super Token", symbol, superToken._address);
        const accounts = await getAllAccounts(superTokens[i]);
        //console.log("Number of Accounts", accounts.length);
        const cfa = new web3.eth.Contract(SuperfluidABI.IConstantFlowAgreementV1, network.cfaAddress);
        // skip wrong host version tokens
        if ((await superToken.methods.getHost().call()).toLowerCase() !== network.hostAddress.toLowerCase()) continue;
        const balances = (await async.mapLimit(accounts, MAX_REQUESTS, async (account) => {
            const rtb = await superToken.methods.realtimeBalanceOf(account, block.timestamp).call(block.number);
            const availableBalance = web3.utils.toBN(rtb.availableBalance);
            const netFlow = web3.utils.toBN(await cfa.methods.getNetFlow(superTokens[i], account).call(block.number));
            return {
                account,
                availableBalance: rtb.availableBalance.toString(),
                criticalForSeconds: parseInt((availableBalance.ltn(0) && netFlow.ltn(0) ? availableBalance.div(netFlow).toString() : "0")),
                criticalFor: (availableBalance.ltn(0) && netFlow.ltn(0) ? availableBalance.div(netFlow).toString() : "0")/3600 + " hours",
            };
        }));
        const negativeBalances = balances.filter(account => web3.utils.toBN(account.availableBalance).ltn(0));
        const rewardAddressBalance = await superToken.methods.realtimeBalanceOf(network.rewardAddress, block.timestamp).call(block.number);
        balances.push({
            account: network.rewardAddress,
            availableBalance: web3.utils.toBN(web3.utils.toBN(rewardAddressBalance.availableBalance))
        });
        const balancesSum = balances.reduce((acc, cur) => {
            return acc.add(web3.utils.toBN(cur.availableBalance));
        }, web3.utils.toBN(0));
        
        // TODO: remove this if the new report format works ok
        if (negativeBalances.length > 0) {
            console.log(`Negative accounts for token ${symbol} (${superTokens[i]})`);
            console.log(negativeBalances);
            negativeExists = true;
        }

        const relevantNegativeBalances = balances.filter(account => account.criticalForSeconds > reportCriticalAfter);
        if (relevantNegativeBalances.length > 0) {
            console.log(`Negative accounts for token ${symbol} (${superTokens[i]}) for longer than ${reportCriticalAfter} seconds`);
            console.log(relevantNegativeBalances.map(a => `\`   acc ${a.account}, availableBalance ${a.availableBalance / 1e18}, critical for ${a.criticalFor}\``));
            negativeExists = true;
        }
        
        const excessSupply = web3.utils.toBN(totalSupply).sub(balancesSum);
        //console.log("Reward account balance", rewardAddressBalance.availableBalance / 1e18);
        //console.log("Balances sum", balancesSum.toString() / 1e18);
        //console.log("Total supply", totalSupply.toString() / 1e18);
        
        console.log(printf("\` %-12s | %7d | %14.3f | %16.0f | %16.0f | %14.3f \`", 
            symbol, 
            accounts.length, 
            rewardAddressBalance.availableBalance / 1e18, 
            balancesSum.toString() / 1e18, 
            totalSupply.toString() / 1e18,
            excessSupply.toString() / 1e18
        ));
        
        await asleep(1000);
    }
    //console.log("```");

    if (negativeExists) {
        console.log(":warning: <!channel> NEGATIVE ACCOUNTS DETECTED! They might be still with-in liquidation period.");
    } else {
        console.log(":white_check_mark: No negative accounts detected.");
    }
})();

