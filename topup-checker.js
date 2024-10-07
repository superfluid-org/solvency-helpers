// checks the funding status of the accounts listed in WATCHLIST_FILE, prints a report and triggers and alert if sender solvency is < MIN_RUNWAY_H
// mandatory env: NETWORK_NAME, WATCHLIST_FILE
// optional env: MIN_RUNWAY_H

const { ethers } = require("ethers");
const { wad4human } = require("@decentral.ee/web3-helpers");
const ISuperfluidAbi = require("./abis/ISuperfluid.json");
const ICFAv1 = require("./abis/ICFAv1.json");
const IGDAv1 = require("./abis/GDAv1.json");
const IERC20 = require("./abis/IERC20.json");
const sfMeta = require("@superfluid-finance/metadata");

const minRunwayS = process.env.MIN_RUNWAY*3600 || 24*3600;

(async () => {

    // SETUP

    const network = sfMeta.getNetworkByName(process.env.NETWORK_NAME);
    if(network === undefined) {
        console.error(`unknown/unsupported network: ${process.env.NETWORK_NAME}`);
        process.exit(1);
    }
    if (process.env.WATCHLIST_FILE === undefined) {
        console.error("missing env var WATCHLIST_FILE");
        process.exit(1);
    }
    const watchList = require(`./${process.env.WATCHLIST_FILE}`);

    const rpc = `https://${network.name}.rpc.x.superfluid.dev`;
    const provider = new ethers.JsonRpcProvider(rpc);

    const host = new ethers.Contract(network.contractsV1.host, ISuperfluidAbi, provider);
    const cfaAddr = await host.getAgreementClass(ethers.keccak256(
        ethers.toUtf8Bytes("org.superfluid-finance.agreements.ConstantFlowAgreement.v1")));
    const cfa = new ethers.Contract(cfaAddr, ICFAv1, provider);
    const gdaAddr = await host.getAgreementClass(ethers.keccak256(
        ethers.toUtf8Bytes("org.superfluid-finance.agreements.GeneralDistributionAgreement.v1")));
    const gda = new ethers.Contract(gdaAddr, IGDAv1, provider);

    // ======

    const symbolCache = {};
    const table = [];
    let raiseAlarm = false;

    for(const item of watchList) {
        //console.log(`processing ${item.superToken}, ${item.account}...`);

        token = new ethers.Contract(item.superToken, IERC20, provider);

        const tokenSymbol = symbolCache[token.address] || await token.symbol();
        symbolCache[token.address] = tokenSymbol;

        const bal = await token.balanceOf(item.account);

        const cfaNetFlow = await cfa.getNetFlow(item.superToken, item.account);
        const gdaNetFlow = await gda.getNetFlow(item.superToken, item.account);
        console.log(`cfaNetFlow: ${cfaNetFlow.toString()}`);
        console.log(`gdaNetFlow: ${gdaNetFlow.toString()}`);
        const netFlow = cfaNetFlow + gdaNetFlow;
        console.log(`netFlow: ${netFlow.toString()}`);

        const runWayS = netFlow === 0n ? undefined : bal / -netFlow;

        table.push({
            Account: item.account,
            Token: tokenSymbol,
            Balance: wad4human(bal),
            CFANetFlowDaily: wad4human(cfaNetFlow * 86400n),
            GDANetFlowDaily: wad4human(gdaNetFlow * 86400n),
            TotalNetFlowDaily: wad4human(netFlow * 86400n),
            RunWayHours: netFlow >= 0n ? '∞' : (runWayS / 3600n).toString()
        });
        raiseAlarm = raiseAlarm || (netFlow < 0n && runWayS < minRunwayS);
    }
    console.log(`Network: ${network.name} - top-up checker`);
    console.log('```');
    console.table(table, ["Account", "Token", "Balance", "CFANetFlowDaily", "GDANetFlowDaily", "TotalNetFlowDaily", "RunWayHours"]);
    console.log('```');

    if(raiseAlarm) {
        console.log(`:rotating_light: <!channel> account with insufficient runway (< ${minRunwayS / 3600}h) detected.`);
    }
})();
