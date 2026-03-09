// data/horizon_engine.js

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS = 6371000;

function terrariumHeight(r, g, b) {
  return (r * 256 + g + b / 256) - 32768;
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = lat * DEG2RAD;
  const y =
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

function destination(lat, lon, azDeg, distM) {
  const φ1 = lat * DEG2RAD;
  const λ1 = lon * DEG2RAD;
  const θ = azDeg * DEG2RAD;
  const δ = distM / EARTH_RADIUS;

  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);
  const sinθ = Math.sin(θ);
  const cosθ = Math.cos(θ);

  const φ2 = Math.asin(
    sinφ1 * cosδ + cosφ1 * sinδ * cosθ
  );

  const λ2 =
    λ1 +
    Math.atan2(
      sinθ * sinδ * cosφ1,
      cosδ - sinφ1 * Math.sin(φ2)
    );

  return {
    lat: φ2 * RAD2DEG,
    lon: ((λ2 * RAD2DEG + 540) % 360) - 180
  };
}

class TileCache {
  constructor({ maxTiles = 256 } = {}) {
    this.maxTiles = maxTiles;
    this.tiles = new Map();      // key -> tile
    this.pending = new Map();    // key -> Promise
    this.sampleCache = new Map();// key -> elevation
  }

  _touch(map, key, value) {
    map.delete(key);
    map.set(key, value);
  }

  _evictIfNeeded() {
    while (this.tiles.size > this.maxTiles) {
      const oldestKey = this.tiles.keys().next().value;
      this.tiles.delete(oldestKey);

      // neteja també mostres d'aquest tile
      const prefix = oldestKey + ":";
      for (const k of this.sampleCache.keys()) {
        if (k.startsWith(prefix)) this.sampleCache.delete(k);
      }
    }
  }

  _tileKey(z, x, y) {
    return `${z}/${x}/${y}`;
  }

  _sampleKey(z, x, y, px, py) {
    return `${z}/${x}/${y}:${px},${py}`;
  }

  _tileUrl(z, x, y) {
    return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  }

  async _loadTile(z, x, y) {
    const key = this._tileKey(z, x, y);

    if (this.tiles.has(key)) {
      const tile = this.tiles.get(key);
      this._touch(this.tiles, key, tile);
      return tile;
    }

    if (this.pending.has(key)) {
      return this.pending.get(key);
    }

    const promise = (async () => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.src = this._tileUrl(z, x, y);
      await img.decode();

      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);

      const data = ctx.getImageData(0, 0, 256, 256);
      const tile = { data };

      this._touch(this.tiles, key, tile);
      this._evictIfNeeded();
      this.pending.delete(key);

      return tile;
    })();

    this.pending.set(key, promise);
    return promise;
  }

  async prefetchTiles(tileList) {
    const uniq = new Map();
    for (const t of tileList) {
      uniq.set(this._tileKey(t.z, t.x, t.y), t);
    }
    await Promise.all(
      Array.from(uniq.values()).map(t => this._loadTile(t.z, t.x, t.y))
    );
  }

  async getElevation(lat, lon, z) {
    const t = lonLatToTile(lon, lat, z);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    const px = Math.max(0, Math.min(255, Math.floor((t.x - tx) * 256)));
    const py = Math.max(0, Math.min(255, Math.floor((t.y - ty) * 256)));

    const skey = this._sampleKey(z, tx, ty, px, py);
    if (this.sampleCache.has(skey)) {
      return this.sampleCache.get(skey);
    }

    const tile = await this._loadTile(z, tx, ty);
    const d = tile.data.data;
    const i = (py * 256 + px) * 4;
    const elev = terrariumHeight(d[i], d[i + 1], d[i + 2]);

    this.sampleCache.set(skey, elev);
    return elev;
  }
}

export class HorizonEngine {
  constructor(opts = {}) {
    this.zoom = opts.tileZoom ?? 12;
    this.observerHeight = opts.observerHeight ?? 1.7;
    this.tileCache = new TileCache({
      maxTiles: opts.maxTiles ?? 256
    });
  }

  buildDistances(maxDistM) {
    const d = [];
    for (let x = 100; x < 5000; x += 100) d.push(x);
    for (let x = 5000; x < 20000; x += 250) d.push(x);
    for (let x = 20000; x <= maxDistM; x += 1000) d.push(x);
    return d;
  }

  buildRayGeometry({ lat, lon, centerAzDeg, fovDeg, samples, distances }) {
    const az0 = centerAzDeg - fovDeg / 2;
    const daz = fovDeg / samples;

    const rays = new Array(samples);
    const tilesNeeded = [];

    for (let i = 0; i < samples; i++) {
      const az = az0 + i * daz;
      const pts = new Array(distances.length);

      for (let j = 0; j < distances.length; j++) {
        const dist = distances[j];
        const p = destination(lat, lon, az, dist);
        pts[j] = { lat: p.lat, lon: p.lon, dist };

        const t = lonLatToTile(p.lon, p.lat, this.zoom);
        tilesNeeded.push({
          z: this.zoom,
          x: Math.floor(t.x),
          y: Math.floor(t.y)
        });
      }

      rays[i] = { az, pts };
    }

    return { az0, daz, rays, tilesNeeded };
  }

  async computeProfile({
    lat,
    lon,
    centerAzDeg = 270,
    fovDeg = 60,
    samples = 200,
    maxDistM = 100000,
    onProgress = null
  }) {
    const distances = this.buildDistances(maxDistM);

    const ground = await this.tileCache.getElevation(lat, lon, this.zoom);
    const obs = ground + this.observerHeight;

    const { az0, daz, rays, tilesNeeded } = this.buildRayGeometry({
      lat,
      lon,
      centerAzDeg,
      fovDeg,
      samples,
      distances
    });

    // Prefetch grossíssim abans del loop calent
    await this.tileCache.prefetchTiles(tilesNeeded);

    const alt = new Float32Array(samples);

    for (let i = 0; i < samples; i++) {
      let maxAng = -90;
      const pts = rays[i].pts;

      for (let j = 0; j < pts.length; j++) {
        const p = pts[j];
        const z = await this.tileCache.getElevation(p.lat, p.lon, this.zoom);

        const ang = Math.atan2(z - obs, p.dist) * RAD2DEG;
        if (ang > maxAng) maxAng = ang;
      }

      alt[i] = maxAng;

      if (onProgress && (i % 10 === 0 || i === samples - 1)) {
        onProgress({
          done: i + 1,
          total: samples,
          fraction: (i + 1) / samples
        });
      }
    }

    return { az0, daz, alt };
  }
}
