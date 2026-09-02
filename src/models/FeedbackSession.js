import mongoose from "mongoose";

// A single scan-to-review journey. One document per QR scan — screens
// PATCH their answers onto it, then it's copied and/or clicked through to
// Google. We deliberately never store the customer's final edited review
// text (see draftEdited/finalLength below) — only what we generated and
// whether they changed it, so we're never in the business of authoring or
// holding what a customer actually posted.
const feedbackSessionSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    qrCodeId: { type: mongoose.Schema.Types.ObjectId, ref: "Hardware" },
    sessionToken: { type: String, required: true, unique: true },
    startedAt: { type: Date, default: Date.now },
    completedAt: Date,

    rating: { type: Number, min: 1, max: 5 },
    menuItemIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "MenuItem" }],
    freeTextItem: String,
    aspects: [String],

    draftGenerated: String,
    draftEdited: Boolean,
    finalLength: Number,

    copiedAt: Date,
    googleClickedAt: Date,

    device: {
      os: String,
      browser: String,
      isMobile: Boolean,
    },
    referrerType: { type: String, enum: ["qr", "nfc", "direct"], default: "qr" },
  },
  { timestamps: true }
);

feedbackSessionSchema.index({ businessId: 1, startedAt: -1 });

export default mongoose.model("FeedbackSession", feedbackSessionSchema);
