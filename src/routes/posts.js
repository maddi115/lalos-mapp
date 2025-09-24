import { ObjectId } from 'mongodb';

// helpers
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

const parseId = (id) => {
  try { return new ObjectId(String(id)); } catch { return null; }
};

export default async function postsRoutes(app, { db }) {
  const Posts = db.collection('posts');

  // Create a post
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
        idemKey,
      };

      const ins = await Posts.insertOne(doc);
      return reply.code(201).send({ ok: true, id: String(ins.insertedId), createdAt: doc.createdAt.toISOString() });
    } catch (e) {
      if (e?.code === 11000) {
        return reply.code(500).send({ statusCode: 500, code: '11000', error: 'Internal Server Error', message: e.message });
      }
      req.log.error(e);
      return reply.code(500).send({ ok: false, error: 'server' });
    }
  });

  // Read by id
  app.get('/api/posts/:id', async (req, reply) => {
    const oid = parseId(req.params.id);
    if (!oid) return reply.code(400).send({ ok: false, error: 'bad id' });
    const doc = await Posts.findOne({ _id: oid });
    if (!doc) return reply.code(404).send({ ok: false, error: 'not found' });
    return toDTO(doc);
  });

  // Update post
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

  // Compat
  app.post('/api/posts/:id/update', async (req, reply) => {
    req.method = 'PATCH';
    return app.routing(req, reply);
  });

  // Nearby posts
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

  // Recent posts
  app.get('/api/posts/recent', async (req) => {
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 9));
    const rows = await Posts.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
    return rows.map(toDTO);
  });

  // Latest post
  app.get('/api/posts/latest', async (req, reply) => {
    const dev = (req.query?.deviceId || null);
    const filter = dev ? { deviceId: dev } : {};
    const row = await Posts.find(filter).sort({ createdAt: -1 }).limit(1).next();
    if (!row) return reply.code(404).send({ ok: false, error: 'not found' });
    return toDTO(row);
  });

  // History
  app.get('/api/posts/history', async () => {
    const rows = await Posts.find({}).sort({ createdAt: -1 }).limit(200).toArray();
    return rows.map(toDTO);
  });
}
