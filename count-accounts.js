const sfSubgraph = require("./superfluid-subgraph");
const sfMeta = require("@superfluid-finance/metadata");

if (require.main === module) {
    const networkName = process.argv[2];
    if (!networkName) {
        console.error("Usage: node count-accounts.js <network-name>");
        process.exit(1);
    }

    const network = sfMeta.getNetworkByName(networkName);
    if (!network) {
        console.error(`Unknown network ${networkName}`);
        process.exit(1);
    }

    const subgraphUrl = `https://${network.name}.subgraph.x.superfluid.dev`;
    console.log(`Using subgraph ${subgraphUrl}`);

    sfSubgraph.init(subgraphUrl);

    (async () => {
        try {
            console.log(`Counting accounts for ${networkName}...`);
            const accounts = await sfSubgraph.getAllAccounts();
            console.log(`Found ${accounts.length} accounts`);
        } catch (error) {
            console.error(error.message);
            process.exit(1);
        }
    })();
} 