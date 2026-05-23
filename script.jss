// script.js - Fixed login & initialization
(function() {
    // DOM elements
    const loginOverlay = document.getElementById('loginOverlay');
    const dashboardWrapper = document.getElementById('dashboardWrapper');
    const loginBtn = document.getElementById('loginBtn');
    const loginUsername = document.getElementById('loginUsername');
    const loginPassword = document.getElementById('loginPassword');
    const logoutBtn = document.getElementById('logoutBtn');
    const darkToggle = document.getElementById('darkToggle');

    // Helper: toast message
    function showToast(msg) {
        const toast = document.getElementById('toastMsg');
        if (!toast) return;
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2500);
    }

    // Authentication check
    function checkAuth() {
        if (sessionStorage.getItem('fireguard_auth') === 'true') {
            loginOverlay.style.display = 'none';
            dashboardWrapper.style.display = 'block';
            if (typeof window.initDashboard === 'function') {
                window.initDashboard();
            } else {
                console.error('initDashboard not defined yet');
            }
        } else {
            loginOverlay.style.display = 'flex';
            dashboardWrapper.style.display = 'none';
        }
    }

    // Login event
    if (loginBtn) {
        loginBtn.addEventListener('click', function(e) {
            e.preventDefault();
            const user = loginUsername.value.trim();
            const pass = loginPassword.value;
            if (user === 'admin' && pass === 'admin123') {
                sessionStorage.setItem('fireguard_auth', 'true');
                checkAuth();
                showToast('✅ Selamat datang, Admin!');
            } else {
                showToast('❌ Username atau password salah!');
                loginPassword.value = '';
            }
        });
    }

    // Enter key on password field
    if (loginPassword) {
        loginPassword.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') loginBtn.click();
        });
    }

    // Logout
    if (logoutBtn) {
        logoutBtn.addEventListener('click', function() {
            sessionStorage.removeItem('fireguard_auth');
            if (window.mqttClient) {
                try { window.mqttClient.end(true); } catch(e) {}
                window.mqttClient = null;
            }
            checkAuth();
            showToast('🔓 Anda telah keluar');
        });
    }

    // Dark mode
    if (darkToggle) {
        darkToggle.addEventListener('click', function() {
            document.body.classList.toggle('dark');
            localStorage.setItem('darkMode', document.body.classList.contains('dark'));
        });
    }
    if (localStorage.getItem('darkMode') === 'true') document.body.classList.add('dark');

    // ========== DASHBOARD CORE (diinisialisasi setelah login) ==========
    let state = {
        gasValue: 0, objectTemp: 0, roomTemp: 0, humidity: 0,
        status: 'AMAN', ledGreen: true, ledYellow: false, ledRed: false, relay: false, buzzer: false,
        thresholds: { gas: 2000, fireDanger: 70, fireWarn: 50, roomHot: 40, humDry: 50 },
        logs: [], historyArrays: { gas: [], objTemp: [], roomTemp: [], hum: [] }, maxRisk: 0
    };
    let mqttClient = null;
    let tempChart = null, gasHumChart = null;
    let currentFilter = 'all';
    let timeLabels = [];
    for (let i = 1; i <= 30; i++) timeLabels.push(`-${i}s`);

    function initHistoryArrays() {
        for (let i = 0; i < 30; i++) {
            state.historyArrays.gas.push(0);
            state.historyArrays.objTemp.push(0);
            state.historyArrays.roomTemp.push(0);
            state.historyArrays.hum.push(0);
        }
    }
    initHistoryArrays();

    function updateCharts() {
        if (tempChart) {
            tempChart.data.datasets[0].data = [...state.historyArrays.roomTemp];
            tempChart.data.datasets[1].data = [...state.historyArrays.objTemp];
            tempChart.update();
        }
        if (gasHumChart) {
            gasHumChart.data.datasets[0].data = [...state.historyArrays.gas];
            gasHumChart.data.datasets[1].data = [...state.historyArrays.hum];
            gasHumChart.update();
        }
    }

    function pushToHistory() {
        state.historyArrays.gas.push(state.gasValue);
        if (state.historyArrays.gas.length > 30) state.historyArrays.gas.shift();
        state.historyArrays.objTemp.push(state.objectTemp);
        if (state.historyArrays.objTemp.length > 30) state.historyArrays.objTemp.shift();
        state.historyArrays.roomTemp.push(state.roomTemp);
        if (state.historyArrays.roomTemp.length > 30) state.historyArrays.roomTemp.shift();
        state.historyArrays.hum.push(state.humidity);
        if (state.historyArrays.hum.length > 30) state.historyArrays.hum.shift();
        updateCharts();
    }

    function applyOutputsByStatus(status) {
        state.ledGreen = state.ledYellow = state.ledRed = state.relay = state.buzzer = false;
        if (status === 'BAHAYA') {
            state.ledRed = true; state.relay = true; state.buzzer = true;
        } else if (['WASPADA', 'GAS_TERDETEKSI', 'API_TERDETEKSI', 'RUANGAN_PANAS'].includes(status)) {
            state.ledYellow = true; state.buzzer = true;
        } else if (status === 'RUANGAN_KERING') {
            // nothing
        } else {
            state.ledGreen = true;
        }
        const ledSpan = document.getElementById('ledSummary');
        if (ledSpan) ledSpan.innerHTML = state.ledRed ? '🔴 MERAH' : (state.ledYellow ? '🟡 KUNING' : '🟢 HIJAU');
        const buzzerSpan = document.getElementById('buzzerSummary');
        if (buzzerSpan) buzzerSpan.innerHTML = state.buzzer ? '🔊 AKTIF' : '🔇 OFF';
        const relaySpan = document.getElementById('relaySummary');
        if (relaySpan) relaySpan.innerHTML = state.relay ? '⚡ ON' : '⭕ OFF';
    }

    function determineStatus() {
        const th = state.thresholds;
        if (state.objectTemp >= th.fireDanger && state.gasValue >= th.gas) return 'BAHAYA';
        if (state.gasValue >= th.gas && state.objectTemp >= th.fireWarn) return 'WASPADA';
        if (state.gasValue >= th.gas) return 'GAS_TERDETEKSI';
        if (state.objectTemp >= th.fireWarn) return 'API_TERDETEKSI';
        if (state.roomTemp > th.roomHot) return 'RUANGAN_PANAS';
        if (state.humidity < th.humDry) return 'RUANGAN_KERING';
        return 'AMAN';
    }

    function updateRiskUI() {
        let score = state.status === 'BAHAYA' ? 100 :
                    (['WASPADA', 'GAS_TERDETEKSI', 'API_TERDETEKSI'].includes(state.status) ? 72 :
                    (state.status === 'RUANGAN_PANAS' ? 45 :
                    (state.status === 'RUANGAN_KERING' ? 20 : 8)));
        if (score > state.maxRisk) state.maxRisk = score;
        const riskRing = document.getElementById('riskRing');
        if (riskRing) {
            riskRing.innerHTML = score + '%';
            riskRing.style.borderColor = score > 70 ? '#ef4444' : (score > 30 ? '#f59e0b' : '#10b981');
        }
        const peakLabel = document.getElementById('peakRiskLabel');
        if (peakLabel) peakLabel.innerHTML = state.maxRisk + '%';
        let trig = (state.gasValue >= state.thresholds.gas ? 1 : 0) +
                   (state.objectTemp >= state.thresholds.fireWarn ? 1 : 0) +
                   (state.roomTemp > state.thresholds.roomHot ? 1 : 0) +
                   (state.humidity < state.thresholds.humDry ? 1 : 0);
        const triggerText = document.getElementById('triggerText');
        if (triggerText) triggerText.innerHTML = `${trig}/4 triggers active`;
        const totalTriggers = document.getElementById('totalTriggers');
        if (totalTriggers) totalTriggers.innerHTML = trig;
        const riskAdvice = document.getElementById('riskAdvice');
        if (riskAdvice) {
            riskAdvice.innerHTML = state.status === 'BAHAYA' ? '🔥 EVACUATION NEEDED' :
                                  (state.status.includes('WASPADA') ? '⚠️ Potential fire risk' : '🟢 Nominal conditions');
        }
        const fireGlow = document.getElementById('fireGlow');
        if (fireGlow) {
            if (state.status === 'BAHAYA') fireGlow.classList.add('active');
            else fireGlow.classList.remove('active');
        }
    }

    function addLog(type, detail) {
        const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        state.logs.unshift({
            time, type, detail,
            status: state.status,
            gas: state.gasValue,
            objTemp: state.objectTemp.toFixed(1),
            roomTemp: state.roomTemp.toFixed(1),
            hum: state.humidity.toFixed(1)
        });
        if (state.logs.length > 150) state.logs.pop();
        renderLogs();
        const todayLogs = state.logs.filter(l => l.time.includes(new Date().toLocaleTimeString().slice(0,5))).length;
        const logCountToday = document.getElementById('logCountToday');
        if (logCountToday) logCountToday.innerHTML = todayLogs;
    }

    function renderLogs() {
        const tbody = document.getElementById('logBody');
        if (!tbody) return;
        let data = state.logs;
        if (currentFilter === 'status') data = data.filter(l => l.type === 'status_change');
        if (currentFilter === 'sensor') data = data.filter(l => l.type === 'sensor_update' || l.type === 'threshold_change');
        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="log-empty">📡 No events yet</td></tr>';
            return;
        }
        tbody.innerHTML = data.map(l => {
            let bc = l.status === 'BAHAYA' ? 'badge-danger' : (l.status !== 'AMAN' ? 'badge-warning' : 'badge-aman');
            return `<tr>
                <td>${l.time}</td>
                <td><small>${l.detail}</small></td>
                <td><span class="status-badge ${bc}">${l.status}</span></td>
                <td>${l.gas}</td>
                <td>${l.objTemp}</td>
                <td>${l.roomTemp}</td>
                <td>${l.hum}</td>
            </tr>`;
        }).join('');
    }

    function updateAllSensorUI() {
        const valGas = document.getElementById('val-gas');
        if (valGas) valGas.innerText = state.gasValue;
        const valObj = document.getElementById('val-objTemp');
        if (valObj) valObj.innerText = state.objectTemp.toFixed(1);
        const valRoom = document.getElementById('val-roomTemp');
        if (valRoom) valRoom.innerText = state.roomTemp.toFixed(1);
        const valHum = document.getElementById('val-hum');
        if (valHum) valHum.innerText = state.humidity.toFixed(1);

        ['gas', 'objTemp', 'roomTemp', 'hum'].forEach(k => {
            const fill = document.getElementById(`fill-${k}`);
            if (!fill) return;
            const maxV = { gas: 4095, objTemp: 120, roomTemp: 60, hum: 100 };
            let val = k === 'gas' ? state.gasValue : k === 'objTemp' ? state.objectTemp : k === 'roomTemp' ? state.roomTemp : state.humidity;
            fill.style.width = `${Math.min(100, (val / maxV[k]) * 100)}%`;
        });
        const lastUpdate = document.getElementById('lastUpdate');
        if (lastUpdate) lastUpdate.innerHTML = new Date().toLocaleTimeString();
        updateRiskUI();
    }

    function onMqttData(data) {
        if (data.gas !== undefined) state.gasValue = Number(data.gas);
        if (data.objectTemp !== undefined) state.objectTemp = Number(data.objectTemp);
        if (data.roomTemp !== undefined) state.roomTemp = Number(data.roomTemp);
        if (data.humidity !== undefined) state.humidity = Number(data.humidity);
        let newStatus = data.status ? data.status.toUpperCase() : determineStatus();
        const valid = ['BAHAYA', 'WASPADA', 'GAS_TERDETEKSI', 'API_TERDETEKSI', 'RUANGAN_PANAS', 'RUANGAN_KERING', 'AMAN'];
        if (!valid.includes(newStatus)) newStatus = 'AMAN';
        const oldStatus = state.status;
        state.status = newStatus;
        applyOutputsByStatus(state.status);
        pushToHistory();
        updateAllSensorUI();
        if (oldStatus !== state.status) addLog('status_change', `Status changed: ${oldStatus} → ${state.status}`);
        else addLog('sensor_update', 'MQTT data ingestion');
    }

    function connectMQTT() {
        const BROKER = 'wss://broker.emqx.io:8084/mqtt';
        const TOPIC = 'fire_detector/data';
        mqttClient = mqtt.connect(BROKER);
        window.mqttClient = mqttClient;
        mqttClient.on('connect', () => {
            const connDot = document.getElementById('connDot');
            const connLabel = document.getElementById('connLabel');
            if (connDot) connDot.style.background = '#10b981';
            if (connLabel) connLabel.innerText = 'MQTT Online';
            mqttClient.subscribe(TOPIC, (err) => { if (!err) showToast('MQTT Live Stream Active'); });
        });
        mqttClient.on('message', (topic, msg) => {
            try {
                const json = JSON.parse(msg.toString());
                onMqttData(json);
            } catch (e) { console.warn(e); }
        });
        mqttClient.on('error', () => {
            const connDot = document.getElementById('connDot');
            const connLabel = document.getElementById('connLabel');
            if (connDot) connDot.style.background = '#ef4444';
            if (connLabel) connLabel.innerText = 'MQTT Error';
            showToast('MQTT connection failed');
        });
    }

    function buildSensors() {
        const grid = document.getElementById('sensorGrid');
        if (!grid) return;
        grid.innerHTML = `
            <div class="sensor-card-modern"><div class="sensor-header"><i class="fas fa-wind" style="color:#8b5cf6;"></i> <span>MQ-2 Combustible Gas</span></div><div class="sensor-digit" id="val-gas">0</div><div class="threshold-progress"><div class="progress-fill" id="fill-gas" style="width:0%; background:#8b5cf6;"></div></div><span style="font-size:0.7rem;">Threshold: ${state.thresholds.gas}</span></div>
            <div class="sensor-card-modern"><div class="sensor-header"><i class="fas fa-fire" style="color:#ef4444;"></i> <span>MLX90614 (Fire Temp)</span></div><div class="sensor-digit" id="val-objTemp">0</div><div class="threshold-progress"><div class="progress-fill" id="fill-objTemp" style="width:0%; background:#ef4444;"></div></div><span style="font-size:0.7rem;">Warning: ${state.thresholds.fireWarn}°C</span></div>
            <div class="sensor-card-modern"><div class="sensor-header"><i class="fas fa-temperature-low" style="color:#3b82f6;"></i> <span>DHT22 Ambient</span></div><div class="sensor-digit" id="val-roomTemp">0</div><div class="threshold-progress"><div class="progress-fill" id="fill-roomTemp" style="width:0%; background:#3b82f6;"></div></div><span style="font-size:0.7rem;">Hot limit: ${state.thresholds.roomHot}°C</span></div>
            <div class="sensor-card-modern"><div class="sensor-header"><i class="fas fa-tint" style="color:#10b981;"></i> <span>Humidity Level</span></div><div class="sensor-digit" id="val-hum">0</div><div class="threshold-progress"><div class="progress-fill" id="fill-hum" style="width:0%; background:#10b981;"></div></div><span style="font-size:0.7rem;">Dry &lt; ${state.thresholds.humDry}%</span></div>
        `;
    }

    function initCharts() {
        const ctxTemp = document.getElementById('tempChart');
        const ctxGas = document.getElementById('gasHumChart');
        if (!ctxTemp || !ctxGas) return;
        tempChart = new Chart(ctxTemp.getContext('2d'), {
            type: 'line',
            data: { labels: timeLabels, datasets: [
                { label: 'Room Temp (°C)', data: state.historyArrays.roomTemp, borderColor: '#3b82f6', tension: 0.3, fill: true },
                { label: 'Object Temp (Fire) °C', data: state.historyArrays.objTemp, borderColor: '#ef4444', tension: 0.3 }
            ] },
            options: { responsive: true, maintainAspectRatio: true }
        });
        gasHumChart = new Chart(ctxGas.getContext('2d'), {
            type: 'line',
            data: { labels: timeLabels, datasets: [
                { label: 'Gas Sensor (analog)', data: state.historyArrays.gas, borderColor: '#a855f7', yAxisID: 'y', tension: 0.3 },
                { label: 'Humidity (%)', data: state.historyArrays.hum, borderColor: '#10b981', yAxisID: 'y1', tension: 0.3 }
            ] },
            options: {
                responsive: true,
                scales: { y: { title: { display: true, text: 'Gas Level' } }, y1: { position: 'right', title: { text: 'Humidity (%)' } } }
            }
        });
    }

    function initEventListeners() {
        const btnThreshold = document.getElementById('btnThreshold');
        if (btnThreshold) {
            btnThreshold.addEventListener('click', () => {
                document.getElementById('thGas').value = state.thresholds.gas;
                document.getElementById('thFireDanger').value = state.thresholds.fireDanger;
                document.getElementById('thFireWarn').value = state.thresholds.fireWarn;
                document.getElementById('thRoomHot').value = state.thresholds.roomHot;
                document.getElementById('thHumDry').value = state.thresholds.humDry;
                document.getElementById('thresholdModal').classList.add('active');
            });
        }
        const saveBtn = document.getElementById('saveThresholdBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                state.thresholds.gas = parseInt(document.getElementById('thGas').value) || 2000;
                state.thresholds.fireDanger = parseFloat(document.getElementById('thFireDanger').value) || 70;
                state.thresholds.fireWarn = parseFloat(document.getElementById('thFireWarn').value) || 50;
                state.thresholds.roomHot = parseFloat(document.getElementById('thRoomHot').value) || 40;
                state.thresholds.humDry = parseFloat(document.getElementById('thHumDry').value) || 50;
                document.getElementById('thresholdModal').classList.remove('active');
                addLog('threshold_change', 'Thresholds updated');
                showToast('Threshold calibrated');
                updateAllSensorUI();
            });
        }
        const closeModal = document.getElementById('closeModalBtn');
        const cancelModal = document.getElementById('cancelModalBtn');
        if (closeModal) closeModal.addEventListener('click', () => document.getElementById('thresholdModal').classList.remove('active'));
        if (cancelModal) cancelModal.addEventListener('click', () => document.getElementById('thresholdModal').classList.remove('active'));
        const clearLog = document.getElementById('btnClearLog');
        if (clearLog) {
            clearLog.addEventListener('click', () => {
                state.logs = [];
                renderLogs();
                showToast('Log cleared');
            });
        }
        const exportLog = document.getElementById('btnExportLog');
        if (exportLog) {
            exportLog.addEventListener('click', () => {
                let csv = "Time,Event,Status,Gas,FireTemp,RoomTemp,Humidity\n" + state.logs.map(l => `${l.time},${l.detail},${l.status},${l.gas},${l.objTemp},${l.roomTemp},${l.hum}`).join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = "fireguard_logs.csv";
                a.click();
                URL.revokeObjectURL(a.href);
            });
        }
        document.querySelectorAll('.log-filter-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.log-filter-btn').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                currentFilter = this.dataset.filter;
                renderLogs();
            });
        });
    }

    // Inisialisasi utama dashboard (dipanggil setelah login)
    window.initDashboard = function() {
        buildSensors();
        initCharts();
        initEventListeners();
        connectMQTT();
        applyOutputsByStatus('AMAN');
        updateAllSensorUI();
        setInterval(() => { if (state.historyArrays.gas.length) updateCharts(); }, 1000);
    };

    checkAuth();
})();