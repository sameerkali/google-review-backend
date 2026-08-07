import mongoose from "mongoose";

const businessSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    owner: String,
    phone: String,
    email: { type: String, required: true, unique: true },
    address: String,
    googleReviewUrl: String,
    logoUrl: String,
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan" },
    status: { type: String, enum: ["active", "suspended", "expired"], default: "active" },
    renewalDate: Date,
  },
  { timestamps: true }
);

export default mongoose.model("Business", businessSchema);