import mongoose from "mongoose";

const hardwareSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["QR", "NFC"], required: true },
    serial: { type: String, required: true, unique: true },
    assignedBusinessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      default: null,
    },
    status: { type: String, enum: ["available", "assigned", "lost", "damaged"], default: "available" },
  },
  { timestamps: true }
);

export default mongoose.model("Hardware", hardwareSchema);