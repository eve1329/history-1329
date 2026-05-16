import crypto from "node:crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

console.log("# Put this on the license server only:");
console.log(`LICENSE_SIGNING_PRIVATE_KEY=${JSON.stringify(privatePem)}`);
console.log("");
console.log("# Put this in license.json before building the desktop app:");
console.log(JSON.stringify({
  required: true,
  serverUrl: "https://your-license-server.example.com",
  publicKey: publicPem
}, null, 2));
