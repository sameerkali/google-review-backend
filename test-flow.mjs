import { MongoMemoryServer } from "mongodb-memory-server";
import { spawn } from "node:child_process";

const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri("expendifii_test");
process.env.PORT = "5111";
process.env.ADMIN_PASSWORD = "admin123";
process.env.JWT_SECRET = "test-secret";

const api = spawn("node", ["src/server.js"], { cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"] });
const BASE = "http://localhost:5111";

const wait = (ms) => new Promise((f) => setTimeout(f, ms));
for (let i = 0; i < 40; i++) {
  try {
    const h = await fetch(BASE + "/health");
    if (h.ok) break;
  } catch {}
  await wait(250);
}

const run = async (label, method, path, body, token) => {
  const headers = { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Safari" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  console.log(`\n${label}  ${method} ${path} -> ${res.status}`);
  console.log(JSON.stringify(data, null, 1));
  return data;
};

const loginRes = await run("A1","POST","/admin/login",{ password: "admin123" });
const token = loginRes.token;

await run("A2","POST","/admin/plans",{ name: "Basic", billingType:"monthly", price:299, features:{analytics:true} }, token);
await run("A3","POST","/admin/plans",{ name: "Standard", billingType:"monthly", price:499, features:{analytics:true,nfc:true} }, token);
await run("A3b","POST","/admin/hardware",{ type:"QR", serial:"QR000001" }, token);
const biz = await run("A4","POST","/admin/business",{ name:"Cafe Delhi", owner:"Sameer", email:"cafe@expendifii.com", address:"Delhi, India", googleReviewUrl:"https://maps.google.com?cid=123", serial:["QR000001"] }, token);
await run("A5","PUT","/admin/business/"+biz._id,{ status:"active" }, token);
await run("A6","POST","/admin/review-suggestions",{ businessId:biz._id, reviewText:"Great coffee and quick service!" }, token);

const public1 = await run("B1","GET","/r/QR000001");
await run("B2","POST","/analytics",{ code:"QR000001" });
await run("B3","POST","/copy",{ code:"QR000001" });
await run("B4","POST","/open-google",{ code:"QR000001" });

await run("A7","GET","/admin/business", null, token);
await run("A8","GET","/admin/hardware", null, token);
await run("A9","GET","/admin/analytics", null, token);
await run("A10","GET","/admin/overview", null, token);

api.kill();
await mongod.stop();
console.log("\nDONE");