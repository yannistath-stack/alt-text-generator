// pages/index.js
import React, { useState, useEffect } from 'react';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';

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
  const [images, setImages] = useState([]);
  const [showResults, setShowResults] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const ACURA_UPPERCASE_MODELS = ['MDX', 'RDX', 'TLX', 'ILX', 'NSX', 'ZDX', 'ADX', 'RLX', 'TSX', 'RSX'];

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

  const buildAlt = (descriptor, breakpoint) => {
    const base = subject();
    const breakpointLabels = {
      's': 'on mobile view', 'small': 'on mobile view',
      'm': 'on tablet view', 'medium': 'on tablet view',
      'l': 'on desktop view', 'large': 'on desktop view',
      'xl': 'on large screen view', 'xlarge': 'on large screen view',
    };
    const bpLabel = breakpoint ? breakpointLabels[breakpoint] || '' : '';
    const parts = [base, descriptor, bpLabel].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
    return clamp(parts);
  };

  const areImagesSimilar = (n1, n2) => {
    const clean = (s) => s.replace(/[-_](s|m|l|xl|small|medium|large|xlarge|\d+x\d+)\./i, '.');
    return clean(n1) === clean(n2);
  };

  // ---------- Vision Heuristics (expanded and refined) ----------
  const analyzeImage = (url) =>
    new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const maxDim = 256;
          const scale = Math.min(maxDim / img.width, maxDim / img.height);
          const w = Math.max(1, Math.floor(img.width * scale));
          const h = Math.max(1, Math.floor(img.height * scale));

          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const { data } = ctx.getImageData(0, 0, w, h);

          const total = w * h;

          let dark = 0, bright = 0, gray = 0, satSum = 0;
          let edge = 0;
          const lum = new Float32Array(total);

          const colBright = new Array(w).fill(0);
          const rowBright = new Array(h).fill(0);
          const brPts = [];

          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const i = (y * w + x) * 4;
              const r = data[i], g = data[i + 1], b = data[i + 2];

              const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              lum[y * w + x] = L;

              const bri = (r + g + b) / 3;
              if (bri < 55) dark++;
              if (bri > 200) { bright++; brPts.push({ x, y, bri }); }
              colBright[x] += bri;
              rowBright[y] += bri;

              const max = Math.max(r, g, b), min = Math.min(r, g, b);
              const sat = max === 0 ? 0 : (max - min) / max;
              satSum += sat;

              if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12) gray++;
            }
          }

          const sobel = (x, y) => {
            const idx = (yy, xx) => lum[Math.max(0, Math.min(h - 1, yy)) * w + Math.max(0, Math.min(w - 1, xx))] || 0;
            const gx =
              -idx(y - 1, x - 1) + idx(y - 1, x + 1) +
              -2 * idx(y, x - 1) + 2 * idx(y, x + 1) +
              -idx(y + 1, x - 1) + idx(y + 1, x + 1);
            const gy =
              idx(y - 1, x - 1) + 2 * idx(y - 1, x) + idx(y - 1, x + 1) -
              (idx(y + 1, x - 1) + 2 * idx(y + 1, x) + idx(y + 1, x + 1));
            return Math.hypot(gx, gy);
          };
          for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) edge += sobel(x, y);
          }

          const brightR = bright / total;
          const darkR = dark / total;
          const avgSat = satSum / total;
          const grayR = gray / total;
          const edgeD = edge / total;

          const topThird = rowBright.slice(0, Math.floor(h / 3)).reduce((a, v) => a + v, 0);
          const midThird = rowBright.slice(Math.floor(h / 3), Math.floor((2 * h) / 3)).reduce((a, v) => a + v, 0);
          const botThird = rowBright.slice(Math.floor((2 * h) / 3)).reduce((a, v) => a + v, 0);

          const interiorScore =
            (darkR > 0.30 ? 1 : 0) +
            (avgSat < 0.22 ? 1 : 0) +
            (edgeD > 22 ? 1 : 0) +
            (grayR > 0.28 ? 1 : 0);

          const isInterior = interiorScore >= 2;

          const centroid = (pts) => {
            if (!pts.length) return { cx: w / 2, cy: h / 2, spread: 9999, vx: 0, vy: 0 };
            let cx = 0, cy = 0;
            pts.forEach((p) => { cx += p.x; cy += p.y; });
            cx /= pts.length; cy /= pts.length;
            let vx = 0, vy = 0;
            pts.forEach((p) => { vx += (p.x - cx) ** 2; vy += (p.y - cy) ** 2; });
            vx /= pts.length; vy /= pts.length;
            return { cx, cy, spread: Math.sqrt(vx + vy), vx, vy };
          };
          const brightCentroid = centroid(brPts);

          const ringScore = (cx, cy, rMin, rMax) => {
            let hits = 0, samples = 0;
            for (let yy = Math.max(1, Math.floor(cy - rMax)); yy < Math.min(h - 1, Math.ceil(cy + rMax)); yy++) {
              for (let xx = Math.max(1, Math.floor(cx - rMax)); xx < Math.min(w - 1, Math.ceil(cx + rMax)); xx++) {
                const rr = Math.hypot(xx - cx, yy - cy);
                if (rr >= rMin && rr <= rMax) {
                  samples++;
                  const e = Math.abs(
                    lum[yy * w + xx] -
                    (lum[yy * w + (xx + 1)] + lum[(yy + 1) * w + xx]) / 2
                  );
                  if (e > 25) hits++;
                }
              }
            }
            return samples ? hits / samples : 0;
          };

          // ---------- INTERIOR ----------
          if (isInterior) {
            const { cx, cy, spread, vx, vy } = brightCentroid;
            const centerish = cx > w * 0.33 && cx < w * 0.67 && cy > h * 0.35 && cy < h * 0.75;
            const lowCenter = centerish && cy > h * 0.45;
            const sideish = cx < w * 0.25 || cx > w * 0.75;

            if (brPts.length > total * 0.008 && lowCenter && spread < Math.min(w, h) * 0.16) {
              return resolve({ descriptor: 'detail of gear shifter' });
            }
            if (
              brPts.length > total * 0.006 &&
              sideish &&
              vy > vx * 1.2 &&
              cy > h * 0.25 && cy < h * 0.7
            ) {
              return resolve({ descriptor: 'detail of paddle shifter' });
            }

            const wheelRing = ringScore(w / 2, h / 2, Math.min(w, h) * 0.20, Math.min(w, h) * 0.38);
            if (wheelRing > 0.09) {
              return resolve({ descriptor: 'detail of steering wheel' });
            }

            const midRectBright = midThird / (w * (h / 3) * 255);
            if (midRectBright > 0.55 && avgSat < 0.25) {
              return resolve({ descriptor: 'detail of infotainment screen' });
            }

            const upperBright = topThird / (w * (h / 3) * 255);
            if (upperBright > 0.5 && brPts.length > total * 0.006 && cy < h * 0.45) {
              let leftPeak = 0, rightPeak = 0;
              for (let x = 0; x < w; x++) {
                if (x < w / 2) leftPeak = Math.max(leftPeak, colBright[x]);
                else rightPeak = Math.max(rightPeak, colBright[x]);
              }
              if ((leftPeak > 0 && rightPeak > 0) && Math.abs(leftPeak - rightPeak) > 0) {
                return resolve({ descriptor: 'detail of instrument cluster' });
              }
            }

            if (botThird > midThird * 1.05 && edgeD > 26) {
              return resolve({ descriptor: 'detail of climate controls' });
            }
            if (edgeD > 24 && cy > h * 0.45) {
              return resolve({ descriptor: 'detail of center console' });
            }
            if (edgeD > 23 && avgSat > 0.25) {
              return resolve({ descriptor: 'detail of seat stitching' });
            }
            if (topThird < midThird && midThird > botThird) {
              return resolve({ descriptor: 'detail of dashboard' });
            }
            return resolve({ descriptor: 'interior detail' });
          }

          // ---------- EXTERIOR ----------
          const wide = w >= h * 1.15;
          const leftSum = colBright.slice(0, Math.floor(w / 2)).reduce((a, v) => a + v, 0);
          const rightSum = colBright.slice(Math.floor(w / 2)).reduce((a, v) => a + v, 0);
          const sideDiff = Math.abs(leftSum - rightSum) / (total * 255);
          const topViewLikely = topThird > botThird * 1.18;

          // wheel / brake caliper
          const corners = [
            { x: w * 0.2, y: h * 0.75 },
            { x: w * 0.8, y: h * 0.75 },
            { x: w * 0.2, y: h * 0.25 },
            { x: w * 0.8, y: h * 0.25 },
          ];
          for (const k of corners) {
            const rs = ringScore(k.x, k.y, Math.min(w, h) * 0.08, Math.min(w, h) * 0.18);
            if (rs > 0.13) {
              const nearWheelBright = brPts.filter(p => Math.hypot(p.x - k.x, p.y - k.y) < Math.min(w, h) * 0.22).length;
              if (nearWheelBright > total * 0.004 && avgSat > 0.28) {
                return resolve({ descriptor: 'detail of brake caliper' });
              }
              return resolve({ descriptor: 'detail of wheel' });
            }
          }

          // headlights hint (twin lower)
          const cols = new Array(w).fill(0);
          brPts.forEach((p) => { if (p.y > h * 0.5) cols[p.x]++; });
          let L = { x: 0, v: 0 }, R = { x: 0, v: 0 };
          cols.forEach((v, x) => {
            if (x < w / 2 && v > L.v) L = { x, v };
            if (x >= w / 2 && v > R.v) R = { x, v };
          });
          const twin = L.v > brPts.length * 0.02 && R.v > brPts.length * 0.02 && Math.abs(L.x - R.x) > w * 0.25;

          // grille & emblem logic
          let grilleLike = false;
          let centerVert = 0;
          for (let x = Math.floor(w * 0.35); x < Math.floor(w * 0.65); x++) centerVert += colBright[x];
          if (centerVert / (w * h) > 30 && edgeD > 26 && !topViewLikely) {
            grilleLike = true;
          }
          const compactBadge =
            brPts.length > total * 0.006 &&
            brightCentroid.spread < Math.min(w, h) * 0.12 &&
            brightCentroid.cy > h * 0.35 &&
            brightCentroid.cx > w * 0.35 &&
            brightCentroid.cx < w * 0.65;

          if (grilleLike && compactBadge) {
            return resolve({ descriptor: 'detail of grille with emblem' });
          }
          if (grilleLike) {
            if (twin || (brightR > 0.08 && wide)) return resolve({ descriptor: 'front view' });
            return resolve({ descriptor: 'detail of grille' });
          }
          if (compactBadge) {
            return resolve({ descriptor: 'detail of badge' });
          }

          // door handle: small bright rectangle on side mid-height near far left/right
          const doorHandle = brPts.some(
            (p) =>
              (p.x < w * 0.18 || p.x > w * 0.82) &&
              p.y > h * 0.35 && p.y < h * 0.6
          );
          if (doorHandle && sideDiff > 0.03) {
            return resolve({ descriptor: 'detail of door handle' });
          }

          // side mirror
          if (brPts.length > total * 0.004) {
            const sideMirror = brPts.some(
              (p) => (p.x < w * 0.12 || p.x > w * 0.88) && p.y > h * 0.3 && p.y < h * 0.7
            );
            if (sideMirror) return resolve({ descriptor: 'detail of side mirror' });
          }

          // spoiler: narrow bright/edge band along very top width
          const topBand = rowBright.slice(0, Math.max(2, Math.floor(h * 0.06))).reduce((a, v) => a + v, 0);
          if (topBand > midThird * 0.25 && edgeD > 22 && !topViewLikely) {
            return resolve({ descriptor: 'detail of spoiler' });
          }

          // sunroof (kept)
          if (topThird < midThird * 0.8 && topThird < botThird * 0.8 && grayR > 0.25) {
            return resolve({ descriptor: 'detail of sunroof' });
          }

          // fog light: small bright blobs at very low corners when front-ish
          const lowLeftBright = brPts.filter(p => p.x < w * 0.2 && p.y > h * 0.8).length;
          const lowRightBright = brPts.filter(p => p.x > w * 0.8 && p.y > h * 0.8).length;
          if ((lowLeftBright + lowRightBright) > total * 0.003 && (twin || (brightR > 0.08 && wide))) {
            return resolve({ descriptor: 'detail of fog light' });
          }

          // headlight/taillight (kept)
          const leftLowerBright = brPts.filter(p => p.x < w * 0.25 && p.y > h * 0.55).length;
          const rightLowerBright = brPts.filter(p => p.x > w * 0.75 && p.y > h * 0.55).length;
          if (leftLowerBright + rightLowerBright > total * 0.004) {
            if (twin || (brightR > 0.08 && wide)) {
              return resolve({ descriptor: 'detail of headlight' });
            } else {
              return resolve({ descriptor: 'detail of taillight' });
            }
          }

          // rear diffuser: high edge density near bottom center & darker bottom band
          const bottomBandEdges = (() => {
            let e = 0, cnt = 0;
            for (let y = Math.floor(h * 0.8); y < h - 1; y++) {
              for (let x = Math.floor(w * 0.3); x < Math.floor(w * 0.7); x++) {
                e += Math.abs(lum[y * w + x] - lum[y * w + (x + 1)]);
                cnt++;
              }
            }
            return cnt ? e / cnt : 0;
          })();
          if (bottomBandEdges > 18 && botThird < midThird * 0.95 && !topViewLikely) {
            return resolve({ descriptor: 'detail of rear diffuser' });
          }

          // exhaust tip: small shiny ring-ish near lower outer corners
          const exCorners = [
            { x: w * 0.12, y: h * 0.88 },
            { x: w * 0.88, y: h * 0.88 },
          ];
          for (const k of exCorners) {
            const rs = ringScore(k.x, k.y, Math.min(w, h) * 0.04, Math.min(w, h) * 0.09);
            const localBright = brPts.filter(p => Math.hypot(p.x - k.x, p.y - k.y) < Math.min(w, h) * 0.12).length;
            if (rs > 0.11 && localBright > total * 0.002) {
              return resolve({ descriptor: 'detail of exhaust tip' });
            }
          }

          // Simple exterior views
          if (topViewLikely) return resolve({ descriptor: 'top view' });
          if (sideDiff > 0.05) return resolve({ descriptor: 'profile view' });
          if (twin || (brightR > 0.08 && wide)) return resolve({ descriptor: 'front view' });
          return resolve({ descriptor: 'rear view' });
        } catch {
          return resolve({ descriptor: 'front view' });
        }
      };
      img.onerror = () => resolve({ descriptor: 'front view' });
      img.src = url;
    });

  // ---- ZIP processing ----
  const processZipFile = async (file) => {
    setProcessing(true);
    const zip = new JSZip();
    try {
      const contents = await zip.loadAsync(file);
      const imageGroups = {};

      // Recursively process all files, including subfolders
      const processFolder = async (folder) => {
        for (const [filename, entry] of Object.entries(folder.files)) {
          if (entry.dir) {
            await processFolder(entry); // Recurse into subfolders
          } else {
            const ext = filename.split('.').pop().toLowerCase();
            if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(ext)) {
              const baseName = filename.replace(/[-_](s|m|l|xl|small|medium|large|xlarge|\d+x\d+)\./i, '.');
              if (!imageGroups[baseName]) imageGroups[baseName] = [];
              const blob = await entry.async('blob');
              const url = URL.createObjectURL(blob);
              imageGroups[baseName].push({ filename, blob, url });
            }
          }
        }
      };
      await processFolder(contents);

      const out = [];
      for (const baseName in imageGroups) {
        const group = imageGroups[baseName];
        if (group.length > 0) {
          // Analyze the first image as the representative for the base descriptor
          const { url: repUrl } = group[0];
          const { descriptor } = await analyzeImage(repUrl);

          // Select the first image as the representative and store all alt texts
          const repImage = group[0];
          const altTexts = {};
          group.forEach(({ filename, blob, url }) => {
            const breakpointMatch = filename.match(/[-_](s|m|l|xl|small|medium|large|xlarge|\d+x\d+)/i);
            const breakpoint = breakpointMatch ? breakpointMatch[1] : null;
            altTexts[breakpoint || 'default'] = buildAlt(descriptor, breakpoint);
          });

          out.push({ id: Date.now() + Math.random(), filename: repImage.filename, url: repImage.url, altTexts, blob: repImage.blob });
        }
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
      Object.entries(img.altTexts).forEach(([bp, alt], idx) => {
        const split = doc.splitTextToSize(`${bp}: ${alt}`, 100);
        doc.text(split, 85, y + 5 + (idx * 10));
      });
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
                <img src={img.url} alt={Object.values(img.altTexts)[0]} style={styles.thumbnail} />
                <div style={styles.altTextContainer}>
                  <label style={styles.label}>Alt Text</label>
                  {Object.entries(img.altTexts).map(([bp, alt], i) => (
                    <div key={bp} style={styles.textBoxWrapper}>
                      <p style={styles.altTextBox}>{alt}</p>
                      <button
                        onClick={() => copyToClipboard(alt, `${index}-${i}`)}
                        style={styles.copyButton}
                        title="Copy to clipboard"
                      >
                        {copiedIndex === `${index}-${i}` ? '✓' : '📋'}
                      </button>
                      <p style={{ ...styles.charCount, color: alt.length > 125 ? '#ef4444' : '#6b7280' }}>
                        {alt.length} characters
                      </p>
                    </div>
                  ))}
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
  textBoxWrapper: { position: 'relative', marginBottom: '0.5rem' },
  altTextBox: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '0.5rem 3rem 0.5rem 0.5rem', color: '#111827', userSelect: 'text', cursor: 'text', wordBreak: 'break-word' },
  copyButton: { position: 'absolute', right: '0.5rem', top: '0.5rem', padding: '0.25rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '1rem' },
  charCount: { fontSize: '0.75rem', color: '#6b7280', marginTop: '0.25rem' },
};
