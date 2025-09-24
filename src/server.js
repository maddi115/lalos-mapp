import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyCors from '@fastify/cors';
import { MongoClient } from 'mongodb';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

// route plugins
import uploadRoutes from './routes/upload.js';
import postsRoutes from './routes/posts.js';

dotenv.config();

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'lalosmap';
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// --- Fastify ---
const app = Fastify({ logger: true });

await app.register(fastifyCors, { origin: true });
await app.register(fastifyMultipart, {
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

// Serve ./public (index.html) and /uploads
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: '/',
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
await Posts.createIndex(
  { idemKey: 1 },
  { unique: true, partialFilterExpression: { idemKey: { $type: 'string' } } }
);
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
app.get('/', async (_req, reply) => reply.sendFile('index.html'));

// --- register external routes (after db is ready) ---
await app.register(uploadRoutes, { db });
await app.register(postsRoutes, { db });

// --- start ---
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Server listening at http://${HOST}:${PORT}`);
  app.log.info(`Uploads served from ${UPLOAD_DIR}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
