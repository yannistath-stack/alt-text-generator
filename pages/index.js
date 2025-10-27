import React, { useEffect, useState } from 'react';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';

/** ************************************************************
 * CONFIG
 ************************************************************* */
const CORRECT_PASSWORD = 'AHM.2025';

// Acura models to keep UPPERCASE when make === Acura
const ACURA_UPPERCASE_MODELS = [
  'MDX', 'RDX', 'TLX', 'ILX', 'NSX', 'ZDX', 'ADX', 'RLX', 'TSX', 'RSX'
];

/** ************************************************************
 * SMALL HELPERS
 ************************************************************* */
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

const normalizeModel = (model, make) => {
  if (!model) return '';
  const up = model.toUpperCase();
  if (make && make.toLowerCase() === 'acura' && ACURA_UPPERCASE_MODELS.includes(up)) {
    return up; // keep official uppercase
  }
  return cap(model);
};

const subjectString = ({ year, make, model, trim, color }) => {
  const parts = [
    year || '',
    make ? cap(make) : '',
    normalizeModel(model, make) || '',
    trim ? cap(trim) : '',
    color ? `in ${color}` : '',
  ].filter(Boolean);
  return parts.join(' ').replace(/\s{2,}/g, ' ').trim();
};

const clamp125 = (s) => (s.length <= 125 ? s : s.slice(0, 125).trim());

/** ************************************************************
 * PERCEPTUAL HASH (content-aware dedupe)
 ************************************************************* */
const imageHash = (img) => {
  const W = 32, H = 32;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);

  const gray = new Float32Array(W * H);
  let sum = 0;
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    gray[i] = y; sum += y;
  }
  const avg = sum / (W * H);

  // block hash bits -> hex string
  let bits = '';
  for (let i = 0; i < gray.length; i++) bits += (gray[i] > avg ? '1' : '0');

  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
};

const hamming = (a, b) => {
  let dist = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return dist + Math.abs(a.length - b.length) * 4;
};

/** ************************************************************
 * VISUAL CLASSIFIER (no filename influence)
 ************************************************************* */
const analyzeImage = (url) => new Promise((resolve) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const maxDim = 256;
      const scale = Math.min(maxDim / img.width, maxDim / img.height);
      const w = Math.max(1, Math.floor(img.width * scale));
      const h = Math.max(1, Math.floor(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);

      let dark = 0, bright = 0, grayish = 0, satSum = 0, redStrong = 0, blueStrong = 0;
      const brightPts = [];
      const top = { sum: 0, cnt: 0 }, mid = { sum: 0, cnt: 0 }, bot = { sum: 0, cnt: 0 };

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const lum = (r + g + b) / 3;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          const s = mx === 0 ? 0 : (mx - mn) / mx;

          if (lum < 50) dark++;
          if (lum > 210) { bright++; brightPts.push({ x, y }); }
          if (Math.abs(r - g) < 15 && Math.abs(g - b) < 15) grayish++;
          if (r > 140 && r > g + 25) redStrong++;
          if (b > 140 && b > r + 20) blueStrong++;
          satSum += s;

          if (y < h / 3) { top.sum += lum; top.cnt++; }
          else if (y < 2 * h / 3) { mid.sum += lum; mid.cnt++; }
          else { bot.sum += lum; bot.cnt++; }
        }
      }

      const total = w * h;
      const darkR = dark / total;
      const grayR = grayish / total;
      const sat = satSum / total;

      // interior vs exterior
      const interiorScore = (darkR > 0.35 ? 1 : 0) + (grayR > 0.32 ? 1 : 0) + (sat < 0.22 ? 1 : 0);
      const isInterior = interiorScore >= 2;

      if (isInterior) {
        // detail classification
        let cx = 0, cy = 0;
        brightPts.forEach((p) => { cx += p.x; cy += p.y; });
        if (brightPts.length) { cx /= brightPts.length; cy /= brightPts.length; }
        let sx = 0, sy = 0;
        brightPts.forEach((p) => { sx += (p.x - cx) ** 2; sy += (p.y - cy) ** 2; });
        if (brightPts.length) { sx /= brightPts.length; sy /= brightPts.length; }
        const spread = Math.sqrt(sx + sy);
        const centerish = (cx > w * 0.35 && cx < w * 0.65 && cy > h * 0.35 && cy < h * 0.70);
        const compact = spread < Math.min(w, h) * 0.16;
        const side = (cx < w * 0.25 || cx > w * 0.75) && (sy > sx * 1.2);
        const bottomBright = (bot.sum / (bot.cnt || 1)) > (mid.sum / (mid.cnt || 1)) + 12;

        let label = 'dashboard';
        if (centerish && compact) label = 'gear shifter';
        else if (side && compact) label = 'paddle shifter';
        else if (bottomBright) label = 'center console';
        // could add: steering wheel (very large circular dark mass + highlights), infotainment screen (rect bright)

        return resolve({ kind: 'detail', label: `detail of ${label}` });
      }

      // exterior
      const topAvg = top.sum / (top.cnt || 1);
      const midAvg = mid.sum / (mid.cnt || 1);
      const botAvg = bot.sum / (bot.cnt || 1);

      const cols = new Array(w).fill(0);
      brightPts.forEach((p) => { if (p.y > h * 0.5) cols[p.x]++; });
      let L = { x: 0, v: 0 }, R = { x: 0, v: 0 };
      cols.forEach((v, x) => { if (x < w / 2 && v > L.v) L = { x, v }; if (x >= w / 2 && v > R.v) R = { x, v }; });
      const twin = L.v > brightPts.length * 0.02 && R.v > brightPts.length * 0.02 && Math.abs(L.x - R.x) > w * 0.25;

      if (redStrong > blueStrong + 120) return resolve({ kind: 'view', label: 'rear view' });
      if (twin || (brightPts.length / total) > 0.10 || blueStrong > redStrong + 40) return resolve({ kind: 'view', label: 'front view' });
      if (topAvg > botAvg + 20 && topAvg > midAvg + 10) return resolve({ kind: 'view', label: 'top view' });
      return resolve({ kind: 'view', label: 'profile view' });
    } catch {
      return resolve({ kind: 'view', label: 'profile view' });
    }
  };
  img.onerror = () => resolve({ kind: 'view', label: 'profile view' });
  img.src = url;
});

/** ************************************************************
 * ALT BUILDER
 ************************************************************* */
const buildAlt = (vehicleInfo, analysis) => {
  const base = subjectString(vehicleInfo);
  const tail = analysis.label; // "front view" or "detail of ..."
  const alt = [base, tail].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
  // stylistic: remove commas if any sneak in
  return clamp125(alt.replace(/,/g, ''));
};

/** ************************************************************
 * ZIP PROCESSOR (content-aware dedupe + analysis)
 ************************************************************* */
const processZipFile = async (file, setProcessing, setImages, setShowResults, vehicleInfo) => {
  setProcessing(true);
  const zip = new JSZip();
  try {
    const contents = await zip.loadAsync(file);

    // Collect candidates (any nested path)
    const candidates = []; // { filename, blob, url, img, w, h, hash }
    const entries = Object.entries(contents.files);

    for (const [filename, entry] of entries) {
      if (entry.dir) continue;
      const ext = filename.split('.').pop().toLowerCase();
      if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(ext)) continue;

      const blob = await entry.async('blob');
      const url = URL.createObjectURL(blob);

      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = url;
      });

      const hash = imageHash(img);
      candidates.push({
        filename, blob, url, img,
        w: img.naturalWidth, h: img.naturalHeight, hash
      });
    }

    // Group near duplicates by hash
    const THRESH = 10;
    const groups = [];
    const used = new Array(candidates.length).fill(false);

    for (let i = 0; i < candidates.length; i++) {
      if (used[i]) continue;
      const group = [candidates[i]];
      used[i] = true;
      for (let j = i + 1; j < candidates.length; j++) {
        if (used[j]) continue;
        if (hamming(candidates[i].hash, candidates[j].hash) <= THRESH) {
          group.push(candidates[j]);
          used[j] = true;
        }
      }
      groups.push(group);
    }

    // For each group, keep largest, analyze, build alt
    const out = [];
    for (const group of groups) {
      const best = group.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
      const analysis = await analyzeImage(best.url);
      const alt = buildAlt(vehicleInfo, analysis);
      out.push({
        id: Date.now() + Math.random(),
        filename: best.filename,
        url: best.url,
        blob: best.blob,
        alt
      });
    }

    setImages(out);
    setShowResults(true);
  } catch (e) {
    console.error(e);
    alert('Error processing ZIP file. Please try again.');
  } finally {
    setProcessing(false);
  }
};

/** ************************************************************
 * PAGE COMPONENT
 ************************************************************* */
export default function AltTextGenerator() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const [vehicleInfo, setVehicleInfo] = useState({
    year: '',
    make: '',
    model: '',
    trim: '',
    color: ''
  });

  const [images, setImages] = useState([]);
  const [showResults, setShowResults] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [dragActive, setDragActive] = useState(false);

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

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setDragActive(false);
    const f = e.dataTransfer.files[0];
    if (f && f.name.toLowerCase().endsWith('.zip')) {
      await processZipFile(f, setProcessing, setImages, setShowResults, vehicleInfo);
    } else {
      alert('Please drop a ZIP file');
    }
  };

  const handleZipUpload = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await processZipFile(f, setProcessing, setImages, setShowResults, vehicleInfo);
  };

  const copyToClipboard = (text, index) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const exportPDF = async () => {
    const doc = new jsPDF();
    let y = 20;

    doc.setFontSize(18);
    doc.text('Alt Text Report', 20, y);
    y += 10;

    doc.setFontSize(12);
    const vText = subjectString(vehicleInfo);
    if (vText) {
      doc.text(vText, 20, y);
      y += 15;
    }

    for (let i = 0; i < images.length; i++) {
      if (y > 220) { doc.addPage(); y = 20; }
      const img = images[i];

      const imgData = await new Promise((res) => {
        const r = new FileReader();
        r.onloadend = () => res(r.result);
        r.readAsDataURL(img.blob);
      });

      doc.addImage(imgData, 'JPEG', 20, y, 60, 40);
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
    setVehicleInfo({
      year: '',
      make: '',
      model: '',
      trim: '',
      color: ''
    });
  };

  /** *******************************
   * RENDER
   ******************************** */
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
              <p style={styles.subtitle}>
                {subjectString(vehicleInfo)}
              </p>
              <p style={styles.count}>{images.length} unique images</p>
            </div>
            <div style={styles.buttonGroup}>
              <button onClick={exportPDF} style={{ ...styles.button, ...styles.greenButton }}>📥 Export PDF</button>
              <button onClick={resetTool} style={{ ...styles.button, ...styles.grayButton }}>Start Over</button>
              <button onClick={handleLogout} style={{ ...styles.button, ...styles.redButton }}>🔒 Logout</button>
            </div>
          </div>

          <div style={styles.imageList}>
            {images.map((img, i) => (
              <div key={img.id} style={styles.imageCard}>
                <img src={img.url} alt="Vehicle preview" style={styles.thumbnail} />
                <div style={styles.altTextContainer}>
                  <label style={styles.label}>Alt Text</label>
                  <div style={styles.textBoxWrapper}>
                    <p style={styles.altTextBox}>{img.alt}</p>
                    <button
                      onClick={() => copyToClipboard(img.alt, i)}
                      style={styles.copyButton}
                      title="Copy to clipboard"
                    >
                      {copiedIndex === i ? '✓' : '📋'}
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

  // Form view
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
              <label style={styles.inputLabel}>
                Year <span style={styles.required}>*</span>
              </label>
              <input
                type="text"
                value={vehicleInfo.year}
                onChange={(e) => setVehicleInfo({ ...vehicleInfo, year: e.target.value })}
                placeholder="2025"
                style={styles.input}
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>
                Make <span style={styles.optional}>(optional)</span>
              </label>
              <input
                type="text"
                value={vehicleInfo.make}
                onChange={(e) => setVehicleInfo({ ...vehicleInfo, make: e.target.value })}
                placeholder="Acura"
                style={styles.input}
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>
                Model <span style={styles.required}>*</span>
              </label>
              <input
                type="text"
                value={vehicleInfo.model}
                onChange={(e) => setVehicleInfo({ ...vehicleInfo, model: e.target.value })}
                placeholder="MDX"
                style={styles.input}
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>
                Trim <span style={styles.optional}>(optional)</span>
              </label>
              <input
                type="text"
                value={vehicleInfo.trim}
                onChange={(e) => setVehicleInfo({ ...vehicleInfo, trim: e.target.value })}
                placeholder="Type S"
                style={styles.input}
              />
            </div>

            <div style={{ ...styles.inputGroup, gridColumn: '1 / -1' }}>
              <label style={styles.inputLabel}>
                Color <span style={styles.optional}>(optional)</span>
              </label>
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
            style={{
              ...styles.uploadBox,
              ...(dragActive ? styles.uploadBoxActive : {}),
            }}
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
              disabled={!vehicleInfo.year || !vehicleInfo.model || processing}
            />
            <label
              htmlFor="zip-upload"
              style={{
                ...styles.uploadLabel,
                opacity: (!vehicleInfo.year || !vehicleInfo.model) ? 0.5 : 1,
                cursor: (!vehicleInfo.year || !vehicleInfo.model) ? 'not-allowed' : 'pointer',
              }}
            >
              <div style={styles.uploadIcon}>📁</div>
              <p style={styles.uploadText}>
                {processing
                  ? 'Processing images...'
                  : dragActive
                    ? 'Drop ZIP file here'
                    : 'Drag & drop ZIP file or click to browse'}
              </p>
              <p style={styles.uploadSubtext}>
                {!vehicleInfo.year || !vehicleInfo.model
                  ? 'Please fill in required fields: Year and Model'
                  : 'Supports JPG, PNG, WEBP, AVIF (ZIP, nested folders OK)'}
              </p>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

/** ************************************************************
 * STYLES
 ************************************************************* */
const styles = {
  loginContainer: {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
  },
  loginCard: {
    background: 'white',
    borderRadius: '16px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
    padding: '3rem',
    maxWidth: '400px',
    width: '100%',
  },
  loginHeader: { textAlign: 'center', marginBottom: '2rem' },
  loginTitle: { fontSize: '1.75rem', fontWeight: 'bold', color: '#111827', marginBottom: '0.5rem' },
  loginSubtitle: { color: '#6b7280', fontSize: '0.875rem' },
  loginForm: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  loginLabel: { display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#374151', marginBottom: '0.5rem' },
  loginInput: {
    width: '100%', padding: '0.75rem 1rem', border: '2px solid #e5e7eb', borderRadius: '8px',
    fontSize: '1rem', outline: 'none', transition: 'border-color 0.2s',
  },
  loginButton: {
    width: '100%', padding: '0.875rem', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white', border: 'none', borderRadius: '8px', fontSize: '1rem', fontWeight: 600, cursor: 'pointer',
  },
  errorMessage: { color: '#ef4444', fontSize: '0.875rem', textAlign: 'center', margin: 0 },
  loginFooter: { textAlign: 'center', fontSize: '0.75rem', color: '#9ca3af', marginTop: '1.5rem' },

  container: { minHeight: '100vh', background: 'linear-gradient(to bottom right, #f9fafb, #f3f4f6)', padding: '2rem' },
  card: {
    maxWidth: '1200px', margin: '0 auto', background: 'white', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', padding: '2rem',
  },
  headerSection: { marginBottom: '2rem' },
  titleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' },
  mainTitle: { fontSize: '2rem', fontWeight: 'bold', color: '#111827' },
  description: { color: '#6b7280' },

  form: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1.5rem' },
  inputGroup: { display: 'flex', flexDirection: 'column' },
  inputLabel: { fontSize: '0.875rem', fontWeight: 500, color: '#374151', marginBottom: '0.5rem' },
  required: { color: '#ef4444' },
  optional: { color: '#9ca3af', fontSize: '0.75rem' },
  input: { width: '100%', padding: '0.75rem 1rem', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '1rem', outline: 'none' },

  uploadBox: {
    border: '2px dashed #d1d5db',
    borderRadius: '8px',
    padding: '3rem',
    textAlign: 'center',
    background: '#f9fafb',
    transition: 'all 0.2s',
  },
  uploadBoxActive: { borderColor: '#3b82f6', background: '#eff6ff' },
  fileInput: { display: 'none' },
  uploadLabel: { display: 'block' },
  uploadIcon: { fontSize: '3rem', marginBottom: '0.5rem' },
  uploadText: { color: '#374151', fontWeight: 500, marginBottom: '0.5rem' },
  uploadSubtext: { fontSize: '0.875rem', color: '#6b7280' },

  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    marginBottom: '2rem', paddingBottom: '1rem', borderBottom: '1px solid #e5e7eb',
  },
  title: { fontSize: '1.5rem', fontWeight: 'bold', color: '#111827' },
  subtitle: { color: '#6b7280', marginTop: '0.25rem' },
  count: { fontSize: '0.875rem', color: '#9ca3af', marginTop: '0.25rem' },
  buttonGroup: { display: 'flex', gap: '0.75rem' },
  button: { padding: '0.5rem 1rem', borderRadius: '8px', border: 'none', fontWeight: 500, cursor: 'pointer', fontSize: '0.875rem' },
  greenButton: { background: '#16a34a', color: 'white' },
  grayButton: { background: '#4b5563', color: 'white' },
  redButton: { background: '#dc2626', color: 'white' },

  imageList: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  imageCard: { display: 'flex', gap: '1.5rem', padding: '1.25rem', border: '1px solid #e5e7eb', borderRadius: '8px' },
  thumbnail: {
    width: '256px', height: '192px', objectFit: 'cover', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', flexShrink: 0,
  },
  altTextContainer: { flex: 1 },
  label: { display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#6b7280', marginBottom: '0.5rem' },
  textBoxWrapper: { position: 'relative' },
  altTextBox: {
    background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px',
    padding: '1rem 4rem 1rem 1rem', color: '#111827', userSelect: 'text', cursor: 'text',
  },
  copyButton: {
    position: 'absolute', right: '0.5rem', top: '0.5rem', padding: '0.5rem',
    background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '1.25rem',
  },
  charCount: { fontSize: '0.875rem', color: '#6b7280', marginTop: '0.5rem' },
};
