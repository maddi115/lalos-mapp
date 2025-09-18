// src/server.js
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- env ---
const PORT = Number(process.env.PORT || 3000);
const HOSTS = Array.from(new Set([process.env.HOST || '::', '0.0.0.0', '127.0.0.1']));
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB || 'lalosmap';

// upload dir (inside /public so static can serve it)
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');

// mime whitelist + simple ext map (no extra deps)
const ALLOW = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/ogg'
]);
const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv'
};
const capComment = (s) => (s ?? '').slice(0, 15).trim() || null;

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

// Fail loudly (avoid “loading forever”)
process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => { app.log.error({ err }, 'uncaughtException'); process.exit(1); });

// CORS + static
await app.register(fastifyCors, { origin: true });
await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
  index: ['index.html'],
});

// Multipart uploads
await app.register(fastifyMultipart, {
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }, // 50MB cap
});

// Ensure upload dir exists
await fs.mkdir(UPLOAD_DIR, { recursive: true });

// --- Mongo connect ---
app.log.info(`Connecting to Mongo at ${MONGODB_URI} ...`);
const client = new MongoClient(MONGODB_URI, {
  serverApi: ServerApiVersion.v1,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
});
try {
  await client.connect();
  await client.db('admin').command({ ping: 1 });
  app.log.info('Connected to MongoDB');
} catch (err) {
  app.log.error({ err }, 'MongoDB connection failed');
  process.exit(1);
}

const db = client.db(DB_NAME);
const posts = db.collection('posts');

// Indexes
await posts.createIndex({ location: '2dsphere' });
await posts.createIndex({ createdAt: -1 });
await posts.createIndex({ deviceId: 1, createdAt: -1 });

// ---- helpers ----
const toPub = (r) => r && ({
  id: r._id.toString(),
  mediaType: r.mediaType,
  url: r.url,
  ytId: r.ytId,
  comment: r.comment,
  natSize: r.natSize,
  pxAtPlace: r.pxAtPlace,
  userCenter: r.userCenter,
  deviceId: r.deviceId || null,
  coordinates: r.location?.coordinates,
  createdAt: r.createdAt,
});

// ---- schemas ----
const postBodySchema = {
  type: 'object',
  required: ['lng', 'lat', 'mediaType'],
  additionalProperties: false,
  properties: {
    lng: { type: 'number' },
    lat: { type: 'number' },
    mediaType: { type: 'string', enum: ['img', 'gif', 'vid', 'yt'] },
    url: { type: ['string', 'null'] },
    ytId: { type: ['string', 'null'] },
    comment: { type: ['string', 'null'], maxLength: 15 },
    natSize: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: { w: { type: 'number' }, h: { type: 'number' } }
    },
    pxAtPlace: { type: ['number', 'null'] },
    userCenter: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: { lng: { type: 'number' }, lat: { type: 'number' } }
    },
    deviceId: { type: ['string', 'null'], maxLength: 128 }
  }
};

const nearQuerySchema = {
  type: 'object',
  required: ['lng', 'lat'],
  properties: {
    lng: { type: 'number' },
    lat: { type: 'number' },
    radiusMeters: { type: 'number' },
    limit: { type: 'number' }
  }
};

const histQuerySchema = {
  type: 'object',
  properties: {
    deviceId: { type: 'string' },
    limit: { type: 'number' }
  }
};

// ---- routes ----
app.get('/api/health', async () => ({ status: 'ok' }));

// Upload endpoint — returns /uploads/<file>
app.post('/api/upload', async (req, reply) => {
  try {
    const part = await req.file(); // expects a single file field
    if (!part) return reply.code(400).send({ error: 'no file' });

    const mime = part.mimetype || '';
    if (!ALLOW.has(mime)) return reply.code(415).send({ error: `unsupported type ${mime}` });

    const ext = EXT[mime] || 'bin';
    const name = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const outPath = path.join(UPLOAD_DIR, name);

    await pipeline(part.file, createWriteStream(outPath));

    // Return a public URL path (served by fastifyStatic)
    return reply.code(201).send({ ok: true, url: `/uploads/${name}`, mime, size: part.file.truncated ? undefined : part._bufSize });
  } catch (err) {
    req.log.error({ err }, 'upload failed');
    return reply.code(500).send({ error: 'upload failed' });
  }
});

app.get('/api/posts/near', { schema: { querystring: nearQuerySchema } }, async (req) => {
  const { lng, lat, radiusMeters = 1609, limit = 50 } = req.query;
  const maxDist = Math.min(Number(radiusMeters) || 1609, 5000);
  const lim = Math.min(Number(limit) || 50, 200);
  const rows = await posts.find({
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: maxDist
      }
    }
  }).limit(lim).toArray();
  return rows.map(toPub);
});

// History (helps client pick a valid recent post)
app.get('/api/posts/history', { schema: { querystring: histQuerySchema } }, async (req) => {
  const deviceId = req.query?.deviceId || null;
  const limit = Math.min(parseInt(req.query?.limit || '10', 10), 50);
  const filter = deviceId ? { deviceId: String(deviceId) } : {};
  const rows = await posts.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
  return rows.map(toPub);
});

// Latest (optionally by deviceId)
app.get('/api/posts/latest', async (req) => {
  const deviceId = (req.query?.deviceId ?? req.headers['x-device-id']) || null;
  const filter = deviceId ? { deviceId: String(deviceId) } : {};
  const r = await posts.find(filter).sort({ createdAt: -1 }).limit(1).next();
  return r ? toPub(r) : null;
});

// Read by id
app.get('/api/posts/:id', async (req, reply) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return reply.code(400).send({ error: 'invalid id' });
  const r = await posts.findOne({ _id: new ObjectId(id) });
  if (!r) return reply.code(404).send({ error: 'not found' });
  return toPub(r);
});

// Create
app.post('/api/posts', { schema: { body: postBodySchema } }, async (req, reply) => {
  const {
    lng, lat, mediaType,
    url = null, ytId = null, comment = null,
    natSize = null, pxAtPlace = null,
    userCenter = null, deviceId = null
  } = req.body;

  if (mediaType === 'yt' && !ytId) return reply.code(400).send({ error: 'ytId required for mediaType=yt' });
  if (mediaType !== 'yt' && !url) return reply.code(400).send({ error: 'url required for img/gif/vid' });

  const fromHeader = req.headers['x-device-id'];
  const devId = String(deviceId || fromHeader || '').slice(0, 128) || null;

  const doc = {
    mediaType, url, ytId,
    comment: capComment(comment),
    natSize: (natSize && natSize.w && natSize.h) ? { w: natSize.w, h: natSize.h } : null,
    pxAtPlace: typeof pxAtPlace === 'number' ? pxAtPlace : null,
    userCenter: userCenter || null,
    deviceId: devId,
    location: { type: 'Point', coordinates: [lng, lat] },
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const { insertedId } = await posts.insertOne(doc);
  return reply.code(201).send({ ok: true, id: insertedId.toString(), createdAt: doc.createdAt });
});

// Update
app.patch('/api/posts/:id', {
  schema: {
    body: {
      type: 'object', additionalProperties: false,
      properties: {
        comment: { type: ['string', 'null'], maxLength: 15 },
        pxAtPlace: { type: ['number', 'null'] },
        url: { type: ['string', 'null'] },
        ytId: { type: ['string', 'null'] },
        userCenter: {
          type: ['object', 'null'], additionalProperties: false,
          properties: { lng: { type: 'number' }, lat: { type: 'number' } }
        }
      }
    }
  }
}, async (req, reply) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return reply.code(400).send({ error: 'invalid id' });

  const { comment, pxAtPlace, url, ytId, userCenter } = req.body || {};
  const $set = { updatedAt: new Date() };

  if (comment !== undefined) $set.comment = capComment(comment);
  if (pxAtPlace !== undefined) $set.pxAtPlace = typeof pxAtPlace === 'number' ? pxAtPlace : null;
  if (url !== undefined) $set.url = url || null;
  if (ytId !== undefined) $set.ytId = ytId || null;
  if (userCenter !== undefined) $set.userCenter = userCenter || null;

  const r = await posts.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set },
    { returnDocument: 'after' }
  );

  if (!r.value) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

// Optional POST fallback (keepalive beacons)
app.post('/api/posts/:id/update', async (req, reply) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return reply.code(400).send({ error: 'invalid id' });
  const { comment, pxAtPlace, url, ytId, userCenter } = req.body || {};
  const $set = { updatedAt: new Date() };
  if (comment !== undefined) $set.comment = capComment(comment);
  if (pxAtPlace !== undefined) $set.pxAtPlace = typeof pxAtPlace === 'number' ? pxAtPlace : null;
  if (url !== undefined) $set.url = url || null;
  if (ytId !== undefined) $set.ytId = ytId || null;
  if (userCenter !== undefined) $set.userCenter = userCenter || null;
  const r = await posts.findOneAndUpdate({ _id: new ObjectId(id) }, { $set }, { returnDocument: 'after' });
  if (!r.value) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

// Root -> index.html
app.get('/', async (_req, reply) => reply.sendFile('index.html'));

// graceful shutdown
async function closeAll() { try { await client.close(); } catch {} }
process.on('SIGINT', async () => { await closeAll(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAll(); process.exit(0); });

// Start server with host fallback
async function start() {
  let lastErr = null;
  for (const host of HOSTS) {
    try {
      const addr = await app.listen({ port: PORT, host });
      app.log.info(`Server listening at ${addr}`);
      return;
    } catch (err) {
      lastErr = err;
      app.log.warn({ err, host }, `listen failed on host ${host}, trying next...`);
    }
  }
  app.log.error({ err: lastErr, hostsTried: HOSTS }, 'Could not bind to any host');
  process.exit(1);
}
await start();
