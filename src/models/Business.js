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
    // Lets the business owner log into their own portal. Optional — set by an
    // admin (onboarding wizard or Edit Business), never self-registered.
    passwordHash: { type: String, select: false },
  },
  { timestamps: true }
);

// Looked up when a plan is deleted (Business.updateMany({ planId }, ...)).
businessSchema.index({ planId: 1 });

export default mongoose.model("Business", businessSchema);