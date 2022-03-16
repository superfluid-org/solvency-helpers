const axios = require("axios");

const MAX_ITEMS = 1000;
const NETWORKS = {
    goerli: {
        hostAddress: "0x22ff293e14F1EC3A09B137e9e06084AFd63adDF9",
        cfaAddress: "0xEd6BcbF6907D4feEEe8a8875543249bEa9D308E8",
        rewardAddress: "0xd15D5d0f5b1b56A4daEF75CfE108Cb825E97d015",
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/protocol-v1-goerli",
        web3ProviderUrl: process.env.GOERLI_PROVIDER_URL || "http://eth-goerli.web3-infra.superfluid.dev",
    },
    kovan: {
        hostAddress: "0xF0d7d1D47109bA426B9D8A3Cde1941327af1eea3",
        cfaAddress: "0xECa8056809e7e8db04A8fF6e4E82cD889a46FE2F",
        rewardAddress: "0xd15D5d0f5b1b56A4daEF75CfE108Cb825E97d015",
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/protocol-v1-kovan",
        web3ProviderUrl: process.env.KOVAN_PROVIDER_URL || "http://eth-kovan.web3-infra.superfluid.dev",
    },

    xdai: {
        hostAddress: "0x2dFe937cD98Ab92e59cF3139138f18c823a4efE7",
        cfaAddress: "0xEbdA4ceF883A7B12c4E669Ebc58927FBa8447C7D",
        //rewardAddress: "",
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/protocol-v1-xdai",
        web3ProviderUrl: process.env.XDAI_PROVIDER_URL || "http://xdai-mainnet.web3-infra.superfluid.dev",
        batchLiquidatorAddress: "0xf4b9bBFc34dc8cc392bC97c76bc60D8350D83172",
    },
    matic: {
        hostAddress: "0x3E14dC1b13c488a8d5D310918780c983bD5982E7",
        cfaAddress: "0x6EeE6060f715257b970700bc2656De21dEdF074C",
        //rewardAddress: "",
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/protocol-v1-matic",
        web3ProviderUrl: process.env.MATIC_PROVIDER_URL || "http://polygon-mainnet.web3-infra.superfluid.dev",
        batchLiquidatorAddress: "0xE6E151C28F6EC8DD696637ac2bf5d24adB527566",
    },
    mumbai: {
        hostAddress: "0xEB796bdb90fFA0f28255275e16936D25d3418603",
        cfaAddress: "0x49e565Ed1bdc17F3d220f72DF0857C26FA83F873",
        //rewardAddress: "",
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/protocol-v1-mumbai",
        web3ProviderUrl: process.env.MATIC_PROVIDER_URL || "http://polygon-mumbai.web3-infra.superfluid.dev",
        //batchLiquidatorAddress: "",
    },
    opmainnet: {
        hostAddress: "0x567c4B141ED61923967cA25Ef4906C8781069a10",
        cfaAddress: "0x204C6f131bb7F258b2Ea1593f5309911d8E458eD",
        //rewardAddress: "",
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/protocol-v1-optimism-mainnet",
        web3ProviderUrl: process.env.MATIC_PROVIDER_URL || "http://optimism-mainnet.web3-infra.superfluid.dev",
        batchLiquidatorAddress: "0xEe1bd2C743BF40B1206B090Fa9aB27A0C57d7B90",
    },
    arbone: {
        hostAddress: "0xCf8Acb4eF033efF16E8080aed4c7D5B9285D2192",
        cfaAddress: "0x731FdBB12944973B500518aea61942381d7e240D",
        //rewardAddress: "",
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/protocol-v1-arbitrum-one",
        web3ProviderUrl: process.env.MATIC_PROVIDER_URL || "http://arbitrum-one.web3-infra.superfluid.dev",
        batchLiquidatorAddress: "0xA87F76e99f6C8Ff8996d14f550ceF47f193D9A09",
    },
};

let network;

function asleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function selectNetwork(networkName) {
    network = NETWORKS[networkName];
    //console.log("Network name", process.env.NETWORK_NAME);
    return network;
}

// graphql
async function graphql(query, { accept } = {}) {
    return await axios.post(network.theGraphQueryUrl, {
        query
    }, {
        headers: {
            //"Authorization": `bearer ${process.env.GITHUB_TOKEN}`,
            //"Accept": accept ? accept : "application/vnd.github.v3+json",
        }
    });
}

async function queryAllPages(queryFn, toItems, itemFn) {
    let lastId = "";
    const items = [];
    while (true) {
        //console.log(`query with lastId ${lastId} ...`);
        const res = await graphql(queryFn(lastId));
        //console.log("done");
        if (res.status !== 200 || res.data.errors) {
            console.error(res.data);
            process.exit(2);
        }
        const newItems = toItems(res);
        //console.log(`newItems: ${newItems.map(itemFn)}`);
        //items.splice(skip, 0,  ...newItems.map(itemFn));
        items.push(...newItems.map(itemFn));
        //console.log(`items now has ${items.length} elements`);
        if (newItems.length < MAX_ITEMS) {
            break;
        } else {
            lastId = newItems[newItems.length-1].id;
            //console.log(`advanced lastId to ${lastId}`);
        }
    }
    return items;
}

function getAllSuperTokensV0() {
    return queryAllPages((skip) => `{
          tokens (first: ${MAX_ITEMS}, skip: ${skip}) {
            id
          }
        }`,
        res => res.data.data.tokens,
        i => i.id
    );
}

function getAllSuperTokens() {
    //console.log("getAllSuperTokens...");
    return queryAllPages((lastId) => `{
          tokens (first: ${MAX_ITEMS},
            where: {
              id_gt: "${lastId}",
              isSuperToken: true
            }
          ) {
            id
          }
        }`,
        res => res.data.data.tokens,
        i => i.id
    );
}

function getAllAccountsV0(token) {
    return Promise.all(Array.from("0123456789abcdefABCDEF").map((a) => (queryAllPages((skip) => `query {
            accountWithTokens(where: {
                token: "${token}",
                account_starts_with: "0x${a}"
            }, first: ${MAX_ITEMS}, skip: ${skip}) {
                account { id }
            }
        }`,
        res => res.data.data.accountWithTokens,
        i => i.account.id
    )))).then(results => Array.from(new Set(results.flat()/*.concat([network.rewardAddress])*/.map(i => i.toLowerCase()))));
}

function getAllAccounts(token) {
    //console.log(`getAllAccounts(${token})...`);
    return queryAllPages((lastId) => `{
          accountTokenSnapshots (first: ${MAX_ITEMS},
            where: { 
                id_gt: "${lastId}",
                token: "${token}"
            }
          ) {
            id
            account {
              id
            }
          }
        }`,
        res => res.data.data.accountTokenSnapshots,
        i => i.account.id
    );
}

function getAllOutFlows(account) {
    console.error("TODO: port to subgraph v1");
    process.exit(1);
    return queryAllPages((skip) => `{
          accounts(where: {
            id: "${account}"
          }) {
            flowsOwned {
              recipient {
                id
              }
            }
          }
        }`,
        res => res.data.data.accounts[0].flowsOwned,
        i => i.recipient.id
    );   
}


module.exports = {
    asleep,
    selectNetwork,
    queryAllPages,
    getAllSuperTokens,
    getAllAccounts,
    getAllOutFlows
}
