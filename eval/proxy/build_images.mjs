#!/usr/bin/env node
/**
 * Build / rebuild the frozen proxy image set (section 1.3).
 *
 * Real: COCO val2017 stills (HTTP), metadata stripped.
 * AI (legal generator outputs — NOT procedural noise):
 *   - sdxl:         DRAGON test set model=SDXL (lesc-unifi/dragon, CC-BY-SA-4.0)
 *   - flux-schnell: DRAGON test set model=Flux_1 (Flux.1-schnell per DRAGON paper)
 *   - pixart:       DRAGON test set model=PixArt_Alpha
 *   - openfake:     ComplexDataLab/OpenFake core **test** split, label=fake (train-disjoint)
 *
 * Source roots (defaults under /mnt/HC_Volume_…/poidh-cache or env overrides):
 *   PROXY_DRAGON_DIR, PROXY_OPENFAKE_DIR
 *
 * Corruptions: none | jpeg_q70 | jpeg_q40 | webp | screenshot
 * Never train on these hashes (see CONSTRUCTION.md).
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname);
const IMAGES = join(ROOT, 'images');
const MANIFEST_PATH = join(ROOT, 'manifest.json');
const COCO_ID_LIST = join(ROOT, 'coco_val_ids.txt');

const COCO_BASE = 'http://images.cocodataset.org/val2017';

/** Prefer volume cache (root / often fills with HF). Override via env. */
const DRAGON_DIR =
  process.env.PROXY_DRAGON_DIR ||
  '/mnt/HC_Volume_105994188/poidh-cache/dragon_extract';
const OPENFAKE_DIR =
  process.env.PROXY_OPENFAKE_DIR ||
  '/mnt/HC_Volume_105994188/poidh-cache/openfake_test';

const REAL_COUNT = 110;
const AI_PER_FAMILY = 28;
const CORRUPTIONS = ['none', 'jpeg_q70', 'jpeg_q40', 'webp', 'screenshot'];

/** Family → how to collect base PNG paths (real generator outputs). */
const AI_SOURCES = [
  {
    family: 'sdxl',
    license:
      'CC-BY-SA-4.0 — DRAGON test (lesc-unifi/dragon), model=SDXL',
    collect: () => listPrefixedPngs(DRAGON_DIR, 'sdxl_'),
  },
  {
    family: 'flux-schnell',
    license:
      'CC-BY-SA-4.0 — DRAGON test (lesc-unifi/dragon), model=Flux_1 (Flux.1-schnell)',
    collect: () => listPrefixedPngs(DRAGON_DIR, 'flux_1_'),
  },
  {
    family: 'pixart',
    license:
      'CC-BY-SA-4.0 — DRAGON test (lesc-unifi/dragon), model=PixArt_Alpha',
    collect: () => listPrefixedPngs(DRAGON_DIR, 'pixart_alpha_'),
  },
  {
    family: 'openfake',
    license:
      'CC-BY-SA-4.0 / OpenFake terms — ComplexDataLab/OpenFake core test split (label=fake, train-disjoint)',
    collect: () => listAllPngs(OPENFAKE_DIR),
  },
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

/**
 * List DRAGON PNGs for a model prefix.
 * `sdxl_` matches `sdxl_0_0_test.png` but not `sdxl_turbo_*` / `sdxl_lightning_*`.
 */
function listPrefixedPngs(dir, prefix) {
  if (!existsSync(dir)) {
    throw new Error(
      `AI source dir missing: ${dir} (set PROXY_DRAGON_DIR / extract DRAGON test PNGs)`,
    );
  }
  const re = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+_\\d+_test\\.png$`,
  );
  return readdirSync(dir)
    .filter((f) => re.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/_(\d+)_\d+_test/)?.[1] ?? 0);
      const nb = Number(b.match(/_(\d+)_\d+_test/)?.[1] ?? 0);
      return na - nb;
    })
    .map((f) => join(dir, f));
}

function listAllPngs(dir) {
  if (!existsSync(dir)) {
    throw new Error(
      `AI source dir missing: ${dir} (set PROXY_OPENFAKE_DIR / materialize OpenFake test fakes)`,
    );
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.webp'))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Encode with optional corruption. Metadata stripped (re-encode, no withMetadata).
 */
async function stripAndEncodeFromFile(absPath, corruption) {
  let img = sharp(absPath).rotate().removeAlpha();

  const meta = await img.metadata();
  const width = meta.width ?? 512;
  const height = meta.height ?? 512;

  if (corruption === 'screenshot') {
    const w = Math.max(64, Math.floor(width * 0.55));
    const h = Math.max(64, Math.floor(height * 0.55));
    const buf = await img
      .resize(w, h, { kernel: 'nearest' })
      .resize(width, height, { kernel: 'nearest' })
      .raw()
      .toBuffer();
    img = sharp(buf, {
      raw: { width, height, channels: 3 },
    });
  }

  switch (corruption) {
    case 'jpeg_q70':
      return {
        buf: await img.jpeg({ quality: 70, mozjpeg: true }).toBuffer(),
        ext: 'jpg',
      };
    case 'jpeg_q40':
      return {
        buf: await img.jpeg({ quality: 40, mozjpeg: true }).toBuffer(),
        ext: 'jpg',
      };
    case 'webp':
      return {
        buf: await img.webp({ quality: 80 }).toBuffer(),
        ext: 'webp',
      };
    case 'screenshot':
    case 'none':
    default:
      return {
        buf: await img.png({ compressionLevel: 9 }).toBuffer(),
        ext: 'png',
      };
  }
}

async function loadCocoRgb(fileName) {
  const url = `${COCO_BASE}/${fileName}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`COCO fetch failed ${url}: ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  const raw = Buffer.from(ab);
  const { data, info } = await sharp(raw)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: Buffer.from(data),
  };
}

async function stripAndEncodeRgb(rgb, corruption) {
  let img = sharp(rgb.data, {
    raw: { width: rgb.width, height: rgb.height, channels: 3 },
  });

  if (corruption === 'screenshot') {
    const w = Math.max(64, Math.floor(rgb.width * 0.55));
    const h = Math.max(64, Math.floor(rgb.height * 0.55));
    const buf = await img
      .resize(w, h, { kernel: 'nearest' })
      .resize(rgb.width, rgb.height, { kernel: 'nearest' })
      .raw()
      .toBuffer();
    img = sharp(buf, {
      raw: { width: rgb.width, height: rgb.height, channels: 3 },
    });
  }

  switch (corruption) {
    case 'jpeg_q70':
      return {
        buf: await img.jpeg({ quality: 70, mozjpeg: true }).toBuffer(),
        ext: 'jpg',
      };
    case 'jpeg_q40':
      return {
        buf: await img.jpeg({ quality: 40, mozjpeg: true }).toBuffer(),
        ext: 'jpg',
      };
    case 'webp':
      return {
        buf: await img.webp({ quality: 80 }).toBuffer(),
        ext: 'webp',
      };
    case 'screenshot':
    case 'none':
    default:
      return {
        buf: await img.png({ compressionLevel: 9 }).toBuffer(),
        ext: 'png',
      };
  }
}

function loadCocoIdList() {
  if (!existsSync(COCO_ID_LIST)) {
    throw new Error(
      `Missing ${COCO_ID_LIST}. Provide COCO val2017 filenames (one per line).`,
    );
  }
  return readFileSync(COCO_ID_LIST, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  // Wipe previous AI tree (old sine-wave freeze) so stale hashes cannot remain.
  const aiRoot = join(IMAGES, 'ai');
  if (existsSync(aiRoot)) {
    rmSync(aiRoot, { recursive: true, force: true });
  }
  ensureDir(IMAGES);
  ensureDir(join(IMAGES, 'real'));

  const rows = [];
  const cocoIds = loadCocoIdList();
  if (cocoIds.length < REAL_COUNT) {
    throw new Error(`Need >= ${REAL_COUNT} COCO ids, got ${cocoIds.length}`);
  }

  console.log(
    `Building ${REAL_COUNT} real (COCO) + ${AI_SOURCES.length * AI_PER_FAMILY} AI from legal generators...`,
  );

  // --- Real (COCO) — re-encode if missing or always rebuild for consistency ---
  for (let i = 0; i < REAL_COUNT; i++) {
    const fileName = cocoIds[i];
    const corruption = CORRUPTIONS[i % CORRUPTIONS.length];
    // Always rebuild real when script runs (deterministic from COCO + corruption).
    process.stdout.write(
      `  real ${i + 1}/${REAL_COUNT} ${fileName} [${corruption}]\n`,
    );
    const rgb = await loadCocoRgb(fileName);
    const { buf, ext } = await stripAndEncodeRgb(rgb, corruption);
    const relpath = `images/real/coco_${fileName.replace('.jpg', '')}_${corruption}.${ext}`;
    const abs = join(ROOT, relpath);
    ensureDir(dirname(abs));
    writeFileSync(abs, buf);
    rows.push({
      relpath,
      sha256: sha256(buf),
      label: 'real',
      family: 'coco-val2017',
      corruption,
      license: 'COCO-val2017 (Flickr original licenses; research use)',
    });
  }

  // --- AI from named legal generator sources ---
  for (const src of AI_SOURCES) {
    const bases = src.collect();
    if (bases.length < AI_PER_FAMILY) {
      throw new Error(
        `Family ${src.family}: need >= ${AI_PER_FAMILY} source images, got ${bases.length} in source dir`,
      );
    }
    ensureDir(join(IMAGES, 'ai', src.family));
    for (let i = 0; i < AI_PER_FAMILY; i++) {
      const corruption = CORRUPTIONS[i % CORRUPTIONS.length];
      const base = bases[i];
      process.stdout.write(
        `  ai ${src.family} ${i + 1}/${AI_PER_FAMILY} ← ${relative(process.cwd(), base)} [${corruption}]\n`,
      );
      const { buf, ext } = await stripAndEncodeFromFile(base, corruption);
      const relpath = `images/ai/${src.family}/${src.family}_${String(i).padStart(3, '0')}_${corruption}.${ext}`;
      const abs = join(ROOT, relpath);
      ensureDir(dirname(abs));
      writeFileSync(abs, buf);
      rows.push({
        relpath,
        sha256: sha256(buf),
        label: 'ai',
        family: src.family,
        corruption,
        license: src.license,
      });
    }
  }

  if (rows.length === 0) {
    throw new Error('manifest would be empty — refuse');
  }

  // Fail if any AI family is still the old procedural tag
  const banned = rows.filter(
    (r) =>
      r.label === 'ai' &&
      /sine|procedural|stand-in|self-generated by eval\/proxy\/build_images/i.test(
        r.license,
      ),
  );
  if (banned.length) {
    throw new Error('refusing procedural AI rows in freeze');
  }

  const manifest = {
    version: 2,
    frozen_at: '2026-08-13',
    section: '1.3',
    description:
      'Full frozen proxy for soul-7 admission. AI half from legal generator datasets (DRAGON SDXL/Flux.1/PixArt-α + OpenFake test). No hashed subset. Never train on these hashes.',
    formula:
      'attempted N; skip-rate=skips/N; BA=(TPR+TNR)/2 on scored only; pass iff BA>=0.750 and skip-rate<=0.10',
    sources: {
      real: 'COCO val2017 via images.cocodataset.org',
      sdxl: 'DRAGON test model=SDXL',
      'flux-schnell': 'DRAGON test model=Flux_1 (Flux.1-schnell)',
      pixart: 'DRAGON test model=PixArt_Alpha',
      openfake: 'ComplexDataLab/OpenFake core test, label=fake',
    },
    rows,
  };

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const realN = rows.filter((r) => r.label === 'real').length;
  const aiN = rows.filter((r) => r.label === 'ai').length;
  const families = [
    ...new Set(rows.filter((r) => r.label === 'ai').map((r) => r.family)),
  ];
  console.log(
    `Wrote ${rows.length} rows → ${relative(process.cwd(), MANIFEST_PATH)} (real=${realN} ai=${aiN} families=${families.join(',')})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
