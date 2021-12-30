const axios = require("axios");

const MAX_ITEMS = 1000;
const NETWORKS = {
    goerli: {
        hostAddress: "0x22ff293e14F1EC3A09B137e9e06084AFd63adDF9",
        cfaAddress: "0xEd6BcbF6907D4feEEe8a8875543249bEa9D308E8",
        rewardAddress: "0xd15D5d0f5b1b56A4daEF75CfE108Cb825E97d015",
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/superfluid-goerli",
        web3ProviderUrl: process.env.GOERLI_PROVIDER_URL || "http://eth-goerli.web3-infra.superfluid.dev",
    },
    kovan: {
        hostAddress: "0xF0d7d1D47109bA426B9D8A3Cde1941327af1eea3",
        cfaAddress: "0xECa8056809e7e8db04A8fF6e4E82cD889a46FE2F",
        rewardAddress: "0xd15D5d0f5b1b56A4daEF75CfE108Cb825E97d015",
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/superfluid-kovan",
        web3ProviderUrl: process.env.KOVAN_PROVIDER_URL || "http://eth-kovan.web3-infra.superfluid.dev",
    },

    xdai: {
        hostAddress: "0x2dFe937cD98Ab92e59cF3139138f18c823a4efE7",
        cfaAddress: "0xEbdA4ceF883A7B12c4E669Ebc58927FBa8447C7D",
        rewardAddress: "0x8e8F05f1aD16D20e66Bd0922b510332104ddAc7B",
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/superfluid-xdai",
        web3ProviderUrl: process.env.XDAI_PROVIDER_URL || "http://xdai-mainnet.web3-infra.superfluid.dev",
        batchLiquidatorAddress: "0xf4b9bBFc34dc8cc392bC97c76bc60D8350D83172",
    },
    matic: {
        hostAddress: "0x3E14dC1b13c488a8d5D310918780c983bD5982E7",
        cfaAddress: "0x6EeE6060f715257b970700bc2656De21dEdF074C",
        rewardAddress: "0x1EB3FAA360bF1f093F5A18d21f21f13D769d044A",
        theGraphQueryUrl: "https://api.thegraph.com/subgraphs/name/superfluid-finance/superfluid-matic",
        web3ProviderUrl: process.env.MATIC_PROVIDER_URL || "http://polygon-mainnet.web3-infra.superfluid.dev",
        batchLiquidatorAddress: "0xE6E151C28F6EC8DD696637ac2bf5d24adB527566",
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
    let skip = 0;
    const items = [];
    while (true) {
        const res = await graphql(queryFn(skip));
        if (res.status !== 200 || res.data.errors) {
            console.error(res.data);
            process.exit(2);
        }
        const newItems = toItems(res);
        items.splice(skip, 0,  ...newItems.map(itemFn));
        if (newItems.length < MAX_ITEMS) break;
        else skip += MAX_ITEMS;
    }
    return items;
}

function getAllSuperTokens() {
    return queryAllPages((skip) => `{
          tokens (first: ${MAX_ITEMS}, skip: ${skip}) {
            id
          }
        }`,
        res => res.data.data.tokens,
        i => i.id
    );
}

function getAllAccounts(token) {
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

function getAllOutFlows(account) {
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
