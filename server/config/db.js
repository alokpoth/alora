const mongoose = require('mongoose');

let isMongoConnected = false;
let cachedPromise = null;

const connectDB = async () => {
  // If already connected, return immediately
  if (mongoose.connection.readyState === 1) {
    isMongoConnected = true;
    return mongoose.connection;
  }

  // If already connecting, share the existing in-flight Promise (prevents connection storms in serverless)
  if (cachedPromise) {
    return cachedPromise;
  }

  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/alokpoth_ai';
  const isLocalMongo = mongoUri.includes('localhost') || mongoUri.includes('127.0.0.1');
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const maxPool = isServerless ? 5 : 20;
  const minPool = isServerless ? 0 : 2;

  cachedPromise = mongoose.connect(mongoUri, {
    maxPoolSize: maxPool,
    minPoolSize: minPool,
    serverSelectionTimeoutMS: isLocalMongo ? 2500 : (isServerless ? 6000 : 10000),
    socketTimeoutMS: 30000,
    maxIdleTimeMS: isServerless ? 15000 : 30000,
    autoIndex: !isServerless
  }).then((conn) => {
    isMongoConnected = true;
    console.log(`[Database] MongoDB Connected: ${conn.connection.host} (Pool Size: ${minPool}-${maxPool}${isServerless ? ', serverless' : ''})`);
    return conn;
  }).catch((error) => {
    cachedPromise = null;
    isMongoConnected = false;
    console.log(`=================================================`);
    console.log(`[Database Note] Local MongoDB server not running or unreachable.`);
    console.log(`[Database Note] Server running in High-Performance In-Memory DB Mode.`);
    console.log(`[Database Note] All APIs, Auth, Admin & Redeem Codes are fully active.`);
    console.log(`=================================================`);
    return null;
  });

  return cachedPromise;
};

mongoose.connection.on('disconnected', () => {
  console.warn('[Database Note] MongoDB disconnected. Falling back to memory mode.');
  isMongoConnected = false;
  cachedPromise = null;
});

mongoose.connection.on('reconnected', () => {
  console.log('[Database Note] MongoDB reconnected.');
  isMongoConnected = true;
});

mongoose.connection.on('error', (err) => {
  console.warn('[Database Note] MongoDB error:', err.message);
  isMongoConnected = false;
  cachedPromise = null;
});

const getIsMongoConnected = () => isMongoConnected && mongoose.connection.readyState === 1;

let lastConnectAttemptTs = 0;
const DB_RETRY_COOLDOWN_MS = 15000;
const ensureDBConnected = async () => {
  if (getIsMongoConnected()) return true;
  const now = Date.now();
  if (!cachedPromise && (now - lastConnectAttemptTs) < DB_RETRY_COOLDOWN_MS) {
    return false;
  }
  lastConnectAttemptTs = now;
  try {
    await Promise.race([
      connectDB(),
      new Promise((resolve) => setTimeout(resolve, 4000))
    ]);
  } catch (e) {}
  return getIsMongoConnected();
};

module.exports = { connectDB, getIsMongoConnected, ensureDBConnected };
