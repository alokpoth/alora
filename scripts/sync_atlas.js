const path = require('path');
const dotenv = require('dotenv');

// Securely load environment variables from root or server directory
dotenv.config();
dotenv.config({ path: path.join(__dirname, '../server/.env') });

const mongoose = require('mongoose');

// Securely retrieve the MongoDB connection string from environment variables
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!uri) {
  console.error('[Sync Error]: MONGODB_URI or MONGO_URI is not set in environment variables.');
  console.error('Please define MONGODB_URI in your .env file before running this script.');
  process.exit(1);
}

const supabase = require('../server/config/supabase');

(async () => {
  try {
    const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    console.log('[Sync] Connected to MongoDB Atlas successfully.');
    const db = conn.connection.db;

    // 1. Sync Models from Supabase to MongoDB Atlas
    if (supabase) {
      const { data: mData } = await supabase.from('api_keys').select('api_key').eq('model_id', '__models_metadata__').single();
      if (mData && mData.api_key) {
        const models = JSON.parse(mData.api_key);
        for (const m of models) {
          const doc = {
            model_id: m.id || m.model_id,
            name: m.name,
            provider: m.provider || 'Alora',
            type: m.type || 'custom',
            base_url: m.base_url || '',
            api_key: m.api_key || '',
            premium: !!m.premium,
            efficient: !!m.efficient,
            order: m.order || 0,
            api_model_1: m.api_model_1 || m.model_id || m.id || '',
            fallback_url_1: m.fallback_url_1 || '',
            fallback_key_1: m.fallback_key_1 || '',
            fallback_model_1: m.fallback_model_1 || '',
            api_model_2: m.api_model_2 || '',
            fallback_url_2: m.fallback_url_2 || '',
            fallback_key_2: m.fallback_key_2 || '',
            fallback_model_2: m.fallback_model_2 || '',
            api_model_3: m.api_model_3 || ''
          };
          await db.collection('aimodels').updateOne(
            { model_id: doc.model_id },
            { $set: doc },
            { upsert: true }
          );
        }
        console.log(`[Sync] Successfully synced ${models.length} models into MongoDB Atlas!`);
      }

      // 2. Sync Plans from Supabase to MongoDB Atlas
      const { data: pData } = await supabase.from('api_keys').select('api_key').eq('model_id', '__plans_metadata__').single();
      if (pData && pData.api_key) {
        const plans = JSON.parse(pData.api_key);
        for (const p of plans) {
          await db.collection('plans').updateOne(
            { name: p.name },
            { $set: p },
            { upsert: true }
          );
        }
        console.log(`[Sync] Successfully synced ${plans.length} plans into MongoDB Atlas!`);
      }
    }

    // 3. Ensure Admin Accounts
    const bcrypt = require('bcryptjs');
    const adminEmails = ['zihanfakir@gmail.com', 'x@zihan.uk'];
    for (const email of adminEmails) {
      const existing = await db.collection('users').findOne({ email });
      if (!existing) {
        const hashedPassword = await bcrypt.hash('123456', 10);
        await db.collection('users').insertOne({
          name: email === 'x@zihan.uk' ? 'Zihan' : 'Zihan Fakir',
          email,
          password: hashedPassword,
          role: 'admin',
          subscription: { plan_name: 'Max', starts_at: new Date(), expires_at: null, is_active: true },
          createdAt: new Date(),
          updatedAt: new Date()
        });
        console.log(`[Sync] Created Admin (${email}) in Atlas.`);
      } else {
        await db.collection('users').updateOne(
          { email },
          { $set: { role: 'admin', 'subscription.plan_name': 'Max', 'subscription.is_active': true } }
        );
        console.log(`[Sync] Updated Admin (${email}) in Atlas.`);
      }
    }

  } catch (e) {
    console.error('[Sync Error]:', e.message);
  } finally {
    await mongoose.disconnect();
    console.log('[Sync] Finished.');
  }
})();
