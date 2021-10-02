const async = require("async");
const Web3 = require("web3");
const SuperfluidABI = require("@superfluid-finance/js-sdk/src/abi");
const { asleep, selectNetwork, getAllSuperTokens, getAllAccounts } = require("./superfluid-subgraph");

const MAX_REQUESTS = 200;

let negativeExists = false;

(async () => {
    console.log("```");
    const network = selectNetwork(process.env.NETWORK_NAME);
    const superTokens = await getAllSuperTokens();
    console.log("Number of Super Tokens", superTokens.length);
    const web3 = new Web3(network.web3ProviderUrl);
    const block = await web3.eth.getBlock("latest");
    for (let i = 0; i < superTokens.length; ++i) {
        console.log("---");
        const superToken = new web3.eth.Contract(SuperfluidABI.ISuperToken, superTokens[i]);
        const symbol = await superToken.methods.symbol().call();
        const totalSupply = await superToken.methods.totalSupply().call();
        console.log("Super Token", symbol, superToken._address);
        const accounts = await getAllAccounts(superTokens[i]);
        console.log("Number of Accounts", accounts.length);
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
        if (negativeBalances.length > 0) {
            console.log(`Negative account for token ${symbol} (${superTokens[i]})`);
            console.log(negativeBalances);
            negativeExists = true;
        }
        console.log("Reward account balance", rewardAddressBalance.availableBalance / 1e18);
        console.log("Balances sum", balancesSum.toString() / 1e18);
        console.log("Total supply", totalSupply.toString() / 1e18);
        await asleep(1000);
    }
    console.log("```");

    if (negativeExists) {
        console.log(":warning: <!channel> NEGATIVE ACCOUNTS DETECTED! They might be still with-in liquidation period.");
    } else {
        console.log(":white_check_mark: No negative accounts detected.");
    }
})();

