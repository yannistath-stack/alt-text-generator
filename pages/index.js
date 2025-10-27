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

  // Known Acura models that should stay uppercase
  const ACURA_UPPERCASE_MODELS = ['MDX', 'RDX', 'TLX', 'ILX', 'NSX', 'ZDX', 'ADX', 'RLX', 'TSX', 'RSX'];

  // ===================== AIO AHM v2.5 CANONICALS =====================

  const CANONICAL_VIEWS = {
    frontThreeQuarter: 'front three-quarter view',
    rearThreeQuarter: 'rear three-quarter view',
    sideProfile: 'side profile',
    frontView: 'front view',
    rearView: 'rear view',
    overhead: 'overhead view',
    exterior: 'exterior view',
    interiorCabin: 'interior cabin',
    dashboard: 'dashboard close-up',
    steeringWheel: 'steering wheel close-up',
    centerConsole: 'center console close-up',
    frontSeats: 'front seats',
    rearSeats: 'rear seats',
    cargoArea: 'cargo area',
  };

  // Detail / part canonical phrases
  const DETAIL_PART_MAP = {
    grille: 'grille detail',
    grill: 'grille detail',
    headlight: 'LED headlight detail',
    headlamp: 'LED headlight detail',
    taillight: 'LED taillight detail',
    tail: 'LED taillight detail',
    wheel: 'alloy wheel detail',
    rim: 'alloy wheel detail',
    badge: 'badge detail',
    logo: 'badge detail',
    exhaust: 'exhaust detail',
    brake: 'brake caliper detail',
    caliper: 'brake caliper detail',
    mirror: 'side mirror detail',
    charging: 'charging port close-up',
    port: 'charging port close-up',
    sunroof: 'panoramic roof detail',
    roof: 'panoramic roof detail',
    paddle: 'paddle shifter detail',
    shifter: 'gear selector detail',
    shift: 'gear selector detail',
    selector: 'gear selector detail',
    gear: 'gear selector detail',
    knob: 'gear selector detail',
  };

  // UI canonical phrases
  const UI_PART_MAP = {
    infotainment: 'infotainment touchscreen display',
    touchscreen: 'infotainment touchscreen display',
    screen: 'infotainment touchscreen display',
    display: 'infotainment touchscreen display',
    nav: 'navigation map view',
    map: 'navigation map view',
    gauge: 'digital gauge cluster',
    cluster: 'digital gauge cluster',
    button: 'control button',
    switch: 'control switch',
    icon: 'interface icon',
  };

  // Environments (used only if unmistakable)
  const ENVIRONMENT_PHRASES = {
    studio: 'in studio',
    showroom: 'in interior showroom',
    street: 'on a city street',
    city: 'with city skyline',
    skyline: 'with city skyline',
    desert: 'on a desert highway',
    mountain: 'on a mountain road',
    snow: 'in snow',
    track: 'at racetrack',
    night: 'at night',
    sunset: 'at sunset',
    dusk: 'at sunset',
    dawn: 'at sunrise',
    beach: 'near the coast',
    tunnel: 'in tunnel',
    garage: 'in garage',
  };

  // ===================== HELPERS =====================

  const capitalize = (str) => {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  };

  const formatModelName = (modelName, make) => {
    if (!modelName) return '';
    const upper = modelName.toUpperCase();
    if (make && make.toLowerCase() === 'acura' && ACURA_UPPERCASE_MODELS.includes(upper)) return upper;
    return modelName.charAt(0).toUpperCase() + modelName.slice(1).toLowerCase();
  };

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ===================== FILENAME PARSER =====================

  const parseFilenameMetadata = (filenameRaw) => {
    const filename = filenameRaw.toLowerCase();

    const tokens = filename
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
      .split(/\s+/);

    const tokenSet = new Set(tokens);
    const hasAny = (arr) => arr.some(t => tokenSet.has(t));

    // Category flags
    let isInterior = false;
    let isDetail = false;
    let isUI = false;
    let part = null;
    let view = null;
    let environment = null;

    // Interior/UI detection (highest priority)
    if (hasAny(['interior','cabin','dashboard','dash','steering','wheel','console','shifter','gear','selector','shift','seat','seats','paddle'])) {
      isInterior = true;
    }
    if (hasAny(['gauge','cluster','screen','display','touchscreen','infotainment','nav','map','button','switch','icon'])) {
      isInterior = true;
      isUI = true;
      for (const key of Object.keys(UI_PART_MAP)) {
        if (tokens.includes(key)) { part = UI_PART_MAP[key]; break; }
      }
      if (!part) part = 'infotainment touchscreen display';
    }

    // Detail/part detection
    for (const key of Object.keys(DETAIL_PART_MAP)) {
      if (tokens.includes(key)) {
        isDetail = true;
        part = DETAIL_PART_MAP[key];
        break;
      }
    }

    // Exterior view detection
    const has34 = hasAny(['3-4','3/4','three-quarter','threequarter','threeq','3q']);
    if (hasAny(['rear','back']) && has34) view = CANONICAL_VIEWS.rearThreeQuarter;
    else if (hasAny(['front']) && has34) view = CANONICAL_VIEWS.frontThreeQuarter;
    else if (hasAny(['side','profile'])) view = CANONICAL_VIEWS.sideProfile;
    else if (hasAny(['front'])) view = CANONICAL_VIEWS.frontView;
    else if (hasAny(['rear','back'])) view = CANONICAL_VIEWS.rearView;
    else if (hasAny(['overhead','top','bird'])) view = CANONICAL_VIEWS.overhead;

    // Interior sub-views (only if not a specific part/UI already)
    if (isInterior && !isDetail && !isUI) {
      if (hasAny(['dashboard','dash'])) view = CANONICAL_VIEWS.dashboard;
      else if (hasAny(['steering','wheel'])) view = CANONICAL_VIEWS.steeringWheel;
      else if (hasAny(['console','shifter','shift','selector','gear'])) view = CANONICAL_VIEWS.centerConsole;
      else if (hasAny(['front','driver','passenger']) && hasAny(['seat','seats'])) view = CANONICAL_VIEWS.frontSeats;
      else if (hasAny(['rear']) && hasAny(['seat','seats'])) view = CANONICAL_VIEWS.rearSeats;
      else if (hasAny(['cargo','trunk'])) view = CANONICAL_VIEWS.cargoArea;
      else view = CANONICAL_VIEWS.interiorCabin;
    }

    // Environment (only when unmistakable in filename)
    for (const key of Object.keys(ENVIRONMENT_PHRASES)) {
      if (tokenSet.has(key)) { environment = ENVIRONMENT_PHRASES[key]; break; }
    }

    return { isInterior, isDetail, isUI, view, part, environment };
  };

  // ===================== IMAGE FALLBACK (very conservative) =====================

  const analyzeImageFallback = (imageUrl) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const maxDim = 160;
          const scale = Math.min(maxDim / img.width, maxDim / img.height);
          canvas.width = Math.max(1, Math.floor(img.width * scale));
          canvas.height = Math.max(1, Math.floor(img.height * scale));
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let blueCount = 0, darkCount = 0, grayCount = 0, total = width * height;
          let topBrightness = 0, bottomBrightness = 0;

          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4;
              const r = data[i], g = data[i+1], b = data[i+2];
              const bright = (r + g + b) / 3;
              if (b > 100 && b > r + 25 && b > g + 25) blueCount++;
              if (Math.abs(r - g) < 18 && Math.abs(g - b) < 18 && Math.abs(r - b) < 18) grayCount++;
              if (bright < 55) darkCount++;
              if (y < height/3) topBrightness += bright;
              if (y > height*2/3) bottomBrightness += bright;
            }
          }

          const blueRatio = blueCount / total;
          const darkRatio = darkCount / total;
          const grayRatio = grayCount / total;
          const topAvg = topBrightness / (width * Math.floor(height/3));
          const bottomAvg = bottomBrightness / (width * Math.floor(height/3));
          const wide = width >= height * 1.15;

          // Night exterior cue: very dark overall, not much blue sky
          if (darkRatio > 0.45 && blueRatio < 0.08 && wide) {
            return resolve({ view: CANONICAL_VIEWS.frontThreeQuarter, environment: 'at night' });
          }

          // Day exterior cue: bright top with blue sky
          if (blueRatio > 0.12 && topAvg > bottomAvg + 25) {
            return resolve({ view: CANONICAL_VIEWS.frontThreeQuarter, environment: null });
          }

          // Interior cue: dark-ish + lots of gray tones
          if (darkRatio > 0.35 && grayRatio > 0.35) {
            return resolve({ view: CANONICAL_VIEWS.interiorCabin, environment: null });
          }

          // Default exterior
          return resolve({ view: CANONICAL_VIEWS.frontThreeQuarter, environment: null });
        } catch {
          return resolve({ view: CANONICAL_VIEWS.exterior, environment: null });
        }
      };
      img.onerror = () => resolve({ view: CANONICAL_VIEWS.exterior, environment: null });
      img.src = imageUrl;
    });
  };

  // ===================== ALT BUILDER (AIO v2.5) =====================

  const buildAltFromMetadata = (meta) => {
    const { year, make, model, trim, color } = vehicleInfo;

    const capitalizedMake = capitalize(make);
    const formattedModel = formatModelName(model, make);
    const capitalizedTrim = trim ? capitalize(trim) : '';
    const colorText = color ? color : '';

    const subjectParts = [
      year || '',
      capitalizedMake || '',
      formattedModel || '',
      capitalizedTrim || '',
      colorText ? `in ${colorText}` : ''
    ].filter(Boolean);

    const subject = subjectParts.join(' ').replace(/\s{2,}/g, ' ').trim();

    let descriptor = '';
    if (meta.isUI && meta.part) {
      descriptor = meta.part;
    } else if (meta.isDetail && meta.part) {
      descriptor = meta.part;
    } else if (meta.view) {
      descriptor = meta.view;
    } else {
      descriptor = CANONICAL_VIEWS.frontThreeQuarter;
    }

    const env = meta.environment ? meta.environment : '';
    let alt = [subject, descriptor, env].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();

    // Length control ≤125: drop env -> color -> trim
    const clamp = (s, max = 125) => (s.length <= max ? s : s.slice(0, max).trim());

    if (alt.length > 125 && env) {
      alt = alt.replace(new RegExp(`\\s+${escapeRegExp(env)}$`), '').trim();
    }
    if (alt.length > 125 && colorText) {
      alt = alt.replace(new RegExp(`\\s+in\\s+${escapeRegExp(colorText)}\\b`, 'i'), '').trim();
    }
    if (alt.length > 125 && capitalizedTrim) {
      alt = alt.replace(new RegExp(`\\s+${escapeRegExp(capitalizedTrim)}\\b`), '').trim();
    }

    return clamp(alt, 125);
  };

  // ===================== ZIP PROCESSING =====================

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
        if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(ext)) continue;

        const isDuplicate = Array.from(processedNames).some(name => 
          areImagesSimilar(name, filename)
        );
        if (isDuplicate) continue;

        const blob = await zipEntry.async('blob');
        const url = URL.createObjectURL(blob);

        // 1) Filename metadata (primary)
        let meta = parseFilenameMetadata(filename);

        // 2) If ambiguous, use conservative image fallback
        if (!meta.view && !meta.part) {
          const fallback = await analyzeImageFallback(url);
          meta = { ...meta, ...fallback };
        }

        // 3) Build compliant alt
        const alt = buildAltFromMetadata(meta);

        imageFiles.push({
          id: Date.now() + Math.random(),
          filename,
          url,
          blob,
          meta,
          alt,
        });

        processedNames.add(filename);
      }

      setImages(imageFiles);
      setShowResults(true);
      setProcessing(false);
    } catch (error) {
      console.error(error);
      alert('Error processing ZIP file. Please try again.');
      setProcessing(false);
    }
  };

  // ===================== UI ACTIONS =====================

  const handleZipUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    await processZipFile(file);
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.zip')) {
      await processZipFile(file);
    } else {
      alert('Please drop a ZIP file');
    }
  };

  const generateAltText = (img) => img.alt;

  const copyToClipboard = (text, index) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const exportPDF = async () => {
    const doc = new jsPDF();
    let yPosition = 20;

    doc.setFontSize(18);
    doc.text('Alt Text Report', 20, yPosition);
    yPosition += 10;

    doc.setFontSize(12);
    const vehicleText = `${vehicleInfo.year} ${capitalize(vehicleInfo.make)} ${formatModelName(vehicleInfo.model, vehicleInfo.make)} ${vehicleInfo.trim ? capitalize(vehicleInfo.trim) : ''} ${vehicleInfo.color ? 'in ' + vehicleInfo.color : ''}`.replace(/\s{2,}/g, ' ').trim();
    doc.text(vehicleText, 20, yPosition);
    yPosition += 15;

    for (let index = 0; index < images.length; index++) {
      const img = images[index];
      
      if (yPosition > 220) {
        doc.addPage();
        yPosition = 20;
      }

      const altText = generateAltText(img);
      
      try {
        const imgData = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(img.blob);
        });

        const isPng = img.filename.toLowerCase().endsWith('.png');
        doc.addImage(imgData, isPng ? 'PNG' : 'JPEG', 20, yPosition, 60, 40);
        
        doc.setFontSize(10);
        const splitText = doc.splitTextToSize(altText, 100);
        doc.text(splitText, 85, yPosition + 5);
        
        yPosition += 50;
      } catch (error) {
        console.error('Error adding image to PDF:', error);
      }
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

  // ===================== AUTH & RENDER =====================

  useEffect(() => {
    const loggedIn = sessionStorage.getItem('authenticated');
    if (loggedIn === 'true') {
      setIsAuthenticated(true);
    }
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
            
            {passwordError && (
              <p style={styles.errorMessage}>{passwordError}</p>
            )}
            
            <button type="submit" style={styles.loginButton}>
              Access Tool
            </button>
          </form>
          
          <p style={styles.loginFooter}>
            For authorized Honda/Acura team members only
          </p>
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
                {vehicleInfo.year} {capitalize(vehicleInfo.make)} {formatModelName(vehicleInfo.model, vehicleInfo.make)} 
                {vehicleInfo.trim && ` ${capitalize(vehicleInfo.trim)}`}
                {vehicleInfo.color && ` in ${vehicleInfo.color}`}
              </p>
              <p style={styles.count}>{images.length} unique images</p>
            </div>
            <div style={styles.buttonGroup}>
              <button onClick={exportPDF} style={{...styles.button, ...styles.greenButton}}>
                📥 Export PDF
              </button>
              <button onClick={resetTool} style={{...styles.button, ...styles.grayButton}}>
                Start Over
              </button>
              <button onClick={handleLogout} style={{...styles.button, ...styles.redButton}}>
                🔒 Logout
              </button>
            </div>
          </div>

          <div style={styles.imageList}>
            {images.map((img, index) => {
              const altText = generateAltText(img);
              return (
                <div key={img.id} style={styles.imageCard}>
                  <img src={img.url} alt={altText} style={styles.thumbnail} />
                  <div style={styles.altTextContainer}>
                    <label style={styles.label}>Alt Text</label>
                    <div style={styles.textBoxWrapper}>
                      <p style={styles.altTextBox}>{altText}</p>
                      <button
                        onClick={() => copyToClipboard(altText, index)}
                        style={styles.copyButton}
                        title="Copy to clipboard"
                      >
                        {copiedIndex === index ? '✓' : '📋'}
                      </button>
                    </div>
                    <p style={{...styles.charCount, color: altText.length > 125 ? '#ef4444' : '#6b7280'}}>
                      {altText.length} characters
                    </p>
                  </div>
                </div>
              );
            })}
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
            <button onClick={handleLogout} style={{...styles.button, ...styles.redButton}}>
              🔒 Logout
            </button>
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
                placeholder="MDX"
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
            style={{
              ...styles.uploadBox,
              ...(dragActive ? styles.uploadBoxActive : {})
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
    transition: 'transform 0.2s',
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
  inputGroup: {
    display: 'flex',
    flexDirection: 'column',
  },
  inputLabel: {
    fontSize: '0.875rem',
    fontWeight: '500',
    color: '#374151',
    marginBottom: '0.5rem',
  },
  required: {
    color: '#ef4444',
  },
  optional: {
    color: '#9ca3af',
    fontSize: '0.75rem',
  },
  input: {
    width: '100%',
    padding: '0.75rem 1rem',
    border: '1px solid #d1d5db',
    borderRadius: '8px',
    fontSize: '1rem',
    outline: 'none',
  },
  uploadBox: {
    border: '2px dashed #d1d5db',
    borderRadius: '8px',
    padding: '3rem',
    textAlign: 'center',
    background: '#f9fafb',
    transition: 'all 0.2s',
  },
  uploadBoxActive: {
    borderColor: '#3b82f6',
    background: '#eff6ff',
  },
  fileInput: {
    display: 'none',
  },
  uploadLabel: {
    display: 'block',
  },
  uploadIcon: {
    fontSize: '4rem',
    marginBottom: '1rem',
  },
  uploadText: {
    color: '#374151',
    fontWeight: '500',
    marginBottom: '0.5rem',
  },
  uploadSubtext: {
    fontSize: '0.875rem',
    color: '#6b7280',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '2rem',
    paddingBottom: '1rem',
    borderBottom: '1px solid #e5e7eb',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    color: '#111827',
  },
  subtitle: {
    color: '#6b7280',
    marginTop: '0.25rem',
  },
  count: {
    fontSize: '0.875rem',
    color: '#9ca3af',
    marginTop: '0.25rem',
  },
  buttonGroup: {
    display: 'flex',
    gap: '0.75rem',
  },
  button: {
    padding: '0.5rem 1rem',
    borderRadius: '8px',
    border: 'none',
    fontWeight: '500',
    cursor: 'pointer',
    fontSize: '0.875rem',
  },
  greenButton: {
    background: '#16a34a',
    color: 'white',
  },
  grayButton: {
    background: '#4b5563',
    color: 'white',
  },
  redButton: {
    background: '#dc2626',
    color: 'white',
  },
  imageList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
  },
  imageCard: {
    display: 'flex',
    gap: '1.5rem',
    padding: '1.25rem',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
  },
  thumbnail: {
    width: '256px',
    height: '192px',
    objectFit: 'cover',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    flexShrink: 0,
  },
  altTextContainer: {
    flex: 1,
  },
  label: {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: '500',
    color: '#6b7280',
    marginBottom: '0.5rem',
  },
  textBoxWrapper: {
    position: 'relative',
  },
  altTextBox: {
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    padding: '1rem 4rem 1rem 1rem',
    color: '#111827',
    userSelect: 'text',
    cursor: 'text',
    wordBreak: 'break-word',
  },
  copyButton: {
    position: 'absolute',
    right: '0.5rem',
    top: '0.5rem',
    padding: '0.5rem',
    background: '#2563eb',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '1.25rem',
  },
  charCount: {
    fontSize: '0.875rem',
    color: '#6b7280',
    marginTop: '0.5rem',
  },
};
