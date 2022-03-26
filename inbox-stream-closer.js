ethers = require("ethers");
CTCAbi = require("./abis/CanonicalTransactionChain");
HostAbi = require("./abis/ISuperfluid");
CFAAbi = require("./abis/CFAv1");

l2RPC = process.env.L2RPC;
l1RPC = process.env.L1RPC;

cfaAddr = process.env.CFA;
hostAddr = process.env.HOST;

l2Provider = new ethers.providers.JsonRpcProvider(l2RPC);
l1Provider = new ethers.providers.JsonRpcProvider(l1RPC);

host = new ethers.Contract(cfaAddr, HostAbi, l2Provider);
cfa = new ethers.Contract(cfaAddr, CFAAbi, l2Provider);

tokenAddr = process.env.TOKEN;
senderAddr = process.env.SENDER;
receiverAddr = process.env.RECEIVER;

encodedCFACall = cfa.interface.encodeFunctionData("deleteFlow", [tokenAddr, senderAddr, receiverAddr, "0x"]);
encodedHostCall = host.interface.encodeFunctionData("callAgreement", [cfaAddr, encodedCFACall, "0x"]);

console.log("calldata", encodedHostCall);

ctcAddr = process.env.CTC;


privKey = process.env.PRIVKEY;
l1Signer = new ethers.Wallet(privKey, l1Provider)

ctc = new ethers.Contract(ctcAddr, CTCAbi, l1Signer);

// see https://github.com/ethereum-optimism/optimism/blob/84c3da1cd07aa426fa9f39fca2509d4e3b5187ec/packages/contracts/contracts/L1/rollup/CanonicalTransactionChain.sol#L201
ctc.enqueue(hostAddr, 500000, encodedHostCall); // target, gas limit, L2 calldata
