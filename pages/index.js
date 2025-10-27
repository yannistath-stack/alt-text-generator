import React, { useState, useEffect } from 'react';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';

/** ─────────────────────────────────────────────────────────────────────────────
 *  CONFIG
 *  ────────────────────────────────────────────────────────────────────────────
 */
const CORRECT_PASSWORD = 'AHM.2025';
const ACURA_UPPERCASE_MODELS = ['MDX','RDX','TLX','ILX','NSX','ZDX','ADX','RLX','TSX','RSX'];

/** Descriptors */
const EXTERIOR = {
  FRONT: 'front view',
  PROFILE: 'profile view',
  REAR: 'rear view',
};

const INTERIOR_DETAIL = {
  PADDLE: 'detail of paddle shifter',
  GEAR: 'detail of gear shifter',
  WHEEL: 'detail of steering wheel',
  DASH: 'detail of dashboard',
  CONSOLE: 'detail of center console',
  INFOTAINMENT: 'detail of infotainment',
  INTERIOR: 'interior detail',
};

/** ─────────────────────────────────────────────────────────────────────────────
 *  UTILS
 *  ────────────────────────────────────────────────────────────────────────────
 */
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
const clamp = (s) => (s.length <= 125 ? s : s.slice(0, 125).trim());

/** Acura model rule (uppercase if Acura & known model) */
function normalizedModel(model, make) {
  if (!model) return '';
  const up = model.toUpperCase();
  if (make && make.toLowerCase() === 'acura' && ACURA_UPPERCASE_MODELS.includes(up)) return up;
  return cap(model);
}

/** Filename normalizer for first-pass dedupe by name */
function normalizeName(filename) {
  let base = filename.toLowerCase();

  // strip extension
  base = base.replace(/\.(jpg|jpeg|png|webp|gif|avif)$/i, '');

  // remove size/scale tokens
  base = base
    .replace(/[-_\.](s|m|l|xl|small|medium|large|xlarge)\b/g, '')
    .replace(/@2x|@3x/gi, '')
    .replace(/[-_]?(\d{2,5})x(\d{2,5})\b/g, '') // WxH
    .replace(/[-_]?copy(\s*\d*)?\b/g, '')
    .replace(/[-_]?final\b/g, '')
    .replace(/[-_]?v\d+\b/g, '')
    .replace(/[-_\.]\d{1,4}\b/g, '');

  // collapse dups
  base = base.replace(/[-_\.]+/g, '-');

  return base.trim();
}

/** Canvas luminance helper */
function toImageData(img, target = 256) {
  const maxDim = target;
  const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
  const w = Math.max(1, Math.floor(img.width * scale));
  const h = Math.max(1, Math.floor(img.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return { ctx, w, h };
}

/** Perceptual hash (16x16 grayscale DCT-like quick pHash) */
function pHash(img) {
  // downscale to 16x16 grayscale
  const size = 16;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const gray = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  // average
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const avg = sum / gray.length;

  // bits
  let bits = '';
  for (let i = 0; i < gray.length; i++) bits += gray[i] > avg ? '1' : '0';
  return bits;
}
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  VISUAL CLASSIFIER (FILENAME IGNORED)
 *  ────────────────────────────────────────────────────────────────────────────
 */
async function analyzeImageURL(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const { ctx, w, h } = toImageData(img, 256);
        const { data } = ctx.getImageData(0, 0, w, h);

        // Stats
        let dark = 0, satSum = 0, edges = 0;
        let topBright = 0, midBright = 0, botBright = 0;
        const lum = new Float32Array(w * h);
        const satArr = new Float32Array(w * h);

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            lum[y * w + x] = l;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const s = max === 0 ? 0 : (max - min) / max;
            satArr[y * w + x] = s;

            if ((r + g + b) / 3 < 55) dark++;
            if (y < h / 3) topBright += l;
            else if (y < 2 * h / 3) midBright += l;
            else botBright += l;
            satSum += s;
          }
        }
        const total = w * h;
        const darkR = dark / total;
        const satAvg = satSum / total;

        // quick sobel edges
        const sobel = (x, y) => {
          const ix = y * w + x;
          const gx =
            -lum[ix - w - 1] - 2 * lum[ix - 1] - lum[ix + w - 1] +
            lum[ix - w + 1] + 2 * lum[ix + 1] + lum[ix + w + 1];
          const gy =
            lum[ix - w - 1] + 2 * lum[ix - w] + lum[ix - w + 1] -
            (lum[ix + w - 1] + 2 * lum[ix + w] + lum[ix + w + 1]);
          return Math.hypot(gx || 0, gy || 0);
        };
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) edges += sobel(x, y);
        }
        const edgeD = edges / total;

        // Exterior vs interior gate: bright, saturated, and strong horizon-ish edges = exterior
        const exteriorScore =
          (darkR < 0.35 ? 1 : 0) +
          (satAvg > 0.25 ? 1 : 0) +
          (edgeD > 20 ? 1 : 0);

        if (exteriorScore >= 2) {
          // Decide front / profile / rear
          // Heuristics: front tends to have bright cluster left+right upper-mid (headlights),
          // profile has bright cluster mostly left or mostly right, rear has bright band lower third.
          const thirds = [0, 0, 0];
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const l = lum[y * w + x];
              if (x < w / 3) thirds[0] += l;
              else if (x < (2 * w) / 3) thirds[1] += l;
              else thirds[2] += l;
            }
          }
          const left = thirds[0], mid = thirds[1], right = thirds[2];
          const upper = topBright, middle = midBright, lower = botBright;

          if ((upper > middle && upper > lower) && Math.abs(left - right) < left * 0.15) {
            return resolve({ descriptor: EXTERIOR.FRONT });
          }
          if ((lower > upper) && (lower > middle)) {
            return resolve({ descriptor: EXTERIOR.REAR });
          }
          return resolve({ descriptor: EXTERIOR.PROFILE });
        }

        // Interior details
        // Look for bright compact clusters for metal/knob → gear shifter detail.
        // Tall side bright streak → paddle shifter detail.
        // Big circle-ish near middle → steering wheel detail.
        // Rectangular/edge heavy middle area → center console detail.
        // Else dashboard / infotainment.

        // Compute bright points map
        const br = [];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const L = lum[y * w + x];
            if (L > 210) br.push({ x, y });
          }
        }
        // centroid
        let cx = 0, cy = 0;
        for (const p of br) { cx += p.x; cy += p.y; }
        if (br.length) { cx /= br.length; cy /= br.length; }

        // spread
        let vx = 0, vy = 0;
        for (const p of br) { vx += (p.x - cx) ** 2; vy += (p.y - cy) ** 2; }
        if (br.length) { vx /= br.length; vy /= br.length; }
        const spread = Math.sqrt(vx + vy);

        const centerish = (cx > w * 0.35 && cx < w * 0.65 && cy > h * 0.35 && cy < h * 0.70);
        const compact = spread < Math.min(w, h) * 0.15;
        const sideBright = (cx < w * 0.25 || cx > w * 0.75);
        const tall = vy > vx * 1.4;

        if (br.length > total * 0.008 && centerish && compact) {
          return resolve({ descriptor: INTERIOR_DETAIL.GEAR });
        }
        if (br.length > total * 0.008 && sideBright && tall) {
          return resolve({ descriptor: INTERIOR_DETAIL.PADDLE });
        }

        // wheel guess: bright ring-ish in mid-top
        if (cy < h * 0.55 && vx > vy * 0.8 && vx < vy * 1.2 && !compact) {
          return resolve({ descriptor: INTERIOR_DETAIL.WHEEL });
        }

        if (edgeD > 24 && cy >= h * 0.45) {
          return resolve({ descriptor: INTERIOR_DETAIL.CONSOLE });
        }

        // infotainment if mid has rectangular edges and sat a bit higher
        if (edgeD > 20 && satAvg > 0.18 && centerish) {
          return resolve({ descriptor: INTERIOR_DETAIL.INFOTAINMENT });
        }

        return resolve({ descriptor: INTERIOR_DETAIL.DASH });
      } catch {
        return resolve({ descriptor: EXTERIOR.FRONT });
      }
    };
    img.onerror = () => resolve({ descriptor: EXTERIOR.FRONT });
    img.src = url;
  });
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  MAIN
 *  ────────────────────────────────────────────────────────────────────────────
 */
export default function AltTextGenerator() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const [vehicleInfo, setVehicleInfo] = useState({
    year: '',
    make: '',
    model: '',
    trim: '',
    color: '',
  });

  const [images, setImages] = useState([]);
  const [showResults, setShowResults] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // auth
  useEffect(() => {
    const loggedIn = sessionStorage.getItem('authenticated');
    if (loggedIn === 'true') setIsAuthenticated(true);
  }, []);

  const handleLogin = (e) => {
    e.preventDefault();
    if (passwordInput === CORRECT_PASSWORD) {
      setIsAuthenticated(true);
      sessionStorage.setItem('authenticated', 'true');
      setPasswordError('');
    } else {
      setPasswordError('Incorrect password. Please try again.');
      setPasswordInput('');
    }
  };
  const handleLogout = () => {
    setIsAuthenticated(false);
    sessionStorage.removeItem('authenticated');
    setPasswordInput('');
  };

  /** Subject builder (no commas) */
  function subject() {
    const { year, make, model, trim, color } = vehicleInfo;
    // Make is optional now. Year + Model are required to enable upload, but subject tolerates missing pieces.
    const mk = make ? cap(make) : '';
    const mdl = normalizedModel(model, make);
    const parts = [year || '', mk || '', mdl || '', trim ? cap(trim) : '', color ? `in ${color}` : '']
      .filter(Boolean)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return parts;
  }

  /** Build alt (no commas) */
  function buildAlt(descriptor) {
    let alt = [subject(), descriptor].filter(Boolean).join(' ').trim();
    // Trim down if needed
    if (alt.length > 125) {
      // drop color then trim
      if (vehicleInfo.color) {
        alt = alt.replace(new RegExp(`\\s+in\\s+${vehicleInfo.color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), '').trim();
      }
    }
    if (alt.length > 125 && vehicleInfo.trim) {
      alt = alt.replace(new RegExp(`\\s+${vehicleInfo.trim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), '').trim();
    }
    return clamp(alt);
  }

  /** ZIP processor with robust dedupe (name + pHash) */
  async function processZipFile(file) {
    setProcessing(true);
    const zip = new JSZip();

    try {
      const contents = await zip.loadAsync(file);
      const entries = Object.entries(contents.files);

      // 1) Filter image file entries
      const candidates = [];
      for (const [filename, entry] of entries) {
        if (entry.dir) continue;
        const ext = filename.split('.').pop().toLowerCase();
        if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(ext)) continue;
        candidates.push({ filename, entry });
      }

      // 2) First-pass dedupe by normalized name → keep only one filename per group (arbitrary; we’ll do pHash later)
      const byName = new Map();
      for (const c of candidates) {
        const key = normalizeName(c.filename);
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(c);
      }

      // Flatten (still possibly multiple size variants per group)
      const nameGroups = Array.from(byName.values()).flat();

      // 3) Load each image to get blob/url + area + pHash
      const items = [];
      for (const c of nameGroups) {
        const blob = await c.entry.async('blob');
        const url = URL.createObjectURL(blob);
        const img = await new Promise((res) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => res(null);
          im.src = url;
        });
        if (!img) continue;
        const hash = pHash(img);
        const area = img.width * img.height;

        items.push({
          id: Math.random(),
          filename: c.filename,
          url,
          blob,
          width: img.width,
          height: img.height,
          area,
          hash,
        });
      }

      // 4) Group by pHash (hamming ≤ 10) and keep largest area per group
      const taken = new Set();
      const groups = [];

      for (let i = 0; i < items.length; i++) {
        if (taken.has(items[i])) continue;
        const group = [items[i]];
        for (let j = i + 1; j < items.length; j++) {
          if (taken.has(items[j])) continue;
          if (hamming(items[i].hash, items[j].hash) <= 10) {
            group.push(items[j]);
            taken.add(items[j]);
          }
        }
        groups.push(group);
      }

      // select largest from each group
      const deduped = groups.map(g => g.sort((a, b) => b.area - a.area)[0]);

      // 5) Visual analysis for each deduped image (filename ignored entirely)
      const analyzed = [];
      for (const img of deduped) {
        const { descriptor } = await analyzeImageURL(img.url);
        analyzed.push({
          ...img,
          descriptor,
          alt: buildAlt(descriptor),
        });
      }

      setImages(analyzed);
      setShowResults(true);
    } catch (e) {
      console.error(e);
      alert('Error processing ZIP file. Please try again.');
    } finally {
      setProcessing(false);
    }
  }

  /** UI handlers */
  const handleZipUpload = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await processZipFile(f);
  };
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };
  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.zip')) await processZipFile(f);
    else alert('Please drop a ZIP file');
  };
  const copyToClipboard = (t, i) => {
    navigator.clipboard.writeText(t);
    setCopiedIndex(i);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const exportPDF = async () => {
    const doc = new jsPDF();
    let y = 20;
    doc.setFontSize(18); doc.text('Alt Text Report', 20, y); y += 10;
    doc.setFontSize(12); doc.text(subject() || 'Vehicle images', 20, y); y += 15;

    for (const img of images) {
      if (y > 220) { doc.addPage(); y = 20; }
      const dataUrl = await new Promise((res) => {
        const r = new FileReader();
        r.onloadend = () => res(r.result);
        r.readAsDataURL(img.blob);
      });
      const isPng = img.filename.toLowerCase().endsWith('.png');
      doc.addImage(dataUrl, isPng ? 'PNG' : 'JPEG', 20, y, 60, 40);
      doc.setFontSize(10);
      const split = doc.splitTextToSize(img.alt, 100);
      doc.text(split, 85, y + 5);
      y += 50;
    }
    doc.save('alt-text-report.pdf');
  };

  const resetTool = () => {
    setShowResults(false);
    setImages([]);
    setVehicleInfo({ year: '', make: '', model: '', trim: '', color: '' });
  };

  /** ───────────────── UI ───────────────── */
  if (!isAuthenticated) {
    return (
      <div style={styles.loginContainer}>
        <div style={styles.loginCard}>
          <div style={styles.loginHeader}>
            <h1 style={styles.loginTitle}>🔒 AI SEO Alt Text Generator</h1>
            <p style={styles.loginSubtitle}>Protected Access</p>
          </div>
          <form onSubmit={handleLogin} style={styles.loginForm}>
            <div style={styles.inputGroup}>
              <label style={styles.loginLabel}>Password</label>
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Enter password"
                style={styles.loginInput}
                autoFocus
              />
            </div>
            {passwordError && <p style={styles.errorMessage}>{passwordError}</p>}
            <button type="submit" style={styles.loginButton}>Access Tool</button>
          </form>
          <p style={styles.loginFooter}>For authorized Honda/Acura team members only</p>
        </div>
      </div>
    );
  }

  if (showResults) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <div style={styles.header}>
            <div>
              <h1 style={styles.title}>Generated Alt Text</h1>
              <p style={styles.subtitle}>{subject()}</p>
              <p style={styles.count}>{images.length} unique images</p>
            </div>
            <div style={styles.buttonGroup}>
              <button onClick={exportPDF} style={{ ...styles.button, ...styles.greenButton }}>📥 Export PDF</button>
              <button onClick={resetTool} style={{ ...styles.button, ...styles.grayButton }}>Start Over</button>
              <button onClick={handleLogout} style={{ ...styles.button, ...styles.redButton }}>🔒 Logout</button>
            </div>
          </div>

          <div style={styles.imageList}>
            {images.map((img, index) => (
              <div key={img.id} style={styles.imageCard}>
                <img src={img.url} alt={img.alt} style={styles.thumbnail} />
                <div style={styles.altTextContainer}>
                  <label style={styles.label}>Alt Text</label>
                  <div style={styles.textBoxWrapper}>
                    <p style={styles.altTextBox}>{img.alt}</p>
                    <button
                      onClick={() => copyToClipboard(img.alt, index)}
                      style={styles.copyButton}
                      title="Copy to clipboard"
                    >
                      {copiedIndex === index ? '✓' : '📋'}
                    </button>
                  </div>
                  <p style={styles.charCount}>{img.alt.length} characters</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const canUpload = Boolean(vehicleInfo.year && vehicleInfo.model); // ONLY year+model required

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.headerSection}>
          <div style={styles.titleRow}>
            <h1 style={styles.mainTitle}>AI SEO Alt Text Generator</h1>
            <button onClick={handleLogout} style={{ ...styles.button, ...styles.redButton }}>🔒 Logout</button>
          </div>
          <p style={styles.description}>Generate optimized alt text for automotive images</p>
        </div>

        <div style={styles.form}>
          <div style={styles.grid}>
            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Year <span style={styles.required}>*</span></label>
              <input
                type="text"
                value={vehicleInfo.year}
                onChange={(e) => setVehicleInfo({ ...vehicleInfo, year: e.target.value })}
                placeholder="2025"
                style={styles.input}
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Model <span style={styles.required}>*</span></label>
              <input
                type="text"
                value={vehicleInfo.model}
                onChange={(e) => setVehicleInfo({ ...vehicleInfo, model: e.target.value })}
                placeholder="MDX"
                style={styles.input}
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Make <span style={styles.optional}>(optional)</span></label>
              <input
                type="text"
                value={vehicleInfo.make}
                onChange={(e) => setVehicleInfo({ ...vehicleInfo, make: e.target.value })}
                placeholder="Acura"
                style={styles.input}
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Trim <span style={styles.optional}>(optional)</span></label>
              <input
                type="text"
                value={vehicleInfo.trim}
                onChange={(e) => setVehicleInfo({ ...vehicleInfo, trim: e.target.value })}
                placeholder="Type S"
                style={styles.input}
              />
            </div>

            <div style={{ ...styles.inputGroup, gridColumn: '1 / -1' }}>
              <label style={styles.inputLabel}>Color <span style={styles.optional}>(optional)</span></label>
              <input
                type="text"
                value={vehicleInfo.color}
                onChange={(e) => setVehicleInfo({ ...vehicleInfo, color: e.target.value })}
                placeholder="Apex Blue Pearl"
                style={styles.input}
              />
            </div>
          </div>

          <div
            style={{ ...styles.uploadBox, ...(dragActive ? styles.uploadBoxActive : {}) }}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            <input
              type="file"
              accept=".zip"
              onChange={handleZipUpload}
              style={styles.fileInput}
              id="zip-upload"
              disabled={!canUpload || processing}
            />
            <label
              htmlFor="zip-upload"
              style={{
                ...styles.uploadLabel,
                opacity: canUpload ? 1 : 0.5,
                cursor: canUpload ? 'pointer' : 'not-allowed'
              }}
            >
              <div style={styles.uploadIcon}>📁</div>
              <p style={styles.uploadText}>
                {processing ? 'Processing images...' : dragActive ? 'Drop ZIP file here' : 'Drag & drop ZIP file or click to browse'}
              </p>
              <p style={styles.uploadSubtext}>
                {canUpload ? 'Supports JPG, PNG, WEBP, AVIF' : 'Please fill Year and Model first'}
              </p>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

/** ─────────────────────────────────────────────────────────────────────────────
 *  STYLES
 *  ────────────────────────────────────────────────────────────────────────────
 */
const styles = {
  loginContainer: {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
  },
  loginCard: { background: 'white', borderRadius: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', padding: '3rem', maxWidth: '400px', width: '100%' },
  loginHeader: { textAlign: 'center', marginBottom: '2rem' },
  loginTitle: { fontSize: '1.75rem', fontWeight: 'bold', color: '#111827', marginBottom: '0.5rem' },
  loginSubtitle: { color: '#6b7280', fontSize: '0.875rem' },
  loginForm: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  loginLabel: { display: 'block', fontSize: '0.875rem', fontWeight: '500', color: '#374151', marginBottom: '0.5rem' },
  loginInput: { width: '100%', padding: '0.75rem 1rem', border: '2px solid #e5e7eb', borderRadius: '8px', fontSize: '1rem', outline: 'none' },
  loginButton: { width: '100%', padding: '0.875rem', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1rem', fontWeight: '600', cursor: 'pointer' },
  errorMessage: { color: '#ef4444', fontSize: '0.875rem', textAlign: 'center', margin: 0 },
  loginFooter: { textAlign: 'center', fontSize: '0.75rem', color: '#9ca3af', marginTop: '1.5rem' },

  container: { minHeight: '100vh', background: 'linear-gradient(to bottom right, #f9fafb, #f3f4f6)', padding: '2rem' },
  card: { maxWidth: '1200px', margin: '0 auto', background: 'white', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', padding: '2rem' },

  headerSection: { marginBottom: '2rem' },
  titleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' },
  mainTitle: { fontSize: '1.75rem', fontWeight: 'bold', color: '#111827' },
  description: { color: '#6b7280' },

  form: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1.5rem' },
  inputGroup: { display: 'flex', flexDirection: 'column' },
  inputLabel: { fontSize: '0.875rem', fontWeight: '500', color: '#374151', marginBottom: '0.5rem' },
  required: { color: '#ef4444' },
  optional: { color: '#9ca3af', fontSize: '0.75rem' },
  input: { width: '100%', padding: '0.75rem 1rem', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '1rem', outline: 'none' },

  uploadBox: { border: '2px dashed #d1d5db', borderRadius: '8px', padding: '2rem', textAlign: 'center', background: '#f9fafb', transition: 'all 0.2s' },
  uploadBoxActive: { borderColor: '#3b82f6', background: '#eff6ff' },
  fileInput: { display: 'none' },
  uploadLabel: { display: 'block' },
  uploadIcon: { fontSize: '3rem', marginBottom: '0.5rem' },
  uploadText: { color: '#374151', fontWeight: '500', marginBottom: '0.5rem' },
  uploadSubtext: { fontSize: '0.875rem', color: '#6b7280' },

  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem', paddingBottom: '1rem', borderBottom: '1px solid #e5e7eb' },
  title: { fontSize: '1.5rem', fontWeight: 'bold', color: '#111827' },
  subtitle: { color: '#6b7280', marginTop: '0.25rem' },
  count: { fontSize: '0.875rem', color: '#9ca3af', marginTop: '0.25rem' },
  buttonGroup: { display: 'flex', gap: '0.75rem' },
  button: { padding: '0.5rem 1rem', borderRadius: '8px', border: 'none', fontWeight: '500', cursor: 'pointer', fontSize: '0.875rem' },
  greenButton: { background: '#16a34a', color: 'white' },
  grayButton: { background: '#4b5563', color: 'white' },
  redButton: { background: '#dc2626', color: 'white' },

  imageList: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  imageCard: { display: 'flex', gap: '1.5rem', padding: '1.25rem', border: '1px solid #e5e7eb', borderRadius: '8px' },
  thumbnail: { width: '256px', height: '192px', objectFit: 'cover', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', flexShrink: 0 },
  altTextContainer: { flex: 1 },
  label: { display: 'block', fontSize: '0.875rem', fontWeight: '500', color: '#6b7280', marginBottom: '0.5rem' },
  textBoxWrapper: { position: 'relative' },
  altTextBox: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '1rem 4rem 1rem 1rem', color: '#111827', userSelect: 'text', cursor: 'text', wordBreak: 'break-word' },
  copyButton: { position: 'absolute', right: '0.5rem', top: '0.5rem', padding: '0.5rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '1.25rem' },
  charCount: { fontSize: '0.875rem', color: '#6b7280', marginTop: '0.5rem' },
};
