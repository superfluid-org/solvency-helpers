const axios = require("axios");

const MAX_ITEMS = 1000;

let subgraphUrl;

function init(subgraphUrl_) {
    subgraphUrl = subgraphUrl_;
}

// graphql
async function graphql(query, { accept } = {}) {
    return await axios.post(subgraphUrl, {
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

function getAllOutFlowsV0(account) {
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

function getAllOutFlows(account) {
    return queryAllPages((lastId) => `{
        account(id: "${account}") {
            outflows(where: {
                id_gt: "${lastId}",
                currentFlowRate_not: "0",
            }) {
                id
                currentFlowRate
                }
            }
        }`,
        res => res.data.data.account.outflows,
        i => i.id
    );
}


module.exports = {
    init,
    queryAllPages,
    getAllSuperTokens,
    getAllAccounts,
    getAllOutFlows
}
