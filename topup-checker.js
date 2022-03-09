// checks the funding status of the accounts listed in topup-addresses.json
// report: address, balance, flowrate, runway
// if runway <24h
// env: NETWORK_NAME, MIN_RUNWAY_H

const { ethers, BigNumber, utils } = require("ethers");
const { wad4human, toBN } = require("@decentral.ee/web3-helpers");
const ISuperfluidAbi = require("./abis/ISuperfluid.json");
const ICFAv1 = require("./abis/ICFAv1.json");
const IERC20 = require("./abis/IERC20.json");

const LIST = require("./topup-list.json");
const minRunwayS = process.env.MIN_RUNWAY || 24;

// TODO: replace with external canonical network list
NETWORKS = [
    { chainId: 5, hostAddr: "0x22ff293e14F1EC3A09B137e9e06084AFd63adDF9", name: "eth-goerli" },
    { chainId: 42, hostAddr: "0xF0d7d1D47109bA426B9D8A3Cde1941327af1eea3", name: "eth-kovan" },
    { chainId: 4, hostAddr: "0xeD5B5b32110c3Ded02a07c8b8e97513FAfb883B6" }, // eth-rinkeby
    { chainId: 3, hostAddr: "0xF2B4E81ba39F5215Db2e05B2F66f482BB8e87FD2" }, // eth-ropsten
    { chainId: 80001, hostAddr: "0xEB796bdb90fFA0f28255275e16936D25d3418603" }, // polygon-mumbai
    { chainId: 69, hostAddr: "0x74b57883f8ce9F2BD330286E884CfD8BB24AC4ED" }, // optimism-kovan
    { chainId: 421611, hostAddr: "0xE01F8743677Da897F4e7De9073b57Bf034FC2433" }, // arbitrum-rinkeby
    { chainId: 43113, hostAddr: "0xf04F2C525819691ed9ABD3D2B7109E1633795e68" }, // avalanche-fuji

    { chainId: 137, hostAddr: "0x3E14dC1b13c488a8d5D310918780c983bD5982E7", name: "polygon-mainnet" },
    { chainId: 100, hostAddr: "0x2dFe937cD98Ab92e59cF3139138f18c823a4efE7", name: "xdai-mainnet" },
    // { chainId: 10, hostAddr: "0x0000000000000000000000000000000000000000" }, // optimism-mainnnet
    // { chainId: 42161, hostAddr: "0x0000000000000000000000000000000000000000" }, // arbitrum-one
    // { chainId: 43114, hostAddr: "0x0000000000000000000000000000000000000000" } // avalanche-C
];

(async () => {
    
    // SETUP
    
    const network = NETWORKS.filter(n => n.name === process.env.NETWORK_NAME)[0];
    if(network === undefined) {
        console.error(`unknown/unsupported network: ${process.env.NETWORK_NAME}`);
        system.exit(1);
    }
    
    const rpc = `http://${network.name}.web3-infra.superfluid.dev`;
    const provider = new ethers.providers.JsonRpcProvider(rpc);
    
    const host = new ethers.Contract(network.hostAddr, ISuperfluidAbi, provider);
    const cfaAddr = await host.getAgreementClass(utils.keccak256(
        utils.toUtf8Bytes("org.superfluid-finance.agreements.ConstantFlowAgreement.v1")));
    const cfa = new ethers.Contract(cfaAddr, ICFAv1, provider);
    
    // ======
    
    const symbolCache = {};
    const table = [];
    for(const item of LIST) {
        //console.log(`processing ${item.token}, ${item.account}...`);
        
        token = new ethers.Contract(item.token, IERC20, provider);
        
        const tokenSymbol = symbolCache[token.address] || await token.symbol();
        symbolCache[token.address] = tokenSymbol;
        
        const bal = await token.balanceOf(item.account);
        
        const netFlow = await cfa.getNetFlow(item.token, item.account);
        
        const runWayS = bal.div(netFlow);
        
        table.push({
            Account: item.account,
            Token: item.token,
            Symbol: tokenSymbol,
            Balance: wad4human(bal),
            NetFlowDaily: wad4human(netFlow.mul(3600*24)),
            RunWayHours: netFlow.gt(0) ? '∞' : runWayS.div(-3600).toString()
        });
    }
    console.log(`Network: ${network.name} - top-up checker`);
    console.log('```');
    console.table(table, ["Account", "Token", "Symbol", "Balance", "NetFlowDaily", "RunWayHours"]);
    console.log('```');
})();
