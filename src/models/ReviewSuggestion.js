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

export default mongoose.model("ReviewSuggestion", reviewSchema);