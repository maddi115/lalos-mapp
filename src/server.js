// src/server.js
import 'dotenv/config';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';

import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- env / basics -----------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB || 'lalosmap';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UP_DIR = path.join(PUBLIC_DIR, 'uploads');
fs.existsSync(UP_DIR) || fs.mkdirSync(UP_DIR, { recursive: true });

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' }
});

// ---- harden crashes so “loading forever” doesn’t happen ---------------------
process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => { app.log.error({ err }, 'uncaughtException'); process.exit(1); });

// ---- plugins ----------------------------------------------------------------
await app.register(fastifyCors, { origin: true });
await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: '/',
  index: ['index.html']
});
await app.register(fastifyMultipart, {
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB max (matches your requirement)
  }
});

// ---- mongo connect ----------------------------------------------------------
app.log.info(`Connecting to Mongo at ${MONGODB_URI} ...`);
const client = new MongoClient(MONGODB_URI, {
  serverApi: ServerApiVersion.v1,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000
});
await client.connect();
await client.db('admin').command({ ping: 1 });
app.log.info('Connected to MongoDB');

const db = client.db(DB_NAME);
const posts = db.collection('posts');

// indexes (idempotent)
await posts.createIndex({ location: '2dsphere' });
await posts.createIndex({ createdAt: -1 });
await posts.createIndex({ deviceId: 1, createdAt: -1 });

// ---- helpers ----------------------------------------------------------------
const MAX_CMT = 15;

function clampComment(v) {
  return ((v ?? '').toString().slice(0, MAX_CMT).trim()) || null;
}

// “last 3AM” in local server time (what UI expects)
function last3am() {
  const now = new Date();
  const three = new Date(now); three.setHours(3, 0, 0, 0);
  if (now < three) three.setDate(three.getDate() - 1);
  return three;
}

function safeExtByMime(mime = '') {
  if (mime.startsWith('image/')) {
    if (mime === 'image/gif') return '.gif';
    if (mime === 'image/png') return '.png';
    if (mime === 'image/webp') return '.webp';
    return '.jpg';
  }
  if (mime.startsWith('video/')) {
    if (mime === 'video/webm') return '.webm';
    if (mime === 'video/ogg' || mime === 'video/ogv') return '.ogv';
    return '.mp4';
  }
  return '';
}

function newUploadName(ext) {
  return `${Date.now()}-${crypto.randomUUID()}${ext}`;
}

async function cleanupUploads() {
  try {
    const cutoff = last3am().getTime();
    const names = await fsp.readdir(UP_DIR);
    for (const name of names) {
      // Expect names like 1758073029601-uuid.ext => parse leading timestamp
      const m = /^(\d+)-/.exec(name);
      if (!m) continue;
      const ts = Number(m[1]);
      if (!Number.isFinite(ts)) continue;
      if (ts < cutoff) {
        const p = path.join(UP_DIR, name);
        fsp.unlink(p).catch(() => {});
      }
    }
  } catch (err) {
    app.log.warn({ err }, 'cleanupUploads failed');
  }
}

// run once on boot, then hourly
await cleanupUploads();
setInterval(cleanupUploads, 60 * 60 * 1000);

// ---- schemas (minimal) ------------------------------------------------------
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
    comment: { type: ['string', 'null'], maxLength: MAX_CMT },
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

// ---- routes -----------------------------------------------------------------
app.get('/api/health', async () => ({ status: 'ok' }));

// Upload file -> { ok, url, mime }
app.post('/api/upload', async (req, reply) => {
  const mp = await req.file();
  if (!mp) return reply.code(400).send({ error: 'no file' });

  const ext = safeExtByMime(mp.mimetype || '');
  if (!ext) return reply.code(400).send({ error: 'unsupported mime' });

  const name = newUploadName(ext);
  const full = path.join(UP_DIR, name);

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(full, { flags: 'wx' });
    mp.file.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    mp.file.on('error', reject);
  });

  return reply.code(201).send({ ok: true, url: `/uploads/${name}`, mime: mp.mimetype });
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
    mediaType,
    url,
    ytId,
    comment: clampComment(comment),
    natSize: (natSize && natSize.w && natSize.h) ? { w: natSize.w, h: natSize.h } : null,
    pxAtPlace: (typeof pxAtPlace === 'number') ? pxAtPlace : null,
    userCenter: userCenter || null,
    deviceId: devId,
    location: { type: 'Point', coordinates: [lng, lat] },
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const { insertedId } = await posts.insertOne(doc);
  return reply.code(201).send({ ok: true, id: insertedId.toString(), createdAt: doc.createdAt });
});

// Near
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

  return rows.map(r => ({
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
    createdAt: r.createdAt
  }));
});

// Latest (optionally by device)
app.get('/api/posts/latest', async (req) => {
  const deviceId = (req.query?.deviceId ?? req.headers['x-device-id']) || null;
  const filter = deviceId ? { deviceId: String(deviceId) } : {};
  const r = await posts.find(filter).sort({ createdAt: -1 }).limit(1).next();
  if (!r) return null;
  return {
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
    createdAt: r.createdAt
  };
});

// By id
app.get('/api/posts/:id', async (req, reply) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return reply.code(400).send({ error: 'invalid id' });
  const r = await posts.findOne({ _id: new ObjectId(id) });
  if (!r) return reply.code(404).send({ error: 'not found' });
  return {
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
    createdAt: r.createdAt
  };
});

// Patch
app.patch('/api/posts/:id', {
  schema: {
    body: {
      type: 'object',
      additionalProperties: false,
      properties: {
        comment: { type: ['string', 'null'], maxLength: MAX_CMT },
        pxAtPlace: { type: ['number', 'null'] },
        url: { type: ['string', 'null'] },
        ytId: { type: ['string', 'null'] },
        userCenter: {
          type: ['object', 'null'],
          additionalProperties: false,
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

  if (comment !== undefined) $set.comment = clampComment(comment);
  if (pxAtPlace !== undefined) $set.pxAtPlace = (typeof pxAtPlace === 'number') ? pxAtPlace : null;
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

// Fallback POST updater (used by unload beacons on some browsers)
app.post('/api/posts/:id/update', async (req, reply) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return reply.code(400).send({ error: 'invalid id' });
  const { comment, pxAtPlace, url, ytId, userCenter } = req.body || {};
  const $set = { updatedAt: new Date() };
  if (comment !== undefined) $set.comment = clampComment(comment);
  if (pxAtPlace !== undefined) $set.pxAtPlace = (typeof pxAtPlace === 'number') ? pxAtPlace : null;
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

// New: recent since last 3AM (for global overlay)
app.get('/api/posts/recent', async (req) => {
  const limit = Math.min(Number(req.query?.limit) || 200, 400);
  const since = last3am();
  const rows = await posts
    .find({ createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  return rows.map(r => ({
    id: r._id.toString(),
    mediaType: r.mediaType,
    url: r.url,
    ytId: r.ytId,
    natSize: r.natSize,
    pxAtPlace: r.pxAtPlace,
    coordinates: r.location?.coordinates,
    createdAt: r.createdAt
  }));
});

// New: history (for device restore fallback)
app.get('/api/posts/history', async (req) => {
  const limit = Math.min(Number(req.query?.limit) || 10, 50);
  const deviceId = (req.query?.deviceId || req.headers['x-device-id'] || '').toString();
  const filter = deviceId ? { deviceId } : {};
  const rows = await posts.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();

  return rows.map(r => ({
    id: r._id.toString(),
    mediaType: r.mediaType,
    url: r.url,
    ytId: r.ytId,
    natSize: r.natSize,
    pxAtPlace: r.pxAtPlace,
    coordinates: r.location?.coordinates,
    userCenter: r.userCenter,
    createdAt: r.createdAt
  }));
});

// Root
app.get('/', async (_req, reply) => reply.sendFile('index.html'));

// ---- shutdown ---------------------------------------------------------------
async function closeAll() { try { await client.close(); } catch {} }
process.on('SIGINT', async () => { await closeAll(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAll(); process.exit(0); });

// ---- start ------------------------------------------------------------------
app.listen({ port: PORT, host: HOST })
  .then(addr => app.log.info(`Server listening at ${addr}`))
  .catch(async (err) => { app.log.error({ err }, 'listen failed'); await closeAll(); process.exit(1); });
