// data/horizon_engine.js

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS_M = 6371000;

function terrariumHeight(r, g, b) {
  return (r * 256 + g + b / 256) - 32768;
}

function lonLatToTileXY(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = lat * DEG2RAD;
  const y =
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

function destinationPoint(latDeg, lonDeg, azDeg, distM) {
  const lat1 = latDeg * DEG2RAD;
  const lon1 = lonDeg * DEG2RAD;
  const brng = azDeg * DEG2RAD;
  const angDist = distM / EARTH_RADIUS_M;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAng = Math.sin(angDist);
  const cosAng = Math.cos(angDist);

  const lat2 = Math.asin(
    sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(brng)
  );

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * sinAng * cosLat1,
      cosAng - sinLat1 * Math.sin(lat2)
    );

  let lonDeg2 = lon2 * RAD2DEG;
  lonDeg2 = ((lonDeg2 + 540) % 360) - 180;

  return { lat: lat2 * RAD2DEG, lon: lonDeg2 };
}

function effectiveEarthRadius(k = 0.13) {
  return EARTH_RADIUS_M / (1 - k);
}

function curvatureDrop(distM, k = 0.13) {
  const reff = effectiveEarthRadius(k);
  return (distM * distM) / (2 * reff);
}

class TerrariumTileCache {
  constructor(options = {}) {
    this.tileUrlTemplate =
      options.tileUrlTemplate ||
      "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

    this.maxTiles = options.maxTiles || 384;
    this.tiles = new Map();      // key -> { imageData }
    this.pending = new Map();    // key -> Promise
    this.sampleCache = new Map();// key -> elevation
  }

  _tileKey(z, x, y) {
    return `${z}/${x}/${y}`;
  }

  _sampleKey(z, x, y, px, py) {
    return `${z}/${x}/${y}:${px},${py}`;
  }

  _touch(map, key, value) {
    map.delete(key);
    map.set(key, value);
  }

  _evict() {
    while (this.tiles.size > this.maxTiles) {
      const oldestKey = this.tiles.keys().next().value;
      this.tiles.delete(oldestKey);

      const prefix = oldestKey + ":";
      for (const k of this.sampleCache.keys()) {
        if (k.startsWith(prefix)) this.sampleCache.delete(k);
      }
    }
  }

  _makeUrl(z, x, y) {
    return this.tileUrlTemplate
      .replace("{z}", z)
      .replace("{x}", x)
      .replace("{y}", y);
  }
  _readTerrariumPixel(tile, px, py) {
    const d = tile.imageData.data;
    const i = (py * 256 + px) * 4;
    return terrariumHeight(d[i], d[i + 1], d[i + 2]);
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

    const p = (async () => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.src = this._makeUrl(z, x, y);
      await img.decode();

      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);

      const tile = {
        imageData: ctx.getImageData(0, 0, 256, 256)
      };

      this._touch(this.tiles, key, tile);
      this.pending.delete(key);
      this._evict();
      return tile;
    })();

    this.pending.set(key, p);
    return p;
  }

  async prefetchTiles(list) {
    const uniq = new Map();
    for (const t of list) {
      uniq.set(this._tileKey(t.z, t.x, t.y), t);
    }
    await Promise.all(
      Array.from(uniq.values()).map(t => this._loadTile(t.z, t.x, t.y))
    );
  }

  async getElevation(lat, lon, z = 12) {
    const t = lonLatToTileXY(lon, lat, z);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);

    const fx = (t.x - tx) * 256;
    const fy = (t.y - ty) * 256;

    const x0 = Math.max(0, Math.min(255, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(255, Math.floor(fy)));
    const x1 = Math.max(0, Math.min(255, x0 + 1));
    const y1 = Math.max(0, Math.min(255, y0 + 1));

    const dx = Math.max(0, Math.min(1, fx - x0));
    const dy = Math.max(0, Math.min(1, fy - y0));

    const skey = `${z}/${tx}/${ty}:${fx.toFixed(2)},${fy.toFixed(2)}`;
    if (this.sampleCache.has(skey)) {
      return this.sampleCache.get(skey);
    }

    const tile = await this._loadTile(z, tx, ty);

    const z00 = this._readTerrariumPixel(tile, x0, y0);
    const z10 = this._readTerrariumPixel(tile, x1, y0);
    const z01 = this._readTerrariumPixel(tile, x0, y1);
    const z11 = this._readTerrariumPixel(tile, x1, y1);

    const z0 = z00 * (1 - dx) + z10 * dx;
    const z1 = z01 * (1 - dx) + z11 * dx;
    const elev = z0 * (1 - dy) + z1 * dy;

    this.sampleCache.set(skey, elev);
    return elev;
  }
}

export class HorizonEngine {
  constructor(options = {}) {
    this.tileZoom = options.tileZoom || 12;
    this.observerHeightM = options.observerHeightM ?? 1.7;
    this.refractionK = options.refractionK ?? 0.13;
    this.tileCache =
      options.tileCache || new TerrariumTileCache(options.tileOptions || {});
  }
buildDistances(maxDistM) {
  const out = [];

  // evitam auto-obstacles falsos més fins que la resolució útil del DEM
  for (let d = 50; d < 1200; d += 30) out.push(d);

  // detall curt-mitjà encara bastant fi
  for (let d = 1200; d < 4000; d += 60) out.push(d);

  // detall mitjà a distància intermèdia
  for (let d = 4000; d < 20000; d += 200) out.push(d);

  // lluny ja podem anar més gros
  for (let d = 20000; d <= maxDistM; d += 1000) out.push(d);

  return out;
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
        const p = destinationPoint(lat, lon, az, dist);
        pts[j] = { lat: p.lat, lon: p.lon, dist };

        const t = lonLatToTileXY(p.lon, p.lat, this.tileZoom);
        tilesNeeded.push({
          z: this.tileZoom,
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
    observerAltM = null,   // altitud AMSL de l'usuari si la tens
    centerAzDeg = 270,
    fovDeg = 20,
    samples = 240,
    maxDistM = 100000,
    onProgress = null,
  }) {
    const distances = this.buildDistances(maxDistM);

    const ground = await this.tileCache.getElevation(lat, lon, this.tileZoom);
    const obsAmsl =
      Number.isFinite(observerAltM) && observerAltM > -100
        ? observerAltM + this.observerHeightM
        : ground + this.observerHeightM;

    const { az0, daz, rays, tilesNeeded } = this.buildRayGeometry({
      lat,
      lon,
      centerAzDeg,
      fovDeg,
      samples,
      distances
    });

    await this.tileCache.prefetchTiles(tilesNeeded);

    const alt = new Float32Array(samples);

    for (let i = 0; i < samples; i++) {
      let maxAng = -90;
      const pts = rays[i].pts;

      for (let j = 0; j < pts.length; j++) {
        const p = pts[j];
        const z = await this.tileCache.getElevation(p.lat, p.lon, this.tileZoom);

        if (!Number.isFinite(z)) continue;

        const drop = curvatureDrop(p.dist, this.refractionK);
        const ang = Math.atan2(z - obsAmsl - drop, p.dist) * RAD2DEG;

        if (ang > maxAng) maxAng = ang;
      }

      alt[i] = maxAng;

      if (onProgress && (i % 10 === 0 || i === samples - 1)) {
        onProgress({
          done: i + 1,
          total: samples,
          fraction: (i + 1) / samples,
        });
      }
    }

    return {
      az0,
      daz,
      alt,
      meta: {
        lat,
        lon,
        observerAltM,
        centerAzDeg,
        fovDeg,
        samples,
        maxDistM,
        tileZoom: this.tileZoom,
        refractionK: this.refractionK
      }
    };
  }
}
