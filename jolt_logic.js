// --- SECURE CONFIGURATION ---
const ENDPOINT = "https://jolt-proxy.ckuran.workers.dev";
const HEADERS = { "Content-Type": "application/json" };

// Global State
let currentListsCache = []; 
let locationsCache = [];
let gridDataCache = [];
let reportDataCache = []; 

// --- 1. HELPER FUNCTIONS ---

const logBox = document.getElementById('system-log');
function log(msg, type='info') {
    if(!logBox) return;
    const d = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.innerHTML = `[${d}] ${msg}`;
    if(type==='error') div.className = 'log-err';
    logBox.prepend(div);
    console.log(`[${type}] ${msg}`);
}

function calculateDuration(items) {
    if (!items || !Array.isArray(items)) return { text: null, seconds: null };
    let timestamps = [];
    const collectTimestamps = (itemList) => {
        itemList.forEach(i => {
            if (i.completionTimestamp > 0) timestamps.push(i.completionTimestamp);
            if (i.subList && i.subList.itemResults) collectTimestamps(i.subList.itemResults);
        });
    };
    collectTimestamps(items);

    if (timestamps.length >= 2) {
        timestamps.sort((a, b) => a - b);
        const start = timestamps[0];
        const end = timestamps[timestamps.length - 1];
        const diffSeconds = end - start;
        const hours = Math.floor(diffSeconds / 3600);
        const minutes = Math.floor((diffSeconds % 3600) / 60);
        return { text: `${hours}h ${minutes}m`, seconds: diffSeconds };
    } else if (timestamps.length === 1) {
            return { text: "< 1m", seconds: 0 };
    }
    return { text: null, seconds: null };
}

function checkExpirationStatus(items) {
    let status = { expired: false, expiring: false, warning: false };
    if (!items || !Array.isArray(items)) return status;
    const today = new Date();
    today.setHours(0,0,0,0);
    
    const sevenDays = new Date();
    sevenDays.setDate(today.getDate() + 7);
    sevenDays.setHours(0,0,0,0);

    const scan = (list) => {
        list.forEach(i => {
            const prompt = (i.itemTemplate && i.itemTemplate.text) ? i.itemTemplate.text : "";
            const isExpItem = prompt.includes("Sanitizer") && prompt.includes("Exp. Date");

            if (isExpItem && i.resultDouble) {
                const expDate = new Date(i.resultDouble * 1000);
                expDate.setHours(0,0,0,0); 

                if (expDate < today) status.expired = true;
                else if (expDate.getTime() === today.getTime()) status.expiring = true;
                else if (expDate <= sevenDays) status.warning = true;
            }
            if (i.subList && i.subList.itemResults) scan(i.subList.itemResults);
        });
    };
    scan(items);
    return status;
}

function extractReportStats(items) {
    let stats = {
        coldMin: null, coldMax: null, coldCount: 0,
        hotMin: null, hotMax: null, hotCount: 0,
        naCount: 0
    };
    
    if(!items) return stats;

    const flatten = (list) => {
        list.forEach(i => {
            if (i.isMarkedNA) stats.naCount++;
            
            if (i.resultDouble) {
                const val = i.resultDouble;
                if (val < 50) {
                    if (stats.coldMin === null || val < stats.coldMin) stats.coldMin = val;
                    if (stats.coldMax === null || val > stats.coldMax) stats.coldMax = val;
                    stats.coldCount++;
                } else if (val > 130) {
                    if (stats.hotMin === null || val < stats.hotMin) stats.hotMin = val;
                    if (stats.hotMax === null || val > stats.hotMax) stats.hotMax = val;
                    stats.hotCount++;
                }
            }
            if (i.subList && i.subList.itemResults) flatten(i.subList.itemResults);
        });
    };
    flatten(items);
    return stats;
}

function calculateIntegrity(items, listName = "", durationSeconds = null) {
    if (!items || !Array.isArray(items)) return { score: null, issues: [] };
    
    const lowerName = listName ? listName.toLowerCase() : "";
    if (lowerName.includes("equipment temperature") || lowerName.includes("fsa - critical") || lowerName.includes("critical daily focus")) {
        return { score: null, issues: [] };
    }

    const isDaypart1 = lowerName.includes("daypart 1");
    const isRelaxedList = isDaypart1 || lowerName.includes("breakfast");

    let score = 100;
    let issues = [];
    let completedItems = [];
    let tempValues = [];
    let naCount = 0;
    let totalCount = 0;
    let integerTempCount = 0;

    const flattenItems = (list) => {
        list.forEach(i => {
            const typeUpper = (i.type || "").toUpperCase();
            const templateTypeUpper = ((i.itemTemplate && i.itemTemplate.type) || "").toUpperCase();
            
            if (typeUpper !== 'TEXT' && templateTypeUpper !== 'TEXT') {
                totalCount++;
                if (i.isMarkedNA) naCount++;
                
                if (i.completionTimestamp > 0) {
                    const prompt = (i.itemTemplate && i.itemTemplate.text) ? i.itemTemplate.text.toLowerCase() : "";
                    const isEquipmentTemp = prompt.includes('equipment') || prompt.includes('cooler') || prompt.includes('freezer') || prompt.includes('walk-in') || prompt.includes('reach-in') || prompt.includes('refrigerator') || prompt.includes('fryer') || prompt.includes('warmer');

                    if (!isEquipmentTemp) completedItems.push(i);
                    
                    const hasTempKey = prompt.includes('temp') || prompt.includes('°') || prompt.includes('℉') || prompt.includes('℃') || prompt.includes(' f ') || prompt.includes(' c ');
                    
                    if (!isEquipmentTemp && i.resultDouble !== null && i.resultDouble !== undefined && (hasTempKey || i.resultDouble > 0)) {
                        tempValues.push({ 
                            val: i.resultDouble, 
                            time: i.completionTimestamp
                        });
                        const isCount = prompt.includes('count') || prompt.includes('number') || prompt.includes('amount') || prompt.includes('quantity');
                        if (!isCount && i.resultDouble % 1 === 0) integerTempCount++;
                    }
                }
                if (i.subList && i.subList.itemResults) flattenItems(i.subList.itemResults);
            }
        });
    };
    flattenItems(items);

    const checkSublists = (currentItems) => {
        currentItems.forEach(item => {
            if (item.subList && item.subList.itemResults) {
                const parentText = (item.itemTemplate && item.itemTemplate.text) ? item.itemTemplate.text : "";
                const subName = item.subList.instanceTitle || parentText || "";
                const subItems = item.subList.itemResults;
                
                let subTimestamps = [];
                const getTimes = (nodes) => {
                    nodes.forEach(n => {
                        if(n.completionTimestamp > 0) subTimestamps.push(n.completionTimestamp);
                        if(n.subList && n.subList.itemResults) getTimes(n.subList.itemResults);
                    });
                };
                getTimes(subItems);
                
                if (subTimestamps.length >= 2) {
                    subTimestamps.sort((a,b) => a-b);
                    const subDur = subTimestamps[subTimestamps.length-1] - subTimestamps[0];
                    
                    const lower = subName.toLowerCase();
                    const lowerParent = parentText.toLowerCase();
                    
                    // UPDATED: Frosty threshold set to 15s
                    const frostyCheck = (lower.includes('frosty') || lowerParent.includes('frosty')) && subDur < 15;
                    // Other critical items threshold
                    const isCritical = lower.includes('beef') || lower.includes('chili') || lower.includes('chicken');
                    const otherCriticalCheck = isCritical && subDur < 25;

                    if (frostyCheck || otherCriticalCheck) {
                        score -= 40; 
                        issues.push(`Sublist '${subName}' too fast (${subDur}s)`);
                    }
                }
                
                const subScoreData = calculateIntegrity(subItems, subName);
                if (subScoreData.score !== null && subScoreData.score < 60) {
                    score -= 40;
                    issues.push(`Sublist '${subName}' Failed Integrity`);
                }
                
                checkSublists(subItems);
            }
        });
    };
    checkSublists(items);

    const timeThreshold = isDaypart1 ? 180 : 300;
    const timeLabel = isDaypart1 ? "3 mins" : "5 mins";

    if (durationSeconds !== null && durationSeconds < timeThreshold && completedItems.length > 10) {
            score -= 20;
            issues.push(`Full List < ${timeLabel}`);
    }

    if (completedItems.length < 2 && score === 100) return { score: Math.max(0, score), issues };

    if (completedItems.length > 1) {
        completedItems.sort((a, b) => a.completionTimestamp - b.completionTimestamp);
        let rapidCount = 0;
        const intervals = Math.max(1, completedItems.length - 1); 
        for (let i = 1; i < completedItems.length; i++) {
            if ((completedItems[i].completionTimestamp - completedItems[i-1].completionTimestamp) < 2) rapidCount++; 
        }
        const rapidPercent = (rapidCount / intervals) * 100;
        if (rapidPercent > 75) { score -= 30; issues.push("Speed Detection (Too Fast)"); } 
        else if (rapidPercent > 45) { score -= 10; issues.push("Potential Rapid Entry"); }
    }

    if (tempValues.length >= 2) {
        if ((integerTempCount / tempValues.length) > 0.6) {
            score -= 30;
            issues.push("Manual Entry Suspected (No Decimals)");
        }
        
        const values = tempValues.map(t => t.val);
        const uniqueValues = new Set(values);
        const duplicateRate = 1 - (uniqueValues.size / values.length);
        const dupThreshold = isRelaxedList ? 0.65 : 0.3; 

        if (duplicateRate > dupThreshold) { score -= 40; issues.push(`High Duplicate Temps (${Math.round(duplicateRate*100)}%)`); }
        if (values.length > 1 && uniqueValues.size === 1) { score -= 60; issues.push("Identical Temperatures"); }

        tempValues.sort((a, b) => a.time - b.time);
        let suspiciousPairs = 0;
        let totalPairs = Math.max(1, tempValues.length - 1);
        
        for(let i=1; i<tempValues.length; i++) {
            const timeDiff = tempValues[i].time - tempValues[i-1].time;
            const valDiff = Math.abs(tempValues[i].val - tempValues[i-1].val);
            const valThreshold = isRelaxedList ? 0.1 : 0.5;
            if (timeDiff < 45 && valDiff < valThreshold) suspiciousPairs++;
        }
        
        const suspiciousRate = suspiciousPairs / totalPairs;
        if (suspiciousRate > 0.5) { score -= 50; issues.push("Rapid Similar/Same Temps"); }
        else if (suspiciousPairs > 0 && tempValues.length < 5) { score -= 30; issues.push("Rapid Similar/Same Temps"); }
    }

    if (totalCount > 0) {
        const naPercent = (naCount / totalCount) * 100;
        if (naPercent > 50) { score -= 50; issues.push(`Excessive N/A`); } 
        else if (naPercent > 30) { score -= 25; issues.push("High N/A Usage"); } 
    }

    return { score: Math.max(0, score), issues };
}

// --- 2. CONFIGURATION & CORE LOGIC ---
let config = {
    proxyUrl: ENDPOINT,
};

window.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;
    
    document.getElementById('startDate').value = todayStr;
    document.getElementById('endDate').value = todayStr;
    document.getElementById('gridDate').value = todayStr;
    document.getElementById('reportDate').value = todayStr;
    
    loadConfigUI();
    fetchLocations();
});

// --- Tab Switching ---
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.view-content').forEach(view => view.classList.remove('active'));
    
    document.querySelector(`.tab-btn[onclick="switchTab('${tabName}')"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
}

// 1. Fetch Locations
async function fetchLocations() {
    const select = document.getElementById('locationSelect');
    const reportSelect = document.getElementById('reportLocationSelect');
    
    try {
        const query = `query GetLocations { company { locations { id name } } }`;
        const data = await joltFetch(query);
        let locations = data.data?.company?.locations || [];
        
        locations.sort((a, b) => a.name.localeCompare(b.name));
        locationsCache = locations; 
        
        [select, reportSelect].forEach(sel => {
            sel.innerHTML = '';
            if (locations.length === 0) { sel.innerHTML = '<option>No Locations Found</option>'; return; }
            locations.forEach(loc => {
                const opt = document.createElement('option');
                opt.value = loc.id; opt.textContent = loc.name; sel.appendChild(opt);
            });
        });
    } catch (err) { handleError(err, "fetching locations"); }
}

// 2. Fetch Checklists (Inspector)
async function fetchChecklists() {
    const locationId = document.getElementById('locationSelect').value;
    const startDateStr = document.getElementById('startDate').value;
    const endDateStr = document.getElementById('endDate').value;
    const sidebar = document.getElementById('listSidebar');

    if(!locationId || !startDateStr || !endDateStr) { alert("Please select location and dates."); return; }

    sidebar.innerHTML = '<div style="padding:20px;">Loading checklists...</div>';
    
    const startTimestamp = Math.floor(new Date(startDateStr + 'T00:00:00').getTime() / 1000);
    const endTimestamp = Math.floor(new Date(endDateStr + 'T23:59:59').getTime() / 1000);

    const lists = await fetchListsForLocation(locationId, startTimestamp, endTimestamp);
    
    // Sorting
    lists.sort((a, b) => {
        const nameA = (a.listTemplate && a.listTemplate.title) ? a.listTemplate.title : (a.instanceTitle || "");
        const nameB = (b.listTemplate && b.listTemplate.title) ? b.listTemplate.title : (b.instanceTitle || "");
        const isSafetyA = /FSL|DFSL|🟧|Food Safety/i.test(nameA);
        const isSafetyB = /FSL|DFSL|🟧|Food Safety/i.test(nameB);
        if (isSafetyA && !isSafetyB) return -1;
        if (!isSafetyA && isSafetyB) return 1;
        return (b.displayTimestamp || 0) - (a.displayTimestamp || 0);
    });

    currentListsCache = lists; 
    sidebar.innerHTML = '';
    if (lists.length === 0) { sidebar.innerHTML = '<div style="padding:20px;">No lists found.</div>'; return; }

    const now = Math.floor(Date.now() / 1000);

    lists.forEach(list => {
        const item = document.createElement('div');
        item.className = 'list-item';
        
        let statusBadge = '';
        let incomplete = list.incompleteCount || 0;
        if (incomplete === 0) statusBadge = '<span class="list-status ls-complete">Complete</span>';
        else if (list.deadlineTimestamp > 0 && list.deadlineTimestamp < now) statusBadge = '<span class="list-status ls-late">Late</span>';
        else if (list.displayTimestamp > now) statusBadge = '<span class="list-status ls-upcoming">Upcoming</span>';
        else statusBadge = '<span class="list-status ls-progress">In Progress</span>';

        const listName = (list.listTemplate && list.listTemplate.title) ? list.listTemplate.title : (list.instanceTitle || "Untitled List");
        const listDate = list.displayTimestamp ? new Date(list.displayTimestamp * 1000) : null;
        const dateStr = listDate ? `${listDate.toLocaleDateString()} ${listDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}` : "";

        let durationTxt = "N/A";
        let integrityBadge = "";
        let scoreVal = "N/A";
        let expiryIndicator = "";

        if (list.itemResults) {
            const dur = calculateDuration(list.itemResults);
            if (dur.text) durationTxt = dur.text;

            const targetLists = ['🟧', 'DFSL', 'FSL', 'Food Safety'];
            const isTargetList = targetLists.some(tag => listName.includes(tag));
            
            if (isTargetList && incomplete === 0) {
                const scoreData = calculateIntegrity(list.itemResults, listName, dur.seconds);
                scoreVal = scoreData.score + "%";
                let badgeClass = 'integrity-high';
                if (scoreData.score === null) { badgeClass = 'integrity-na'; scoreVal = "N/A"; }
                else if (scoreData.score < 60) badgeClass = 'integrity-low';
                else if (scoreData.score < 85) badgeClass = 'integrity-med';
                integrityBadge = `<span class="integrity-badge ${badgeClass}">${scoreVal}</span>`;
            }

            const expStatus = checkExpirationStatus(list.itemResults);
            if (expStatus.expired) expiryIndicator = "🔴";
            else if (expStatus.expiring) expiryIndicator = "🟡";
            else if (expStatus.warning) expiryIndicator = "🟠";
        }
        
        list._computed = {
            status: statusBadge.replace(/<[^>]*>?/gm, ''),
            duration: durationTxt,
            integrity: scoreVal,
            locationName: document.getElementById('locationSelect').options[document.getElementById('locationSelect').selectedIndex].text
        };

        item.innerHTML = `
            <span class="list-title">${listName} ${expiryIndicator}</span>
            <div class="list-meta">
                <span>${dateStr}</span>
                ${statusBadge}
            </div>
            <div class="list-stats">
                <span>⏱️ ${durationTxt}</span>
                ${integrityBadge ? `<span>🛡️ ${integrityBadge}</span>` : ''}
            </div>
        `;
        item.onclick = () => {
            document.querySelectorAll('.list-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            renderListDetails(list); 
        };
        sidebar.appendChild(item);
    });
}

// --- GRID VIEW LOGIC ---

async function loadStoreGrid() {
    const dateStr = document.getElementById('gridDate').value;
    if (!dateStr) { alert("Please select date."); return; }

    const overlay = document.getElementById('loadingOverlay');
    const loadText = document.getElementById('loadingText');
    const loadSub = document.getElementById('loadingSubtext');
    
    overlay.style.display = 'flex';
    gridDataCache = []; 
    // NEW: Cache report data for PDF generation
    reportDataCache = [];

    const startTs = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000);
    const endTs = Math.floor(new Date(dateStr + 'T23:59:59').getTime() / 1000);
    const now = Math.floor(Date.now() / 1000);

    const tbody = document.querySelector('#storeTable tbody');
    tbody.innerHTML = '';

    for (let i = 0; i < locationsCache.length; i++) {
        const loc = locationsCache[i];
        loadText.innerText = `Processing Store ${i + 1} of ${locationsCache.length}`;
        loadSub.innerText = loc.name;

        try {
            // Fetch lists for this location
            const lists = await fetchListsForLocation(loc.id, startTs, endTs);
            
            // --- Process Lists ---
            let rowData = {
                name: loc.name,
                id: loc.id,
                dp1: { status: 'Missing', score: null },
                dp3: { status: 'Missing', score: null },
                dp5: { status: 'Missing', score: null },
                sanitizer: 'OK'
            };
            
            // For PDF Report Data Accumulation
            let locReport = {
                name: loc.name,
                id: loc.id,
                lists: []
            };
            
            let hasExpired = false;
            let hasExpiring = false;
            let hasWarning = false;

            lists.forEach(list => {
                const title = (list.listTemplate && list.listTemplate.title) ? list.listTemplate.title : (list.instanceTitle || "Untitled");
                const titleLower = title.toLowerCase();

                // Check Sanitizer
                if (list.itemResults) {
                    const expStatus = checkExpirationStatus(list.itemResults);
                    if (expStatus.expired) hasExpired = true;
                    if (expStatus.expiring) hasExpiring = true;
                    if (expStatus.warning) hasWarning = true;
                }

                // Filter for DFSL/FSL
                if (titleLower.includes('dfsl') || titleLower.includes('fsl')) {
                    let bucket = null;
                    if (titleLower.includes('daypart 1')) bucket = 'dp1';
                    else if (titleLower.includes('daypart 3')) bucket = 'dp3';
                    else if (titleLower.includes('daypart 5')) bucket = 'dp5';

                    // Save relevant list data for report
                    if (bucket) {
                        locReport.lists.push({
                            type: bucket,
                            title: title,
                            itemResults: list.itemResults
                        });

                        let statusText = "In Progress";
                        if (list.incompleteCount === 0) statusText = "Complete";
                        else if (list.deadlineTimestamp > 0 && list.deadlineTimestamp < now) statusText = "Late";
                        
                        let integrityVal = "";
                        if (list.incompleteCount === 0 && list.itemResults) {
                            const dur = calculateDuration(list.itemResults);
                            const scoreData = calculateIntegrity(list.itemResults, title, dur.seconds);
                            if (scoreData.score !== null) integrityVal = scoreData.score + "%";
                        }
                        rowData[bucket].status = statusText;
                        rowData[bucket].score = integrityVal;
                    }
                }
            });

            if (hasExpired) rowData.sanitizer = "EXPIRED";
            else if (hasExpiring) rowData.sanitizer = "Expiring";
            else if (hasWarning) rowData.sanitizer = "Warning";

            gridDataCache.push(rowData);
            // Push compiled report data
            if(locReport.lists.length > 0) reportDataCache.push(locReport);
            
            renderGridRow(tbody, rowData);

            // Tiny delay to breathe
            await new Promise(r => setTimeout(r, 50)); 

        } catch(e) {
            console.error("Grid Error " + loc.name, e);
        }
    }
    
    overlay.style.display = 'none';
}

// --- REPORT GENERATOR ---
async function generateSingleReport() {
    const locId = document.getElementById('reportLocationSelect').value;
    const dateStr = document.getElementById('reportDate').value;
    if(!locId || !dateStr) { alert("Select location and date."); return; }
    
    // Format date to MM-DD-YYYY
    const [yyyy, mm, dd] = dateStr.split('-');
    const dateFormatted = `${mm}-${dd}-${yyyy}`;
    
    const locName = document.getElementById('reportLocationSelect').options[document.getElementById('reportLocationSelect').selectedIndex].text;
    
    const startTs = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000);
    const endTs = Math.floor(new Date(dateStr + 'T23:59:59').getTime() / 1000);
    
    const overlay = document.getElementById('loadingOverlay');
    const loadText = document.getElementById('loadingText');
    overlay.style.display = 'flex';
    loadText.innerText = "Generating Report...";
    
    try {
        const lists = await fetchListsForLocation(locId, startTs, endTs);
        
        // Extract buckets
        let buckets = { dp1: null, dp3: null, dp5: null };
        let equipmentItems = []; 
        
        // Helper to collect all Equipment items from ANY list present
        const collectEquipment = (list) => {
                const scan = (items) => {
                    items.forEach(i => {
                    const prompt = (i.itemTemplate && i.itemTemplate.text) ? i.itemTemplate.text : "";
                    const promptLower = prompt.toLowerCase();
                    // Broad Equipment Match
                    const isEq = promptLower.includes('equipment') || promptLower.includes('cooler') || promptLower.includes('freezer') || promptLower.includes('walk-in') || promptLower.includes('reach-in') || promptLower.includes('refrigerator') || promptLower.includes('fryer') || promptLower.includes('grill') || promptLower.includes('warmer') || promptLower.includes('well');
                    
                    if(isEq && i.resultDouble !== null) {
                            equipmentItems.push({
                                label: i.itemTemplate.text,
                                val: i.resultValue || i.resultDouble || (i.isMarkedNA ? "N/A" : "-")
                            });
                    }
                    if(i.subList && i.subList.itemResults) scan(i.subList.itemResults);
                    });
                };
                if(list && list.itemResults) scan(list.itemResults);
        };

        lists.forEach(list => {
                const title = (list.listTemplate && list.listTemplate.title) ? list.listTemplate.title : "";
                const tLower = title.toLowerCase();
                
                // Filter for main FSL lists
                if(tLower.includes('dfsl') || tLower.includes('fsl')) {
                    if(tLower.includes('daypart 1')) buckets.dp1 = list;
                    else if(tLower.includes('daypart 3')) buckets.dp3 = list;
                    else if(tLower.includes('daypart 5')) buckets.dp5 = list;
                }
                
                // Collect Equipment from EVERYTHING (including ZEquipment, Building Checks etc)
                collectEquipment(list);
        });
        
        // Deduplicate Equipment Items (Keep latest if duplicates exist)
        const uniqueEquip = [];
        const seenEquip = new Set();
        equipmentItems.reverse().forEach(e => {
                if(!seenEquip.has(e.label)) {
                    uniqueEquip.push(e);
                    seenEquip.add(e.label);
                }
        });
        uniqueEquip.reverse();
        
        // Build HTML
        let html = `
            <div class="report-header">
                <div class="report-title">Food Safety Log Report</div>
                <div class="report-meta">
                    <div>Date: ${dateFormatted}</div>
                    <div>Location: ${locName}</div>
                </div>
            </div>
            
            <table class="report-table">
                <thead>
                    <tr>
                        <th style="text-align:left; width: 40%;">Item</th>
                        <th>Daypart 1</th>
                        <th>Daypart 3</th>
                        <th>Daypart 5</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        // --- Helper to extract specific item values ---
        const getVal = (list, keyword, isBoolean = false) => {
            if(!list || !list.itemResults) return "";
            let found = null;
            const search = (items) => {
                for(let i of items) {
                    const prompt = (i.itemTemplate && i.itemTemplate.text) ? i.itemTemplate.text : "";
                    if(prompt.toLowerCase().includes(keyword.toLowerCase())) {
                            found = i; return;
                    }
                    if(i.subList && i.subList.itemResults) search(i.subList.itemResults);
                    if(found) return;
                }
            };
            search(list.itemResults);
            
            if(found) {
                if(found.isMarkedNA) return "N/A";
                
                if (isBoolean) {
                    return (found.resultValue == "1" || found.resultValue === "true" || found.resultValue === "Yes") ? "YES" : "NO";
                }
                
                if (keyword.includes("Exp") && found.resultDouble > 946684800) {
                        const d = new Date(found.resultDouble * 1000);
                        return `${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}-${d.getFullYear()}`;
                }

                if(found.resultDouble) return found.resultDouble;
                return found.resultValue || found.resultText || "-";
            }
            return "";
        };
        
        // Define Rows for Report (Expanded) - Matches Template 2 Sections
        // Hardcoded Order based on Template 2
        const rows = [
            { header: "COOLERS" },
            { label: "Meat Well", key: "Meat Well" },
            { label: "Salad Cooler", key: "Salad" },
            { label: "Sandwich Cooler", key: "Sandwich cooler" },
            { label: "Walk-in Cooler", key: "Walk-in Cooler" },
            { header: "FREEZERS" },
            { label: "Walk-in Freezer", key: "Walk-in Freezer" },
            { header: "COLD HELD PRODUCTS" },
            { label: "Frosty Mix", key: "Frosty Mix" },
            { label: "Sliced Tomatoes", key: "Tomatoes" },
            { label: "Lettuce", key: "Lettuce" },
            { label: "Cheddar Cheese", key: "Cheddar" },
            { label: "Meat Patty (Raw)", key: "Panned Small" },
            { header: "HOT HELD PRODUCTS" },
            { label: "Chicken Filet", key: "Chicken Filet" },
            { label: "Sausage", key: "Sausage" },
            { label: "Eggs", key: "Eggs" },
            { label: "Cheese Sauce", key: "Cheese Sauce" },
            { label: "Nuggets", key: "Nuggets" },
            { label: "Spicy Chicken", key: "Spicy" },
            { label: "Classic Chicken", key: "Classic" },
            { label: "Chili Meat", key: "Chili Meat" },
            { label: "Cooked Patty", key: "Cooked Meat" },
            { header: "DAILY CRITICAL FOCUS" },
            { label: "Handwashing", key: "Handwashing", isBool: true },
            { label: "Sanitizer Strength", key: "Sanitizer Strength", isBool: true },
            { label: "Sanitizer Exp", key: "Exp. Date" }, 
            { label: "Probe Calibration", key: "Probe Calibration" }
        ];
        
        rows.forEach(r => {
            if(r.header) {
                html += `<tr><td colspan="4" class="report-section-header">${r.header}</td></tr>`;
            } else {
                html += `
                    <tr>
                        <td style="text-align:left;">${r.label}</td>
                        <td>${getVal(buckets.dp1, r.key, r.isBool)}</td>
                        <td>${getVal(buckets.dp3, r.key, r.isBool)}</td>
                        <td>${getVal(buckets.dp5, r.key, r.isBool)}</td>
                    </tr>
                `;
            }
        });
        
        html += `</tbody></table>`;
        
        // DYNAMIC EQUIPMENT SECTION (All other equipment found)
        // We filter out items already shown in the main table to avoid duplicates?
        // Actually, request said "This will display every equipment that site has".
        // So we list uniqueEquip below.
        
        if(uniqueEquip.length > 0) {
                html += `
                <div style="font-weight:bold; margin-bottom:5px; margin-top:20px; font-size:14px; background:#e0e0e0; padding:5px;">EQUIPMENT TEMPERATURES (All Day)</div>
                <table class="report-table" style="width:100%;">
                    <thead>
                        <tr><th style="text-align:left;">Equipment Name</th><th>Value</th></tr>
                    </thead>
                    <tbody>
                `;
                uniqueEquip.forEach(eq => {
                    html += `<tr><td style="text-align:left;">${eq.label}</td><td>${eq.val}</td></tr>`;
                });
                html += `</tbody></table>`;
        }
        
        document.getElementById('reportContent').innerHTML = html;
        
    } catch(e) {
        console.error(e);
        alert("Error generating report.");
    }
    overlay.style.display = 'none';
}

function renderGridRow(tbody, data) {
    const tr = document.createElement('tr');
    const renderCell = (cellData) => {
        let statusClass = "ls-missing";
        if (cellData.status === "Complete") statusClass = "ls-complete";
        else if (cellData.status === "Late") statusClass = "ls-late";
        else if (cellData.status === "In Progress") statusClass = "ls-progress";
        
        let html = `<div class="grid-cell-content"><span class="list-status ${statusClass}">${cellData.status}</span>`;
        if (cellData.score) {
                let color = "green";
                const num = parseInt(cellData.score);
                if (num < 60) color = "red"; else if (num < 85) color = "#b8860b";
                html += `<span class="grid-score" style="color:${color}">🛡️ ${cellData.score}</span>`;
        }
        html += `</div>`;
        return html;
    };
    let sanHtml = `<span style="color:green; font-weight:bold;">OK</span>`;
    if (data.sanitizer === "EXPIRED") sanHtml = `<span style="color:white; background:red; padding:3px 6px; border-radius:4px; font-weight:bold;">EXPIRED 🔴</span>`;
    else if (data.sanitizer === "Expiring") sanHtml = `<span style="color:black; background:gold; padding:3px 6px; border-radius:4px; font-weight:bold;">Expiring 🟡</span>`;
    else if (data.sanitizer === "Warning") sanHtml = `<span style="color:white; background:orange; padding:3px 6px; border-radius:4px; font-weight:bold;">Next 7 Days 🟠</span>`;

    tr.innerHTML = `<td><strong>${data.name}</strong></td><td>${renderCell(data.dp1)}</td><td>${renderCell(data.dp3)}</td><td>${renderCell(data.dp5)}</td><td>${sanHtml}</td>`;
    tbody.appendChild(tr);
}

function exportGridToCSV() {
    if (!gridDataCache || gridDataCache.length === 0) { alert("No grid data to export."); return; }
    let csv = "Store Name,DP1 Status,DP1 Integrity,DP3 Status,DP3 Integrity,DP5 Status,DP5 Integrity,Sanitizer Issues\n";
    gridDataCache.forEach(d => {
        csv += `"${d.name}","${d.dp1.status}","${d.dp1.score||''}","${d.dp3.status}","${d.dp3.score||''}","${d.dp5.status}","${d.dp5.score||''}","${d.sanitizer}"\n`;
    });
    downloadCSV(csv, "jolt_store_grid_overview.csv");
}

// --- Core Fetch Function ---
async function fetchListsForLocation(locationId, start, end) {
    const ITEM_FIELDS = `
        id type __typename resultValue resultText resultDouble isMarkedNA completionTimestamp
        resultAssets { id name }
        resultCompanyFiles { fileURI }
        peripheral { type }
        itemTemplate { text type isScoringItemType isRequired }
        notes { body }
    `;
    const query = `
        query GetChecklists($filter: ListInstancesFilter!) {
            listInstances(filter: $filter) {
                id displayTimestamp deadlineTimestamp incompleteCount isActive instanceTitle
                listTemplate { title }
                itemResults {
                    ${ITEM_FIELDS}
                    subList {
                        id instanceTitle
                        itemResults {
                            ${ITEM_FIELDS}
                            subList {
                                id instanceTitle
                                itemResults {
                                    ${ITEM_FIELDS}
                                    subList {
                                        id instanceTitle
                                        itemResults { ${ITEM_FIELDS} }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `;
    const variables = { 
        filter: { locationIds: [locationId], displayAfterTimestamp: start, displayBeforeTimestamp: end, isSublist: false }
    };
    try {
        const data = await joltFetch(query, variables);
        return data.data?.listInstances || [];
    } catch(e) { console.error(e); return []; }
}

// --- Core UI & Render ---
// (Render logic maintained from previous step, ensuring variables are defined)
async function renderListDetails(listData) {
    // ... (standard render logic reusing helper functions defined at top) ...
    const container = document.getElementById('detailView');
    const listName = (listData.listTemplate && listData.listTemplate.title) ? listData.listTemplate.title : (listData.instanceTitle || "Checklist");
    container.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center;"><h3>${listName}</h3><button class="btn-secondary" style="padding:5px 10px; font-size:0.8rem;" onclick='exportListDetails(${JSON.stringify(listData.id)})'>Export List Details</button></div>`;
    window.currentDetailList = listData;
    const items = listData.itemResults || [];
    if (items.length === 0) { container.innerHTML += `<p>No items found.</p>`; return; }
    const durationInfo = calculateDuration(items);
    let durationHtml = "";
    if (durationInfo.text) durationHtml = `<div><strong>⏱️ Total Time:</strong> ${durationInfo.text}</div>`;
    let integrityHtml = "";
    const targetLists = ['🟧', 'DFSL', 'FSL', 'Food Safety'];
    const isTargetList = targetLists.some(tag => listName.includes(tag));
    if (isTargetList && listData.incompleteCount === 0) {
        const scoreData = calculateIntegrity(items, listName, durationInfo.seconds);
        let badgeClass = 'integrity-high';
        let scoreDisplay = scoreData.score + "%";
        if (scoreData.score === null) { badgeClass = 'integrity-na'; scoreDisplay = "N/A"; }
        else if (scoreData.score < 60) badgeClass = 'integrity-low';
        else if (scoreData.score < 85) badgeClass = 'integrity-med';
        integrityHtml = `<div class="integrity-score ${badgeClass}">🛡️ Integrity Score: ${scoreDisplay} <span style="font-weight:normal; font-size:0.8rem; margin-left:10px;">(${scoreData.issues.join(', ') || 'Looks Good'})</span></div>`;
    }
    if (durationHtml || integrityHtml) container.innerHTML += `<div class="checklist-meta">${durationHtml} ${integrityHtml}</div>`;
    const listContainer = document.createElement('div');
    items.forEach(item => { const el = createItemElement(item, isTargetList); if (el) listContainer.appendChild(el); });
    container.appendChild(listContainer);
}

// Create Item HTML
function createItemElement(itemResult, isParentTargetList) {
    const typeUpper = (itemResult.type || "").toUpperCase();
    const templateTypeUpper = ((itemResult.itemTemplate && itemResult.itemTemplate.type) || "").toUpperCase();
    if (typeUpper === 'TEXT' || templateTypeUpper === 'TEXT') return null;
    
    const div = document.createElement('div');
    let prompt = "Unknown Item";
    if (itemResult.itemTemplate && itemResult.itemTemplate.text) prompt = itemResult.itemTemplate.text; else prompt = `Item ID: ${itemResult.id}`;
    
    // Expiration Logic
    let entryClass = "checklist-entry";
    const isExpItem = prompt.includes("Sanitizer") && prompt.includes("Exp. Date");
    if (isExpItem && itemResult.resultDouble) {
        const today = new Date(); today.setHours(0,0,0,0);
        const expDate = new Date(itemResult.resultDouble * 1000); expDate.setHours(0,0,0,0);
        
        const sevenDays = new Date();
        sevenDays.setDate(today.getDate() + 7);
        sevenDays.setHours(0,0,0,0);

        if (expDate < today) entryClass += " expired-item";
        else if (expDate.getTime() === today.getTime()) entryClass += " expiring-item";
        else if (expDate <= sevenDays) entryClass += " expiring-item"; // Reuse yellow for warning
    }
    div.className = entryClass;
    
    // Status Logic
    let displayValue = "";
    let statusClass = "status-pending";
    let statusText = "TODO";
    let photoAsset = null;
    let photoUrl = null; // New variable for URL

    const isPhotoType = typeUpper.includes('PHOTO') || templateTypeUpper.includes('PHOTO');
    const completed = itemResult.completionTimestamp && itemResult.completionTimestamp > 0;
    if (completed) { statusClass = "status-pass"; statusText = "DONE"; }
    if (itemResult.isMarkedNA) { displayValue = "N/A"; statusClass = "status-na"; statusText = "N/A"; }
    else if (isPhotoType) {
        // Prioritize resultCompanyFiles for URL if available
        if (itemResult.resultCompanyFiles && itemResult.resultCompanyFiles.length > 0) {
            photoUrl = itemResult.resultCompanyFiles[0].fileURI;
            // Also set photoAsset just in case we need name/id for fallback
             if (itemResult.resultAssets && itemResult.resultAssets.length > 0) photoAsset = itemResult.resultAssets[0];
        } 
        else if (itemResult.resultAssets && itemResult.resultAssets.length > 0) {
             // Fallback to resultAssets if resultCompanyFiles is empty/missing
            photoAsset = itemResult.resultAssets[0];
        } else if (!completed) statusText = "NO PHOTO";
    } else if (itemResult.resultDouble) {
            const isDateType = typeUpper.includes('DATE') || typeUpper.includes('TIME');
            if (isDateType || prompt.toLowerCase().includes('date')) {
                if (itemResult.resultDouble > 946684800) displayValue = new Date(itemResult.resultDouble * 1000).toLocaleDateString();
                else displayValue = itemResult.resultDouble;
            } else displayValue = itemResult.resultDouble;
    } else if (itemResult.resultValue) displayValue = itemResult.resultValue;
    else if (itemResult.resultText) displayValue = itemResult.resultText;
    
    // Thermometer Icon
    let valDisplay = displayValue;
    if (itemResult.peripheral && itemResult.peripheral.type === 'TEMPERATURE_PROBE') {
         valDisplay += ' 🌡️';
    }

    // Button HTML generation - CLEANED for invalid tokens
    let photoBtnHtml = '';
    // Helper to escape strings properly for onclick
    const escapeStr = (str) => {
        if(!str) return "";
        return str.replace(/['"\r\n]/g, " ").trim();
    };

    if (photoUrl) {
         // Button to show photo with URL
         const safePrompt = escapeStr(prompt);
         photoBtnHtml = `<button class="photo-btn" onclick="showPhoto('${safePrompt}', null, '${photoUrl}')">View Photo</button>`;
    } else if (photoAsset) {
         // Button to show info that URL is missing but asset exists
         const safeName = escapeStr(photoAsset.name);
         photoBtnHtml = `<button class="photo-btn" onclick="showPhoto('${safeName}', '${photoAsset.id}', null)">View Photo Info</button>`;
    }

    let html = `<div class="entry-header"><span class="entry-title">${prompt}</span><div style="display:flex; align-items:center;">${valDisplay ? `<span class="entry-value">${valDisplay}</span>` : ''}${photoBtnHtml}<span class="status-badge ${statusClass}" style="margin-left:10px;">${statusText}</span></div></div>`;
    if (itemResult.notes && itemResult.notes.length > 0) { itemResult.notes.forEach(note => { if (note.body) html += `<div class="entry-notes">📝 ${note.body}</div>`; }); }
    div.innerHTML = html;

    if (itemResult.subList && itemResult.subList.itemResults && itemResult.subList.itemResults.length > 0) {
        const subContainer = document.createElement('div');
        subContainer.className = 'sublist-container';
        const subTitle = itemResult.subList.instanceTitle || "Sub-list";
        
        // Sub Integrity
            let subIntegrityHtml = "";
            let subTimestamps = [];
            const collectSubTimestamps = (list) => { list.forEach(si => { if(si.completionTimestamp > 0) subTimestamps.push(si.completionTimestamp); }); }
            collectSubTimestamps(itemResult.subList.itemResults);
            let subSeconds = null;
            let subDurationStr = "";
            if (subTimestamps.length >= 2) {
                subTimestamps.sort((a,b) => a-b);
                subSeconds = subTimestamps[subTimestamps.length-1] - subTimestamps[0];
                const mins = Math.floor(subSeconds / 60); const secs = subSeconds % 60;
                subDurationStr = `<span class="duration-tag">⏱️ ${mins}m ${secs}s</span>`;
            }
            if (isParentTargetList && subTimestamps.length >= 2) {
            const subScore = calculateIntegrity(itemResult.subList.itemResults, prompt, subSeconds); 
            let badgeClass = 'integrity-high';
            let scoreDisplay = subScore.score + "%";
            if (subScore.score === null) { badgeClass = 'integrity-na'; scoreDisplay = "N/A"; }
            else if (subScore.score < 60) badgeClass = 'integrity-low';
            else if (subScore.score < 85) badgeClass = 'integrity-med';
            subIntegrityHtml = `<span class="integrity-badge ${badgeClass}" style="font-size:0.7rem; margin-left:8px;">🛡️ ${scoreDisplay}</span>`;
        }
        subContainer.innerHTML = `<div class="sublist-header"><span>${subTitle} ${subIntegrityHtml}</span> ${subDurationStr}</div>`;
        itemResult.subList.itemResults.forEach(subItem => {
            const subEl = createItemElement(subItem, isParentTargetList);
            if (subEl) subContainer.appendChild(subEl);
        });
        div.appendChild(subContainer);
    }
    return div;
}

// --- Other helpers from previous version maintained ---
function downloadCSV(csvContent, filename) { const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }); const link = document.createElement("a"); if (link.download !== undefined) { const url = URL.createObjectURL(blob); link.setAttribute("href", url); link.setAttribute("download", filename); link.style.visibility = 'hidden'; document.body.appendChild(link); link.click(); document.body.removeChild(link); } }
function exportCurrentView() { /* (re-implemented in full above) */ 
    if (!currentListsCache || currentListsCache.length === 0) { alert("No data."); return; }
    let csv = "Location,Checklist Name,Date,Status,Duration,Integrity Score\n";
    currentListsCache.forEach(list => { const comp = list._computed || {}; const title = (list.listTemplate && list.listTemplate.title) ? list.listTemplate.title : (list.instanceTitle || "Untitled"); const d = list.displayTimestamp ? new Date(list.displayTimestamp * 1000).toLocaleString() : ""; const cleanTitle = `"${title.replace(/"/g, '""')}"`; const cleanLoc = `"${(comp.locationName || "").replace(/"/g, '""')}"`; csv += `${cleanLoc},${cleanTitle},${d},${comp.status},${comp.duration},${comp.integrity}\n`; });
    downloadCSV(csv, "jolt_export_current_view.csv");
}
function exportAllLocations() { /* (re-implemented in full above) */
    /* ... same logic ... */ 
    const startDateStr = document.getElementById('startDate').value; const endDateStr = document.getElementById('endDate').value; if(!startDateStr || !endDateStr) { alert("Select dates."); return; }
    const overlay = document.getElementById('loadingOverlay'); const loadText = document.getElementById('loadingText'); const select = document.getElementById('locationSelect'); const options = Array.from(select.options).filter(o => o.value); if (options.length === 0) return;
    overlay.style.display = 'flex'; loadText.innerText = `Starting Export...`;
    const startTs = Math.floor(new Date(startDateStr + 'T00:00:00').getTime() / 1000); const endTs = Math.floor(new Date(endDateStr + 'T23:59:59').getTime() / 1000);
    let csv = "Location,Checklist Name,Date,Status,Duration,Integrity Score\n";
    (async () => {
            for (let i = 0; i < options.length; i++) {
            const locOpt = options[i]; loadText.innerText = `Processing ${i+1}/${options.length}: ${locOpt.text}`;
            try { const lists = await fetchListsForLocation(locOpt.value, startTs, endTs);
                lists.forEach(list => { const title = (list.listTemplate && list.listTemplate.title) ? list.listTemplate.title : (list.instanceTitle || "Untitled"); const d = list.displayTimestamp ? new Date(list.displayTimestamp * 1000).toLocaleString() : ""; let status = "In Progress"; if (list.incompleteCount === 0) status = "Complete"; let duration = "N/A"; let integrity = "N/A"; if (list.itemResults) { const dur = calculateDuration(list.itemResults); if (dur.text) duration = dur.text; const targetLists = ['🟧', 'DFSL', 'FSL']; if (targetLists.some(tag => title.includes(tag))) { const scoreData = calculateIntegrity(list.itemResults, title, dur.seconds); integrity = scoreData.score + "%"; } } csv += `"${locOpt.text.replace(/"/g,'""')}","${title.replace(/"/g,'""')}",${d},${status},${duration},${integrity}\n`; }); await new Promise(r => setTimeout(r, 200)); 
            } catch (e) { console.error("Export Error", e); }
            }
            overlay.style.display = 'none'; downloadCSV(csv, "jolt_export_all_locations.csv");
    })();
}
function showPhoto(name, id, url) { 
    const modal = document.getElementById('photoModal'); 
    const cap = document.getElementById('photoCaption'); 
    const title = document.getElementById('photoTitle');
    const placeholder = document.querySelector('.photo-placeholder');
    
    // Reset modal content
    placeholder.style.display = 'flex';
    placeholder.innerHTML = '<span>Image Preview Unavailable via API</span>';
    const existingImg = modal.querySelector('img.dynamic-photo');
    if(existingImg) existingImg.remove();

    title.innerText = "Photo: " + (name || "Unknown");
    
    if (url) {
        placeholder.style.display = 'none';
        const img = document.createElement('img');
        img.src = url;
        img.className = 'dynamic-photo';
        img.style.maxWidth = '100%';
        img.style.maxHeight = '80vh';
        // Insert img after h3
        title.insertAdjacentElement('afterend', img);
        cap.innerText = "";
    } else {
        cap.innerText = `Asset ID: ${id}`;
    }

    modal.style.display = 'flex'; 
}
function closePhoto() { document.getElementById('photoModal').style.display = 'none'; }
async function debugSchema() { log("Running Introspection...", 'info'); }
async function joltFetch(query, variables = {}) { const url = config.proxyUrl; const payload = { query: query, variables: variables }; const response = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(payload) }); if (!response.ok) throw new Error(await response.text()); const result = await response.json(); if (result.errors) throw new Error(result.errors.map(e => e.message).join(", ")); return result; }
function handleError(err, context) { log(`Error ${context}: ${err.message}`, 'error'); }
function openConfig() { document.getElementById('configModal').style.display = 'flex'; document.getElementById('cfg-url').value = config.proxyUrl; }
function saveConfig() { config.proxyUrl = document.getElementById('cfg-url').value; document.getElementById('configModal').style.display = 'none'; fetchLocations(); }
function loadConfigUI() { document.getElementById('cfg-url').value = config.proxyUrl; }