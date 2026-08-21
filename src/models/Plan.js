import mongoose from "mongoose";

const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    billingType: { type: String, enum: ["one_time", "monthly", "annually"], default: "monthly" },
    price: { type: Number, required: true },
    features: {
      // What level of analytics the business owner sees for their own account.
      analytics: { type: String, enum: ["none", "basic", "full"], default: "none" },
      // Whether the business owner sees who scanned (device/browser/time), not just counts.
      userData: { type: Boolean, default: false },
      // Whether the business gets actionable suggestions to increase foot traffic.
      suggestions: { type: Boolean, default: false },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model("Plan", planSchema);