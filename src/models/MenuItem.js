import mongoose from "mongoose";

const menuItemSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    name: { type: String, required: true, trim: true },
    category: String,
    price: { type: Number, min: 0 },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    featured: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Covers the hot GET /feedback/:token/menu lookup (active items for a
// business, in display order) as well as the admin per-business list.
menuItemSchema.index({ businessId: 1, active: 1, sortOrder: 1 });

export default mongoose.model("MenuItem", menuItemSchema);
