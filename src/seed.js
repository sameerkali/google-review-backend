import "dotenv/config";
import mongoose from "mongoose";
import Plan from "./models/Plan.js";
import Hardware from "./models/Hardware.js";
import ReviewSuggestion from "./models/ReviewSuggestion.js";

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

await mongoose.connect(process.env.MONGO_URI);
await Plan.deleteMany({});
await Plan.insertMany(plans);
await Hardware.deleteMany({});
await Hardware.insertMany(hardware);
await ReviewSuggestion.deleteMany({});
console.log("Seeded 3 plans, 3 hardware, empty review pool.");
await mongoose.disconnect();