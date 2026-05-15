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
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
    const tblWithPIC = [];
    const tblNoPIC = [];
    const tblIdle = [];

    const superTokens = await sfSubgraph.getAllSuperTokensExtended(!(process.env.INCLUDE_UNLISTED === "true"));

    for (let i = 0; i < superTokens.length; i++) {
        try {
            const picInfo = await toga.methods.getCurrentPICInfo(superTokens[i].id).call();
            const bondStr = wad4human(picInfo.bond);
            const entry = {
                name: superTokens[i].name,
                symbol: superTokens[i].symbol,
                PIC: picInfo.pic,
                Bond: bondStr,
                ExitRatePerDay: wad4human(toBN(picInfo.exitRate).mul(toBN(3600 * 24))),
                _bondNum: parseFloat(bondStr),
            };
            if (picInfo.pic !== ZERO_ADDR) {
                tblWithPIC.push(entry);
            } else if (picInfo.bond !== '0') {
                tblNoPIC.push(entry);
            } else if (process.env.ALL_TOKENS) {
                tblIdle.push(entry);
            }
        } catch(err) {
            console.error(err);
        }
    }
    tblWithPIC.sort((a, b) => b._bondNum - a._bondNum);
    tblNoPIC.sort((a, b) => b._bondNum - a._bondNum);

    console.log(`Network: ${networkName} — TOGAv2: ${tblWithPIC.length} with PIC, ${tblNoPIC.length} no PIC, ${tblIdle.length} idle`);

    if (tblWithPIC.length > 0) {
        console.log('');
        console.log('With PIC:');
        for (const t of tblWithPIC) {
            const exitPart = parseFloat(t.ExitRatePerDay) > 0 ? `, Exit/day ${t.ExitRatePerDay}` : '';
            console.log(`${t.symbol} — PIC ${t.PIC}, Bond ${t.Bond}${exitPart}`);
        }
    }

    if (tblNoPIC.length > 0) {
        console.log('');
        console.log('No PIC:');
        for (const t of tblNoPIC) {
            console.log(`${t.symbol} — Bond ${t.Bond}`);
        }
    }

    if (tblIdle.length > 0) {
        console.log('');
        console.log(`Idle: ${tblIdle.map(t => t.symbol).join(', ')}`);
    }
})();

