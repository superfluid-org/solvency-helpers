#!/usr/bin/env node
/**
 * Bruteforce solvency checker for Superfluid protocol.
 * Iterates over all SuperTokens and accounts, checks for critical/insolvent accounts.
 * Uses viem, @sfpro/sdk ABIs, subgraph with fallback to persisted cache.
 *
 * ## Phases
 *
 * 0. **prepareAccounts** – Build workload: token list + token→accounts map.
 * 0b. **tokenInit** – RPC getHost per token; filter by host match; queue realtimeBalance jobs.
 * 1. **realtimeBalance** – RPC realtimeBalanceOfNow for all token/account pairs.
 * 2. **followupChecks** – For accounts with negative balance + deposit: RPC isPatricianPeriodNow
 *    and isAccountSolventNow. Classify as patrician/pleb/pirate, solvent/insolvent.
 * 3. **report** – Emit warnings for negative accounts above threshold; optionally alert.
 *
 * ## Insolvent accounts without outflow
 *
 * Accounts with negative balance and no deposit (no active outflow) are counted in
 * `criticalCount` but are not run through followupChecks (isPatricianPeriodNow,
 * isAccountSolventNow). They are insolvent but cannot be closed via stream-closer
 * links since there is no outflow to close. They are excluded from the report section.
 *
 * ## Data sources
 *
 * - **Subgraph**: SuperToken list, accountTokenSnapshots (global token→accounts), outflows (for
 *   stream-closer links). Paginated with id_gt.
 * - **Cache** (cache-ts/): Tokens and tokenAccounts. Used when USE_CACHE=1 or when subgraph
 *   fails. Cache is saved after prepareAccounts and tokenInit phases.
 * - **RPC**: getHost, realtimeBalanceOfNow, isPatricianPeriodNow, isAccountSolventNow; also
 *   chainId, blockNumber, getBlock for health checks.
 *
 * ## RPC batching (three levels)
 *
 * 1. **App chunking** (RPC_BATCH_SIZE, default 5000): How many readContract calls per
 *    sequential chunk. Chunks are processed one after another.
 * 2. **JSON-RPC batching** (viem http transport, batchSize: RPC_BATCH_SIZE): Multiple
 *    eth_call requests are batched into a single HTTP POST. Each eth_call can be either a
 *    raw call or a Multicall3 aggregate3.
 * 3. **Multicall** (MULTICALL_CALLDATA_KB, default 5): When > 0, readContract calls are
 *    aggregated into Multicall3 aggregate3. The value is max calldata size in KB per multicall
 *    chunk. Multiple reads become one eth_call (one multicall) up to that limit.
 *
 * Flow: reads → (if multicall) grouped into multicall chunks by calldata size → each chunk is
 * one eth_call → many eth_calls batched into one HTTP request.
 *
 * ## RPC retries
 *
 * processWithRetry wraps each RPC phase. It uses adaptive batch size:
 * - On full batch failure: increment consecutiveFullFailures.
 * - After 2 consecutive full failures: halve the effective batch size (min 1) and reset.
 * - Failed items are retried in the next round. Up to RETRY_ROUNDS (default 10).
 * - If items still fail after all rounds, the script throws.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { createPublicClient, http, formatEther, extractChain, type Address, type Chain } from "viem";
import * as viemChains from "viem/chains";
import { defineChain } from "viem/chains/utils";
import sfMeta from "@superfluid-finance/metadata";
import { superTokenAbi } from "@sfpro/sdk/abi";
import { cfaAbi } from "@sfpro/sdk/abi/core";

// --- Constants and env ---
const SUBGRAPH_MAX_ITEMS = 1000;
const RPC_BATCH_SIZE = Number(process.env.RPC_BATCH_SIZE) || 5000;
const MULTICALL_CALLDATA_KB =
  Number(process.env.MULTICALL_CALLDATA_KB) || 5;
const RETRY_ROUNDS = Number(process.env.RETRY_ROUNDS) || 10;
const RPC_DRIFT_WARN_THRESHOLD = Number(process.env.RPC_DRIFT_WARN_THRESHOLD) || 900;
const STREAM_CLOSER_URL =
  process.env.STREAM_CLOSER_URL ||
  "https://ipfs.io/ipns/k2k4r8mh72qtu8510x7okj8c78nijugxr53edj7nxs8yecqy7zlyh4rz/stream-closer.html";
const NETWORK_NAME = process.env.NETWORK_NAME;
const CACHE_TS_DIR = "./cache-ts";
const USE_CACHE = /^(1|true|yes)$/i.test(process.env.USE_CACHE ?? "");
const TOKEN_ALERT_SKIP_LIST = process.env.TOKEN_ALERT_SKIP_LIST?.split(/\s+/) || [];
const BUFFER_WARN_THRESHOLD_PCT = Number(process.env.BUFFER_WARN_THRESHOLD_PCT) || 15;
const THRESHOLDS_FILE = "./solvency-thresholds.json";

// PPP period classification (patrician / pleb / pirate)
const PPP_PERIOD = { PATRICIAN: 1, PLEB: 2, PIRATE: 3 } as const;

// --- Types ---
interface SuperTokenMeta {
  id: string;
  isListed?: boolean;
  name?: string;
  symbol?: string;
}

interface CacheFile {
  network: string;
  timestamp: number;
  chainId?: number;
  blockNumber?: number;
  tokens: SuperTokenMeta[];
  tokenAccounts: Record<string, string[]>;
}

interface AccountState {
  account: string;
  availableBalance: bigint;
  pppPeriod: number;
  depositConsumedPct: number;
  belowWarningThreshold: boolean;
}

interface TokenContext {
  tokenAddr: Address;
  symbol: string;
  tokenMeta: SuperTokenMeta;
  warningThreshold: bigint;
  totalAccounts: number;
  accountStates: AccountState[];
}

interface RealtimeJob {
  tokenAddr: Address;
  account: Address;
}

interface FollowupJob {
  tokenAddr: Address;
  account: Address;
  availableBalance: bigint;
  deposit: bigint;
}

interface TokenInitJob {
  tokenMeta: SuperTokenMeta;
  tokenAddr: Address;
  accounts: string[];
}

// --- Logging ---
let deferredLog = "";
let warnMode = false;

function infoLog(msg: string): void {
  if (!process.env.INTROVERT || warnMode) {
    console.log(msg);
  } else {
    deferredLog += msg;
  }
}

function warnLog(msg: string): void {
  if (deferredLog !== "") {
    console.log(deferredLog);
    deferredLog = "";
  }
  console.log(msg);
  warnMode = true;
}

function stderrLog(msg: unknown): void {
  console.error(msg);
}

function debugLog(msg: string): void {
  if (process.env.DEBUG) console.log(`[DEBUG] ${msg}`);
}

function pppPeriodName(pppPeriodId: number): string {
  switch (pppPeriodId) {
    case PPP_PERIOD.PATRICIAN:
      return "patrician";
    case PPP_PERIOD.PLEB:
      return "pleb";
    case PPP_PERIOD.PIRATE:
      return "pirate";
    default:
      throw new Error(`invalid pppPeriodId: ${pppPeriodId}`);
  }
}

function calcDepositConsumedPct(availableBalance: bigint, deposit: bigint): number {
  return availableBalance >= 0n || deposit === 0n ? 0 : Number((-availableBalance * 100n) / deposit);
}

function tokenDisplay(tokenAddr: string, symbol?: string): string {
  const clean = symbol?.trim();
  return clean ? `${clean} (${tokenAddr})` : tokenAddr;
}

async function runSequentialChunks<T>(
  items: T[],
  chunkSize: number,
  runChunk: (chunk: T[], chunkIdx: number, totalChunks: number) => Promise<void>
): Promise<void> {
  const totalChunks = Math.ceil(items.length / chunkSize);
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkIdx = Math.floor(i / chunkSize);
    await runChunk(chunk, chunkIdx, totalChunks);
  }
}

interface AdaptiveBatchState {
  currentMax: number;
  consecutiveFullFailures: number;
}

/** Retry failed items. Uses adaptive batch size: when 2 consecutive batches at current max fully fail, halve the max. */
async function processWithRetry<T, R>(
  items: T[],
  processBatch: (batch: T[]) => Promise<(R | null)[]>,
  maxRounds: number,
  phaseLabel: string,
  adaptive: AdaptiveBatchState
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length);
  let toProcess: { item: T; idx: number }[] = items.map((item, idx) => ({ item, idx }));
  let roundsUsed = 0;

  for (let round = 0; round < maxRounds; round++) {
    if (toProcess.length === 0) break;

    const next: { item: T; idx: number }[] = [];
    const batchSize = Math.min(adaptive.currentMax, toProcess.length);

    if (process.env.DEBUG) {
      const n = toProcess.length;
      const batchCount = Math.ceil(n / batchSize);
      if (round === 0) {
        debugLog(
          `${phaseLabel} r0 | ${n} reads ×${batchCount} batch(es) of ${batchSize}`
        );
      } else {
        debugLog(
          `${phaseLabel} r${round} | ${n} failed reads ×${batchCount} batch(es) of ${batchSize}`
        );
      }
    }

    for (let i = 0; i < toProcess.length; i += batchSize) {
      const batch = toProcess.slice(i, i + batchSize);
      const batchItems = batch.map((x) => x.item);
      const batchResults = await processBatch(batchItems);

      const allFailed = batchResults.every((r) => r === null);
      if (allFailed) {
        adaptive.consecutiveFullFailures++;
        if (adaptive.consecutiveFullFailures >= 2) {
          const newMax = Math.max(1, Math.floor(batch.length / 2));
          adaptive.currentMax = Math.min(adaptive.currentMax, newMax);
          adaptive.consecutiveFullFailures = 0;
          if (process.env.DEBUG) {
            debugLog(
              `${phaseLabel} | 2 full failures at ${batch.length} → max ${adaptive.currentMax}`
            );
          }
        }
      } else {
        adaptive.consecutiveFullFailures = 0;
      }

      batchResults.forEach((res, j) => {
        const idx = batch[j].idx;
        if (res !== null) {
          results[idx] = res;
        } else {
          next.push(batch[j]);
        }
      });
    }

    roundsUsed = round + 1;

    if (process.env.DEBUG && next.length > 0) {
      debugLog(
        `${phaseLabel} r${round} | ${next.length}/${items.length} failed (RPC-level)`
      );
    }
    toProcess = next;
  }

  if (toProcess.length > 0) {
    throw new Error(
      `Persistent RPC failures after ${maxRounds} retry rounds: ${toProcess.length} calls still failing in ${phaseLabel}`
    );
  }

  if (process.env.DEBUG && roundsUsed > 1) {
    debugLog(`${phaseLabel} | ok after ${roundsUsed} rounds`);
  }

  return results;
}

// --- Subgraph (native fetch) ---
let subgraphUrl = "";

async function graphql(query: string): Promise<{ data?: unknown; errors?: unknown[] }> {
  const res = await fetch(subgraphUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`Subgraph HTTP ${res.status}`);
  }
  return res.json() as Promise<{ data?: unknown; errors?: unknown[] }>;
}

async function queryAllPages<T, R>(
  queryFn: (lastId: string) => string,
  toItems: (res: { data?: unknown }) => T[],
  itemFn: (item: T) => R,
  debugLabel?: string
): Promise<R[]> {
  let lastId = "";
  const items: R[] = [];
  let page = 0;
  const start = process.env.DEBUG ? Date.now() : 0;
  while (true) {
    page++;
    const pageStart = process.env.DEBUG ? Date.now() : 0;
    const res = await graphql(queryFn(lastId));
    if (res.errors) {
      throw new Error(`Subgraph errors: ${JSON.stringify(res.errors)}`);
    }
    const newItems = toItems(res);
    items.push(...newItems.map(itemFn));
    if (process.env.DEBUG && debugLabel) {
      const pageMs = Date.now() - pageStart;
      debugLog(
        `subgraph ${debugLabel} | page ${page} | ${newItems.length} items | total ${items.length} | ${pageMs}ms`
      );
    }
    if (newItems.length < SUBGRAPH_MAX_ITEMS) break;
    const last = newItems[newItems.length - 1] as { id?: string };
    lastId = last?.id ?? "";
  }
  if (process.env.DEBUG && debugLabel) {
    const totalMs = Date.now() - start;
    debugLog(`subgraph ${debugLabel} | done | ${items.length} items | ${page} pages | ${totalMs}ms`);
  }
  return items;
}

async function fetchSuperTokens(): Promise<SuperTokenMeta[]> {
  return queryAllPages(
    (lastId) => `{
      tokens (first: ${SUBGRAPH_MAX_ITEMS}, where: { id_gt: "${lastId}", isSuperToken: true }) {
        id isListed name symbol
      }
    }`,
    (res) => (res.data as { tokens?: SuperTokenMeta[] })?.tokens ?? [],
    (i) => i,
    "tokens"
  );
}

async function getAllAccountTokenSnapshots(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  let lastId = "";
  let page = 0;
  const start = process.env.DEBUG ? Date.now() : 0;

  while (true) {
    page++;
    const pageStart = process.env.DEBUG ? Date.now() : 0;
    const query = `{
      accountTokenSnapshots (first: ${SUBGRAPH_MAX_ITEMS}, where: { id_gt: "${lastId}" }) {
        id
        account { id }
        token { id }
      }
    }`;
    const res = await graphql(query);
    if (res.errors) {
      throw new Error(`Subgraph errors: ${JSON.stringify(res.errors)}`);
    }
    const items =
      (res.data as { accountTokenSnapshots?: { id: string; account: { id: string }; token: { id: string } }[] })
        ?.accountTokenSnapshots ?? [];

    for (const item of items) {
      const tokenId = item.token?.id;
      const accountId = item.account?.id;
      if (tokenId && accountId) {
        const list = map.get(tokenId) ?? [];
        list.push(accountId);
        map.set(tokenId, list);
      }
    }

    if (process.env.DEBUG) {
      const pageMs = Date.now() - pageStart;
      const total = Array.from(map.values()).reduce((s, a) => s + a.length, 0);
      debugLog(
        `subgraph accountTokenSnapshots global | page ${page} | ${items.length} items | total ${total} | ${pageMs}ms`
      );
    }

    if (items.length < SUBGRAPH_MAX_ITEMS) break;
    const last = items[items.length - 1];
    lastId = last?.id ?? "";
  }

  if (process.env.DEBUG) {
    const totalMs = Date.now() - start;
    const total = Array.from(map.values()).reduce((s, a) => s + a.length, 0);
    debugLog(
      `subgraph accountTokenSnapshots global | done | ${map.size} tokens | ${total} snapshots | ${page} pages | ${totalMs}ms`
    );
  }
  return map;
}

async function getAllOutflows(token: string, account: string): Promise<string[]> {
  return queryAllPages(
    (lastId) => `{
      account(id: "${account}") {
        outflows(where: { token: "${token}", id_gt: "${lastId}", currentFlowRate_not: "0" }) {
          id currentFlowRate
        }
      }
    }`,
    (res) => {
      const acc = (res.data as { account?: { outflows?: { id: string }[] } } | null)?.account;
      return acc?.outflows ?? [];
    },
    (i) => i.id,
    `outflows token ${token} account ${account}`
  );
}

// --- Cache ---
function getCachePath(network: string, timestamp: number): string {
  return join(CACHE_TS_DIR, `solvency-${network}-${timestamp}.json`);
}

function loadLatestCache(network: string): CacheFile | null {
  try {
    mkdirSync(CACHE_TS_DIR, { recursive: true });
    const files = readdirSync(CACHE_TS_DIR)
      .filter((f) => f.startsWith(`solvency-${network}-`) && f.endsWith(".json"))
      .map((f) => {
        const m = f.match(/solvency-[\w-]+-(\d+)\.json/);
        return { name: f, ts: m ? parseInt(m[1], 10) : 0 };
      })
      .filter((x) => x.ts > 0)
      .sort((a, b) => b.ts - a.ts);
    if (files.length === 0) return null;
    const raw = readFileSync(join(CACHE_TS_DIR, files[0].name), "utf-8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

function saveCache(cache: CacheFile): void {
  mkdirSync(CACHE_TS_DIR, { recursive: true });
  const path = getCachePath(cache.network, cache.timestamp);
  writeFileSync(path, JSON.stringify(cache, null, 2));
}

interface ResolvedWorkload {
  superTokens: SuperTokenMeta[];
  tokenAccountsMap: Map<string, string[]> | null;
  usedCacheForTokens: boolean;
  usedCacheForAccounts: boolean;
  cache: CacheFile;
}

async function resolveTokenWorkload(networkName: string): Promise<ResolvedWorkload> {
  const timestamp = Math.floor(Date.now() / 1000);
  let superTokens: SuperTokenMeta[];
  let usedCacheForTokens = false;

  if (USE_CACHE) {
    const loaded = loadLatestCache(networkName);
    if (!loaded?.tokens?.length) {
      stderrLog("ERR: USE_CACHE=1 but no cache found in cache-ts/ for this network");
      process.exit(2);
    }
    superTokens = loaded.tokens;
    usedCacheForTokens = true;
    infoLog(`Using cache only (USE_CACHE=1): ${superTokens.length} tokens from cache-ts/`);
  } else {
    try {
      superTokens = await fetchSuperTokens();
    } catch {
      const cache = loadLatestCache(networkName);
      if (!cache?.tokens?.length) {
        stderrLog("ERR: Subgraph failed and no persisted token list in cache-ts/");
        process.exit(2);
      }
      superTokens = cache.tokens;
      usedCacheForTokens = true;
      warnLog("WARN: Using persisted token list (subgraph unavailable)");
    }
  }

  const cache: CacheFile = {
    network: networkName,
    timestamp,
    tokens: superTokens,
    tokenAccounts: {},
  };

  let tokenAccountsMap: Map<string, string[]> | null = null;
  let usedCacheForAccounts = false;

  if (usedCacheForTokens) {
    const loaded = loadLatestCache(networkName);
    if (loaded?.tokenAccounts && Object.keys(loaded.tokenAccounts).length > 0) {
      cache.tokenAccounts = { ...loaded.tokenAccounts };
      usedCacheForAccounts = true;
      debugLog(
        `phase prepareAccounts | using cache for accounts (${Object.keys(cache.tokenAccounts).length} tokens from cache)`
      );
    } else if (USE_CACHE) {
      stderrLog("ERR: USE_CACHE=1 but cache has no tokenAccounts");
      process.exit(2);
    }
  }

  if (!usedCacheForAccounts) {
    try {
      tokenAccountsMap = await getAllAccountTokenSnapshots();
      debugLog(`phase prepareAccounts | global fetch done | ${tokenAccountsMap.size} tokens in map`);
    } catch (e) {
      stderrLog(e);
      const latest = loadLatestCache(networkName);
      if (latest?.tokenAccounts) {
        tokenAccountsMap = new Map(Object.entries(latest.tokenAccounts));
        usedCacheForAccounts = true;
        warnLog("WARN: Global account fetch failed, using persisted tokenAccounts from cache");
      } else {
        stderrLog("ERR: Global account fetch failed and no cache available");
        process.exit(2);
      }
    }
  }

  return {
    superTokens,
    tokenAccountsMap,
    usedCacheForTokens,
    usedCacheForAccounts,
    cache,
  };
}

// --- Close links ---
/** Subgraph Stream id format: senderAddress-receiverAddress-tokenAddress-revisionIndex */
function parseReceiverFromOutflowId(id: string): string {
  const parts = id.split("-");
  if (parts.length < 4) {
    throw new Error(`Invalid outflow id format (expected sender-receiver-token-revision): ${id}`);
  }
  const receiver = parts[1];
  if (!/^0x[a-fA-F0-9]{40}$/.test(receiver)) {
    throw new Error(`Invalid receiver address in outflow id: ${id}`);
  }
  return receiver;
}

async function getCFACloseLinks(
  chainId: number,
  token: string,
  account: string
): Promise<string[]> {
  const baseLink = `${STREAM_CLOSER_URL}?chainId=${chainId}&token=${token}&sender=${account}`;
  try {
    const outflows = await getAllOutflows(token, account);
    const receivers = outflows.map((id) => parseReceiverFromOutflowId(id));
    return receivers.length > 0
      ? receivers.map((r) => `${baseLink}&receiver=${r}`)
      : [baseLink];
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Invalid outflow id")) {
      throw e;
    }
    stderrLog("getting outflows failed");
    return [baseLink];
  }
}

// --- Phases ---
interface PrepareAccountsInput {
  superTokens: SuperTokenMeta[];
  tokenAccountsMap: Map<string, string[]> | null;
  usedCacheForTokens: boolean;
  usedCacheForAccounts: boolean;
  cache: CacheFile;
}

function prepareAccounts(input: PrepareAccountsInput): {
  tokenInitJobs: TokenInitJob[];
  accountCount: number;
} {
  const { superTokens, tokenAccountsMap, usedCacheForTokens, usedCacheForAccounts, cache } = input;
  const tokenInitJobs: TokenInitJob[] = [];
  let accountCount = 0;

  debugLog(`phase prepareAccounts | start | scanning ${superTokens.length} tokens`);

  for (let tokenIdx = 0; tokenIdx < superTokens.length; tokenIdx++) {
    const tokenMeta = superTokens[tokenIdx];
    const tokenAddr = tokenMeta.id as Address;
    let accounts: string[];
    const accountsSource = usedCacheForAccounts ? "cache" : "subgraph-global";

    if (usedCacheForTokens && tokenAddr in cache.tokenAccounts) {
      accounts = cache.tokenAccounts[tokenAddr];
    } else if (tokenAccountsMap) {
      accounts = tokenAccountsMap.get(tokenAddr) ?? [];
    } else {
      accounts = [];
    }

    if (accounts.length === 0 && !usedCacheForAccounts) {
      debugLog(
        `phase prepareAccounts | token ${tokenIdx + 1}/${superTokens.length} | ${tokenDisplay(tokenAddr, tokenMeta.symbol)} | 0 accounts | skipping`
      );
      continue;
    }

    if (process.env.DEBUG) {
      debugLog(
        `phase prepareAccounts | token ${tokenIdx + 1}/${superTokens.length} | ${tokenDisplay(tokenAddr, tokenMeta.symbol)} | ${accounts.length} accounts | source=${accountsSource}`
      );
    }

    cache.tokenAccounts[tokenAddr] = accounts;
    accountCount += accounts.length;

    tokenInitJobs.push({ tokenMeta, tokenAddr, accounts });
  }

  debugLog(
    `phase prepareAccounts | ${tokenInitJobs.length} tokens with accounts | ${accountCount} account snapshots`
  );

  return { tokenInitJobs, accountCount };
}

type ReadContractClient = { readContract: (...args: any[]) => Promise<any> };

interface TokenInitInput {
  tokenInitJobs: TokenInitJob[];
  host: Address;
  dustFilter: { address: string; above: number }[] | undefined;
  clientWithCount: ReadContractClient;
  adaptiveBatch: AdaptiveBatchState;
}

async function runTokenInit(input: TokenInitInput): Promise<{
  tokenContexts: Map<string, TokenContext>;
  realtimeJobs: RealtimeJob[];
}> {
  const { tokenInitJobs, host, dustFilter, clientWithCount, adaptiveBatch } = input;
  const tokenContexts = new Map<string, TokenContext>();
  const realtimeJobs: RealtimeJob[] = [];

  await runSequentialChunks(tokenInitJobs, RPC_BATCH_SIZE, async (chunk, chunkIdx, totalChunks) => {
    const chunkStart = process.env.DEBUG ? Date.now() : 0;

    const results = await processWithRetry(
      chunk,
      async (batch) =>
        Promise.all(
          batch.map(async (job) => {
            try {
              return (await clientWithCount.readContract({
                address: job.tokenAddr,
                abi: superTokenAbi,
                functionName: "getHost",
              })) as Address;
            } catch {
              return null;
            }
          })
        ),
      RETRY_ROUNDS,
      `tokenInit chunk ${chunkIdx}/${totalChunks}`,
      adaptiveBatch
    );

    let accepted = 0;
    results.forEach((tokenHost, idx) => {
      const job = chunk[idx];
      if (!tokenHost) return;

      if (tokenHost.toLowerCase() !== host.toLowerCase()) return;

      const warningThreshRaw =
        (dustFilter?.find((e) => e.address.toLowerCase() === job.tokenAddr.toLowerCase())?.above ??
          0) *
        86400 *
        365;
      const symbol = job.tokenMeta.symbol?.trim() || job.tokenAddr;

      tokenContexts.set(job.tokenAddr.toLowerCase(), {
        tokenAddr: job.tokenAddr,
        symbol,
        tokenMeta: job.tokenMeta,
        warningThreshold: BigInt(Math.max(0, Math.floor(warningThreshRaw))),
        totalAccounts: job.accounts.length,
        accountStates: [],
      });
      accepted++;

      for (const account of job.accounts) {
        realtimeJobs.push({ tokenAddr: job.tokenAddr, account: account as Address });
      }
    });

    if (process.env.DEBUG) {
      const chunkDuration = Date.now() - chunkStart;
      debugLog(
        `tokenInit ${chunkIdx}/${totalChunks} | ${chunk.length} tokens ${accepted} ok | ${chunkDuration}ms`
      );
    }
  });

  debugLog(
    `tokenInit done | ${tokenContexts.size} tokens | ${realtimeJobs.length} realtimeBalance reads queued`
  );

  return { tokenContexts, realtimeJobs };
}

interface RealtimeBalanceInput {
  realtimeJobs: RealtimeJob[];
  clientWithCount: ReadContractClient;
  tokenContexts: Map<string, TokenContext>;
  adaptiveBatch: AdaptiveBatchState;
}

async function runRealtimeBalances(input: RealtimeBalanceInput): Promise<{
  followupJobs: FollowupJob[];
  criticalCount: number;
}> {
  const { realtimeJobs, clientWithCount, tokenContexts, adaptiveBatch } = input;
  const followupJobs: FollowupJob[] = [];
  let criticalCount = 0;

  await runSequentialChunks(realtimeJobs, RPC_BATCH_SIZE, async (chunk, chunkIdx, totalChunks) => {
    const chunkStart = process.env.DEBUG ? Date.now() : 0;
    const results = await processWithRetry(
      chunk,
      async (batch) =>
        Promise.all(
          batch.map(async (job) => {
            try {
              return await clientWithCount.readContract({
                address: job.tokenAddr,
                abi: superTokenAbi,
                functionName: "realtimeBalanceOfNow",
                args: [job.account],
              });
            } catch {
              return null;
            }
          })
        ),
      RETRY_ROUNDS,
      `realtimeBalance chunk ${chunkIdx}/${totalChunks}`,
      adaptiveBatch
    );

    results.forEach((rtb, idx) => {
      const job = chunk[idx];
      const tokenCtx = tokenContexts.get(job.tokenAddr.toLowerCase());
      if (!tokenCtx) return;

      if (!rtb) return;

      const [availableBalance, deposit, owedDeposit] = rtb as readonly [bigint, bigint, bigint];
      const hasDeposit = deposit > 0n || owedDeposit > 0n;
      const depositConsumedPct = calcDepositConsumedPct(availableBalance, deposit);

      if (availableBalance < 0n) {
        criticalCount++;
        if (hasDeposit) {
          followupJobs.push({
            tokenAddr: job.tokenAddr,
            account: job.account,
            availableBalance,
            deposit,
          });
          return;
        }
      }

      tokenCtx.accountStates.push({
        account: job.account,
        availableBalance,
        pppPeriod: PPP_PERIOD.PLEB,
        depositConsumedPct,
        belowWarningThreshold: false,
      });
    });

    if (process.env.DEBUG) {
      debugLog(
        `realtimeBalance ${chunkIdx}/${totalChunks} | ${chunk.length} reads ${Date.now() - chunkStart}ms`
      );
    }
  });

  debugLog(`realtimeBalance done | followup ${followupJobs.length} accounts`);

  return { followupJobs, criticalCount };
}

interface FollowupChecksInput {
  followupJobs: FollowupJob[];
  cfaAddr: Address;
  clientWithCount: ReadContractClient;
  tokenContexts: Map<string, TokenContext>;
  network: { contractsV1: { toga?: string } };
  adaptiveBatch: AdaptiveBatchState;
}

async function runFollowupChecks(input: FollowupChecksInput): Promise<{
  patricianCount: number;
  insolventCount: number;
  insolventBelowThresholdCount: number;
}> {
  const { followupJobs, cfaAddr, clientWithCount, tokenContexts, network, adaptiveBatch } = input;
  let patricianCount = 0;
  let insolventCount = 0;
  let insolventBelowThresholdCount = 0;

  await runSequentialChunks(followupJobs, RPC_BATCH_SIZE, async (chunk, chunkIdx, totalChunks) => {
    const chunkStart = process.env.DEBUG ? Date.now() : 0;
    const results = await processWithRetry(
      chunk,
      async (batch) =>
        Promise.all(
          batch.map(async (job) => {
            try {
              const [patricianResult, solventResult] = await Promise.allSettled([
                clientWithCount.readContract({
                  address: cfaAddr,
                  abi: cfaAbi,
                  functionName: "isPatricianPeriodNow",
                  args: [job.tokenAddr, job.account],
                }),
                clientWithCount.readContract({
                  address: job.tokenAddr,
                  abi: superTokenAbi,
                  functionName: "isAccountSolventNow",
                  args: [job.account],
                }),
              ]);

              if (solventResult.status !== "fulfilled") return null;

              return {
                isPatrician:
                  patricianResult.status === "fulfilled"
                    ? (patricianResult.value as boolean)
                    : false,
                isSolvent: solventResult.value as boolean,
              };
            } catch {
              return null;
            }
          })
        ),
      RETRY_ROUNDS,
      `followupChecks chunk ${chunkIdx}/${totalChunks}`,
      adaptiveBatch
    );

    results.forEach((followup, idx) => {
      const job = chunk[idx];
      const tokenCtx = tokenContexts.get(job.tokenAddr.toLowerCase());
      if (!tokenCtx) return;

      if (!followup) return;

      let pppPeriod: number = PPP_PERIOD.PLEB;
      let belowWarningThreshold = false;
      if (followup.isPatrician) {
        pppPeriod = PPP_PERIOD.PATRICIAN;
        patricianCount++;
      }

      if (!followup.isSolvent) {
        pppPeriod = PPP_PERIOD.PIRATE;
        insolventCount++;
        if (-job.availableBalance < tokenCtx.warningThreshold) {
          insolventBelowThresholdCount++;
          belowWarningThreshold = true;
        } else {
          infoLog(
            `insolvent: token ${job.tokenAddr}, account ${job.account}` +
              (job.account.toLowerCase() === (network.contractsV1.toga ?? "").toLowerCase()
                ? " (TOGA)"
                : "")
          );
        }
      }

      const depositConsumedPct = calcDepositConsumedPct(job.availableBalance, job.deposit);

      tokenCtx.accountStates.push({
        account: job.account,
        availableBalance: job.availableBalance,
        pppPeriod,
        depositConsumedPct,
        belowWarningThreshold,
      });
    });

    if (process.env.DEBUG) {
      const chunkDuration = Date.now() - chunkStart;
      debugLog(
        `followupChecks ${chunkIdx}/${totalChunks} | ${chunk.length} reads ${chunkDuration}ms`
      );
    }
  });

  debugLog(`followupChecks done`);

  return { patricianCount, insolventCount, insolventBelowThresholdCount };
}

interface ReportInput {
  tokenContexts: Map<string, TokenContext>;
  chainId: number;
  depositConsumedThresholdPct: number;
}

async function report(input: ReportInput): Promise<boolean> {
  const { tokenContexts, chainId, depositConsumedThresholdPct } = input;
  let triggerAlert = false;

  for (const tokenCtx of tokenContexts.values()) {
    const { tokenAddr, symbol, tokenMeta, totalAccounts, accountStates } = tokenCtx;

    if (process.env.DEBUG) {
      debugLog(`token ${symbol} | summary | ${totalAccounts} accounts`);
    }

    const badAccountStates = accountStates.filter(
      (s) => s.depositConsumedPct > depositConsumedThresholdPct && !s.belowWarningThreshold
    );

    if (badAccountStates.length > 0) {
      warnLog(
        `Negative accounts for token ${symbol} (${tokenAddr}) with >${depositConsumedThresholdPct}% buffer consumed:`
      );
      const lines = await Promise.all(
        badAccountStates.map(async (a) => {
          const links = await getCFACloseLinks(chainId, tokenAddr, a.account);
          const linksStr = links.map((l, i) => `<${l}|Close${i + 1}>`).join(", ");
          return `  ${a.account} balance ${formatEther(a.availableBalance)} ppp ${pppPeriodName(a.pppPeriod)} ${a.depositConsumedPct}% | ${linksStr}`;
        })
      );
      warnLog(lines.join("\n"));
      triggerAlert = true;
      if (
        !tokenMeta.isListed ||
        TOKEN_ALERT_SKIP_LIST.some((x) => x.toLowerCase() === tokenAddr.toLowerCase())
      ) {
        triggerAlert = false;
      }
    }
  }

  return triggerAlert;
}

// --- Main ---
async function run(): Promise<void> {
  if (!NETWORK_NAME) {
    stderrLog("ERR: NETWORK_NAME env var required");
    process.exit(1);
  }

  const network = sfMeta.getNetworkByName(NETWORK_NAME);
  if (!network) {
    stderrLog(`ERR: network ${NETWORK_NAME} not found. Check NETWORK_NAME.`);
    process.exit(1);
  }

  const rpcUrlOverride = process.env[`${network.uppercaseName}_PROVIDER_URL`];
  const rpcUrl =
    rpcUrlOverride ?? `https://${network.name}.sfrpc.x.superfluid.dev?app=solvency-checker`;

  const subgraphUrlOverride = process.env[`${network.uppercaseName}_SUBGRAPH_URL`];
  subgraphUrl =
    subgraphUrlOverride ?? `https://${network.name}.subgraph.x.superfluid.dev?app=solvency-checker`;

  const depositConsumedThresholdPct = Math.floor(BUFFER_WARN_THRESHOLD_PCT);
  const host = network.contractsV1.host as Address;
  const cfaAddr = network.contractsV1.cfaV1 as Address;

  // Load dust filter: per-token threshold (above = max wei·seconds to treat as dust, in years).
  // Used as above * 86400 * 365 to get wei·seconds; insolvent accounts below that are not alerted.
  let dustFilter: { address: string; above: number }[] | undefined;
  try {
    const th = JSON.parse(readFileSync(THRESHOLDS_FILE, "utf-8"));
    dustFilter = th.networks?.[network.chainId]?.thresholds;
  } catch {
    // no thresholds file
  }

  // Resolve chain by chainId from viem (includes multicall3), or fall back to minimal defineChain
  const chainsArray = (Object.values(viemChains) as unknown[]).filter(
    (v): v is Chain =>
      typeof v === "object" && v !== null && "id" in v && typeof (v as { id?: unknown }).id === "number"
  ) as Chain[];
  const viemChain = extractChain({ chains: chainsArray, id: network.chainId });
  const chain: Chain = viemChain
    ? { ...viemChain, rpcUrls: { default: { http: [rpcUrl] } } }
    : defineChain({
        id: network.chainId,
        name: network.name,
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      });
  if (process.env.DEBUG) {
    const hasMulticall = !!(chain as { contracts?: { multicall3?: unknown } }).contracts?.multicall3;
    debugLog(`chain | id=${chain.id} | from viem=${!!viemChain} | multicall3=${hasMulticall}`);
  }

  // DEBUG: reads = app-level readContract; eth_calls = JSON-RPC batch (may be multicalls)
  let rpcReqId = 0;
  const rpcReqQueue: { id: number; start: number }[] = [];

  let rpcRequestCount = 0;
  const client = createPublicClient({
    chain,
    batch:
      MULTICALL_CALLDATA_KB > 0
        ? { multicall: { batchSize: MULTICALL_CALLDATA_KB * 1024 } }
        : undefined,
    transport: http(rpcUrl, {
      batch: { batchSize: RPC_BATCH_SIZE, wait: 0 },
      retryCount: 0,
      onFetchRequest: (request) => {
        const id = ++rpcReqId;
        const start = Date.now();
        rpcReqQueue.push({ id, start });
        if (process.env.DEBUG) {
          request.clone().text().then((text) => {
            try {
              const parsed = JSON.parse(text);
              const n = Array.isArray(parsed) ? parsed.length : 1;
              debugLog(`RPC #${id} → ${n} eth_calls`);
            } catch {
              debugLog(`RPC #${id} → ?`);
            }
          });
        }
      },
      onFetchResponse: (response) => {
        const req = rpcReqQueue.shift();
        if (req && process.env.DEBUG) {
          debugLog(`RPC #${req.id} ← ${response.status} ${Date.now() - req.start}ms`);
        }
      },
    }),
  });

  // Count RPC by wrapping - use a simple increment on each request
  // viem doesn't expose request count easily; we approximate via readContract calls
  const clientWithCount = {
    ...client,
    readContract: async (...args: Parameters<typeof client.readContract>) => {
      rpcRequestCount++;
      return client.readContract(...args);
    },
  };

  const workload = await resolveTokenWorkload(NETWORK_NAME);
  const { superTokens, tokenAccountsMap, usedCacheForTokens, usedCacheForAccounts, cache } =
    workload;

  infoLog(`Checking ${superTokens.length} ${NETWORK_NAME} tokens… (RPC: ${rpcUrl})`);
  debugLog(
    `config | rpcBatchSize=${RPC_BATCH_SIZE} | multicallCalldataKb=${MULTICALL_CALLDATA_KB} | retryRounds=${RETRY_ROUNDS} | useCache=${USE_CACHE} | network=${NETWORK_NAME}`
  );

  // RPC health
  let chainId: number;
  let blockNumber: bigint;
  let rpcDriftS: number;
  try {
    chainId = await client.getChainId();
    blockNumber = await client.getBlockNumber();
    const block = await client.getBlock({ blockNumber });
    rpcDriftS = Math.floor(Date.now() / 1000) - Number(block.timestamp);
  } catch (e) {
    warnLog(`:rotating_light: <!channel> communicating with ${NETWORK_NAME} RPC failed`);
    process.exit(1);
  }

  cache.chainId = chainId;
  cache.blockNumber = Number(blockNumber);
  const infoMsg =
    `last block: ${blockNumber}` +
    (dustFilter ? ", dustfilter used, " : ", ") +
    `RPC drift: ${rpcDriftS}s`;
  if (rpcDriftS > RPC_DRIFT_WARN_THRESHOLD) {
    warnLog(infoMsg + " <- :rotating_light: <!channel>");
  } else {
    infoLog(infoMsg);
  }

  if (process.env.SENTINEL_ACCOUNT) {
    const bal = await client.getBalance({ address: process.env.SENTINEL_ACCOUNT as Address });
    infoLog(`sentinel ${process.env.SENTINEL_ACCOUNT} balance: ${formatEther(bal)}`);
  }

  const adaptiveBatch: AdaptiveBatchState = { currentMax: RPC_BATCH_SIZE, consecutiveFullFailures: 0 };

  // Phase 0: build token/account workload
  const { tokenInitJobs, accountCount } = prepareAccounts({
    superTokens,
    tokenAccountsMap,
    usedCacheForTokens,
    usedCacheForAccounts,
    cache,
  });

  saveCache(cache);

  // Phase 0b: token init (getHost, filter by host, queue realtimeBalance jobs)
  const { tokenContexts, realtimeJobs } = await runTokenInit({
    tokenInitJobs,
    host,
    dustFilter,
    clientWithCount,
    adaptiveBatch,
  });

  if (tokenContexts.size === 0 && tokenInitJobs.length > 0) {
    stderrLog(
      "ERR: No tokens passed host check. All tokens may use a different Superfluid host (wrong network?)."
    );
    process.exit(2);
  }

  // Phase 1: realtimeBalanceOfNow for all token/account pairs
  const { followupJobs, criticalCount: realtimeCriticalCount } = await runRealtimeBalances({
    realtimeJobs,
    clientWithCount,
    tokenContexts,
    adaptiveBatch,
  });

  // Phase 2: patrician + solvency checks for negative accounts with deposits
  const {
    patricianCount,
    insolventCount,
    insolventBelowThresholdCount,
  } = await runFollowupChecks({
    followupJobs,
    cfaAddr,
    clientWithCount,
    tokenContexts,
    network,
    adaptiveBatch,
  });

  const criticalCount = realtimeCriticalCount - insolventCount;

  // Phase 3: report
  const triggerAlert = await report({
    tokenContexts,
    chainId,
    depositConsumedThresholdPct,
  });

  saveCache(cache);

  infoLog(
    `Checked ${superTokens.length} tokens, ${accountCount} accs, ` +
      `${criticalCount} critical (${patricianCount} patrician), ${insolventCount} insolvent (${insolventBelowThresholdCount} dust) | ~${rpcRequestCount} RPC`
  );

  if (triggerAlert) {
    warnLog(`:rotating_light: <!channel> ${NETWORK_NAME}: NEGATIVE ACCOUNTS DETECTED!`);
  } else {
    infoLog(`:white_check_mark: ${NETWORK_NAME}: No neg. accs detected`);
  }
}

run().catch((e) => {
  stderrLog(e);
  process.exit(1);
});
