/**
 * Example invocation with CTC on goerli:
 * PRIVKEY=0x123... L1RPC=https://eth-goerli.rpc.x.superfluid.dev HOST=0x22ff293e14F1EC3A09B137e9e06084AFd63adDF9 CFA=0xEd6BcbF6907D4feEEe8a8875543249bEa9D308E8 CTC=0x607F755149cFEB3a14E1Dc3A4E2450Cde7dfb04D TOKEN=0xe01f8743677da897f4e7de9073b57bf034fc2433 SENDER=0x30B125d5Fc58c1b8E3cCB2F1C71a1Cc847f024eE RECEIVER=0xC20a5455035Ab593682Cf9b9916b9407cc9e47f3 node inbox-stream-closer.js
 */

ethers = require("ethers");
CTCAbi = require("./abis/CanonicalTransactionChain");
HostAbi = require("./abis/ISuperfluid");
CFAAbi = require("./abis/CFAv1");

l1RPC = process.env.L1RPC;

cfaAddr = process.env.CFA;
hostAddr = process.env.HOST;

l1Provider = new ethers.providers.JsonRpcProvider(l1RPC);

host = new ethers.Contract(cfaAddr, HostAbi);
cfa = new ethers.Contract(cfaAddr, CFAAbi);

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
ctc.enqueue(hostAddr, 500000, encodedHostCall).then((res, err) => {
    if (err) {
        console.error("ERR:", err.toString());
    } else {
        console.log("RESULT:", JSON.stringify(res, null, 2));
    }
}); // target, gas limit, L2 calldata
