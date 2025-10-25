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

  // PASSWORD CONFIGURATION - Change this to your desired password
  const CORRECT_PASSWORD = 'AHM.2025'; // <-- CHANGE THIS PASSWORD

  useEffect(() => {
    // Check if already logged in (session storage)
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

  const capitalize = (str) => {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  };

  const detectAngle = (filename) => {
    const lower = filename.toLowerCase();
    
    if (lower.match(/front|exterior.*front|facade|grille/i)) return 'front three-quarter view';
    if (lower.match(/side|profile|lateral/i)) return 'side profile view';
    if (lower.match(/rear|back/i)) return 'rear three-quarter view';
    if (lower.match(/interior|inside|cabin|dashboard|cockpit|shifter|steering/i)) return 'interior dashboard view';
    if (lower.match(/wheel|rim|tire/i)) return 'wheel detail view';
    if (lower.match(/engine|motor|bay/i)) return 'engine bay view';
    if (lower.match(/detail|close|macro/i)) return 'detail shot';
    if (lower.match(/top|aerial|overhead|roof/i)) return 'overhead view';
    if (lower.match(/trunk|boot|cargo/i)) return 'trunk view';
    
    return 'exterior view';
  };

  const areImagesSimilar = (name1, name2) => {
    const clean1 = name1.replace(/[-_](s|m|l|xl|small|medium|large|xlarge|\d+x\d+)\./i, '.');
    const clean2 = name2.replace(/[-_](s|m|l|xl|small|medium|large|xlarge|\d+x\d+)\./i, '.');
    return clean1 === clean2;
  };

  const handleZipUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

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

        if (!isDuplicate) {
          const blob = await zipEntry.async('blob');
          const url = URL.createObjectURL(blob);
          const angle = detectAngle(filename);
          
          imageFiles.push({
            id: Date.now() + Math.random(),
            filename,
            url,
            angle,
            blob
          });
          
          processedNames.add(filename);
        }
      }

      setImages(imageFiles);
      setShowResults(true);
      setProcessing(false);
    } catch (error) {
      alert('Error processing ZIP file. Please try again.');
      setProcessing(false);
    }
  };

  const generateAltText = (angle) => {
    const { year, make, model, trim, color } = vehicleInfo;
    
    const capitalizedMake = capitalize(make);
    const capitalizedModel = capitalize(model);
    const capitalizedTrim = capitalize(trim);
    
    let altText = `${year} ${capitalizedMake} ${capitalizedModel}`;
    if (trim) altText += ` ${capitalizedTrim}`;
    if (color) altText += ` in ${color}`;
    altText += `, ${angle}`;
    return altText;
  };

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
    const vehicleText = `${vehicleInfo.year} ${capitalize(vehicleInfo.make)} ${capitalize(vehicleInfo.model)} ${vehicleInfo.trim ? capitalize(vehicleInfo.trim) : ''} ${vehicleInfo.color ? 'in ' + vehicleInfo.color : ''}`;
    doc.text(vehicleText, 20, yPosition);
    yPosition += 15;

    for (let index = 0; index < images.length; index++) {
      const img = images[index];
      
      if (yPosition > 220) {
        doc.addPage();
        yPosition = 20;
      }

      const altText = generateAltText(img.angle);
      
      try {
        const imgData = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(img.blob);
        });

        doc.addImage(imgData, 'JPEG', 20, yPosition, 60, 40);
        
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

  // LOGIN SCREEN
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

  // MAIN APP (only shown after login)
  if (showResults) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <div style={styles.header}>
            <div>
              <h1 style={styles.title}>Generated Alt Text</h1>
              <p style={styles.subtitle}>
                {vehicleInfo.year} {capitalize(vehicleInfo.make)} {capitalize(vehicleInfo.model)} 
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
              const altText = generateAltText(img.angle);
              return (
                <div key={img.id} style={styles.imageCard}>
                  <img src={img.url} alt="Vehicle preview" style={styles.thumbnail} />
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
                    <p style={styles.charCount}>{altText.length} characters</p>
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
                placeholder="Integra"
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

          <div style={styles.uploadBox}>
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
                {processing ? 'Processing images...' : 'Click to upload ZIP file with vehicle images'}
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
