import "dotenv/config";
import mongoose from "mongoose";
import Plan from "./models/Plan.js";
import Hardware from "./models/Hardware.js";
import ReviewSuggestion from "./models/ReviewSuggestion.js";

const plans = [
  { name: "Starter", billingType: "one_time", price: 999, features: { analytics: false, nfc: false } },
  { name: "Basic", billingType: "monthly", price: 299, features: { analytics: true, nfc: false } },
  { name: "Standard", billingType: "monthly", price: 499, features: { analytics: true, nfc: true } },
];
const hardware = [
  { type: "QR", serial: "QR000001" },
  { type: "QR", serial: "QR000002" },
  { type: "NFC", serial: "NFC000001" },
];

await mongoose.connect(process.env.MONGO_URI);
await Plan.deleteMany({});
await Plan.insertMany(plans);
await Hardware.deleteMany({});
await Hardware.insertMany(hardware);
await ReviewSuggestion.deleteMany({});
console.log("Seeded 3 plans, 3 hardware, empty review pool.");
await mongoose.disconnect();