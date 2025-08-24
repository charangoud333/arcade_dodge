import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import './ViralArcade.css';

/**
 * Viral Arcade — Dodge & Collect
 * A fast, touch-friendly, single-file React mini-game built with Tailwind + Framer Motion.
 * Goal: drag the player to collect good orbs (⚡) and avoid hazards (💀). Chain combos, trigger slow-mo,
 * earn badges, and chase your local high score.
 *
 * Features
 * - Clean, modern UI with neon gradient, particles, and subtle motion.
 * - Mouse & touch controls (drag anywhere inside the arena).
 * - Dynamic difficulty ramp: more spawns, faster speeds, smarter hazards.
 * - Power-ups: slow-mo + magnet + score x2 (emergent, time-limited).
 * - Combos + streak meter + juicy hit/collect feedback.
 * - Pause/Resume, Game Over screen, LocalStorage high score.
 * - Share button (Web Share API fallback copy-to-clipboard).
 * - Lightweight sound effects (WebAudio, toggleable).
 */

// ---------- Types ----------

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const randSign = () => (Math.random() < 0.5 ? -1 : 1);
const dist2 = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

function useLocalStorage(key, initial) {
  const [val, setVal] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  }, [key, val]);
  return [val, setVal];
}

// ---------- Audio (tiny synth) ----------

function useBeeper(enabled) {
  const ctxRef = useRef(null);
  useEffect(() => {
    if (!enabled) return;
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
  }, [enabled]);

  const beep = (freq = 440, duration = 0.07, type = "sine", gain = 0.08) => {
    if (!enabled) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  };

  return { beep };
}

// ---------- Main Component ----------

export default function ViralArcade() {
  // UI + game state
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [score, setScore] = useState(0);
  const [best, setBest] = useLocalStorage("viral_arcade_best", 0);
  const [combo, setCombo] = useState(0);
  const [mult, setMult] = useState(1);
  const [streak, setStreak] = useState(0);
  const [sound, setSound] = useState(true);
  const [slowmo, setSlowmo] = useState(0); // ms remaining
  const [magnet, setMagnet] = useState(0); // ms remaining
  const [x2, setX2] = useState(0); // ms remaining
  const [flash, setFlash] = useState(null); // HUD toast
  const [badges, setBadges] = useState([]);

  const arenaRef = useRef(null);
  const playerRef = useRef(null);

  const [player, setPlayer] = useState({ x: 0.5, y: 0.5 }); // normalized pos
  const [radius, setRadius] = useState(18);

  const orbsRef = useRef([]);
  const idRef = useRef(1);
  const lastTs = useRef(null);

  const [seed, setSeed] = useState(0); // re-render hint after game over

  const { beep } = useBeeper(sound);

  // Difficulty curve
  const difficulty = useMemo(() => {
    const t = Math.min(1, score / 5000);
    return {
      spawnRate: 0.9 + t * 2.2, // spawns/sec
      speed: 70 + t * 170, // px/sec
      badShare: 0.35 + t * 0.25, // proportion bad
      powerChance: 0.08 + t * 0.05,
    };
  }, [score]);

  // Resize observer to keep player within bounds
  useEffect(() => {
    const el = arenaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSeed((s) => s + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Input: drag/touch
  useEffect(() => {
    const arena = arenaRef.current;
    if (!arena) return;

    const toNorm = (eX, eY) => {
      const rect = arena.getBoundingClientRect();
      const x = clamp((eX - rect.left) / rect.width, 0, 1);
      const y = clamp((eY - rect.top) / rect.height, 0, 1);
      return { x, y };
    };

    let dragging = false;

    const onDown = (e) => {
      dragging = true;
      const pt = "touches" in e ? e.touches[0] : e;
      setPlayer(toNorm(pt.clientX, pt.clientY));
    };
    const onMove = (e) => {
      if (!dragging) return;
      const pt = "touches" in e ? e.touches[0] : e;
      setPlayer(toNorm(pt.clientX, pt.clientY));
      e.preventDefault();
    };
    const onUp = () => (dragging = false);

    arena.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp);

    arena.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);

    return () => {
      arena.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      arena.removeEventListener("touchstart", onDown);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, []);

  // Game loop
  useEffect(() => {
    if (!running || paused) return;
    let raf = 0;

    const tick = (ts) => {
      const arena = arenaRef.current;
      if (!arena) return;
      if (lastTs.current == null) lastTs.current = ts;
      const dt = (ts - lastTs.current) / 1000; // seconds
      lastTs.current = ts;

      const slowFactor = slowmo > 0 ? 0.4 : 1;
      const effectiveDt = dt * slowFactor;

      // Timers
      if (slowmo > 0) setSlowmo((s) => Math.max(0, s - dt * 1000));
      if (magnet > 0) setMagnet((s) => Math.max(0, s - dt * 1000));
      if (x2 > 0) setX2((s) => Math.max(0, s - dt * 1000));

      // Spawn logic
      const spawnPerSec = difficulty.spawnRate;
      const chance = spawnPerSec * dt;
      if (Math.random() < chance) spawnOrb();

      // Move orbs
      const rect = arena.getBoundingClientRect();
      const pxPos = (v) => ({ x: v.x * rect.width, y: v.y * rect.height });

      const playerPx = pxPos(player);
      const newOrbs = [];
      for (const o of orbsRef.current) {
        const velScale = difficulty.speed / Math.max(rect.width, rect.height);
        let vx = o.vel.x * velScale * effectiveDt;
        let vy = o.vel.y * velScale * effectiveDt;

        // Magnet effect pulls good orbs toward player
        if (magnet > 0 && o.kind !== "bad") {
          const p = playerPx;
          const oPx = pxPos(o.pos);
          const dx = p.x - oPx.x;
          const dy = p.y - oPx.y;
          const m = Math.hypot(dx, dy) || 1;
          vx += (dx / m) * 0.8 * effectiveDt;
          vy += (dy / m) * 0.8 * effectiveDt;
        }

        const nx = clamp(o.pos.x + vx, 0, 1);
        const ny = clamp(o.pos.y + vy, 0, 1);
        const bounced = nx === 0 || nx === 1 || ny === 0 || ny === 1;
        o.pos = { x: nx, y: ny };
        if (bounced) {
          o.vel.x *= nx === 0 || nx === 1 ? -1 : 1;
          o.vel.y *= ny === 0 || ny === 1 ? -1 : 1;
        }
        o.spin = (o.spin || 0) + (o.kind === "bad" ? 0.03 : 0.02);

        // TTL
        if (performance.now() - o.bornAt < o.ttl) newOrbs.push(o);
      }
      orbsRef.current = newOrbs;

      // Collisions
      for (const o of [...orbsRef.current]) {
        const oPx = pxPos(o.pos);
        const r = o.radius;
        const d2 = dist2(playerPx, oPx);
        const hit = d2 <= (radius + r) * (radius + r);
        if (hit) {
          if (o.kind === "bad") {
            // game over
            beep(160, 0.15, "sawtooth", 0.08);
            endGame();
            return;
          }
          // good or power
          handleCollect(o);
          orbsRef.current = orbsRef.current.filter((x) => x.id !== o.id);
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, paused, player, radius, difficulty, slowmo, magnet, x2]);

  const handleCollect = (o) => {
    if (o.kind === "good") {
      const inc = Math.round(10 * mult * (x2 > 0 ? 2 : 1));
      setScore((s) => s + inc);
      setCombo((c) => c + 1);
      setStreak((s) => Math.min(100, s + 5));
      if (combo + 1 === 10) toast("x2 Active!", () => setX2(4000));
      if ((combo + 1) % 15 === 0) toast("SLOW-MO!", () => setSlowmo(3000));
      if ((combo + 1) % 20 === 0) toast("MAGNET!", () => setMagnet(4000));
      beep(660 + Math.min(400, combo * 10), 0.05, "triangle", 0.06);
    } else if (o.kind === "power") {
      const choice = Math.random();
      if (choice < 0.34) {
        toast("Slow Motion", () => setSlowmo(3500));
      } else if (choice < 0.67) {
        toast("Magnet Field", () => setMagnet(5000));
      } else {
        toast("Score x2", () => setX2(6000));
      }
      beep(880, 0.08, "square", 0.07);
    }

    // Badges
    const milestones = [200, 600, 1200, 2500, 4000, 6000];
    for (const m of milestones) {
      if (score < m && score + 1 >= m && !badges.includes(`🏅 ${m}`)) {
        setBadges((b) => [...b, `🏅 ${m}`]);
      }
    }
  };

  const toast = (msg, run) => {
    setFlash(msg);
    run?.();
    setTimeout(() => setFlash(null), 1200);
  };

  const spawnOrb = () => {
    const arena = arenaRef.current;
    if (!arena) return;
    const rect = arena.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    const edge = Math.floor(rand(0, 4));
    let x = rand(0, 1);
    let y = rand(0, 1);
    if (edge === 0) y = 0; // top
    if (edge === 1) y = 1; // bottom
    if (edge === 2) x = 0; // left
    if (edge === 3) x = 1; // right

    const toCenter = { x: 0.5 - x, y: 0.5 - y };
    const len = Math.hypot(toCenter.x, toCenter.y) || 1;
    const jitter = { x: rand(-0.3, 0.3), y: rand(-0.3, 0.3) };

    const speed = difficulty.speed / Math.max(w, h);
    const vel = {
      x: (toCenter.x / len + jitter.x) * speed * rand(0.6, 1.3),
      y: (toCenter.y / len + jitter.y) * speed * rand(0.6, 1.3),
    };

    const isPower = Math.random() < difficulty.powerChance;
    const isBad = Math.random() < difficulty.badShare && !isPower;

    const kind = isPower ? "power" : isBad ? "bad" : "good";
    const orb = {
      id: idRef.current++,
      kind,
      pos: { x, y },
      vel,
      radius: kind === "bad" ? rand(12, 18) : kind === "power" ? rand(14, 20) : rand(10, 16),
      bornAt: performance.now(),
      ttl: rand(5000, 10000),
      spin: rand(0, Math.PI * 2),
    };
    orbsRef.current.push(orb);
  };

  const startGame = () => {
    setScore(0);
    setCombo(0);
    setMult(1);
    setStreak(0);
    setSlowmo(0);
    setMagnet(0);
    setX2(0);
    setBadges([]);
    orbsRef.current = [];
    idRef.current = 1;
    lastTs.current = null;
    setRunning(true);
    setPaused(false);
    setSeed((s) => s + 1);
  };

  const endGame = () => {
    setRunning(false);
    setPaused(false);
    setStreak(0);
    setCombo(0);
    setMult(1);
    setSeed((s) => s + 1);
    setBest((b) => (score > b ? score : b));
  };

  const shareScore = async () => {
    const text = `I scored ${score} in Viral Arcade! Can you beat me?`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Viral Arcade", text });
      } catch {}
    } else {
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied! Share anywhere");
      } catch {}
    }
  };

  // Multiplier decay when not collecting
  useEffect(() => {
    if (!running || paused) return;
    const id = setInterval(() => {
      setStreak((s) => Math.max(0, s - 2));
      setMult((m) => clamp(m * 0.995, 1, 5));
    }, 80);
    return () => clearInterval(id);
  }, [running, paused]);

  // Increase multiplier gradually with streak
  useEffect(() => {
    const m = 1 + Math.floor(streak / 25) * 0.2;
    setMult(clamp(Number(m.toFixed(1)), 1, 4));
  }, [streak]);

  const activeBuffs = [
    slowmo > 0 ? { label: "Slow", icon: "🐌" } : null,
    magnet > 0 ? { label: "Magnet", icon: "🧲" } : null,
    x2 > 0 ? { label: "x2", icon: "✨" } : null,
  ].filter(Boolean);

  return (
    <div className="viral-arcade">
      <div className="game-container">
        {/* Header */}
        <div className="header">
          <div className="title-section">
            <div className="title">Viral Arcade</div>
            <div className="subtitle">Dodge & Collect</div>
          </div>
          <div className="controls">
            <button
              onClick={() => setSound((s) => !s)}
              className="control-btn"
            >
              {sound ? "🔊" : "🔇"}
            </button>
            {running && (
              <button
                onClick={() => setPaused((p) => !p)}
                className="control-btn"
              >
                {paused ? "▶️" : "⏸️"}
              </button>
            )}
          </div>
        </div>

        {/* HUD */}
        <div className="hud">
          <div className="hud-card">
            <div className="hud-label">Score</div>
            <div className="hud-value">{score}</div>
          </div>
          <div className="hud-card">
            <div className="hud-label">Best</div>
            <div className="hud-value">
              🏆 {best}
            </div>
          </div>
          <div className="hud-card">
            <div className="hud-label">Combo</div>
            <div className="hud-value">{combo}</div>
          </div>
        </div>

        {/* Streak meter */}
        <div className="streak-container">
          <div className="streak-bar">
            <div
              className="streak-fill"
              style={{ width: `${streak}%` }}
            />
          </div>
          <div className="streak-label">Streak · Multiplier x{mult.toFixed(1)}</div>
        </div>

        {/* Active buffs */}
        <div className="buffs-container">
          <AnimatePresence>
            {activeBuffs.map((b) => (
              <motion.div
                key={b.label}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="buff"
              >
                {b.icon}
                <span>{b.label}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Arena */}
        <div
          ref={arenaRef}
          className="arena"
        >
          {/* Glow grid */}
          <div className="arena-glow" />

          {/* Player */}
          <motion.div
            ref={playerRef}
            className="player"
            animate={{
              left: `calc(${player.x * 100}% - ${radius}px)`,
              top: `calc(${player.y * 100}% - ${radius}px)`,
            }}
            transition={{ type: "spring", stiffness: 400, damping: 30, mass: 0.6 }}
            style={{ width: radius * 2, height: radius * 2 }}
          />

          {/* Orbs */}
          {orbsRef.current.map((o) => (
            <motion.div
              key={o.id}
              className={`orb orb-${o.kind}`}
              style={{
                left: `calc(${o.pos.x * 100}% - ${o.radius}px)`,
                top: `calc(${o.pos.y * 100}% - ${o.radius}px)`,
                width: o.radius * 2,
                height: o.radius * 2,
                transform: `rotate(${o.spin}rad)`,
              }}
            />
          ))}

          {/* Toast */}
          <AnimatePresence>
            {flash && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                className="toast"
              >
                {flash}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Center watermark */}
          {!running && (
            <div className="overlay">
              <div className="welcome-screen">
                <div className="welcome-title">Dodge the 💀, collect the ⚡</div>
                <div className="welcome-subtitle">Drag inside the arena. Mobile-friendly. Get combos to trigger power-ups.</div>
                <div className="welcome-controls">
                  <button
                    onClick={startGame}
                    className="btn-primary"
                  >
                    ▶️ Start
                  </button>
                  <button
                    onClick={() => {
                      setBest(0);
                      toast("Best reset");
                    }}
                    className="btn-secondary"
                  >
                    🔄 Reset Best
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Pause overlay */}
          {running && paused && (
            <div className="overlay overlay-blur">
              <div className="pause-screen">
                <div className="pause-title">Paused</div>
                <button
                  onClick={() => setPaused(false)}
                  className="btn-primary"
                >
                  ▶️ Resume
                </button>
              </div>
            </div>
          )}

          {/* Game Over overlay */}
          {!running && score > 0 && (
            <div className="overlay overlay-dark">
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="game-over-modal"
              >
                <div className="game-over-title">Game Over</div>
                <div className="game-over-subtitle">Final Score</div>
                <div className="final-score">{score}</div>
                <div className="best-score">
                  🏆 Best: <span>{best}</span>
                </div>
                <div className="badges">
                  {badges.map((b) => (
                    <span key={b} className="badge">{b}</span>
                  ))}
                </div>
                <div className="game-over-actions">
                  <button
                    onClick={startGame}
                    className="btn-dark"
                  >
                    🔄 Play Again
                  </button>
                  <button
                    onClick={shareScore}
                    className="btn-light"
                  >
                    📤 Share Score
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="footer">
          <div>Tip: Keep dragging in small circles to lure good orbs while dodging 💀 edges.</div>
          <div>v1.0</div>
        </div>
      </div>
    </div>
  );
}
