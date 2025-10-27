import React, { useState, useEffect } from 'react';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';

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

  const CORRECT_PASSWORD = 'Honda2025';
  const ACURA_UPPERCASE_MODELS = ['MDX','RDX','TLX','ILX','NSX','ZDX','ADX','RLX','TSX','RSX'];

  // ===== Canonical phrases (AIO AHM v2.5) =====
  const VIEW = {
    FRONT_34: 'front three-quarter view',
    REAR_34: 'rear three-quarter view',
    SIDE: 'side profile',
    FRONT: 'front view',
    REAR: 'rear view',
    OVERHEAD: 'overhead view',
    EXTERIOR: 'exterior view',
    INTERIOR: 'interior cabin',
    DASH: 'dashboard close-up',
    WHEEL: 'steering wheel close-up',
    CONSOLE: 'center console close-up',
    FRONT_SEATS: 'front seats',
    REAR_SEATS: 'rear seats',
    CARGO: 'cargo area',
  };

  const DETAIL = {
    GEAR: 'gear selector detail',
    PADDLE: 'paddle shifter detail',
    HEADLIGHT: 'LED headlight detail',
    TAILLIGHT: 'LED taillight detail',
    WHEEL: 'alloy wheel detail',
    BADGE: 'badge detail',
  };

  const ENV = {
    NIGHT: 'at night',
    STUDIO: 'in studio',
    SHOWROOM: 'in interior showroom',
    CITY: 'with city skyline',
    DESERT: 'on a desert highway',
    MOUNTAIN: 'on a mountain road',
    SNOW: 'in snow',
    TRACK: 'at racetrack',
    TUNNEL: 'in tunnel',
    GARAGE: 'in garage',
  };

  // ===== Helpers =====
  const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
  const formatModelName = (model, make) => {
    if (!model) return '';
    const up = model.toUpperCase();
    if (make && make.toLowerCase() === 'acura' && ACURA_UPPERCASE_MODELS.includes(up)) return up;
    return capitalize(model);
  };
  const clampAlt = (alt) => alt.length <= 125 ? alt : alt.slice(0,125).trim();

  const subjectLine = () => {
    const { year, make, model, trim, color } = vehicleInfo;
    const parts = [
      year,
      capitalize(make),
      formatModelName(model, make),
      trim ? capitalize(trim) : '',
      color ? `in ${color}` : ''
    ].filter(Boolean);
    return parts.join(' ').replace(/\s{2,}/g,' ').trim();
  };

  // ===== Visual analyzer (no filename usage) =====
  async function analyzeImage(url) {
    // Returns { descriptor: string, environment: string | null }
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const maxDim = 256;
          const scale = Math.min(maxDim / img.width, maxDim / img.height);
          const w = Math.max(1, Math.floor(img.width * scale));
          const h = Math.max(1, Math.floor(img.height * scale));

          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const { data } = ctx.getImageData(0, 0, w, h);

          // Basic stats
          let total = w * h;
          let dark = 0, bright = 0, blue = 0, gray = 0, satSum = 0;
          let topBright = 0, bottomBright = 0;

          // Track brightest pixels for centroid/shape
          const brightPts = [];
          const veryBrightThresh = 210;

          // Simple Sobel for edge density (luma only)
          const lum = new Float32Array(total);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const i = (y*w + x) * 4;
              const r = data[i], g = data[i+1], b = data[i+2];
              const l = 0.2126*r + 0.7152*g + 0.0722*b;
              lum[y*w + x] = l;

              const brightness = (r+g+b)/3;
              if (brightness < 55) dark++;
              if (brightness > 180) bright++;
              const max = Math.max(r,g,b), min = Math.min(r,g,b);
              const sat = max === 0 ? 0 : (max - min) / max; // 0..1
              satSum += sat;

              if (b > 100 && b > r + 25 && b > g + 25) blue++;

              if (Math.abs(r-g) < 15 && Math.abs(g-b) < 15) gray++;

              if (brightness > veryBrightThresh) {
                brightPts.push({x, y});
              }

              if (y < h/3) topBright += brightness;
              if (y > (2*h)/3) bottomBright += brightness;
            }
          }

          // Edge density
          let edgeSum = 0;
          const sobel = (x,y) => {
            const gx = (
              -1*lum[(y-1)*w + (x-1)] + 1*lum[(y-1)*w + (x+1)] +
              -2*lum[(y  )*w + (x-1)] + 2*lum[(y  )*w + (x+1)] +
              -1*lum[(y+1)*w + (x-1)] + 1*lum[(y+1)*w + (x+1)]
            );
            const gy = (
               1*lum[(y-1)*w + (x-1)] + 2*lum[(y-1)*w + (x  )] + 1*lum[(y-1)*w + (x+1)] +
              -1*lum[(y+1)*w + (x-1)] - 2*lum[(y+1)*w + (x  )] - 1*lum[(y+1)*w + (x+1)]
            );
            return Math.sqrt(gx*gx + gy*gy);
          };
          for (let y = 1; y < h-1; y++) {
            for (let x = 1; x < w-1; x++) {
              edgeSum += sobel(x,y);
            }
          }
          const edgeDensity = edgeSum / (w*h);

          // Ratios
          const darkRatio = dark / total;
          const brightRatio = bright / total;
          const blueRatio = blue / total;
          const grayRatio = gray / total;
          const avgSat = satSum / total;
          const topAvg = topBright / (w * Math.floor(h/3));
          const bottomAvg = bottomBright / (w * Math.floor(h/3));
          const wide = w >= h * 1.15;

          // Brightest area centroid and spread
          let cx = 0, cy = 0;
          brightPts.forEach(p => { cx += p.x; cy += p.y; });
          if (brightPts.length) { cx /= brightPts.length; cy /= brightPts.length; }
          // spread (variance)
          let vx = 0, vy = 0;
          brightPts.forEach(p => { vx += (p.x - cx)**2; vy += (p.y - cy)**2; });
          if (brightPts.length) { vx /= brightPts.length; vy /= brightPts.length; }
          const spread = Math.sqrt(vx + vy); // lower = compact highlight

          // Horizontal bright histogram (for twin headlights)
          const cols = new Array(w).fill(0);
          brightPts.forEach(p => { if (p.y > h*0.5) cols[p.x]++; });
          // Find two peaks
          let leftPeak = {x:0,v:0}, rightPeak = {x:0,v:0};
          for (let x = 0; x < w; x++) {
            const v = cols[x];
            if (x < w/2 && v > leftPeak.v) leftPeak = {x,v};
            if (x >= w/2 && v > rightPeak.v) rightPeak = {x,v};
          }
          const twinHeadlights =
            leftPeak.v > (brightPts.length * 0.02) &&
            rightPeak.v > (brightPts.length * 0.02) &&
            Math.abs(leftPeak.x - rightPeak.x) > w*0.25;

          // ===== Classification =====

          // Exterior day: blue sky on top
          if (blueRatio > 0.12 && topAvg > bottomAvg + 22) {
            return resolve({ descriptor: VIEW.FRONT_34, environment: null });
          }

          // Exterior night: dark overall + wide + twin bright peaks in lower half OR strong bright ratio in lower half
          if (darkRatio > 0.42 && wide && (twinHeadlights || brightRatio > 0.10) && topAvg <= bottomAvg) {
            return resolve({ descriptor: VIEW.FRONT_34, environment: ENV.NIGHT });
          }

          // Interior vs exterior gate:
          // Interiors: darker, low saturation, gray-heavy, high edge concentration from buttons/trim
          const interiorScore =
            (darkRatio > 0.30 ? 1 : 0) +
            (grayRatio > 0.30 ? 1 : 0) +
            (avgSat < 0.22 ? 1 : 0) +
            (edgeDensity > 22 ? 1 : 0); // 22 is empirical for 256px resize

          if (interiorScore >= 2) {
            // Interior subtype: gear selector vs paddle vs dashboard/console
            const centerish = (cx > w*0.35 && cx < w*0.65 && cy > h*0.35 && cy < h*0.70);
            const compactHighlight = spread < Math.min(w,h) * 0.16; // small shiny knob/metal
            const sideBright = (cx < w*0.25 || cx > w*0.75);
            const tallShape = vy > vx * 1.4; // elongated vertically (paddle)

            if (brightPts.length > total * 0.01 && centerish && compactHighlight) {
              return resolve({ descriptor: DETAIL.GEAR, environment: null }); // gear selector
            }
            if (brightPts.length > total * 0.01 && sideBright && tallShape) {
              return resolve({ descriptor: DETAIL.PADDLE, environment: null }); // paddle shifter
            }

            // Fallback interior labels based on edges near center console area
            if (edgeDensity > 26) {
              return resolve({ descriptor: VIEW.CONSOLE, environment: null });
            }
            return resolve({ descriptor: VIEW.DASH, environment: null });
          }

          // Default exterior (no sky, not night enough)
          return resolve({ descriptor: VIEW.FRONT_34, environment: null });
        } catch {
          return resolve({ descriptor: VIEW.EXTERIOR, environment: null });
        }
      };
      img.onerror = () => resolve({ descriptor: VIEW.EXTERIOR, environment: null });
      img.src = url;
    });
  }

  // ===== Build final alt (AIO v2.5) =====
  const buildAlt = ({descriptor, environment}) => {
    const subject = subjectLine();
    let alt = [subject, descriptor, environment || ''].filter(Boolean).join(' ').trim();

    // If >125, drop env -> color -> trim in that order
    if (alt.length > 125 && environment) {
      alt = alt.replace(new RegExp(`\\s+${environment.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`), '').trim();
    }
    const { trim, color } = vehicleInfo;
    if (alt.length > 125 && color) {
      alt = alt.replace(new RegExp(`\\s+in\\s+${color.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`,'i'),'').trim();
    }
    if (alt.length > 125 && trim) {
      alt = alt.replace(new RegExp(`\\s+${trim.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`,'i'),'').trim();
    }
    return clampAlt(alt);
  };

  // ===== ZIP processing (ignores filenames) =====
  const areImagesSimilar = (name1, name2) => {
    const clean1 = name1.replace(/[-_](s|m|l|xl|small|medium|large|xlarge|\d+x\d+)\./i, '.');
    const clean2 = name2.replace(/[-_](s|m|l|xl|small|medium|large|xlarge|\d+x\d+)\./i, '.');
    return clean1 === clean2;
  };

  const processZipFile = async (file) => {
    setProcessing(true);
    const zip = new JSZip();
    try {
      const contents = await zip.loadAsync(file);
      const imageFiles = [];
      const processedNames = new Set();

      for (const [filename, zipEntry] of Object.entries(contents.files)) {
        if (zipEntry.dir) continue;
        const ext = filename.split('.').pop().toLowerCase();
        if (!['jpg','jpeg','png','gif','webp','avif'].includes(ext)) continue;

        const isDuplicate = Array.from(processedNames).some(n => areImagesSimilar(n, filename));
        if (isDuplicate) continue;

        const blob = await zipEntry.async('blob');
        const url = URL.createObjectURL(blob);

        // Visual analysis (no filename)
        const analysis = await analyzeImage(url);
        const alt = buildAlt(analysis);

        imageFiles.push({
          id: Date.now() + Math.random(),
          filename,
          url,
          blob,
          analysis,
          alt,
        });

        processedNames.add(filename);
      }

      setImages(imageFiles);
      setShowResults(true);
    } catch (e) {
      console.error(e);
      alert('Error processing ZIP file. Please try again.');
    } finally {
      setProcessing(false);
    }
  };

  // ===== UI handlers =====
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
    e.preventDefault(); e.stopPropagation(); setDragActive(false);
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.zip')) await processZipFile(f);
    else alert('Please drop a ZIP file');
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
    doc.text('Alt Text Report', 20, y); y += 10;

    doc.setFontSize(12);
    doc.text(subjectLine(), 20, y); y += 15;

    for (let i = 0; i < images.length; i++) {
      if (y > 220) { doc.addPage(); y = 20; }
      const img = images[i];
      const alt = img.alt;

      const imgData = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(img.blob);
      });

      const isPng = img.filename.toLowerCase().endsWith('.png');
      doc.addImage(imgData, isPng ? 'PNG' : 'JPEG', 20, y, 60, 40);
      doc.setFontSize(10);
      const split = doc.splitTextToSize(alt, 100);
      doc.text(split, 85, y + 5);
      y += 50;
    }

    doc.save('alt-text-report.pdf');
  };

  const resetTool = () => {
    setShowResults(false);
    setImages([]);
    setVehicleInfo({ year:'', make:'', model:'', trim:'', color:'' });
  };

  // ===== Auth & render =====
  useEffect(() => {
    const loggedIn = sessionStorage.getItem('authenticated');
    if (loggedIn === 'true') setIsAuthenticated(true);
  }, []);

  const handleLogin = (e) => {
    e.preventDefault();
    if (passwordInput === CORRECT_PASSWORD) {
      setIsAuthenticated(true);
      sessionStorage.setItem('authenticated','true');
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
                {subjectLine()}
              </p>
              <p style={styles.count}>{images.length} unique images</p>
            </div>
            <div style={styles.buttonGroup}>
              <button onClick={exportPDF} style={{...styles.button, ...styles.greenButton}}>📥 Export PDF</button>
              <button onClick={resetTool} style={{...styles.button, ...styles.grayButton}}>Start Over</button>
              <button onClick={handleLogout} style={{...styles.button, ...styles.redButton}}>🔒 Logout</button>
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
                  <p style={{...styles.charCount, color: img.alt.length > 125 ? '#ef4444' : '#6b7280'}}>
                    {img.alt.length} characters
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.headerSection}>
          <div style={styles.titleRow}>
            <h1 style={styles.mainTitle}>AI SEO Alt Text Generator</h1>
            <button onClick={handleLogout} style={{...styles.button, ...styles.redButton}}>🔒 Logout</button>
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
                onChange={(e) => setVehicleInfo({...vehicleInfo, year: e.target.value})}
                placeholder="2025"
                style={styles.input}
              />
            </div>
            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Make <span style={styles.required}>*</span></label>
              <input
                type="text"
                value={vehicleInfo.make}
                onChange={(e) => setVehicleInfo({...vehicleInfo, make: e.target.value})}
                placeholder="Acura"
                style={styles.input}
              />
            </div>
            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Model <span style={styles.required}>*</span></label>
              <input
                type="text"
                value={vehicleInfo.model}
                onChange={(e) => setVehicleInfo({...vehicleInfo, model: e.target.value})}
                placeholder="ADX"
                style={styles.input}
              />
            </div>
            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Trim <span style={styles.optional}>(optional)</span></label>
              <input
                type="text"
                value={vehicleInfo.trim}
                onChange={(e) => setVehicleInfo({...vehicleInfo, trim: e.target.value})}
                placeholder="Type S"
                style={styles.input}
              />
            </div>
            <div style={{...styles.inputGroup, gridColumn: '1 / -1'}}>
              <label style={styles.inputLabel}>Color <span style={styles.optional}>(optional)</span></label>
              <input
                type="text"
                value={vehicleInfo.color}
                onChange={(e) => setVehicleInfo({...vehicleInfo, color: e.target.value})}
                placeholder="Apex Blue Pearl"
                style={styles.input}
              />
            </div>
          </div>

          <div
            style={{...styles.uploadBox, ...(dragActive ? styles.uploadBoxActive : {})}}
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
              disabled={!vehicleInfo.year || !vehicleInfo.make || !vehicleInfo.model || processing}
            />
            <label
              htmlFor="zip-upload"
              style={{
                ...styles.uploadLabel,
                opacity: (!vehicleInfo.year || !vehicleInfo.make || !vehicleInfo.model) ? 0.5 : 1,
                cursor: (!vehicleInfo.year || !vehicleInfo.make || !vehicleInfo.model) ? 'not-allowed' : 'pointer'
              }}
            >
              <div style={styles.uploadIcon}>📁</div>
              <p style={styles.uploadText}>
                {processing ? 'Processing images...' : dragActive ? 'Drop ZIP file here' : 'Drag & drop ZIP file or click to browse'}
              </p>
              <p style={styles.uploadSubtext}>
                {!vehicleInfo.year || !vehicleInfo.make || !vehicleInfo.model
                  ? 'Please fill in required fields first'
                  : 'Supports JPG, PNG, WEBP, AVIF'}
              </p>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===== Styles (unchanged) ===== */
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
  loginHeader: {
    textAlign: 'center',
    marginBottom: '2rem',
  },
  loginTitle: {
    fontSize: '1.75rem',
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: '0.5rem',
  },
  loginSubtitle: {
    color: '#6b7280',
    fontSize: '0.875rem',
  },
  loginForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
  },
  loginLabel: {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: '500',
    color: '#374151',
    marginBottom: '0.5rem',
  },
  loginInput: {
    width: '100%',
    padding: '0.75rem 1rem',
    border: '2px solid #e5e7eb',
    borderRadius: '8px',
    fontSize: '1rem',
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  loginButton: {
    width: '100%',
    padding: '0.875rem',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '1rem',
    fontWeight: '600',
    cursor: 'pointer',
  },
  errorMessage: {
    color: '#ef4444',
    fontSize: '0.875rem',
    textAlign: 'center',
    margin: 0,
  },
  loginFooter: {
    textAlign: 'center',
    fontSize: '0.75rem',
    color: '#9ca3af',
    marginTop: '1.5rem',
  },
  container: {
    minHeight: '100vh',
    background: 'linear-gradient(to bottom right, #f9fafb, #f3f4f6)',
    padding: '2rem',
  },
  card: {
    maxWidth: '1200px',
    margin: '0 auto',
    background: 'white',
    borderRadius: '12px',
    boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
    padding: '2rem',
  },
  headerSection: {
    marginBottom: '2rem',
  },
  titleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.5rem',
  },
  mainTitle: {
    fontSize: '2rem',
    fontWeight: 'bold',
    color: '#111827',
  },
  description: {
    color: '#6b7280',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '1.5rem',
  },
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
