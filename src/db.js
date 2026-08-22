import mongoose from "mongoose";

// Cached across invocations within the same lambda container — without this,
// a serverless deployment opens a brand new MongoDB connection on every cold
// start (and can exhaust the DB's connection limit under concurrent load).
let connection = null;

export function connectDB() {
  if (connection) return connection;

  mongoose.set("bufferCommands", false);

  connection = mongoose
    .connect(process.env.MONGO_URI || "mongodb://localhost:27017/qr_review_platform", {
      serverSelectionTimeoutMS: 5000,
      // Many concurrent serverless instances each hold their own pool — keep
      // it small so they don't collectively blow past the DB's connection cap.
      maxPoolSize: 10,
    })
    .then((m) => {
      console.log("MongoDB connected ✓");
      return m;
    })
    .catch((err) => {
      connection = null; // let the next request retry instead of caching a permanent failure
      throw err;
    });

  return connection;
}
