const GameState = {
    MENU: 0,
    PLAYING: 1,
    GAMEOVER: 2,
    LEVEL_CLEAR: 3
};

// Web Audio API Controller for Procedural Sound
const AudioController = {
    audioCtx: null,
    enabled: false,

    init() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this.enabled = true;
        }
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
    },

    playTone(freq, type, duration, vol = 0.5, slideFreq = null) {
        if (!this.enabled || !this.audioCtx) return;
        const osc = this.audioCtx.createOscillator();
        const gainNode = this.audioCtx.createGain();
        osc.type = type;
        osc.connect(gainNode);
        gainNode.connect(this.audioCtx.destination);

        osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);
        if (slideFreq) {
            osc.frequency.exponentialRampToValueAtTime(slideFreq, this.audioCtx.currentTime + duration);
        }

        gainNode.gain.setValueAtTime(vol, this.audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + duration);

        osc.start();
        osc.stop(this.audioCtx.currentTime + duration);
    },

    playNoise(duration, vol) {
        if (!this.enabled || !this.audioCtx) return;
        const bufferSize = this.audioCtx.sampleRate * duration;
        const buffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        const noise = this.audioCtx.createBufferSource();
        noise.buffer = buffer;

        // Lowpass filter for thud effect
        const filter = this.audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1000;

        const gainNode = this.audioCtx.createGain();
        gainNode.gain.setValueAtTime(vol, this.audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + duration);

        noise.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(this.audioCtx.destination);

        noise.start();
    },

    playShoot() {
        this.playTone(300, 'triangle', 0.1, 0.2, 150); // Pew sound
    },

    playImpact() {
        // Crunch/Blast
        this.playTone(100, 'square', 0.15, 0.1, 40);
        this.playNoise(0.15, 0.4);
    },

    playTick() {
        this.playTone(600, 'sine', 0.05, 0.1); // UI click
    },

    playGameOver() {
        this.playTone(150, 'sawtooth', 0.5, 0.2, 80);
    },

    playWin() {
        this.playTone(400, 'sine', 0.1, 0.1, 600);
        setTimeout(() => this.playTone(600, 'sine', 0.2, 0.1, 800), 100);
    },

    playCombo(level) {
        // Higher pitch for combo
        this.playTone(300 + (level * 50), 'sine', 0.1, 0.1, 400 + (level * 50));
    }
};

const Config = {
    ROWS: 12,
    COLS: 7, // Wider grid to look like a blast game
    COLORS: 5,
    BLOCK_SIZE: 0,
    SPACING: 2,
};

let currentState = GameState.PLAYING;
let currentLevel = 1;

let grid = []; // 2D array [col][row] containing block objects
let activeTargets = [];
let queuedTargets = [];
let projectiles = [];
let particles = [];
let floatingTexts = [];

// Juice vars
let hitStopFrames = 0;
let comboCount = 0;
let lastHitTime = 0;

const gridContainer = document.getElementById('grid-container');
const gridElement = document.getElementById('grid');
const activeTargetsElement = document.getElementById('active-targets');
const queuedTargetsElement = document.getElementById('queued-targets');
const canvas = document.getElementById('effects-canvas');
const ctx = canvas.getContext('2d');

function initGame() {
    calculateSizes();
    window.addEventListener('resize', () => {
        calculateSizes();
        renderGrid(); // just refresh dom positions
    });

    document.body.addEventListener('pointerdown', () => {
        AudioController.init();
    }, { once: true });

    requestAnimationFrame(gameLoop);
    startLevel(1);
}

function calculateSizes() {
    const containerRect = gridContainer.getBoundingClientRect();
    const availableWidth = containerRect.width - 10;
    const availableHeight = containerRect.height - 10;

    const maxWidthBased = (availableWidth - (Config.COLS - 1) * Config.SPACING) / Config.COLS;
    const maxHeightBased = (availableHeight - (Config.ROWS - 1) * Config.SPACING) / Config.ROWS;

    Config.BLOCK_SIZE = Math.floor(Math.min(maxWidthBased, maxHeightBased));

    gridElement.style.width = `${Config.COLS * Config.BLOCK_SIZE + (Config.COLS - 1) * Config.SPACING}px`;
    gridElement.style.height = `${Config.ROWS * Config.BLOCK_SIZE + (Config.ROWS - 1) * Config.SPACING}px`;

    const gameContainer = document.getElementById('game-container');
    canvas.width = gameContainer.clientWidth;
    canvas.height = gameContainer.clientHeight;
}

function startLevel(level) {
    currentLevel = level;
    document.getElementById('level-display').innerText = level;
    currentState = GameState.PLAYING;
    projectiles = [];
    particles = [];
    floatingTexts = [];
    comboCount = 0;

    generateLevelData();
    renderTargets();
}

function generateLevelData() {
    const totalBlocks = Config.COLS * Config.ROWS;

    let allCannons = [];
    let blocksLeft = totalBlocks;

    let minChunk = Math.max(4, 15 - currentLevel);
    let maxChunk = Math.max(8, 20 - currentLevel);

    while (blocksLeft > 0) {
        let chunk = Math.min(blocksLeft, minChunk + Math.floor(Math.random() * (maxChunk - minChunk)));
        allCannons.push({
            color: Math.floor(Math.random() * Config.COLORS),
            count: chunk,
            shooting: false,
            lastShot: 0,
            completed: false
        });
        blocksLeft -= chunk;
    }

    let simGrid = Array.from({ length: Config.COLS }, () => []);
    let simQueue = allCannons.map(c => ({ cannon: c, remaining: c.count }));
    let simActive = [];

    let placedBlocks = 0;
    while (placedBlocks < totalBlocks) {
        while (simActive.length < 3 && simQueue.length > 0) {
            simActive.push(simQueue.shift());
        }

        let activeIndex = Math.floor(Math.random() * simActive.length);
        let activeObj = simActive[activeIndex];

        let availableCols = [];
        for (let c = 0; c < Config.COLS; c++) {
            if (simGrid[c].length < Config.ROWS) availableCols.push(c);
        }

        if (availableCols.length > 0) {
            let c = availableCols[Math.floor(Math.random() * availableCols.length)];
            simGrid[c].push(activeObj.cannon.color);
            activeObj.remaining--;
            placedBlocks++;

            if (activeObj.remaining === 0) {
                simActive.splice(activeIndex, 1);
            }
        }
    }

    gridElement.innerHTML = '';
    grid = [];

    for (let c = 0; c < Config.COLS; c++) {
        grid[c] = [];
        for (let r = 0; r < Config.ROWS; r++) {
            const color = simGrid[c][r];

            const block = document.createElement('div');
            block.className = `block color-${color}`;
            block.style.width = `${Config.BLOCK_SIZE}px`;
            block.style.height = `${Config.BLOCK_SIZE}px`;

            const left = c * (Config.BLOCK_SIZE + Config.SPACING);
            const bottom = r * (Config.BLOCK_SIZE + Config.SPACING);

            block.style.left = `${left}px`;
            block.style.bottom = `${Config.ROWS * (Config.BLOCK_SIZE + Config.SPACING) + bottom}px`;

            gridElement.appendChild(block);

            grid[c][r] = {
                color: color,
                c: c,
                r: r,
                el: block,
                targeted: false
            };

            setTimeout(() => {
                block.style.bottom = `${bottom}px`;
            }, 50 + Math.random() * 200 + (Config.ROWS - r) * 30);
        }
    }

    activeTargets = [null, null, null];
    queuedTargets = allCannons;
}

function renderTargets() {
    activeTargetsElement.innerHTML = '';
    for (let i = 0; i < 3; i++) {
        const target = activeTargets[i];
        if (target) {
            const el = document.createElement('div');
            el.className = `target-bucket color-${target.color}`;
            el.innerText = target.count;
            if (target.completed) {
                el.innerText = '✓';
            }
            el.id = `active-target-${i}`;

            // Visual feedback if it's shooting
            if (target.shooting) {
                el.classList.add('shooting');
            }

            activeTargetsElement.appendChild(el);
        } else {
            const el = document.createElement('div');
            el.className = `target-bucket empty-slot`;
            activeTargetsElement.appendChild(el);
        }
    }

    queuedTargetsElement.innerHTML = '';
    queuedTargets.forEach((target, index) => {
        const el = document.createElement('div');
        el.className = `target-bucket color-${target.color}`;
        el.innerText = target.count;
        el.onclick = () => onQueueTargetClick(index);
        queuedTargetsElement.appendChild(el);
    });
}

function renderGrid() {
    for (let c = 0; c < Config.COLS; c++) {
        for (let r = 0; r < Config.ROWS; r++) {
            if (grid[c][r]) {
                const b = grid[c][r];
                b.el.style.width = `${Config.BLOCK_SIZE}px`;
                b.el.style.height = `${Config.BLOCK_SIZE}px`;
                const left = c * (Config.BLOCK_SIZE + Config.SPACING);
                const bottom = b.r * (Config.BLOCK_SIZE + Config.SPACING); // use real property mostly r === b.r
                b.el.style.left = `${left}px`;
                b.el.style.bottom = `${bottom}px`;
            }
        }
    }
}

function onQueueTargetClick(index) {
    if (currentState !== GameState.PLAYING) return;

    let emptyIndex = activeTargets.findIndex(t => t === null);
    if (emptyIndex !== -1) {
        let t = queuedTargets.splice(index, 1)[0];
        activeTargets[emptyIndex] = t;
        renderTargets();
    }
}

function findExposedBlock(color) {
    let bestBlock = null;
    let lowestR = 999;

    // An exposed block is the first non-null block from the bottom in any column
    const exposedBlocks = [];

    for (let c = 0; c < Config.COLS; c++) {
        for (let r = 0; r < Config.ROWS; r++) {
            const b = grid[c][r];
            if (b) {
                // This is the lowest block in this column
                exposedBlocks.push(b);
                break; // move to next column
            }
        }
    }

    // Now from these exposed blocks, select one that matches color and isn't targeted yet
    for (let b of exposedBlocks) {
        if (b.color === color && !b.targeted) {
            if (b.r < lowestR) {
                lowestR = b.r;
                bestBlock = b;
            }
        }
    }

    return bestBlock;
}

function destroyBlock(b) {
    if (b.el && b.el.parentNode) {
        b.el.classList.add('destroying');
        // Add wobble to neighbors
        applyWobble(b.c, b.r);
        setTimeout(() => { if (b.el.parentNode) b.el.remove(); }, 200);
    }

    // Find inside grid and set to null
    let foundC = -1, foundR = -1;
    for (let c = 0; c < Config.COLS; c++) {
        for (let r = 0; r < Config.ROWS; r++) {
            if (grid[c][r] === b) {
                foundC = c; foundR = r; break;
            }
        }
    }

    if (foundC !== -1) {
        grid[foundC][foundR] = null;
        applyColumnGravity(foundC);
    }
}

function applyWobble(centerC, centerR) {
    // Make surrounding blocks wobble a bit for juiciness
    const dirs = [[-1, 0], [1, 0], [0, 1]];
    dirs.forEach(d => {
        const nc = centerC + d[0];
        const nr = centerR + d[1];
        if (nc >= 0 && nc < Config.COLS && nr >= 0 && nr < Config.ROWS) {
            const neighbor = grid[nc][nr];
            if (neighbor && neighbor.el) {
                neighbor.el.classList.remove('block-wobble');
                void neighbor.el.offsetWidth; // reset anim
                neighbor.el.classList.add('block-wobble');
            }
        }
    });
}

function applyColumnGravity(c) {
    let writeRow = 0;
    for (let r = 0; r < Config.ROWS; r++) {
        if (grid[c][r]) {
            if (r > writeRow) {
                const b = grid[c][r];
                grid[c][writeRow] = b;
                grid[c][r] = null;
                b.r = writeRow; // update logical placement

                const bottom = writeRow * (Config.BLOCK_SIZE + Config.SPACING);
                b.el.style.bottom = `${bottom}px`;
            }
            writeRow++;
        }
    }
}

function spawnParticles(x, y, col) {
    for (let i = 0; i < 15; i++) {
        particles.push({
            x: x, y: y,
            vx: (Math.random() - 0.5) * 16,
            vy: (Math.random() - 0.5) * 16 - 2, // slight upward bias
            life: 1,
            color: col
        });
    }
}

function spawnFloatingText(x, y, text, color) {
    floatingTexts.push({
        x: x, y: y,
        text: text,
        color: color,
        life: 1.0,
        vy: -2
    });
}

function shakeScreen() {
    const container = document.getElementById('game-container');
    container.classList.remove('shake');
    void container.offsetWidth; // trigger reflow
    container.classList.add('shake');
}

function triggerHitStop(frames) {
    hitStopFrames = frames;
}

function completeTarget(index) {
    activeTargets[index] = null;
    renderTargets();

    // Check level clear
    if (activeTargets.every(t => t === null) && queuedTargets.length === 0) {
        // Double check no blocks are left
        let hasBlocks = false;
        for (let c = 0; c < Config.COLS; c++) {
            for (let r = 0; r < Config.ROWS; r++) {
                if (grid[c][r]) hasBlocks = true;
            }
        }
        if (!hasBlocks) {
            setTimeout(showLevelClear, 1000);
        }
    }
}

function showLevelClear() {
    AudioController.playWin();
    currentState = GameState.LEVEL_CLEAR;
    document.getElementById('overlay').classList.remove('hidden');
    document.getElementById('overlay-title').innerText = 'Level Clear!';
    document.getElementById('next-level-btn').onclick = () => {
        document.getElementById('overlay').classList.add('hidden');
        startLevel(currentLevel + 1);
    };
}

function showGameOver() {
    AudioController.playGameOver();
    currentState = GameState.GAMEOVER;
    document.getElementById('game-over-overlay').classList.remove('hidden');
    document.getElementById('restart-btn').onclick = () => {
        document.getElementById('game-over-overlay').classList.add('hidden');
        startLevel(currentLevel); // Replay current level
    };
}

let lastTime = 0;
function gameLoop(time) {
    if (hitStopFrames > 0) {
        hitStopFrames--;
        requestAnimationFrame(gameLoop);
        return;
    }
    const dt = time - lastTime;
    lastTime = time;

    if (currentState === GameState.PLAYING) {
        const now = time;
        // Manage shooting logic
        activeTargets.forEach((t, i) => {
            if (t && !t.completed) {
                if (now - t.lastShot > 150) { // Shoot speed
                    t.lastShot = now;

                    let b = findExposedBlock(t.color);
                    if (b) {
                        b.targeted = true;

                        const targetBtn = document.getElementById(`active-target-${i}`);
                        if (targetBtn) {
                            targetBtn.classList.remove('recoil');
                            void targetBtn.offsetWidth;
                            targetBtn.classList.add('recoil');
                            AudioController.playShoot();

                            const btnRect = targetBtn.getBoundingClientRect();
                            const containerRect = document.getElementById('game-container').getBoundingClientRect();

                            const startX = btnRect.left - containerRect.left + btnRect.width / 2;
                            const startY = btnRect.top - containerRect.top; // Shoot from top edge of button

                            projectiles.push({
                                x: startX, y: startY,
                                targetBlock: b,
                                color: t.color
                            });
                        }

                        t.count--;
                        const el = document.getElementById(`active-target-${i}`);
                        if (el && !t.completed) {
                            el.innerText = t.count;
                            el.classList.add('shooting');
                            setTimeout(() => el.classList.remove('shooting'), 60);
                        }
                    }

                    if (t.count <= 0 && !t.completed) {
                        t.completed = true;
                        const el = document.getElementById(`active-target-${i}`);
                        if (el) {
                            el.classList.remove('shooting');
                            el.style.transform = 'scale(0)';
                            el.style.opacity = '0';

                            setTimeout(() => {
                                completeTarget(i);
                            }, 300);
                        }
                    }
                }
            }
        });

        // Stuck Loss Logic Verification
        let isStuck = true;
        let isAllActiveFull = true;

        for (let i = 0; i < 3; i++) {
            if (activeTargets[i] === null) {
                isAllActiveFull = false;
                isStuck = false;
                break;
            } else {
                if (findExposedBlock(activeTargets[i].color)) {
                    isStuck = false;
                }
            }
        }

        if (isStuck && isAllActiveFull && projectiles.length === 0) {
            showGameOver();
        }
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Projectiles homing
    for (let i = projectiles.length - 1; i >= 0; i--) {
        let p = projectiles[i];

        let targetX = p.x;
        let targetY = p.y - 100; // default go up if lost

        if (p.targetBlock && p.targetBlock.el && p.targetBlock.el.parentNode) {
            const blockRect = p.targetBlock.el.getBoundingClientRect();
            const containerRect = document.getElementById('game-container').getBoundingClientRect();
            targetX = blockRect.left - containerRect.left + blockRect.width / 2;
            targetY = blockRect.top - containerRect.top + blockRect.height / 2;
        } else {
            // Target lost. Just fly upwards and die.
            p.y -= 15;
            if (p.y < -50) projectiles.splice(i, 1);
            continue;
        }

        const dx = targetX - p.x;
        const dy = targetY - p.y;
        const dist = Math.hypot(dx, dy);
        const speed = 18; // Speed of balls

        if (dist < speed) {
            // HIT Block
            destroyBlock(p.targetBlock);
            projectiles.splice(i, 1);
            spawnParticles(targetX, targetY, p.color);

            AudioController.playImpact();
            shakeScreen();
            triggerHitStop(2);

            if (time - lastHitTime < 800) {
                comboCount++;
                AudioController.playCombo(Math.min(comboCount, 10));
                spawnFloatingText(targetX, targetY - 20, `${comboCount}x COMBO!`, p.color);
            } else {
                comboCount = 1;
                spawnFloatingText(targetX, targetY - 20, "BLAST!", p.color);
            }
            lastHitTime = time;
        } else {
            p.x += (dx / dist) * speed;
            p.y += (dy / dist) * speed;

            // Draw Ball
            ctx.beginPath();
            ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(`--color-${p.color}`);
            ctx.fill();
            ctx.lineWidth = 3;
            ctx.strokeStyle = '#fff';
            ctx.stroke();

            // Trail
            ctx.beginPath();
            ctx.moveTo(p.x, p.y + 8);
            ctx.lineTo(p.x - (dx / dist) * 20, p.y - (dy / dist) * 20);
            ctx.strokeStyle = `rgba(255,255,255,0.5)`;
            ctx.stroke();
        }
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.5; // gravity
        p.life -= 0.05;

        if (p.life <= 0) {
            particles.splice(i, 1);
            continue;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 * p.life, 0, Math.PI * 2);
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(`--color-${p.color}`);
        ctx.globalAlpha = p.life;
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // Floating Texts
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft = floatingTexts[i];
        ft.y += ft.vy;
        ft.life -= 0.02;

        if (ft.life <= 0) {
            floatingTexts.splice(i, 1);
            continue;
        }

        ctx.font = 'bold 24px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#000';

        ctx.globalAlpha = ft.life;
        ctx.strokeText(ft.text, ft.x, ft.y);
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(`--color-${ft.color}`);
        ctx.fillText(ft.text, ft.x, ft.y);
        ctx.globalAlpha = 1;
    }

    requestAnimationFrame(gameLoop);
}

initGame();
