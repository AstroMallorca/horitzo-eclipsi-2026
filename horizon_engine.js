// data/horizon_engine.js

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS_M = 6371000;
const DEFAULT_REFRACTION_K = 0.13;

function terrariumHeight(r, g, b) {
  return (r * 256 + g + b / 256) - 32768;
}

function lonLatToTileXY(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = ((lon + 180) / 360) * n;
  const latRad = lat * DEG2RAD;
  const y =
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

function tileXYToLonLat(x, y, z) {
  const n = Math.pow(2, z);
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  return { lon, lat: latRad * RAD2DEG };
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

function effectiveEarthRadius(k = DEFAULT_REFRACTION_K) {
  return EARTH_RADIUS_M / (1 - k);
}

function curvatureDrop(distM, k = DEFAULT_REFRACTION_K) {
  const reff = effectiveEarthRadius(k);
  return (distM * distM) / (2 * reff);
}

export class TerrariumTileCache {
  constructor(options = {}) {
    this.tileUrlTemplate =
      options.tileUrlTemplate ||
      "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
    this.maxCache = options.maxCache || 128;
    this.cache = new Map();
  }

  _makeUrl(z, x, y) {
    return this.tileUrlTemplate
      .replace("{z}", z)
      .replace("{x}", x)
      .replace("{y}", y);
  }

  _touch(key, value) {
    this.cache.delete(key);
    this.cache.set(key, value);

    if (this.cache.size > this.maxCache) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  async getTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this.cache.has(key)) {
      const existing = this.cache.get(key);
      this._touch(key, existing);
      return existing;
    }

    const url = this._makeUrl(z, x, y);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.src = url;
    await img.decode();

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, 256, 256);

    const tile = { z, x, y, imageData };
    this._touch(key, tile);
    return tile;
  }

  async getElevation(lat, lon, z = 12) {
    const t = lonLatToTileXY(lon, lat, z);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);

    const px = Math.max(0, Math.min(255, Math.floor((t.x - tx) * 256)));
    const py = Math.max(0, Math.min(255, Math.floor((t.y - ty) * 256)));

    const tile = await this.getTile(z, tx, ty);
    const data = tile.imageData.data;
    const i = (py * 256 + px) * 4;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    return terrariumHeight(r, g, b);
  }
}

export class HorizonEngine {
  constructor(options = {}) {
    this.tileCache =
      options.tileCache || new TerrariumTileCache(options.tileOptions || {});
    this.tileZoom = options.tileZoom || 12;
    this.observerHeightM = options.observerHeightM ?? 1.7;
    this.refractionK = options.refractionK ?? DEFAULT_REFRACTION_K;
  }

  async getGroundElevation(lat, lon) {
    return this.tileCache.getElevation(lat, lon, this.tileZoom);
  }

  buildDistanceArray(maxDistM, distanceStepM) {
    const out = [];
    for (let d = distanceStepM; d <= maxDistM; d += distanceStepM) {
      out.push(d);
    }
    return out;
  }

  async computeProfile({
    lat,
    lon,
    centerAzDeg = 270,
    fovDeg = 60,
    samples = 1000,
    maxDistM = 100000,
    distanceStepM = 500,
    onProgress = null,
  }) {
    const zGround = await this.getGroundElevation(lat, lon);
    const zObs = zGround + this.observerHeightM;

    const azStart = centerAzDeg - fovDeg / 2;
    const azStep = fovDeg / Math.max(1, samples - 1);

    const distances = this.buildDistanceArray(maxDistM, distanceStepM);
    const profile = new Float32Array(samples);

    for (let i = 0; i < samples; i++) {
      const az = azStart + i * azStep;
      let maxAngle = -90;

      for (let j = 0; j < distances.length; j++) {
        const d = distances[j];
        const p = destinationPoint(lat, lon, az, d);
        const z = await this.tileCache.getElevation(p.lat, p.lon, this.tileZoom);

        if (!Number.isFinite(z)) continue;

        const drop = curvatureDrop(d, this.refractionK);
        const ang = Math.atan2(z - zObs - drop, d) * RAD2DEG;
        if (ang > maxAngle) maxAngle = ang;
      }

      profile[i] = maxAngle;

      if (onProgress && (i % 20 === 0 || i === samples - 1)) {
        onProgress({
          done: i + 1,
          total: samples,
          fraction: (i + 1) / samples,
        });
      }
    }

    return {
      az0: azStart,
      daz: azStep,
      alt: profile,
      meta: {
        lat,
        lon,
        centerAzDeg,
        fovDeg,
        samples,
        maxDistM,
        distanceStepM,
        tileZoom: this.tileZoom,
      },
    };
  }
}