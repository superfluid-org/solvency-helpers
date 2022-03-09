const togaABI = require("./abis/TOGA.json");
const Web3 = require("web3");
const axios = require("axios");
const { wad4human, toBN } = require("@decentral.ee/web3-helpers");

/*CONFIGS*/
const NETWORKS = {
    xdai: {
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/protocol-v1-xdai",
        web3ProviderUrl: process.env.XDAI_PROVIDER_URL || "http://xdai-mainnet.web3-infra.superfluid.dev",
        toga: "0xb7DE52F4281a7a276E18C40F94cd93159C4A2d22"
    },
    matic: {
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/protocol-v1-matic",
        web3ProviderUrl: process.env.MATIC_PROVIDER_URL || "http://matic.hetzner-buck-1.web3-infra.superfluid.dev/rpc",
        toga: "0x6AEAeE5Fd4D05A741723D752D30EE4D72690A8f7"
    },
};



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
    //for(networkName in NETWORKS) {
        const web3 = new Web3(NETWORKS[networkName].web3ProviderUrl);
        const toga = new web3.eth.Contract(togaABI, NETWORKS[networkName].toga);
        const tblPIC = []; 
        const tblNoPIC = [];
        const superTokens = await getSuperTokens(NETWORKS[networkName].theGraphQueryUrl);

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
        //console.table(tblNoPIC);
    //} 
})();

