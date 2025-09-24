import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export default async function uploadRoutes(app, opts) {
  const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'public');
  const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
}
