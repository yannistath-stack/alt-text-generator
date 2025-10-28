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

  // ---- Local AI model (free, in-browser) ----
  const modelRef = useRef(null);
  const ensureModel = async () => {
    if (!modelRef.current) {
      modelRef.current = await mobilenet.load(); // small + fast
      // warm up
      await tf.nextFrame();
      // eslint-disable-next-line no-console
      console.log('✅ MobileNet loaded');
    }
    return modelRef.current;
  };

  const ACURA_UPPERCASE_MODELS = ['MDX','RDX','TLX','ILX','NSX','ZDX','ADX','RLX','TSX','RSX'];

  // ---- Helpers ----
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
  const modelName = (m, make) => {
    if (!m) return '';
    const up = m.toUpperCase();
    if (make && make.toLowerCase() === 'acura' && ACURA_UPPERCASE_MODELS.includes(up)) return up;
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

  // -----------------------------
  // Perceptual hashing (aHash) for content de-dup
  // -----------------------------
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

  // -----------------------------
  // Free local AI: classify via MobileNet
  // -----------------------------
  const classifyWithMobileNet = async (imgEl) => {
    const model = await ensureModel();
    // MobileNet can take an HTMLImageElement directly
    const preds = await model.classify(imgEl, 5); // top-5 labels
    return preds.map(p => p.className.toLowerCase());
  };

  // -----------------------------
  // Map labels → AIO AHM v2.5 canonical descriptor
  // -----------------------------
  const canonicalizeFromLabels = (labels) => {
    const s = labels.join(' ');
    // Interior parts
    if (/\b(gearshift|gear stick|gear lever|shift knob|manual transmission|gear shifter)\b/.test(s)) return 'gear shifter detail';
    if (/\bpaddle\b/.test(s)) return 'detail of paddle shifter';
    if (/\b(steering wheel|steering)\b/.test(s)) return 'steering wheel detail';
    if (/\b(instrument panel|dashboard|instrument cluster|gauge)\b/.test(s)) return 'instrument cluster detail';
    if (/\b(screen|display|touchscreen|infotainment)\b/.test(s)) return 'infotainment screen detail';
    if (/\b(center console)\b/.test(s)) return 'center console detail';
    if (/\b(seat|upholstery)\b/.test(s) && /\bstitch\b/.test(s)) return 'seat stitching detail';

    // Exterior parts
    if (/\b(headlight|head lamp)\b/.test(s)) return 'headlight detail';
    if (/\b(taillight|rear light)\b/.test(s)) return 'taillight detail';
    if (/\b(wheel|rim|tire)\b/.test(s)) return 'detail of wheel';
    if (/\b(brake caliper|caliper)\b/.test(s)) return 'detail of brake caliper';
    if (/\b(grille|emblem|badge)\b/.test(s)) return s.includes('badge') || s.includes('emblem') ? 'detail of badge' : 'detail of grille with emblem';
    if (/\b(door handle)\b/.test(s)) return 'detail of door handle';
    if (/\b(mirror)\b/.test(s)) return 'side mirror detail';
    if (/\b(spoiler)\b/.test(s)) return 'detail of spoiler';
    if (/\b(sunroof)\b/.test(s)) return 'detail of sunroof';
    if (/\b(fog light)\b/.test(s)) return 'detail of fog light';
    if (/\b(exhaust)\b/.test(s)) return 'detail of exhaust tip';
    if (/\b(rear diffuser)\b/.test(s)) return 'detail of rear diffuser';

    // Views — MobileNet won’t give view; use generic safe default
    return null; // let the fallback choose a simple view below
  };

  // Simple view fallback if no part found
  const simpleViewFallback = (imgEl) => {
    // quick geometry heuristic: wide aspect → likely front view
    const { naturalWidth: w, naturalHeight: h } = imgEl;
    if (w > h * 1.15) return 'front three-quarter view';
    return 'side profile';
  };

  // -----------------------------
  // ZIP processing → dedupe → thumbnails → sequential AI
  // -----------------------------
  const processZipFile = async (file) => {
    setProcessing(true);
    try {
      const zip = new JSZip();
      const contents = await zip.loadAsync(file);
      const entries = Object.entries(contents.files).filter(([_, entry]) => !entry.dir);

      const supported = ['jpg','jpeg','png','gif','webp','avif'];
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

      // Compute perceptual hashes
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

      // Group by similarity (hamming ≤ 6)
      const groups = [];
      for (const it of withHashes) {
        let placed = false;
        for (const g of groups) {
          if (it.hash && g.rep) {
            if (hamming(it.hash, g.rep) <= 6) {
              g.items.push(it);
              placed = true;
              break;
            }
          } else if (!it.hash && !g.rep) {
            g.items.push(it);
            placed = true;
            break;
          }
        }
        if (!placed) groups.push({ rep: it.hash, items: [it] });
      }

      // Choose one per group (smallest size)
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

      // 2) Sequentially analyze and fill alt text
      await ensureModel(); // load once
      for (const item of uniques) {
        // mark as processing
        setImages((prev) => prev.map((p) => (p.id === item.id ? { ...p, processing: true } : p)));

        // Use the displayed image element
        const imgEl = await urlToImageElement(item.url);

        // Get labels from MobileNet (free, local)
        let labels = [];
        try {
          labels = await classifyWithMobileNet(imgEl);
        } catch {
          labels = [];
        }

        // Map to canonical descriptor or fallback view
        let descriptor = canonicalizeFromLabels(labels);
        if (!descriptor) descriptor = simpleViewFallback(imgEl);

        // Build final alt
        const alt = buildAlt(descriptor);

        // update
        setImages((prev) => prev.map((p) => (p.id === item.id ? { ...p, alt, processing: false } : p)));
        // tiny pause so progress feels smooth
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 120));
      }
    } catch (e) {
      // eslint-disable-next-line no-console
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
      // Preload model after login
      ensureModel();
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

  // ---------------- RENDER (UI unchanged) ----------------
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

/* ---------- Styles (unchanged) ---------- */
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
