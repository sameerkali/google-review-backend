import mongoose from "mongoose";

const eventSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    hardwareId: { type: mongoose.Schema.Types.ObjectId, ref: "Hardware" },
    code: String,
    eventType: { type: String, enum: ["scan", "google_click", "review_copy"], required: true },
    browser: String,
    device: { type: String, enum: ["mobile", "desktop", "tablet"] },
    os: String,
    ipHash: String,
    city: String,
    country: String,
  },
  { timestamps: true }
);

eventSchema.index({ businessId: 1, createdAt: -1 });
// Covers the per-eventType counts run on every admin/business analytics load.
eventSchema.index({ businessId: 1, eventType: 1 });
export default mongoose.model("AnalyticsEvent", eventSchema);