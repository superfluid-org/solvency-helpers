/*
 * Compiles a list of accounts (transaction sender) which triggered liquidations.
 * Self-liquidations (deleteFlow of critical accounts) are NOT included.
 * Usage: [USE_CACHE=1] $1 <network_name>
 * If USE_CACHE is set, it caches the subgraph query results to disk / uses that cache if exists.
 */

const axios = require('axios');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// first arg
networkName = process.argv[2];

//const SUBGRAPH_URL = `https://subgraph-endpoints.superfluid.dev/${networkName}/protocol-v1`;
const SUBGRAPH_URL = `https://${networkName}.subgraph.x.superfluid.dev`;
// const RPC_URL = `https://rpc-endpoints.superfluid.dev/${networkName}/protocol-v1`;
const RPC_URL = process.env.RPC_URL || `https://${networkName}.arpc.x.superfluid.dev`;

// Cache settings
const USE_CACHE = process.env.USE_CACHE;
const CACHE_DIR = process.env.CACHE_DIR || '.cache';
const CACHE_FILE = path.join(CACHE_DIR, `${networkName}-liquidation-events.json`);

// Maximum items per page
const MAX_ITEMS = 1000;
// Batch size for RPC requests
const BATCH_SIZE = 1000;

// Function to generate GraphQL query with pagination
function generateQuery(lastId = "") {
  console.log(`Generating query for ${lastId}`);
  return `
  query MyQuery {
    agreementLiquidatedV2Events(
      first: ${MAX_ITEMS},
      where: { id_gt: "${lastId}" }
    ) {
      id
      transactionHash
      token
      liquidatorAccount
      targetAccount
      liquidationType
      rewardAccount
      rewardAmountReceiver
      rewardAmount
    }
  }
  `;
}

// Function to save data to cache
function saveToCache(data) {
  try {
    // Ensure cache directory exists
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    console.log(`Cache saved to ${CACHE_FILE}`);
  } catch (error) {
    console.error(`Error saving cache: ${error.message}`);
  }
}

// Function to read data from cache
function readFromCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      console.log(`Read cache from ${CACHE_FILE}`);
      return JSON.parse(data);
    }
    return null;
  } catch (error) {
    console.error(`Error reading cache: ${error.message}`);
    return null;
  }
}

// Function to get transaction data in batches
async function getTransactionSenders(provider, txHashes) {
  console.log("Starting to fetch transaction data...");
  const results = [];

  // Process in batches
  for (let i = 0; i < txHashes.length; i += BATCH_SIZE) {
    const batch = txHashes.slice(i, i + BATCH_SIZE);
    console.log(`Fetching batch ${i/BATCH_SIZE + 1} of ${Math.ceil(txHashes.length/BATCH_SIZE)} (${batch.length} transactions)`);

    try {
      // Create promises for all transactions in the batch
      const promises = batch.map(hash => provider.getTransaction(hash));

      // Wait for all promises to resolve
      const transactions = await Promise.all(promises);
      results.push(...transactions);
    } catch (error) {
      console.error(`Error fetching batch at index ${i}: ${error.message}`);
    }
  }

  return results;
}

async function fetchAllEvents() {
  let lastId = "";
  const allEvents = [];

  // Paginate through all results
  while (true) {
    // Make the GraphQL request
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: generateQuery(lastId) }
    );

    // Extract the events from the response
    const events = response.data.data.agreementLiquidatedV2Events;

    // Add events to our collection
    allEvents.push(...events);

    // If we got fewer events than the maximum, we've reached the end
    if (events.length < MAX_ITEMS) {
      break;
    } else {
      // Otherwise, update lastId for the next page
      lastId = events[events.length - 1].id;
    }
  }

  return allEvents;
}

async function getDistinctLiquidators() {
  try {
    let allEvents;

    // Check if we should use cache
    if (USE_CACHE) {
      console.log("USE_CACHE is set, attempting to load from cache...");
      allEvents = readFromCache();

      if (!allEvents) {
        console.log("Cache not found or invalid, fetching from subgraph...");
        allEvents = await fetchAllEvents();
        if (USE_CACHE) {
          saveToCache(allEvents);
        }
      }
    } else {
      console.log("Fetching data from subgraph...");
      allEvents = await fetchAllEvents();
      saveToCache(allEvents);
    }

    console.log(`Found ${allEvents.length} total liquidation events`);

    // Get unique transaction hashes
    const uniqueTxHashes = [...new Set(allEvents.map(event => event.transactionHash))];
    console.log(`Found ${uniqueTxHashes.length} unique transaction hashes`);

    // Connect to the provider
    console.log(`Connecting to RPC at ${RPC_URL}`);
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // Get transaction data for all unique transaction hashes
    const transactions = await getTransactionSenders(provider, uniqueTxHashes);
    console.log(`Retrieved ${transactions.length} transactions of ${uniqueTxHashes.length} requested`);
    console.log(`Null/undefined transactions: ${transactions.filter(tx => !tx).length}`);

    // Create a map of transaction hash to sender
    const txSenderMap = {};
    let mappedCount = 0;

    transactions.forEach(tx => {
      if (tx && tx.hash) {
        txSenderMap[tx.hash] = tx.from;
        mappedCount++;
      }
    });

    console.log(`Successfully mapped ${mappedCount} transactions to their senders`);

    // Enrich events with transaction sender
    const enrichedEvents = allEvents.map(event => ({
      ...event,
      transactionSender: txSenderMap[event.transactionHash]
    }));

    // Filter out events where transaction sender is the same as targetAccount
    const filteredEvents = enrichedEvents.filter(event => {
      const isNotSelfLiquidation = event.transactionSender &&
                                   event.liquidatorAccount.toLowerCase() !== event.targetAccount.toLowerCase() &&
                                   event.transactionSender.toLowerCase() !== event.targetAccount.toLowerCase();
      return isNotSelfLiquidation;
    });

    // Get distinct liquidator accounts (transaction senders) from the filtered events
    const distinctLiquidators = [...new Set(filteredEvents.map(event => event.transactionSender))].sort();

    // Build a map of liquidator accounts to a sample transaction hash
    const liquidatorToSampleTxMap = {};
    for (const event of filteredEvents) {
      if (event.transactionSender && !liquidatorToSampleTxMap[event.transactionSender]) {
        liquidatorToSampleTxMap[event.transactionSender] = event.transactionHash;
      }
    }

    // Log one transaction hash for each liquidator
    console.log("Sample transactions for each liquidator:");
    distinctLiquidators.forEach(liquidator => {
      if (liquidator) {
        const sampleTx = liquidatorToSampleTxMap[liquidator];
        console.log(`Liquidator ${liquidator}: ${sampleTx}`);
      }
    });

    console.log(`Found ${distinctLiquidators.length} distinct liquidator accounts from ${filteredEvents.length} filtered events (${allEvents.length} total events):`);
    console.log(distinctLiquidators);

    return distinctLiquidators;
  } catch (error) {
    console.error('Error fetching data:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

// Run the function
getDistinctLiquidators();
