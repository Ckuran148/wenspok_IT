const FILTER_WEEKS = 5;
const CSV_FILENAME = 'Cases Week 1.csv';
const CSV_MARKETS_FILENAME = 'Emails DM Sites CSV.csv';
let scrollInterval = null;
let siteToMarketMap = {};

document.getElementById('filter-weeks-display').innerText = FILTER_WEEKS;

// --- Helpers ---
function parseCustomDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const s = dateStr.trim().replace(/"/g, '');
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    const parts = s.split(' ');
    const datePart = parts[0];
    if (datePart.includes('-')) {
        const dp = datePart.split('-');
        if (dp.length === 3) {
            const months = {'jan':0, 'feb':1, 'mar':2, 'apr':3, 'may':4, 'jun':5, 'jul':6, 'aug':7, 'sep':8, 'oct':9, 'nov':10, 'dec':11};
            const mStr = dp[1].toLowerCase();
            if (months[mStr] !== undefined) {
                const year = parseInt(dp[2]);
                const h = parts[1] ? parseInt(parts[1].split(':')[0]) : 0;
                return new Date(year, months[mStr], parseInt(dp[0]), h);
            }
        }
    }
    return null;
}

function formatDate(date) {
    if (!date) return '';
    return `${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}-${date.getFullYear()}`;
}

function getGroup(state) {
    const s = (state||'').toString().trim();
    if (['New','Open','Pending'].includes(s)) return 'Open';
    if (['Resolved','Closed'].includes(s)) return 'Closed';
    if (s === 'Cancelled') return 'Cancelled';
    return 'Unknown';
}

function extractSiteNumber(str) {
    if (!str) return '';
    const m = str.toString().match(/\d+/);
    return m ? m[0] : str.trim();
}

// --- Scrolling Logic ---
function startScrolling() {
    if (scrollInterval) clearInterval(scrollInterval);
    const container = document.getElementById('imp-scroll-container');
    if (container.scrollHeight <= container.clientHeight) return;

    let scrollPos = 0;
    scrollInterval = setInterval(() => {
        scrollPos += 0.5; 
        container.scrollTop = scrollPos;
        if (container.scrollTop >= (container.scrollHeight / 2)) {
            scrollPos = 0;
            container.scrollTop = 0;
        }
    }, 40);
}

// --- Core Logic ---
function updateDashboard(data) {
    document.getElementById('manual-input-container').style.display = 'none';
    document.getElementById('last-updated-time').innerText = new Date().toLocaleTimeString();

    if (data.length === 0) return;
    const row0 = data[0];
    const keys = Object.keys(row0);
    const findK = (s) => keys.find(k => k.toLowerCase().trim().includes(s));
    
    const cCreated = findK('created'), cState = findK('state')||findK('status'), cCat = findK('category');
    const cSub = findK('subcategory'), cSite = findK('site');
    const cNum = findK('number')||keys[0], cShort = findK('short')||findK('desc');

    const now = new Date();
    const cutoff = new Date(); cutoff.setDate(now.getDate() - (FILTER_WEEKS*7));
    
    // Filter Data (Date OR Open)
    const filtered = data.filter(r => {
        const d = parseCustomDate(r[cCreated]);
        const isRecent = d && d >= cutoff;
        const grp = getGroup(r[cState]);
        return isRecent || (grp === 'Open');
    });

    // Importance (Overdue > 21 days)
    const d21 = new Date(); d21.setDate(now.getDate()-21);
    const overdue = data.filter(r => {
        const d = parseCustomDate(r[cCreated]);
        return getGroup(r[cState])==='Open' && d && d < d21;
    }).sort((a,b) => parseCustomDate(a[cCreated]) - parseCustomDate(b[cCreated]));
    
    const impTable = document.getElementById('importance-table-body');
    impTable.innerHTML = '';
    document.getElementById('overdue-count').innerText = overdue.length;
    
    if(overdue.length===0) {
        document.getElementById('importance-empty-msg').style.display='block';
    } else {
        document.getElementById('importance-empty-msg').style.display='none';
        const renderRow = (r) => {
            const days = Math.floor((now - parseCustomDate(r[cCreated])) / 86400000);
            const row = document.createElement('tr');
            row.innerHTML = `<td width="12%"><strong>${r[cNum]}</strong></td><td width="18%">${extractSiteNumber(r[cSite])||'-'}</td><td width="15%">${formatDate(parseCustomDate(r[cCreated]))}</td><td width="10%"><span class="badge-overdue">${days}d</span></td><td width="45%" class="text-truncate" style="max-width:150px">${r[cShort]||'-'}</td>`;
            impTable.appendChild(row);
        };
        overdue.forEach(renderRow);
        if (overdue.length > 3) {
            overdue.forEach(renderRow); // Duplicate for seamless scroll
            setTimeout(startScrolling, 1000);
        }
    }

    // Stats
    let nOpen=0, nClosed=0, nCanc=0, sameDay=0;
    let cats={}, subs={}, sitesVol={}, sitesOpen={};
    let lifespans=[], catTimes={}, marketsOpen={}, marketsVol={};
    
    filtered.forEach(r => {
        const grp = getGroup(r[cState]);
        const site = extractSiteNumber(r[cSite])||'Unknown';
        const mkt = siteToMarketMap[site] || 'Unknown';
        const cat = r[cCat]||'Other';
        const sub = r[cSub]||'Other';
        
        sitesVol[site] = (sitesVol[site]||0)+1;
        marketsVol[mkt] = (marketsVol[mkt]||0)+1;

        if(grp==='Open') {
            nOpen++;
            sitesOpen[site] = (sitesOpen[site]||0)+1;
            marketsOpen[mkt] = (marketsOpen[mkt]||0)+1;
            cats[cat] = (cats[cat]||0) + 1;
            subs[sub] = (subs[sub]||0) + 1;
        }
        else if(grp==='Closed') {
            nClosed++;
            const dC = parseCustomDate(r[cCreated]);
            const dU = parseCustomDate(r[findK('updated')]);
            if(dC && dU && dU>=dC) {
                const diff = dU-dC;
                lifespans.push(diff);
                if(dC.getDate()===dU.getDate() && dC.getMonth()===dU.getMonth()) sameDay++;
                if(!catTimes[cat]) catTimes[cat]=[];
                catTimes[cat].push(diff);
            }
        }
        else if(grp==='Cancelled') nCanc++;
    });

    // KPIs
    const nTotal = nOpen + nClosed + nCanc;
    const getPct = (n) => nTotal > 0 ? ((n/nTotal)*100).toFixed(1) + '%' : '0%';
    document.getElementById('kpi-total').innerText = nTotal;
    document.getElementById('kpi-open').innerText = nOpen;
    document.getElementById('pct-open').innerText = getPct(nOpen);
    document.getElementById('kpi-closed').innerText = nClosed;
    document.getElementById('pct-closed').innerText = getPct(nClosed);
    document.getElementById('kpi-cancelled').innerText = nCanc;
    document.getElementById('pct-cancelled').innerText = getPct(nCanc);

    // Life Stats
    const nL = lifespans.length;
    if(nL>0) {
        const avg = lifespans.reduce((a,b)=>a+b,0)/nL;
        document.getElementById('stat-avg').innerText = (avg/86400000).toFixed(1)+'d';
        document.getElementById('stat-sameday').innerText = ((sameDay/nL)*100).toFixed(0)+'%';
        document.getElementById('stat-3days').innerText = ((lifespans.filter(l=>l<=259200000).length/nL)*100).toFixed(0)+'%';
        document.getElementById('stat-7days').innerText = ((lifespans.filter(l=>l<=604800000).length/nL)*100).toFixed(0)+'%';
        document.getElementById('stat-over7').innerText = ((lifespans.filter(l=>l>604800000).length/nL)*100).toFixed(0)+'%';
    }

    // Plot Charts
    function plotBar(id, data, color) {
        const keys = Object.keys(data).sort((a,b)=> data[b] - data[a]); 
        const values = keys.map(k=>data[k]);
        const trace1 = { y: keys.map(k => `<b>${k}</b>`), x: values, text: values, textposition: 'auto', type: 'bar', orientation: 'h', marker:{color: color} };
        Plotly.newPlot(id, [trace1], {
            margin:{t:5,b:20,l:100,r:10}, 
            yaxis:{automargin:true, autorange:'reversed', ticksuffix: " "},
            font: { size: 16 }
        }, {responsive:true, displayModeBar:false});
    }
    plotBar('chart-category', cats, '#0dcaf0');
    plotBar('chart-subcategory', subs, '#ffc107');

    // Top Sites
    function listSites(id, obj, colorClass) {
        const el = document.getElementById(id);
        const arr = Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,4);
        el.innerHTML = arr.map((x, i) => `<div class="site-list-item"><span>${i+1}. ${x[0]}</span><span class="badge ${colorClass} text-white">${x[1]}</span></div>`).join('');
        if(arr.length===0) el.innerHTML = '<div class="text-muted small fst-italic">No data</div>';
    }
    listSites('top-sites-overall', sitesVol, 'bg-primary');
    listSites('top-sites-open', sitesOpen, 'bg-danger');
    listSites('top-markets-open', marketsOpen, 'bg-total');
    listSites('top-markets-overall', marketsVol, 'bg-primary');

    // Performance Charts
    const perf = Object.entries(catTimes).map(([k,v]) => ({
        cat: k, avg: (v.reduce((a,b)=>a+b,0)/v.length)/86400000
    })).sort((a,b)=>b.avg-a.avg);
    
    function plotPerf(id, data, color) {
        const yVals = data.map(d=>d.avg);
        Plotly.newPlot(id, [{
            x: data.map(d=>d.cat), y: yVals, text: yVals.map(v=>v.toFixed(1)), textposition: 'auto', type: 'bar', marker:{color: color}
        }], {
            margin:{t:10,b:80,l:30,r:10}, 
            yaxis:{title:''}, xaxis:{tickangle: -25},
            font: { size: 16 }
        }, {responsive:true, displayModeBar:false});
    }
    plotPerf('chart-slowest', perf.slice(0,5), '#ffc107'); 
    plotPerf('chart-fastest', perf.reverse().slice(0,5), '#198754'); 
}

// --- Init ---
function init() {
    Papa.parse(CSV_MARKETS_FILENAME, {
        download: true, header: true, skipEmptyLines: true,
        complete: (res) => {
            if(res.data) {
                const keys = Object.keys(res.data[0] || {});
                const kSite = keys.find(k => /site|store|location/i.test(k));
                const kMkt = keys.find(k => /market|dm|area/i.test(k));
                if(kSite && kMkt) {
                    res.data.forEach(r => {
                        if(r[kSite] && r[kMkt]) {
                            const sNum = extractSiteNumber(r[kSite]);
                            if(sNum) siteToMarketMap[sNum] = r[kMkt].trim();
                        }
                    });
                }
            }
            loadMainData();
        },
        error: () => loadMainData()
    });
}

function loadMainData() {
    Papa.parse(CSV_FILENAME, {
        download: true, header: true, skipEmptyLines: true,
        complete: (res) => updateDashboard(res.data),
        error: () => document.getElementById('manual-input-container').style.display='block'
    });
}

init();

document.getElementById('csv-file-input').addEventListener('change', (e) => {
    if(e.target.files[0]) Papa.parse(e.target.files[0], {header:true, skipEmptyLines:true, complete:(r)=>updateDashboard(r.data)});
});