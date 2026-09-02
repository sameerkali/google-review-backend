import "dotenv/config";
import mongoose from "mongoose";
import Plan from "./models/Plan.js";
import Hardware from "./models/Hardware.js";
import Business from "./models/Business.js";
import MenuItem from "./models/MenuItem.js";

const plans = [
  { name: "Basic", billingType: "monthly", price: 299, features: { analytics: "none", userData: false, suggestions: false } },
  { name: "Starter", billingType: "monthly", price: 599, features: { analytics: "basic", userData: true, suggestions: false } },
  { name: "Pro", billingType: "monthly", price: 999, features: { analytics: "full", userData: true, suggestions: true } },
];
const hardware = [
  { type: "QR", serial: "QR000001" },
  { type: "QR", serial: "QR000002" },
  { type: "NFC", serial: "NFC000001" },
];

// One real, walkable demo — the Stage 1 build order calls for "one seeded
// demo restaurant with a real menu" so the /r/DEMO-CAFE flow can be shown on
// a prospect's own phone before any paying customer exists.
const DEMO_CODE = "DEMO-CAFE";
const demoMenu = [
  "Cold Brew", "Cappuccino", "Masala Chai", "Filter Coffee",
  "Avocado Toast", "Club Sandwich", "Margherita Pizza", "Pasta Alfredo",
  "Chocolate Brownie", "Cheesecake",
];

await mongoose.connect(process.env.MONGO_URI);

await Plan.deleteMany({});
await Plan.insertMany(plans);

await Hardware.deleteMany({});
await Hardware.insertMany(hardware);

await MenuItem.deleteMany({});

// Idempotent — re-running the seed script updates the demo business instead
// of erroring on the unique email, or piling up duplicate hardware/menu rows.
let demo = await Business.findOne({ email: "demo@expendifii.com" });
if (!demo) {
  demo = await Business.create({
    name: "Demo Cafe",
    email: "demo@expendifii.com",
    city: "Delhi",
    // Placeholder — replace with the real Place ID Finder link before
    // demoing this to an actual prospect (see plan section 3.6).
    googleReviewUrl: "https://search.google.com/local/writereview?placeid=REPLACE_ME",
    status: "active",
  });
}
await Hardware.findOneAndUpdate(
  { serial: DEMO_CODE },
  { type: "QR", serial: DEMO_CODE, assignedBusinessId: demo._id, status: "assigned" },
  { upsert: true }
);
await MenuItem.insertMany(demoMenu.map((name, i) => ({ businessId: demo._id, name, sortOrder: i })));

console.log(`Seeded 3 plans, ${hardware.length + 1} hardware, and a demo business at /r/${DEMO_CODE} with ${demoMenu.length} menu items.`);
await mongoose.disconnect();
