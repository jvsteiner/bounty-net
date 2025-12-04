import { readFileSync } from "fs";

// Parse CBOR-encoded unicity certificate to extract epoch
const tokenPath = process.argv[2] || "/Users/jamie/.bounty-net/tokens/reporter-test-000056772607a64e.json";
const tokenJson = JSON.parse(readFileSync(tokenPath, "utf-8"));
const certHex = tokenJson.genesis.inclusionProof.unicityCertificate;

console.log("Certificate hex (first 200 chars):", certHex.slice(0, 200));
console.log("\nOur trustbase epoch: 1");
console.log("Our trustbase networkId: 3");

// The certificate is CBOR encoded, epoch might be at offset
// d903ef = tag, 87 = array of 7, 01 = version, d903f0 = tag, 8a = array of 10
// First item after version should be epoch
// Let's look at bytes after the initial tags
const bytes = Buffer.from(certHex, 'hex');
console.log("\nFirst 50 bytes:", bytes.slice(0, 50).toString('hex'));
