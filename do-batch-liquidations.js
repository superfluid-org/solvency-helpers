/*
* CAUTION!
* This script is currently broken.
* TODO: fix or remove
*/

require("dotenv").config();
const axios = require("axios");
const async = require("async");
const Web3 = require("web3");
const SuperfluidABI = require("@superfluid-finance/js-sdk/src/abi");
const SuperfluidSDK = require("@superfluid-finance/js-sdk");
const HDWalletProvider = require("@truffle/hdwallet-provider");
const TruffleContract = require("@truffle/contract");

const { asleep, selectNetwork, getAllSuperTokens, getAllAccountsForToken, getAllOutFlows } = require("./superfluid-subgraph");

const MAX_REQUESTS = 200;
const BATCH_LIQUIDATOR = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "host",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "cfa",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "superToken",
        "type": "address"
      },
      {
        "internalType": "address[]",
        "name": "senders",
        "type": "address[]"
      },
      {
        "internalType": "address[]",
        "name": "receivers",
        "type": "address[]"
      }
    ],
    "name": "deleteFlows",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

(async () => {
    const network = selectNetwork(process.env.NETWORK_NAME);

    //const web3 = new Web3(network.web3ProviderUrl);
    const web3Provider = new HDWalletProvider(
        process.env.AGENT_MNEMONIC,
        network.web3ProviderUrl,
        parseInt(process.env.ACCOUNT_INDEX) || 0,
        1,
        true);
    try {
        const web3 = new Web3(web3Provider);
        const web3Accounts = await web3.eth.getAccounts();
        const BatchLiquidator = TruffleContract({
            abi: BATCH_LIQUIDATOR
        });
        BatchLiquidator.setProvider(web3Provider);  
        const batchLiquidator = await BatchLiquidator.at(network.batchLiquidatorAddress);

        console.log("Agent account", web3Accounts[0]);
        console.log("Batch liquidator", batchLiquidator.address);

        const sf = new SuperfluidSDK.Framework({ version: "v1", web3 });
        await sf.initialize();

        const block = await web3.eth.getBlock("latest");

        const superTokens = await getAllSuperTokens();
        console.log("Number of Super Tokens", superTokens.length);
        for (let i = 0; i < superTokens.length; ++i) {
            console.log("---");
            const superToken = new web3.eth.Contract(SuperfluidABI.ISuperToken, superTokens[i]);
            const symbol = await superToken.methods.symbol().call();
            const totalSupply = await superToken.methods.totalSupply().call();
            console.log("Super Token", symbol, superToken._address);
            const accounts = await getAllAccountsForToken(superTokens[i]);
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
            }))
            const negativeBalances = balances.filter(account => web3.utils.toBN(account.availableBalance).ltn(0));
            const rewardAddressBalance = await superToken.methods.realtimeBalanceOf(network.rewardAddress, block.timestamp).call(block.number);
            balances.push({
                account: network.rewardAddress,
                availableBalance: web3.utils.toBN(web3.utils.toBN(rewardAddressBalance.availableBalance))
            });
            const balancesSum = balances.reduce((acc, cur) => {
                return acc.add(web3.utils.toBN(cur.availableBalance));
            }, web3.utils.toBN(0));
            console.log("Number of negative accounts", negativeBalances.length);
            const senders = [];
            const receivers = []
            const deleteFlows = async () => {
                if (senders.length === 0) return;
                console.log("Senders");
                console.log(`[${senders.join(",")}]`);
                console.log("Receivers");
                console.log(`[${receivers.join(",")}]`);
                console.log("Batch liquidating...");
                const tx = await batchLiquidator.deleteFlows(
                    sf.host.address,
                    sf.agreements.cfa.address,
                    superTokens[i],
                    senders,
                    receivers, {
                        from: web3Accounts[0],
                        gasPrice: 30e9
                    }
                );
                console.log("Batch liquidated", tx);
                senders.splice(0, senders.length);
                receivers.splice(0, receivers.length);
            }
            if (negativeBalances.length > 0) {
                for (let j = 0; j < negativeBalances.length; ++j) {
                    const sender = negativeBalances[j].account;
                    const recipients = await getAllOutFlows(sender);
                    for (let k = 0; k < recipients.length; ++k) {
                        senders.push(`${sender}`);
                        receivers.push(`${recipients[k]}`);
                        if (senders.length >= 50) {
                            await deleteFlows();
                        }
                    }
                }
                await deleteFlows();
            }
        }
        await asleep(1000);
    } catch (e) {
        console.error("Error caught", e);
    }

    web3Provider.engine.stop();
})();
