import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    reviewText: { type: String, required: true },
    status: { type: String, enum: ["unused", "reserved", "used"], default: "unused" },
    reservedAt: Date,
    usedAt: Date,
  },
  { timestamps: true }
);

// Covers the hot GET /r/:code reservation query ({businessId, status}) as well
// as the businessId-only sorted lists in /business/me/reviews and /admin/reviews.
reviewSchema.index({ businessId: 1, status: 1, createdAt: -1 });

export default mongoose.model("ReviewSuggestion", reviewSchema);