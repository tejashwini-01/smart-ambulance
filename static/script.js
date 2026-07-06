let emergencyActive = false;
let emergencyLane = null;
let ambulanceSpawnedThisCycle = false;
/* ========= Socket & server state ========= */
const socket = io();
let serverState = { lanes:{1:{},2:{},3:{},4:{}}, queue: [] };

function setLightsFromState(){
  const L = serverState.lanes || {};
  for (let i=1;i<=4;i++){
    const st = L[i] || {};
    const sig = document.querySelector(`.signal[data-lane="${i}"]`);
    if(!sig) continue;
    sig.querySelectorAll('.light').forEach(n => n.style.opacity = .25);
    if(st.color === 'red') sig.querySelector('.light.red').style.opacity = 1;
    else if(st.color === 'yellow') sig.querySelector('.light.yellow').style.opacity = 1;
    else if(st.color === 'green') sig.querySelector('.light.green').style.opacity = 1;
    const t = document.getElementById('timer'+i);
    if(t) t.textContent = ((+st.time_left||0) + 's');
    // 🚑 Spawn ambulance exactly when emergency lane turns GREEN
    if (emergencyActive &&
        emergencyLane == i &&
        st.color === 'green' &&
        !ambulanceSpawnedThisCycle) {

        makeVehicle('ambulance', i);
        ambulanceSpawnedThisCycle = true;
    }
  }

  // queue UI
  const q = serverState.queue || [];
  document.getElementById('queueLen').textContent = q.length;
  const ql = document.getElementById('queueList'); ql.innerHTML = '';
  q.forEach((item, idx) => {
    const d = document.createElement('div');
    d.textContent = `${idx+1}. Lane ${item.lane} (${item.duration}s) ${item.driver?'- '+item.driver:''}`;
    ql.appendChild(d);
  });
}

socket.on('state_update', (payload) => {
  const oldLen = serverState.queue?.length || 0;
  serverState = payload || serverState;
  setLightsFromState();

  const nowLen = serverState.queue?.length || 0;

  // 🔥 Detect emergency mode ON / OFF
  if (serverState.queue.length > 0) {
      emergencyActive = true;
      emergencyLane = Number(serverState.queue[0].lane);
  } else {
      emergencyActive = false;
      emergencyLane = null;
      ambulanceSpawnedThisCycle = false; // reset
  }
});
window.addEventListener('load', async () => {
  try {
    const r = await fetch('/get_state'); serverState = await r.json();
  } catch(e){}
  setLightsFromState();
  initSim();
});

/* ========= Geometry helpers ========= */
function simBox(){ return document.getElementById('sim').getBoundingClientRect(); }
function geom(){
  const r = simBox();
  const cx = r.width/2;
  const cy = r.height/2;

  const offset = 28;   // ← SHIFT LEFT/NORTH OF DIVIDER

  return {
    // Lane 1: North → South (move left of divider)
    1:{ 
      start:{x:cx + offset, y:-60}, 
      dir:{x:0, y:1},  
      stopY:170, 
      exitY:r.height+60 
    },

    // Lane 4: South → North (move left of divider)
    4:{ 
      start:{x:cx - offset, y:r.height+60}, 
      dir:{x:0, y:-1}, 
      stopY:r.height - 170, 
      exitY:-60 
    },

    // Lane 2: West → East (move above divider)
    2:{ 
      start:{x:-60, y:cy - offset}, 
      dir:{x:1, y:0},  
      stopX:360, 
      exitX:r.width+60 
    },

    // Lane 3: East → West (move above divider)
    3:{ 
      start:{x:r.width+60, y:cy + offset}, 
      dir:{x:-1, y:0}, 
      stopX:r.width - 360, 
      exitX:-60 
    },

    w:r.width,
    h:r.height
  };
}
function isGreen(lane){
  const s = serverState.lanes?.[lane];
  return s && s.color === 'green';
}

/* ========= Vehicle simulation ========= */
const layer = document.getElementById('vehicles-layer');
const vehicles = []; // {el,type,lane,x,y,dir,spd,stopped,passed}

/* Minimal vector SVG templates (small, crisp) */
/* return SVG based on kind and lane (top-view for lane 1 & 4) */
function svgFor(kind, lane){

  const top = (lane === 1 || lane === 4);   // top-view only for vertical lanes

  /* ===================== CAR ====================== */
  if(kind === 'car'){
    if(top){
      return `<svg viewBox="0 0 120 200" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <rect x="20" y="10" rx="16" ry="16" width="100" height="300" fill="#4a8df5" stroke="#123c7c" stroke-width="6"/>
        <rect x="35" y="40" width="50" height="60" rx="10" fill="#dff3ff"/>
        <rect x="35" y="120" width="50" height="60" rx="10" fill="#dff3ff"/>
      </svg>`;
    }
    // side-view
    return `<svg viewBox="0 0 120 60" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
      <rect x="10" y="10" rx="10" ry="10" width="100" height="40" fill="#4a8df5" stroke="#123c7c" stroke-width="3"/>
      <rect x="30" y="16" width="60" height="18" rx="5" fill="#dff3ff"/>
      <circle cx="30" cy="50" r="6" fill="#111"/><circle cx="90" cy="50" r="6" fill="#111"/>
    </svg>`;
  }

  /* ===================== AUTO ====================== */
  if(kind === 'auto'){
    if(top){
      return `<svg viewBox="0 0 120 200" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <rect x="20" y="10" rx="20" ry="20" width="80" height="180" fill="#ffc400" stroke="#b88400" stroke-width="6"/>
        <rect x="34" y="42" width="52" height="48" rx="12" fill="#fff"/>
        <rect x="34" y="120" width="52" height="48" rx="12" fill="#fff"/>
      </svg>`;
    }
    return `<svg viewBox="0 0 110 70" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="12" rx="12" ry="12" width="94" height="46" fill="#ffc400" stroke="#b88400" stroke-width="3"/>
      <rect x="24" y="20" width="62" height="20" rx="5" fill="#fff" opacity="0.9"/>
      <circle cx="28" cy="58" r="7" fill="#111"/><circle cx="82" cy="58" r="7" fill="#111"/>
    </svg>`;
  }

  /* ===================== BIKE ====================== */
  if(kind === 'bike'){
    if(top){
      return `<svg viewBox="0 0 60 160" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <rect x="18" y="20" width="24" height="120" rx="12" fill="#7f8c8d"/>
      </svg>`;
    }
    return `<svg viewBox="0 0 80 40" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
      <rect x="10" y="10" width="60" height="20" rx="6" fill="#7f8c8d"/>
      <circle cx="20" cy="32" r="5" fill="#111"/><circle cx="60" cy="32" r="5" fill="#111"/>
    </svg>`;
  }

  /* ===================== BUS ====================== */
  if(kind === 'bus'){
    if(top){
      return `<svg viewBox="0 0 160 280" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <rect x="20" y="10" rx="26" ry="26" width="120" height="260" fill="#e74639" stroke="#7a120c" stroke-width="6"/>
        <rect x="38" y="40" width="84" height="80" fill="#fff"/>
        <rect x="38" y="150" width="84" height="80" fill="#fff"/>
      </svg>`;
    }
    return `<svg viewBox="0 0 200 80" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="10" rx="12" ry="12" width="184" height="60" fill="#e74639" stroke="#7a120c" stroke-width="4"/>
      <rect x="28" y="22" width="144" height="28" fill="#fff" opacity="0.9"/>
      <circle cx="36" cy="70" r="8" fill="#111"/><circle cx="164" cy="70" r="8" fill="#111"/>
    </svg>`;
  }

  /* ===================== AMBULANCE ====================== */
  if(kind === 'ambulance'){
    if(top){
      return `<svg viewBox="0 0 140 260" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <rect x="14" y="10" rx="20" ry="20" width="112" height="240" fill="#fff" stroke="#e11d48" stroke-width="6"/>
        <rect x="50" y="40" width="40" height="40" fill="#e11d48"/>
        <rect x="40" y="100" width="60" height="20" fill="#e11d48"/>
        <rect x="50" y="150" width="40" height="40" fill="#e11d48"/>
      </svg>`;
    }
    return `<svg viewBox="0 0 140 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="8" rx="10" ry="10" width="124" height="48" fill="#fff" stroke="#e11d48" stroke-width="3"/>
      <rect x="44" y="18" width="12" height="28" fill="#e11d48"/>
      <rect x="34" y="28" width="32" height="10" fill="#e11d48"/>
      <circle cx="28" cy="54" r="6" fill="#111"/><circle cx="112" cy="54" r="6" fill="#111"/>
    </svg>`;
  }

  return '';
}

/* create vehicle element */
function makeVehicle(kind, lane){
  const g = geom()[lane];
  const el = document.createElement('div');
  el.className = 'vehicle ' + kind;
  el.innerHTML = svgFor(kind,lane);
  // increase size only for top-view lanes (1 and 4)
if (lane === 1 || lane === 4) {
    if (kind === 'car') { el.style.width = "20px"; el.style.height = "30px"; }
    if (kind === 'auto') { el.style.width = "20px"; el.style.height = "40px"; }
    if (kind === 'bike') { el.style.width = "50px"; el.style.height = "30px"; }
    if (kind === 'bus') { el.style.width = "30px"; el.style.height = "80px"; }
    if (kind === 'ambulance') { el.style.width = "30px"; el.style.height = "75px"; }
}
  // set initial center position
  el.style.left = g.start.x + 'px';
  el.style.top  = g.start.y + 'px';

  // rotation: rotate the whole element (including svg). Keep translate(-50%, -50%) in CSS transform order.
  const rot = (lane === 1)? 0 : (lane === 4)? 0 : (lane === 2)? 0 : 0;
  el.style.transform = `translate(-50%,-50%) rotate(${rot}deg)`;

  layer.appendChild(el);

  const baseSpeed = (kind === 'bus')? 85 : (kind === 'bike')? 95 : (kind === 'auto')? 110 : 120;
  const v = {
    el, type: kind, lane,
    x: g.start.x, y: g.start.y,
    dir: g.dir,
    stopped: false, passed: false,
    spd: (kind === 'ambulance' ? 220 : baseSpeed)
  };
  vehicles.push(v);
  return v;
}

/* spawn traffic */
let spawnTimer = null;
function startTraffic(){
  if(spawnTimer) clearInterval(spawnTimer);
  spawnTimer = setInterval(()=>{
    const lane = 1 + Math.floor(Math.random()*4);
    const r = Math.random();
    const kind = (r<0.12)?'bus' : (r<0.35)?'auto' : (r<0.65)?'bike' : 'car';
    makeVehicle(kind,lane);
  }, 900 + Math.random()*600);
}

/* spawn ambulance when queue increases */
function spawnAmbulanceFromQueueTail(){
  const q = serverState.queue || [];
  if(!q.length) return;
  const last = q[q.length-1];
  makeVehicle('ambulance', Number(last.lane));
}

/* physics loop */
let lastT = performance.now();
function tick(now){
  const dt = Math.max(0, (now - lastT)/1000); lastT = now;
  const g = geom();

  for(let i=0;i<vehicles.length;i++){
    const v = vehicles[i];
    // approach & stop logic (ambulance ignores signal)
    if(!v.passed && v.type !== 'ambulance'){
      if(v.lane === 1){
        if(!isGreen(1) && v.y < g[1].stopY - 24){
          const next = v.y + v.spd*dt;
          if(next >= g[1].stopY - 24){ v.y = g[1].stopY - 24; v.stopped = true; }
        }
      } else if(v.lane === 4){
        if(!isGreen(4) && v.y > g[4].stopY + 24){
          const next = v.y - v.spd*dt;
          if(next <= g[4].stopY + 24){ v.y = g[4].stopY + 24; v.stopped = true; }
        }
      } else if(v.lane === 2){
        if(!isGreen(2) && v.x < g[2].stopX - 24){
          const next = v.x + v.spd*dt;
          if(next >= g[2].stopX - 24){ v.x = g[2].stopX - 24; v.stopped = true; }
        }
      } else if(v.lane === 3){
        if(!isGreen(3) && v.x > g[3].stopX + 24){
          const next = v.x - v.spd*dt;
          if(next <= g[3].stopX + 24){ v.x = g[3].stopX + 24; v.stopped = true; }
        }
      }
    }

    // ambulances never stop (they ignore red in simulation)
    if(v.type === 'ambulance') v.stopped = false;

    // resume when green
    if(v.stopped && isGreen(v.lane)) v.stopped = false;
    /* --- SAFE DISTANCE BETWEEN VEHICLES (Anti-overlap) --- */
const SAFE_GAP = 45;  // distance (px) — increase if needed

for (let j = 0; j < vehicles.length; j++) {
    if (i === j) continue;
    const w = vehicles[j];

    if (w.lane === v.lane) {  // same lane only
        if (v.dir.y > 0) {  
            // Lane 1 (moving down)
            if (w.y > v.y && (w.y - v.y) < SAFE_GAP) v.stopped = true;
        }
        else if (v.dir.y < 0) {
            // Lane 4 (moving up)
            if (w.y < v.y && (v.y - w.y) < SAFE_GAP) v.stopped = true;
        }
        else if (v.dir.x > 0) {
            // Lane 2 (moving right)
            if (w.x > v.x && (w.x - v.x) < SAFE_GAP) v.stopped = true;
        }
        else if (v.dir.x < 0) {
            // Lane 3 (moving left)
            if (w.x < v.x && (v.x - w.x) < SAFE_GAP) v.stopped = true;
        }
    }
}
    // move if not stopped
    if(!v.stopped){
      v.x += v.dir.x * v.spd * dt;
      v.y += v.dir.y * v.spd * dt;
    }

    // passed center?
    // Mark vehicle as passed ONLY after fully crossing the junction
if (!v.passed) {

    if (v.lane === 1 && v.y > g[1].stopY + 100) v.passed = true;   // moving down
    if (v.lane === 4 && v.y < g[4].stopY - 100) v.passed = true;   // moving up
    if (v.lane === 2 && v.x > g[2].stopX + 100) v.passed = true;   // moving right
    if (v.lane === 3 && v.x < g[3].stopX - 100) v.passed = true;   // moving left
}

    // remove if outside
    if(v.x < -200 || v.x > g.w+200 || v.y < -200 || v.y > g.h+200){
      v.el.remove();
      v.dead = true;
    } else {
      v.el.style.left = v.x + 'px';
      v.el.style.top  = v.y + 'px';
    }
  }

  // compact
  for(let j = vehicles.length - 1; j >= 0; j--){
    if(vehicles[j].dead) vehicles.splice(j,1);
  }

  requestAnimationFrame(tick);
}

/* boot */
function initSim(){
  startTraffic();
  lastT = performance.now();
  requestAnimationFrame(tick);
}