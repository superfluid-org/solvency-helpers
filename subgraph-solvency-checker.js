/*
* usage: <exe> <network>
*/

const sfSubgraph = require("./superfluid-subgraph");
const Web3 = require("web3");
const sfMeta = require("@superfluid-finance/metadata");
const SuperfluidABI = require("@superfluid-finance/js-sdk/src/abi");
const async = require('async');
const MAX_PARALLEL_REQUESTS = process.env.MAX_PARALLEL_REQUESTS || 10;

const NETWORK_NAME = process.argv[2];
if (NETWORK_NAME === undefined) {
    console.error("Usage: node subgraph-solvency-checker.js <network>");
    process.exit(1);
}
const network = sfMeta.getNetworkByName(NETWORK_NAME);
if (network === undefined) {
    console.error(`Unknown network ${NETWORK_NAME}`);
    process.exit(1);
}

if (network.contractsV1.gdaV1) {
    console.log(`network with GDA at ${network.contractsV1.gdaV1}`);
}

const SUBGRAPH_URL = "https://{{NETWORK}}.subgraph.x.superfluid.dev".replace("{{NETWORK}}", NETWORK_NAME);
console.log(`Using subgraph ${SUBGRAPH_URL}`);
const RPC_URL = "https://{{NETWORK}}.rpc.x.superfluid.dev".replace("{{NETWORK}}", NETWORK_NAME);
const web3 = new Web3(RPC_URL);

(async () => {
    sfSubgraph.init(network.subgraphV1.hostedEndpoint);

    //const superTokens = await sfSubgraph.getAllSuperTokens();
    //console.log(`Found ${superTokens.length} super tokens`);

    const now = Math.floor(Date.now() / 1000);
    console.log(`now: ${now}`);

    // gets the accounts which are "maybe critical" now.
    // TODO: what does this "maybe critical" actually mean?
    // How does it change with GDA?
    const maybeCriticalAccounts = await sfSubgraph.getAccountsCriticalAt(now);
    console.log(`Found ${maybeCriticalAccounts.length} critical accounts`);

    const criticalAccounts = await checkMaybeCriticalAccounts(maybeCriticalAccounts);
    console.log(`criticalAccounts: ${JSON.stringify(criticalAccounts, null, 2)}`);
})();

async function checkMaybeCriticalAccounts(maybeCriticalAccounts) {
    // iterate over accs
    const criticalAccounts = (await async.mapLimit(
        maybeCriticalAccounts,
        MAX_PARALLEL_REQUESTS,
        async (mca /* maybeCriticalAccount */) => {
            //console.log(`item: ${JSON.stringify(criticalAccount, null, 2)}`);
            const { critical, insolvent, balance, deposit } = await getAccountStatusFromRpc(mca.token.id, mca.account.id);
            console.log(`acc ${mca.account.id}, token ${mca.token.id} (${mca.token.symbol}): balance ${web3.utils.fromWei(balance)}, deposit ${web3.utils.fromWei(deposit)} |`
                + `${mca.isLiquidationEstimateOptimistic ? " optimistic" : ""} ${critical ? "critical" : ""} ${insolvent ? "insolvent" : ""}`);

            if (balance.lte(web3.utils.toBN(0))) {
                return {
                    ...mca,
                    balance,
                    deposit
                };
            }
        }
    )).filter(Boolean); // filter out empty (undefined) elements

    console.log(`got ${criticalAccounts.length} critical accounts`);
    return criticalAccounts;
}

// returns an object with `balance` and `deposit`, both BNs
async function getAccountStatusFromRpc(superTokenAddr, accountAddr) {
    const superToken = new web3.eth.Contract(SuperfluidABI.ISuperToken, superTokenAddr);
    const isCritical = await superToken.methods.isAccountCriticalNow(accountAddr).call();
    // if not critical, then solvent, else we must check
    const isSolvent = isCritical ? await superToken.methods.isAccountSolventNow(accountAddr).call() : true;
    const rtb = await superToken.methods.realtimeBalanceOfNow(accountAddr).call();
    return {
        critical: isCritical,
        insolvent: !isSolvent,
        balance: web3.utils.toBN(rtb.availableBalance),
        deposit: web3.utils.toBN(rtb.deposit)
    };
}