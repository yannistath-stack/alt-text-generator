// pages/index.js
import React, { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';
import * as tf from '@tensorflow/tfjs';
import * as mobilenet from '@tensorflow-models/mobilenet';

export default function AltTextGenerator() {
  // ---- Auth ----
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const CORRECT_PASSWORD = 'AHM.2025';

  // ---- Vehicle form (Make is optional) ----
  const [vehicleInfo, setVehicleInfo] = useState({
    year: '',
    make: '',
    model: '',
    trim: '',
    color: '',
  });

  // ---- App state ----
  const [images, setImages] = useState([]); // [{id, filename, url, blob, hash, alt, processing}]
  const [showResults, setShowResults] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // ---- Free, local model ----
  const modelRef = useRef(null);
  const ensureModel = async () => {
    if (!modelRef.current) {
      modelRef.current = await mobilenet.load(); // small, fast
      await tf.nextFrame(); // warm-up tick
      console.log('✅ MobileNet loaded');
    }
    return modelRef.current;
  };

  // ---- Helpers: naming & subject ----
  const ACURA_UPPERCASE_MODELS = ['MDX','RDX','TLX','ILX','NSX','ZDX','ADX','RLX','TSX','RSX'];

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

  // Uppercase known Acura models even if Make is empty (team workflow)
  const modelName = (m, make) => {
    if (!m) return '';
    const up = m.toUpperCase();
    if (ACURA_UPPERCASE_MODELS.includes(up)) return up;
    return cap(m);
  };

  const clamp = (s) => (s.length <= 125 ? s : s.slice(0, 125).trim());

  const subject = () => {
    const { year, make, model, trim, color } = vehicleInfo;
    const parts = [
      year || '',
      make ? cap(make) : '',
      modelName(model, make) || '',
      trim ? cap(trim) : '',
      color ? `in ${color}` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return parts;
  };

  const buildAlt = (descriptor) => {
    const base = subject();
    const parts = [base, descriptor].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
    return clamp(parts);
  };

  // ---- Filename canonicalization for dedupe ----
  const canonicalName = (name) => {
    const dot = name.lastIndexOf('.');
    const base = dot >= 0 ? name.slice(0, dot) : name;
    const ext = dot >= 0 ? name.slice(dot + 1) : '';
    const cleaned = base
      .replace(/[-_](s|m|l|xl|xxl|small|medium|large|xlarge)\b/gi, '')
      .replace(/[-_]\d{2,4}x\d{2,4}\b/gi, '')
      .replace(/@(\d+)x\b/gi, '')
      .replace(/\b(\d{3,5}w)\b/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/[-_]{2,}/g, '-')
      .trim()
      .toLowerCase();
    return `${cleaned}.${ext.toLowerCase()}`;
  };

  // ---- Perceptual hash (aHash) for content dedupe ----
  const urlToImageElement = (url) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = url;
    });

  const aHashFromImageElement = (imgEl) => {
    const size = 8;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    const gray = [];
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      gray.push(v);
    }
    const avg = gray.reduce((a, b) => a + b, 0) / gray.length;
    return gray.map(v => (v >= avg ? '1' : '0')).join('');
  };

  const hamming = (a, b) => {
    if (!a || !b || a.length !== b.length) return 64;
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
  };

  // ---- Local model classify ----
  const classifyWithMobileNet = async (imgEl) => {
    const model = await ensureModel();
    const preds = await model.classify(imgEl, 5); // [{className, probability}]
    return preds.map(p => ({ label: p.className.toLowerCase(), prob: p.probability || 0 }));
  };

  // ---- Quick interior detector (labels + simple pixel stats) ----
  const looksInterior = (labelsArr, imgEl) => {
    const s = labelsArr.map(l => l.label || l).join(' ').toLowerCase();
    if (/\b(interior|dashboard|steering|gear|console|upholstery|seat|knob|speedometer|instrument)\b/.test(s)) return true;

    // tiny visual cue (dark, low saturation)
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const ctx = c.getContext('2d'); ctx.drawImage(imgEl, 0, 0, 64, 64);
    const { data } = ctx.getImageData(0, 0, 64, 64);
    let dark = 0, satSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      const bri = (r+g+b)/3;
      const max = Math.max(r,g,b), min = Math.min(r,g,b);
      const sat = max === 0 ? 0 : (max-min)/max;
      if (bri < 60) dark++;
      satSum += sat;
    }
    const total = 64*64;
    return (dark/total > 0.28) && (satSum/total < 0.28);
  };

  // ---- Contextual resolver: labels + interior → canonical descriptor ----
  const resolveDescriptor = (labelsWithProb, interior, imgEl) => {
    // score buckets
    const score = {
      'gear shifter detail': 0,
      'detail of paddle shifter': 0,
      'steering wheel detail': 0,
      'instrument cluster detail': 0,
      'infotainment screen detail': 0,
      'center console detail': 0,
      'seat stitching detail': 0,
      'detail of wheel': 0,
      'detail of brake caliper': 0,
      'headlight detail': 0,
      'taillight detail': 0,
      'detail of grille with emblem': 0,
      'detail of badge': 0,
      'detail of door handle': 0,
      'side mirror detail': 0,
      'detail of spoiler': 0,
      'detail of sunroof': 0,
      'detail of fog light': 0,
      'detail of exhaust tip': 0,
      'detail of rear diffuser': 0,
    };

    // helper to bump scores on keyword hits
    const bump = (key, p, w = 1) => { score[key] += (p * w); };

    labelsWithProb.forEach(({ label, prob }) => {
      const s = label.toLowerCase();

      // interior
      if (/\b(gear\s?shift|gear\s?shifter|gear\s?stick|shift\s?knob|gear\s?lever|manual\s?transmission)\b/.test(s)) bump('gear shifter detail', prob, 3);
      if (/\bpaddle\b/.test(s)) bump('detail of paddle shifter', prob, 2.5);
      if (/\b(steering\s?wheel|steering)\b/.test(s)) bump('steering wheel detail', prob, 2.5);
      if (/\b(instrument\s?(panel|cluster)|dashboard|gauge)\b/.test(s)) bump('instrument cluster detail', prob, 2.2);
      if (/\b(touch\s?screen|touchscreen|screen|display|infotainment)\b/.test(s)) bump('infotainment screen detail', prob, 2.2);
      if (/\b(center\s?console)\b/.test(s)) bump('center console detail', prob, 2.0);
      if (/\b(seat|upholstery)\b/.test(s) && /\bstitch(ing)?\b/.test(s)) bump('seat stitching detail', prob, 2.0);

      // exterior
      if (/\b(head\s?light|headlight)\b/.test(s)) bump('headlight detail', prob, 2.2);
      if (/\b(tail\s?light|taillight|rear\s?light)\b/.test(s)) bump('taillight detail', prob, 2.2);
      if (/\b(wheel|rim|tire)\b/.test(s)) bump('detail of wheel', prob, 2.0);
      if (/\b(brake\s?caliper|caliper)\b/.test(s)) bump('detail of brake caliper', prob, 2.2);
      if (/\b(grille|grill)\b/.test(s)) bump('detail of grille with emblem', prob, 1.8);
      if (/\b(emblem|badge)\b/.test(s)) bump('detail of badge', prob, 1.9);
      if (/\b(door\s?handle)\b/.test(s)) bump('detail of door handle', prob, 1.8);
      if (/\b(mirror)\b/.test(s)) bump('side mirror detail', prob, 1.4); // lower weight; may be shiny surfaces
      if (/\b(spoiler)\b/.test(s)) bump('detail of spoiler', prob, 1.6);
      if (/\b(sun\s?roof|sunroof)\b/.test(s)) bump('detail of sunroof', prob, 1.6);
      if (/\b(fog\s?light)\b/.test(s)) bump('detail of fog light', prob, 1.6);
      if (/\b(exhaust)\b/.test(s)) bump('detail of exhaust tip', prob, 1.6);
      if (/\b(rear\s?diffuser)\b/.test(s)) bump('detail of rear diffuser', prob, 1.6);
    });

    // If interior, suppress exterior-only weak matches like "side mirror"
    if (interior) score['side mirror detail'] *= 0.2;

    // Choose the best-scoring descriptor if confident enough
    let best = null, bestScore = 0;
    Object.entries(score).forEach(([k, v]) => {
      if (v > bestScore) { best = k; bestScore = v; }
    });

    // Confidence threshold: if nothing strong, pick a view fallback
    if (!best || bestScore < 0.35) {
      const { naturalWidth: w, naturalHeight: h } = imgEl;
      return interior ? 'interior detail' : (w > h * 1.15 ? 'front three-quarter view' : 'side profile');
    }
    return best;
  };

  // ---- ZIP processing → HYBRID DEDUPE → thumbnails → sequential AI ----
  const processZipFile = async (file) => {
    setProcessing(true);
    try {
      const zip = new JSZip();
      const contents = await zip.loadAsync(file);
      const entries = Object.entries(contents.files).filter(([_, entry]) => !entry.dir);

      const supported = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'];
      const imageEntries = entries.filter(([name]) => {
        const ext = name.split('.').pop().toLowerCase();
        return supported.includes(ext);
      });

      // Load blobs + temp URLs
      const all = [];
      for (const [filename, entry] of imageEntries) {
        const blob = await entry.async('blob');
        const url = URL.createObjectURL(blob);
        all.push({ filename, blob, url, size: blob.size });
      }

      // Perceptual hashes
      const withHashes = [];
      for (const it of all) {
        try {
          const imgEl = await urlToImageElement(it.url);
          const hash = aHashFromImageElement(imgEl);
          withHashes.push({ ...it, hash });
        } catch {
          withHashes.push({ ...it, hash: null });
        }
      }

      // 1) Name-based pass: keep smallest per canonical name
      const byName = new Map();
      for (const it of withHashes) {
        const key = canonicalName(it.filename);
        const prev = byName.get(key);
        if (!prev || it.size < prev.size) byName.set(key, it);
      }
      const nameDeduped = Array.from(byName.values());

      // 2) Visual pass: merge anything visually the same (tight threshold)
      const groups = [];
      for (const it of nameDeduped) {
        let placed = false;
        for (const g of groups) {
          if (it.hash && g.rep && hamming(it.hash, g.rep) <= 4) { // stricter than before
            g.items.push(it); placed = true; break;
          }
        }
        if (!placed) groups.push({ rep: it.hash, items: [it] });
      }

      // Choose one per visual group (smallest blob)
      const uniques = groups.map((g) => {
        const chosen = g.items.reduce((a, b) => (a.size <= b.size ? a : b));
        return {
          id: Date.now() + Math.random(),
          filename: chosen.filename,
          url: chosen.url,
          blob: chosen.blob,
          hash: chosen.hash,
          alt: '',
          processing: false,
        };
      });

      // 1) Show thumbnails (no alt yet)
      setImages(uniques);
      setShowResults(true);

      // 2) Sequential AI pass
      await ensureModel();
      for (const item of uniques) {
        setImages((prev) => prev.map((p) => (p.id === item.id ? { ...p, processing: true } : p)));

        const imgEl = await urlToImageElement(item.url);

        let labels = [];
        try {
          labels = await classifyWithMobileNet(imgEl); // [{label, prob}]
        } catch {
          labels = [];
        }

        const interior = looksInterior(labels, imgEl);
        const descriptor = resolveDescriptor(labels, interior, imgEl);
        const alt = buildAlt(descriptor);

        setImages((prev) => prev.map((p) => (p.id === item.id ? { ...p, alt, processing: false } : p)));
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 120));
      }
    } catch (e) {
      console.error(e);
      alert('Error processing ZIP file. Please try again.');
    } finally {
      setProcessing(false);
    }
  };

  // ---- UI handlers ----
  const handleZipUpload = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await processZipFile(f);
  };
  const handleDrag = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };
  const handleDrop = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setDragActive(false);
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.zip')) await processZipFile(f);
    else alert('Please drop a ZIP file');
  };
  const copyToClipboard = (t, i) => {
    if (!t) return;
    navigator.clipboard.writeText(t);
    setCopiedIndex(i);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  // ---- PDF export ----
  const exportPDF = async () => {
    const doc = new jsPDF();
    let y = 20;
    doc.setFontSize(18);
    doc.text('Alt Text Report', 20, y);
    y += 10;

    doc.setFontSize(12);
    doc.text(subject() || 'Vehicle images', 20, y);
    y += 15;

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
      const split = doc.splitTextToSize(img.alt || '', 100);
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

  // ---- Auth ----
  useEffect(() => {
    const logged = sessionStorage.getItem('authenticated');
    if (logged === 'true') setIsAuthenticated(true);
  }, []);
  const handleLogin = (e) => {
    e.preventDefault();
    if (passwordInput === CORRECT_PASSWORD) {
      setIsAuthenticated(true);
      sessionStorage.setItem('authenticated', 'true');
      setPasswordError('');
      ensureModel(); // preload model once logged in
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

  // ---------------- RENDER ----------------
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
                <img src={img.url} alt={img.alt || 'Vehicle image'} style={styles.thumbnail} />
                <div style={styles.altTextContainer}>
                  <label style={styles.label}>Alt Text</label>
                  <div style={styles.textBoxWrapper}>
                    <p style={styles.altTextBox}>
                      {img.alt || (img.processing ? 'Analyzing image…' : '')}
                    </p>
                    <button
                      onClick={() => copyToClipboard(img.alt, index)}
                      style={styles.copyButton}
                      title="Copy to clipboard"
                      disabled={!img.alt}
                    >
                      {copiedIndex === index ? '✓' : '📋'}
                    </button>
                  </div>
                  <p style={{ ...styles.charCount, color: img.alt && img.alt.length > 125 ? '#ef4444' : '#6b7280' }}>
                    {img.alt ? `${img.alt.length} characters` : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const requiredFilled = !!vehicleInfo.year && !!vehicleInfo.model;

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
              disabled={!requiredFilled || processing}
            />
            <label
              htmlFor="zip-upload"
              style={{
                ...styles.uploadLabel,
                opacity: requiredFilled ? 1 : 0.5,
                cursor: requiredFilled ? 'pointer' : 'not-allowed',
              }}
            >
              <div style={styles.uploadIcon}>📁</div>
              <p style={styles.uploadText}>
                {processing ? 'Processing images...' : dragActive ? 'Drop ZIP file here' : 'Drag & drop ZIP file or click to browse'}
              </p>
              <p style={styles.uploadSubtext}>
                {requiredFilled ? 'Supports JPG, PNG, WEBP, AVIF' : 'Please fill in Year and Model first'}
              </p>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Styles ---------- */
const styles = {
  loginContainer: { minHeight: '100vh', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' },
  loginCard: { background: 'white', borderRadius: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', padding: '3rem', maxWidth: '400px', width: '100%' },
  loginHeader: { textAlign: 'center', marginBottom: '2rem' },
  loginTitle: { fontSize: '1.75rem', fontWeight: 'bold', color: '#111827', marginBottom: '0.5rem' },
  loginSubtitle: { color: '#6b7280', fontSize: '0.875rem' },
  loginForm: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  loginLabel: { display: 'block', fontSize: '0.875rem', fontWeight: '500', color: '#374151', marginBottom: '0.5rem' },
  loginInput: { width: '100%', padding: '0.75rem 1rem', border: '2px solid #e5e7eb', borderRadius: '8px', fontSize: '1rem', outline: 'none' },
  loginButton: { width: '100%', padding: '0.875rem', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white', border: 'none', borderRadius: '8px', fontWeight: '600', cursor: 'pointer' },
  errorMessage: { color: '#ef4444', fontSize: '0.875rem', textAlign: 'center', margin: 0 },
  loginFooter: { textAlign: 'center', fontSize: '0.75rem', color: '#9ca3af', marginTop: '1.5rem' },

  container: { minHeight: '100vh', background: 'linear-gradient(to bottom right, #f9fafb, #f3f4f6)', padding: '2rem' },
  card: { maxWidth: '1200px', margin: '0 auto', background: 'white', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', padding: '2rem' },

  headerSection: { marginBottom: '2rem' },
  titleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  mainTitle: { fontSize: '2rem', fontWeight: 'bold', color: '#111827' },
  description: { color: '#6b7280' },

  form: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1.5rem' },
  inputGroup: { display: 'flex', flexDirection: 'column' },
  inputLabel: { fontSize: '0.875rem', fontWeight: '500', color: '#374151', marginBottom: '0.5rem' },
  required: { color: '#ef4444' },
  optional: { color: '#9ca3af', fontSize: '0.75rem' },
  input: { width: '100%', padding: '0.75rem 1rem', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '1rem', outline: 'none' },

  uploadBox: { border: '2px dashed #d1d5db', borderRadius: '8px', padding: '3rem', textAlign: 'center', background: '#f9fafb', transition: 'all 0.2s' },
  uploadBoxActive: { borderColor: '#3b82f6', background: '#eff6ff' },
  fileInput: { display: 'none' },
  uploadLabel: { display: 'block' },
  uploadIcon: { fontSize: '4rem', marginBottom: '1rem' },
  uploadText: { color: '#374151', fontWeight: '500', marginBottom: '0.5rem' },
  uploadSubtext: { fontSize: '0.875rem', color: '#6b7280' },

  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', margin: '0 0 2rem', paddingBottom: '1rem', borderBottom: '1px solid #e5e7eb' },
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
