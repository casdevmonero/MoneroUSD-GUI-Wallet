// PS3 XMB-style flowing wave background for MoneroUSD welcome page
(function () {
  const canvas = document.getElementById('welcomeCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h, animId;
  let time = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Wave layers — each wave has its own speed, amplitude, color, and vertical offset
  const waves = [
    { amp: 80, freq: 0.0018, speed: 0.012, yOff: 0.55, color: 'rgba(255,102,0,0.04)', thick: 160 },
    { amp: 60, freq: 0.0025, speed: 0.018, yOff: 0.50, color: 'rgba(255,102,0,0.06)', thick: 120 },
    { amp: 45, freq: 0.0032, speed: 0.025, yOff: 0.45, color: 'rgba(255,102,0,0.07)', thick: 90 },
    { amp: 35, freq: 0.0040, speed: 0.032, yOff: 0.52, color: 'rgba(204,82,0,0.05)', thick: 70 },
    { amp: 25, freq: 0.0055, speed: 0.040, yOff: 0.48, color: 'rgba(255,133,51,0.04)', thick: 50 },
    { amp: 55, freq: 0.0020, speed: 0.008, yOff: 0.60, color: 'rgba(255,102,0,0.03)', thick: 140 },
  ];

  // Floating particles (like XMB dust motes)
  const particles = [];
  const PARTICLE_COUNT = 40;

  function initParticles() {
    particles.length = 0;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.5 + 0.5,
        vx: (Math.random() - 0.3) * 0.3,
        vy: (Math.random() - 0.5) * 0.15,
        alpha: Math.random() * 0.3 + 0.05,
        pulse: Math.random() * Math.PI * 2,
      });
    }
  }

  function drawWave(wave, t) {
    const baseY = h * wave.yOff;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 3) {
      const y = baseY +
        Math.sin(x * wave.freq + t * wave.speed) * wave.amp +
        Math.sin(x * wave.freq * 0.7 + t * wave.speed * 1.3 + 1.5) * wave.amp * 0.4 +
        Math.cos(x * wave.freq * 0.4 + t * wave.speed * 0.6 + 3.0) * wave.amp * 0.2;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = wave.color;
    ctx.fill();
  }

  function drawParticles(t) {
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.pulse += 0.015;
      // Wrap around
      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      if (p.y < -10) p.y = h + 10;
      if (p.y > h + 10) p.y = -10;
      const a = p.alpha * (0.6 + 0.4 * Math.sin(p.pulse));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,133,51,' + a.toFixed(3) + ')';
      ctx.fill();
    }
  }

  // Subtle radial gradient overlay for depth
  function drawGradientOverlay() {
    const grad = ctx.createRadialGradient(w * 0.5, h * 0.35, 0, w * 0.5, h * 0.5, w * 0.8);
    grad.addColorStop(0, 'rgba(255,102,0,0.03)');
    grad.addColorStop(0.5, 'rgba(15,15,15,0)');
    grad.addColorStop(1, 'rgba(15,15,15,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  function frame() {
    time += 1;
    ctx.clearRect(0, 0, w, h);

    // Dark base
    ctx.fillStyle = '#0f0f0f';
    ctx.fillRect(0, 0, w, h);

    drawGradientOverlay();

    // Draw waves back to front
    for (const wave of waves) {
      drawWave(wave, time);
    }

    drawParticles(time);

    animId = requestAnimationFrame(frame);
  }

  function start() {
    resize();
    initParticles();
    if (animId) cancelAnimationFrame(animId);
    frame();
  }

  function stop() {
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
  }

  window.addEventListener('resize', () => {
    resize();
    initParticles();
  });

  // Expose start/stop so app.js can control it
  window.__welcomeBg = { start, stop };

  // Auto-start if welcome page is visible
  if (!document.getElementById('welcomePage')?.classList.contains('hidden')) {
    start();
  }
})();
