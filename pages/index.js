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

  const CORRECT_PASSWORD = 'AHM.2025';

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
  };

  const capitalize = (str) => (!str ? '' : str.charAt(0).toUpperCase() + str.slice(1).toLowerCase());

  // --- Global image classifier ---
  const analyzeImage = (url) => new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const maxDim = 256;
        const scale = Math.min(maxDim / img.width, maxDim / img.height);
        const w = Math.max(64, Math.floor(img.width * scale));
        const h = Math.max(64, Math.floor(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        const total = w * h;
        let dark = 0, bright = 0, grayish = 0, satSum = 0;
        const brightPts = [];
        const satOf = (r,g,b)=>{const max=Math.max(r,g,b),min=Math.min(r,g,b);return max===0?0:(max-min)/max;};

        for (let y=0;y<h;y++){
          for (let x=0;x<w;x++){
            const i=(y*w+x)*4;
            const r=data[i],g=data[i+1],b=data[i+2];
            const bri=(r+g+b)/3;
            const sat=satOf(r,g,b);
            if (bri<55) dark++;
            if (bri>200) brightPts.push({x,y});
            if (Math.abs(r-g)<12 && Math.abs(g-b)<12) grayish++;
            satSum+=sat;
          }
        }
        const darkR=dark/total, grayR=grayish/total, avgSat=satSum/total;

        // Simple vertical bands brightness
        let top=0,mid=0,bot=0;
        for (let y=0;y<h;y++){
          for (let x=0;x<w;x++){
            const i=(y*w+x)*4;
            const bri=(data[i]+data[i+1]+data[i+2])/3;
            if (y<h/3) top+=bri;
            else if (y<2*h/3) mid+=bri;
            else bot+=bri;
          }
        }
        const band=w*Math.floor(h/3);
        top/=band;mid/=band;bot/=band;

        const interiorScore=(darkR>0.35?1:0)+(avgSat<0.22?1:0)+(grayR>0.22?1:0);
        const confidentInterior=interiorScore>=2.5;

        // centroid and shape of bright cluster
        let cx=0,cy=0;
        brightPts.forEach(p=>{cx+=p.x;cy+=p.y;});
        if (brightPts.length){cx/=brightPts.length;cy/=brightPts.length;}
        let vx=0,vy=0;
        brightPts.forEach(p=>{vx+=(p.x-cx)**2;vy+=(p.y-cy)**2;});
        if (brightPts.length){vx/=brightPts.length;vy/=brightPts.length;}
        const spread=Math.sqrt(vx+vy);
        const tallVsWide=vy>vx*1.35;
        const centerish=cx>w*0.33&&cx<w*0.67&&cy>h*0.33&&cy<h*0.7;
        const compact=spread<Math.min(w,h)*0.18;
        const sideBright=cx<w*0.25||cx>w*0.75;
        const wideAspect=w/h>=1.2;
        const dayGradient=top>bot+18;
        const nightGradient=bot>top+10;

        // ---------- Classification ----------
        if (confidentInterior){
          if (centerish&&compact) return resolve('detail of gear shifter');
          if (sideBright&&tallVsWide) return resolve('detail of paddle shifter');
          return resolve('detail of dashboard');
        }
        if (dayGradient) return resolve('front view');
        if (nightGradient) return resolve('front view');
        if (wideAspect) return resolve('profile view');
        return resolve('front view');
      } catch {
        return resolve('front view');
      }
    };
    img.onerror = () => resolve('front view');
    img.src = url;
  });

  const processZipFile = async (file) => {
    setProcessing(true);
    const zip = new JSZip();
    try {
      const contents = await zip.loadAsync(file);
      const imageFiles = [];
      for (const [filename, zipEntry] of Object.entries(contents.files)) {
        if (zipEntry.dir) continue;
        const ext = filename.split('.').pop().toLowerCase();
        if (!['jpg','jpeg','png','webp','avif'].includes(ext)) continue;
        const blob = await zipEntry.async('blob');
        const url = URL.createObjectURL(blob);
        const descriptor = await analyzeImage(url);
        imageFiles.push({id:Date.now()+Math.random(),url,blob,descriptor});
      }
      setImages(imageFiles);
      setShowResults(true);
    } catch {
      alert('Error processing ZIP. Try again.');
    } finally {
      setProcessing(false);
    }
  };

  const handleZipUpload = (e)=>{const f=e.target.files[0];if(f)processZipFile(f);};
  const handleDrag=(e)=>{e.preventDefault();e.stopPropagation();if(['dragenter','dragover'].includes(e.type))setDragActive(true);else setDragActive(false);};
  const handleDrop=(e)=>{e.preventDefault();setDragActive(false);const f=e.dataTransfer.files[0];if(f&&f.name.endsWith('.zip'))processZipFile(f);};

  const generateAltText=(descriptor)=>{
    const {year,make,model,trim,color}=vehicleInfo;
    let text=`${year} ${capitalize(model)}`;
    if (make) text=`${year} ${capitalize(make)} ${capitalize(model)}`;
    if (trim) text+=` ${capitalize(trim)}`;
    if (color) text+=` in ${color}`;
    text+=` ${descriptor}`;
    return text.trim();
  };

  const copyToClipboard=(text,index)=>{
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(()=>setCopiedIndex(null),2000);
  };

  const exportPDF=async()=>{
    const doc=new jsPDF();let y=20;
    doc.setFontSize(18);doc.text('Alt Text Report',20,y);y+=10;
    doc.setFontSize(12);
    const vText=`${vehicleInfo.year} ${capitalize(vehicleInfo.make)} ${capitalize(vehicleInfo.model)} ${vehicleInfo.trim?capitalize(vehicleInfo.trim):''} ${vehicleInfo.color?'in '+vehicleInfo.color:''}`;
    doc.text(vText.trim(),20,y);y+=15;
    for (let i=0;i<images.length;i++){
      if (y>220){doc.addPage();y=20;}
      const img=images[i];
      const alt=generateAltText(img.descriptor);
      const imgData=await new Promise(r=>{
        const reader=new FileReader();reader.onloadend=()=>r(reader.result);reader.readAsDataURL(img.blob);
      });
      doc.addImage(imgData,'JPEG',20,y,60,40);
      doc.setFontSize(10);
      const split=doc.splitTextToSize(alt,100);
      doc.text(split,85,y+5);
      y+=50;
    }
    doc.save('alt-text-report.pdf');
  };

  const resetTool=()=>{
    setShowResults(false);
    setImages([]);
    setVehicleInfo({year:'',make:'',model:'',trim:'',color:''});
  };

  // ------------------ LOGIN PAGE ------------------
  if (!isAuthenticated) {
    return (
      <div style={styles.loginContainer}>
        <div style={styles.loginCard}>
          <h1 style={styles.loginTitle}>🔒 AI SEO Alt Text Generator</h1>
          <p style={styles.loginSubtitle}>Protected Access</p>
          <form onSubmit={handleLogin}>
            <input type="password" value={passwordInput} onChange={(e)=>setPasswordInput(e.target.value)} placeholder="Enter password" style={styles.loginInput}/>
            {passwordError && <p style={styles.error}>{passwordError}</p>}
            <button type="submit" style={styles.loginButton}>Access Tool</button>
          </form>
          <p style={styles.loginFooter}>For authorized Honda/Acura team members only</p>
        </div>
      </div>
    );
  }

  // ------------------ RESULTS PAGE ------------------
  if (showResults) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <div style={styles.header}>
            <h1 style={styles.title}>Generated Alt Text</h1>
            <div style={styles.buttonGroup}>
              <button onClick={exportPDF} style={{...styles.button,background:'#16a34a'}}>Export PDF</button>
              <button onClick={resetTool} style={{...styles.button,background:'#4b5563'}}>Start Over</button>
              <button onClick={handleLogout} style={{...styles.button,background:'#dc2626'}}>Logout</button>
            </div>
          </div>
          <p>{images.length} unique images</p>
          {images.map((img,i)=>{
            const alt=generateAltText(img.descriptor);
            return (
              <div key={img.id} style={styles.imageCard}>
                <img src={img.url} alt="" style={styles.thumbnail}/>
                <div style={styles.altContainer}>
                  <label>Alt Text</label>
                  <div style={styles.textBoxWrapper}>
                    <p style={styles.altText}>{alt}</p>
                    <button onClick={()=>copyToClipboard(alt,i)} style={styles.copyButton}>{copiedIndex===i?'✓':'📋'}</button>
                  </div>
                  <p style={styles.charCount}>{alt.length} characters</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ------------------ FORM PAGE ------------------
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.headerSection}>
          <div style={styles.titleRow}>
            <h1 style={styles.mainTitle}>AI SEO Alt Text Generator</h1>
            <button onClick={handleLogout} style={{...styles.button,background:'#dc2626'}}>Logout</button>
          </div>
          <p style={styles.description}>Generate optimized alt text for automotive images</p>
        </div>
        <div style={styles.form}>
          <div style={styles.grid}>
            <div style={styles.inputGroup}>
              <label>Year *</label>
              <input type="text" value={vehicleInfo.year} onChange={(e)=>setVehicleInfo({...vehicleInfo,year:e.target.value})} placeholder="2025" style={styles.input}/>
            </div>
            <div style={styles.inputGroup}>
              <label>Model *</label>
              <input type="text" value={vehicleInfo.model} onChange={(e)=>setVehicleInfo({...vehicleInfo,model:e.target.value})} placeholder="MDX" style={styles.input}/>
            </div>
            <div style={styles.inputGroup}>
              <label>Make (optional)</label>
              <input type="text" value={vehicleInfo.make} onChange={(e)=>setVehicleInfo({...vehicleInfo,make:e.target.value})} placeholder="Acura" style={styles.input}/>
            </div>
            <div style={styles.inputGroup}>
              <label>Trim (optional)</label>
              <input type="text" value={vehicleInfo.trim} onChange={(e)=>setVehicleInfo({...vehicleInfo,trim:e.target.value})} placeholder="Type S" style={styles.input}/>
            </div>
            <div style={{...styles.inputGroup,gridColumn:'1 / -1'}}>
              <label>Color (optional)</label>
              <input type="text" value={vehicleInfo.color} onChange={(e)=>setVehicleInfo({...vehicleInfo,color:e.target.value})} placeholder="Apex Blue Pearl" style={styles.input}/>
            </div>
          </div>
          <div onDragEnter={handleDrag} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleDrop}
               style={{...styles.uploadBox,...(dragActive?styles.uploadBoxActive:{})}}>
            <input type="file" accept=".zip" onChange={handleZipUpload} disabled={!vehicleInfo.year||!vehicleInfo.model||processing} style={{display:'none'}} id="zip-upload"/>
            <label htmlFor="zip-upload" style={{cursor:(!vehicleInfo.year||!vehicleInfo.model)?'not-allowed':'pointer',opacity:(!vehicleInfo.year||!vehicleInfo.model)?0.5:1}}>
              <div style={styles.uploadIcon}>📁</div>
              <p>{processing?'Processing images...':dragActive?'Drop ZIP here':'Drag & drop ZIP or click to browse'}</p>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles={
  loginContainer:{minHeight:'100vh',display:'flex',justifyContent:'center',alignItems:'center',background:'linear-gradient(135deg,#667eea,#764ba2)'},
  loginCard:{background:'#fff',borderRadius:'12px',padding:'2rem',boxShadow:'0 10px 30px rgba(0,0,0,0.2)',textAlign:'center'},
  loginTitle:{fontSize:'1.5rem',fontWeight:'bold',marginBottom:'0.5rem'},
  loginSubtitle:{color:'#666',marginBottom:'1rem'},
  loginInput:{width:'100%',padding:'0.75rem',border:'1px solid #ccc',borderRadius:'8px',marginBottom:'1rem'},
  loginButton:{width:'100%',padding:'0.75rem',background:'#667eea',color:'#fff',border:'none',borderRadius:'8px',cursor:'pointer'},
  error:{color:'red',fontSize:'0.875rem',marginBottom:'1rem'},
  loginFooter:{fontSize:'0.75rem',color:'#999'},
  container:{minHeight:'100vh',background:'#f9fafb',padding:'2rem'},
  card:{maxWidth:'1200px',margin:'0 auto',background:'#fff',borderRadius:'12px',padding:'2rem',boxShadow:'0 4px 8px rgba(0,0,0,0.1)'},
  header:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'1rem'},
  buttonGroup:{display:'flex',gap:'0.5rem'},
  button:{padding:'0.5rem 1rem',color:'#fff',border:'none',borderRadius:'6px',cursor:'pointer'},
  imageCard:{display:'flex',gap:'1rem',padding:'1rem',border:'1px solid #eee',borderRadius:'8px',marginBottom:'1rem'},
  thumbnail:{width:'250px',height:'180px',objectFit:'cover',borderRadius:'8px'},
  altContainer:{flex:1},
  textBoxWrapper:{position:'relative'},
  altText:{background:'#f3f4f6',padding:'1rem',borderRadius:'8px',border:'1px solid #ddd'},
  copyButton:{position:'absolute',right:'0.5rem',top:'0.5rem',background:'#2563eb',color:'#fff',border:'none',borderRadius:'6px',padding:'0.5rem',cursor:'pointer'},
  charCount:{fontSize:'0.875rem',color:'#666',marginTop:'0.5rem'},
  form:{display:'flex',flexDirection:'column',gap:'1rem'},
  grid:{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:'1rem'},
  inputGroup:{display:'flex',flexDirection:'column'},
  input:{padding:'0.75rem',border:'1px solid #ccc',borderRadius:'8px'},
  uploadBox:{border:'2px dashed #ccc',padding:'2rem',borderRadius:'8px',textAlign:'center',background:'#f9fafb'},
  uploadBoxActive:{borderColor:'#3b82f6',background:'#eff6ff'},
  uploadIcon:{fontSize:'3rem',marginBottom:'0.5rem'},
  mainTitle:{fontSize:'1.75
