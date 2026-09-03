import mongoose from "mongoose";

const businessSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    owner: String,
    phone: String,
    email: { type: String, required: true, unique: true },
    address: String,
    city: String,
    // Frontend already validates the http(s):// prefix before sending, but
    // that's not something the server should rely on to hold.
    website: {
      type: String,
      validate: {
        validator: (v) => !v || /^https?:\/\//i.test(v),
        message: "website must start with http:// or https://",
      },
    },
    // Handed back to end-user clients verbatim (feedback.js's /clicked route)
    // for the browser to navigate to — validated the same way `website` is
    // so a non-http(s) scheme (e.g. javascript:) can't end up there.
    googleReviewUrl: {
      type: String,
      validate: {
        validator: (v) => !v || /^https?:\/\//i.test(v),
        message: "googleReviewUrl must start with http:// or https://",
      },
    },
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