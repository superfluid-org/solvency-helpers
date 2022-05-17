const togaABI = require("./abis/TOGA.json");
const Web3 = require("web3");
const axios = require("axios");
const { wad4human, toBN } = require("@decentral.ee/web3-helpers");
const sfMeta = require("superfluid-metadata");


async function getSuperTokens(graphAPI) {
    const query = `query MyQuery {
  tokens(where: {isSuperToken: true}) {
    name
    symbol
    isSuperToken
    isListed
    id
  }
}`;
    const res = await axios.post(graphAPI, { query });

    if (res.status !== 200 || res.data.errors) {
        console.error(res.data);
        process.exit(1);
    }

    return res.data.data.tokens;
}

(async () => {
    const networkName = process.env.NETWORK_NAME;
    const network = sfMeta.getNetworkByName(networkName);
    const rpcUrl = `http://${network.name}.web3-infra.superfluid.dev`;

    const web3 = new Web3(rpcUrl);
    const toga = new web3.eth.Contract(togaABI, network.contractsV1.toga);
    const tblPIC = [];
    const tblNoPIC = [];
    const superTokens = await getSuperTokens(network.subgraphV1.hostedEndpoint);

    for (let i = 0; i < superTokens.length; i++) {
        try {
            const picInfo = await toga.methods.getCurrentPICInfo(superTokens[i].id).call();
            if(picInfo.bond !== '0' || picInfo.pic !== "0x0000000000000000000000000000000000000000") {
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

