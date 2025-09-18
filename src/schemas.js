// src/schemas.js
export const postBodySchema = {
  type: 'object',
  required: ['lng', 'lat', 'mediaType'],
  additionalProperties: true,
  properties: {
    lng: { type: 'number' },
    lat: { type: 'number' },
    mediaType: { type: 'string', enum: ['img', 'gif', 'vid', 'yt'] },
    url: { type: ['string', 'null'] },      // required for img/gif/vid (enforced in handler)
    ytId: { type: ['string', 'null'] },     // required for yt (enforced in handler)
    comment: { type: ['string', 'null'], maxLength: 500 },
    // client may send natSize:{w,h} or natW/natH — support both
    natSize: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: { w: { type: 'number' }, h: { type: 'number' } },
      required: ['w', 'h'],
    },
    natW: { type: ['number', 'null'] },
    natH: { type: ['number', 'null'] },
    pxAtPlace: { type: ['number', 'null'] },
    userCenter: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: { lng: { type: 'number' }, lat: { type: 'number' } },
      required: ['lng', 'lat'],
    },
    deviceId: { type: ['string', 'null'], maxLength: 128 },
  },
};

export const nearQuerySchema = {
  type: 'object',
  required: ['lng', 'lat'],
  additionalProperties: true,
  properties: {
    lng: { type: 'number' },
    lat: { type: 'number' },
    radiusMeters: { type: ['number', 'string'], pattern: '^[0-9]+(\\.[0-9]+)?$' },
    limit: { type: ['number', 'string'], pattern: '^[0-9]+$' },
    deviceId: { type: ['string', 'null'] },
  },
};
