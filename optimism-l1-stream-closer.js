/**
 * Example invocation on goerli:
 * PRIVKEY=0x123... L1RPC=https://eth-goerli.rpc.x.superfluid.dev PORTAL=0x5b47E1A08Ea6d985D6649300584e6722Ec4B1383 HOST=0xE40983C2476032A0915600b9472B3141aA5B5Ba9 CFA=0xff48668fa670A85e55A7a822b352d5ccF3E7b18C TOKEN=0xe01f8743677da897f4e7de9073b57bf034fc2433 SENDER=0x30B125d5Fc58c1b8E3cCB2F1C71a1Cc847f024eE RECEIVER=0xC20a5455035Ab593682Cf9b9916b9407cc9e47f3 node optimism-l1-stream-closer.js
 * Deployment addresses can be found in https://github.com/ethereum-optimism/optimism/tree/master/packages/contracts-bedrock/deployments - make sure to pick the proxy
 * mainnet portal: 0xbEb5Fc579115071764c7423A4f12eDde41f106Ed
 */

const { ethers, Wallet, Contract, utils } = require("ethers");
HostAbi = require("./abis/ISuperfluid");
CFAAbi = require("./abis/CFAv1");
OptimismPortalAbi = require("./abis/OptimismPortal");

l1RPC = process.env.L1RPC;

cfaAddr = process.env.CFA;
hostAddr = process.env.HOST;
portalAddr = process.env.PORTAL;
tokenAddr = process.env.TOKEN;
senderAddr = process.env.SENDER;
receiverAddr = process.env.RECEIVER;
privKey = process.env.PRIVKEY;

l1Provider = new ethers.providers.JsonRpcProvider(l1RPC);

host = new Contract(cfaAddr, HostAbi);
cfa = new Contract(cfaAddr, CFAAbi);

encodedCFACall = cfa.interface.encodeFunctionData("deleteFlow", [tokenAddr, senderAddr, receiverAddr, "0x"]);
encodedHostCall = host.interface.encodeFunctionData("callAgreement", [cfaAddr, encodedCFACall, "0x"]);

console.log("calldata", encodedHostCall);

l1Signer = new Wallet(privKey, l1Provider)

portal = new Contract(portalAddr, OptimismPortalAbi, l1Signer);

// function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes memory _data)
portal.depositTransaction(hostAddr, 0, 3500000, false, encodedHostCall, { value: utils.parseEther('0.0') })
    .then((res, err) => {
        if (err) {
            console.error("ERR:", err.toString());
        } else {
            console.log("RESULT:", JSON.stringify(res, null, 2));
        }
    }
);
