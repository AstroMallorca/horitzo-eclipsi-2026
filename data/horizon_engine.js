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

function destination(lat, lon, az, dist) {
  const φ1 = lat * DEG2RAD;
  const λ1 = lon * DEG2RAD;
  const θ = az * DEG2RAD;
  const δ = dist / EARTH_RADIUS;

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) +
    Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  );

  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );

  return {
    lat: φ2 * RAD2DEG,
    lon: ((λ2 * RAD2DEG + 540) % 360) - 180
  };
}

class TileCache {

  constructor() {
    this.tiles = new Map();
  }

  async get(z, x, y) {

    const key = `${z}/${x}/${y}`;
    if (this.tiles.has(key)) return this.tiles.get(key);

    const url =
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await img.decode();

    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;

    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const data = ctx.getImageData(0, 0, 256, 256);

    const tile = { data };
    this.tiles.set(key, tile);

    return tile;
  }

  async elevation(lat, lon, z) {

    const t = lonLatToTile(lon, lat, z);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);

    const px = Math.floor((t.x - tx) * 256);
    const py = Math.floor((t.y - ty) * 256);

    const tile = await this.get(z, tx, ty);

    const i = (py * 256 + px) * 4;
    const d = tile.data.data;

    return terrariumHeight(d[i], d[i + 1], d[i + 2]);
  }

}

export class HorizonEngine {

  constructor(opts = {}) {
    this.zoom = opts.tileZoom ?? 12;
    this.cache = new TileCache();
    this.observerHeight = 1.7;
  }

  buildDistances(maxDist) {

    const d = [];

    for (let x = 100; x < 5000; x += 100) d.push(x);
    for (let x = 5000; x < 20000; x += 250) d.push(x);
    for (let x = 20000; x < maxDist; x += 1000) d.push(x);

    return d;
  }

  async computeProfile(opts) {

    const {
      lat,
      lon,
      centerAzDeg = 270,
      fovDeg = 60,
      samples = 120,
      maxDistM = 100000
    } = opts;

    const distances = this.buildDistances(maxDistM);

    const ground = await this.cache.elevation(lat, lon, this.zoom);
    const obs = ground + this.observerHeight;

    const az0 = centerAzDeg - fovDeg / 2;
    const daz = fovDeg / samples;

    const alt = new Float32Array(samples);

    for (let i = 0; i < samples; i++) {

      const az = az0 + i * daz;
      let maxAng = -90;

      for (let d of distances) {

        const p = destination(lat, lon, az, d);
        const z = await this.cache.elevation(p.lat, p.lon, this.zoom);

        const ang =
          Math.atan2(z - obs, d) * RAD2DEG;

        if (ang > maxAng) maxAng = ang;
      }

      alt[i] = maxAng;
    }

    return { az0, daz, alt };

  }

}
