import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyCors from '@fastify/cors';
import { MongoClient, ObjectId } from 'mongodb';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'lalosmap';
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// --- Fastify ---
const app = Fastify({ logger: true });

await app.register(fastifyCors, {
  origin: true,
});

await app.register(fastifyMultipart, {
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 1,
  }
});

// Serve ./public (index.html) and /uploads
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: '/',               // serves index.html and assets (including /uploads/*)
  index: 'index.html',
});

// --- Mongo ---
app.log.info(`Connecting to Mongo at ${MONGO_URL} ...`);
const client = new MongoClient(MONGO_URL);
await client.connect();
const db = client.db(DB_NAME);
const Posts = db.collection('posts');
app.log.info('Connected to MongoDB');

// Ensure indexes (idempotent)
await Posts.createIndex({ location: '2dsphere' });
await Posts.createIndex({ createdAt: -1 });
await Posts.createIndex({ deviceId: 1, createdAt: -1 });
// Unique only when idemKey is a string (matches your partial unique index approach)
await Posts.createIndex(
  { idemKey: 1 },
  { unique: true, partialFilterExpression: { idemKey: { $type: 'string' } } }
);
// Older sparse dupeKey (keep if you had it before; harmless if unused)
await Posts.createIndex({ dupeKey: 1 }, { unique: true, sparse: true });

// --- helpers ---
const toDTO = (doc) => {
  if (!doc) return null;
  return {
    id: String(doc._id),
    mediaType: doc.mediaType || 'img',
    url: doc.url || null,
    ytId: doc.ytId || null,
    comment: doc.comment ?? null,
    natSize: doc.natSize || null,
    pxAtPlace: typeof doc.pxAtPlace === 'number' ? doc.pxAtPlace : null,
    userCenter: doc.userCenter || null,
    coordinates: Array.isArray(doc.location?.coordinates)
      ? doc.location.coordinates
      : null,
    createdAt: doc.createdAt?.toISOString?.() || doc.createdAt || null,
    updatedAt: doc.updatedAt?.toISOString?.() || doc.updatedAt || null,
  };
};

const cleanNum = (n) => {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
};

const now = () => new Date();

// --- routes ---
app.get('/api/health', async () => ({ status: 'ok' }));

// Upload: returns { ok, url, mime }
app.post('/api/upload', async (req, reply) => {
  const parts = req.parts();
  let file;
  for await (const p of parts) {
    if (p.type === 'file') { file = p; break; }
  }
  if (!file) {
    return reply.code(400).send({ ok: false, error: 'no file' });
  }

  const buf = await file.toBuffer();
  const extGuess = (() => {
    const name = (file.filename || '').toLowerCase();
    const fromName = path.extname(name).replace('.', '');
    if (fromName) return fromName;
    return 'bin';
  })();

  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const ext = extGuess || 'bin';
  const fname = `${id}.${ext}`;
  const fpath = path.join(UPLOAD_DIR, fname);

  await fs.promises.writeFile(fpath, buf);
  const mime = file.mimetype || 'application/octet-stream';
  return reply.code(201).send({ ok: true, url: `/uploads/${fname}`, mime });
});

// Create a post
// body: { lng, lat, mediaType("img"), url, ytId, comment, natSize{w,h}, pxAtPlace, userCenter{lng,lat}, deviceId, idemKey? }
app.post('/api/posts', async (req, reply) => {
  try {
    const b = req.body || {};
    const lng = cleanNum(b.lng);
    const lat = cleanNum(b.lat);
    const mediaType = (b.mediaType || 'img').toLowerCase();
    const url = (b.url || null);
    const ytId = (b.ytId || null);
    const comment = (typeof b.comment === 'string' ? b.comment.trim().slice(0, 15) : null);
    const pxAtPlace = cleanNum(b.pxAtPlace);
    const natSize = (b.natSize && Number.isFinite(b.natSize.w) && Number.isFinite(b.natSize.h))
      ? { w: Math.round(b.natSize.w), h: Math.round(b.natSize.h) }
      : null;
    const deviceId = (b.deviceId || null);
    const userCenter = (b.userCenter && Number.isFinite(b.userCenter.lng) && Number.isFinite(b.userCenter.lat))
      ? { lng: Number(b.userCenter.lng), lat: Number(b.userCenter.lat) }
      : null;

    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return reply.code(400).send({ ok: false, error: 'lng/lat required' });
    }
    if (mediaType !== 'img' && mediaType !== 'yt' && mediaType !== 'vid' && mediaType !== 'gif') {
      return reply.code(400).send({ ok: false, error: 'invalid mediaType' });
    }
    if (mediaType !== 'yt' && !url) {
      return reply.code(400).send({ ok: false, error: 'url required for non-YouTube media' });
    }

    // Optional idempotency key; if none, leave null (your partial unique id
    // only triggers when it's a string).
    let idemKey = typeof b.idemKey === 'string' ? b.idemKey : null;

    const doc = {
      mediaType,
      url: mediaType === 'yt' ? null : url,
      ytId: mediaType === 'yt' ? (ytId || null) : null,
      comment,
      natSize,
      pxAtPlace: Number.isFinite(pxAtPlace) ? pxAtPlace : null,
      userCenter,
      deviceId: deviceId || null,
      location: { type: 'Point', coordinates: [lng, lat] },
      createdAt: now(),
      updatedAt: now(),
      idemKey,     // only unique if string, thanks to partial unique index
    };

    const ins = await Posts.insertOne(doc);
    return reply.code(201).send({ ok: true, id: String(ins.insertedId), createdAt: doc.createdAt.toISOString() });
  } catch (e) {
    if (e?.code === 11000) {
      // duplicate idemKey (only when string). Tell client to PATCH the existing post instead.
      return reply.code(500).send({ statusCode: 500, code: '11000', error: 'Internal Server Error', message: e.message });
    }
    req.log.error(e);
    return reply.code(500).send({ ok: false, error: 'server' });
  }
});

// Normalize ID
const parseId = (id) => {
  try { return new ObjectId(String(id)); } catch { return null; }
};

// Read by id (DTO)
app.get('/api/posts/:id', async (req, reply) => {
  const oid = parseId(req.params.id);
  if (!oid) return reply.code(400).send({ ok: false, error: 'bad id' });
  const doc = await Posts.findOne({ _id: oid });
  if (!doc) return reply.code(404).send({ ok: false, error: 'not found' });
  return toDTO(doc);
});

// UPDATE: PATCH /api/posts/:id  (saves comment, pxAtPlace, url, natSize, mediaType if provided)
app.patch('/api/posts/:id', async (req, reply) => {
  const oid = parseId(req.params.id);
  if (!oid) return reply.code(400).send({ ok: false, error: 'bad id' });

  const p = req.body || {};
  const set = { updatedAt: now() };
  if (p.comment !== undefined) set.comment = (typeof p.comment === 'string' ? p.comment.trim().slice(0, 15) : null);
  if (p.pxAtPlace !== undefined && Number.isFinite(Number(p.pxAtPlace))) set.pxAtPlace = Math.round(Number(p.pxAtPlace));
  if (p.url !== undefined) set.url = p.url || null;
  if (p.mediaType !== undefined) set.mediaType = String(p.mediaType || 'img').toLowerCase();
  if (p.natSize && Number.isFinite(p.natSize.w) && Number.isFinite(p.natSize.h)) {
    set.natSize = { w: Math.round(p.natSize.w), h: Math.round(p.natSize.h) };
  }

  const res = await Posts.findOneAndUpdate(
    { _id: oid },
    { $set: set },
    { returnDocument: 'after' }
  );
  if (!res || !res.value) return reply.code(404).send({ ok: false, error: 'not found' });
  return toDTO(res.value);
});

// COMPAT: old client used POST /api/posts/:id/update
app.post('/api/posts/:id/update', async (req, reply) => {
  // forward to the new PATCH handler
  req.method = 'PATCH';
  return app.routing(req, reply);
});

// near: GET /api/posts/near?lng=&lat=&radiusMeters=5000&limit=80
app.get('/api/posts/near', async (req, reply) => {
  const q = req.query || {};
  const lng = cleanNum(q.lng);
  const lat = cleanNum(q.lat);
  const radiusMeters = Math.min(5000, Math.max(50, cleanNum(q.radiusMeters) || 5000));
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 80));
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return reply.code(400).send({ ok: false, error: 'lng/lat required' });
  }

  const cur = Posts.find({
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: radiusMeters,
      }
    }
  }).sort({ createdAt: -1 }).limit(limit);

  const rows = await cur.toArray();
  return rows.map(toDTO);
});

// recent: same shape as before
app.get('/api/posts/recent', async (req) => {
  const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 9));
  const rows = await Posts.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  return rows.map(toDTO);
});

// latest: newest one globally, or by deviceId if provided
app.get('/api/posts/latest', async (req, reply) => {
  const dev = (req.query?.deviceId || null);
  const filter = dev ? { deviceId: dev } : {};
  const row = await Posts.find(filter).sort({ createdAt: -1 }).limit(1).next();
  if (!row) return reply.code(404).send({ ok: false, error: 'not found' });
  return toDTO(row);
});

// (Optional) historical dump you had before
app.get('/api/posts/history', async () => {
  const rows = await Posts.find({}).sort({ createdAt: -1 }).limit(200).toArray();
  return rows.map(toDTO);
});

// index.html
app.get('/', async (_req, reply) => reply.sendFile('index.html'));

// start
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Server listening at http://${HOST}:${PORT}`);
  app.log.info(`Uploads served from ${UPLOAD_DIR}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
