const togaABI = require("./abis/TOGA.json");
const Web3 = require("web3");
const axios = require("axios");
const { wad4human, toBN } = require("@decentral.ee/web3-helpers");
const sfMetaPromise = import("@superfluid-finance/metadata");
const sfSubgraph = require("./superfluid-subgraph");

(async () => {
    const sfMeta = (await sfMetaPromise).default;

    const networkName = process.env.NETWORK_NAME;
    const network = sfMeta.getNetworkByName(networkName);
    if (network === undefined) {
        console.error(`ERR: network ${NETWORK_NAME} not found in metadata. Check value of env var NETWORK_NAME`);
        process.exit(1);
    }

    const rpcUrl = `https://${network.name}.rpc.x.superfluid.dev?app=toga-checker`;
    const subgraphUrl = `https://${network.name}.subgraph.x.superfluid.dev?app=toga-checker`;
    sfSubgraph.init(subgraphUrl);

    const web3 = new Web3(rpcUrl);
    const toga = new web3.eth.Contract(togaABI, network.contractsV1.toga);
    const tblPIC = [];
    const tblNoPIC = [];

    const superTokens = await sfSubgraph.getAllSuperTokensExtended(!(process.env.INCLUDE_UNLISTED === "true"));

    for (let i = 0; i < superTokens.length; i++) {
        try {
            const picInfo = await toga.methods.getCurrentPICInfo(superTokens[i].id).call();
            if(process.env.ALL_TOKENS || picInfo.bond !== '0' || picInfo.pic !== "0x0000000000000000000000000000000000000000") {
                tblPIC.push({
                    name: superTokens[i].name,
                    symbol: superTokens[i].symbol,
                    PIC: picInfo.pic,
                    Bond: wad4human(picInfo.bond),
                    ExitRatePerDay: wad4human(toBN(picInfo.exitRate).mul(toBN(3600 * 24)))
                });
            } else {
                tblNoPIC.push({
                    name: superTokens[i].name,
                    symbol: superTokens[i].symbol,
                })
            }
        } catch(err) {
            console.error(err);
        }
    }
    console.log(`Network: ${networkName} - TOGAv2`);
    console.log('```');
    console.table(tblPIC, ["name", "symbol", "PIC", "Bond", "ExitRatePerDay"]);
    console.log('```');
})();

