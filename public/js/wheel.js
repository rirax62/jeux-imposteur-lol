// Roue animée sur <canvas>. Le résultat est TOUJOURS fourni par le serveur (index) ; la roue ne fait que l'animer.
const COLORS = ['#6b3fd4', '#0690a0', '#a8884a', '#8b2fb8', '#0a7a8c', '#c8aa6e', '#4a2fa0', '#12a79a'];

export class Wheel {
  constructor(canvas, labels = []) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rot = 0;
    this.spinning = false;
    this.setLabels(labels);
  }
  setLabels(labels) {
    this.labels = labels;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round((this.canvas.clientWidth || 460) * dpr);
    this.canvas.width = this.canvas.height = size;
    this.draw();
  }
  draw() {
    const { ctx, canvas, labels } = this;
    const S = canvas.width, R = S / 2 - S * 0.02, C = S / 2;
    ctx.clearRect(0, 0, S, S);
    const n = labels.length;
    if (!n) {
      ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.arc(C, C, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8190a8'; ctx.font = `${S * 0.04}px system-ui`; ctx.textAlign = 'center';
      ctx.fillText('Aucun joueur éligible', C, C);
      return;
    }
    const seg = (Math.PI * 2) / n;
    ctx.save(); ctx.translate(C, C); ctx.rotate(this.rot);
    for (let i = 0; i < n; i++) {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, i * seg, (i + 1) * seg); ctx.closePath();
      const g = ctx.createRadialGradient(0, 0, R * 0.1, 0, 0, R);
      g.addColorStop(0, '#0a1424'); g.addColorStop(1, COLORS[i % COLORS.length]);
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = S * 0.004; ctx.strokeStyle = 'rgba(240,230,210,.55)'; ctx.stroke();
      ctx.save(); ctx.rotate((i + 0.5) * seg); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f0e6d2'; ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = S * 0.008;
      const fs = Math.max(S * 0.028, Math.min(S * 0.05, (R * seg) * 0.55));
      ctx.font = `600 ${fs}px "Palatino Linotype", Georgia, serif`;
      let t = labels[i]; while (ctx.measureText(t).width > R * 0.68 && t.length > 3) t = t.slice(0, -2);
      ctx.fillText(t === labels[i] ? t : t + '…', R * 0.92, 0);
      ctx.restore();
    }
    ctx.restore();
    // Anneau doré + moyeu
    ctx.beginPath(); ctx.arc(C, C, R, 0, Math.PI * 2); ctx.lineWidth = S * 0.018; ctx.strokeStyle = '#c8aa6e'; ctx.stroke();
    const hub = ctx.createRadialGradient(C, C, 0, C, C, R * 0.14);
    hub.addColorStop(0, '#f0e6d2'); hub.addColorStop(1, '#785a28');
    ctx.beginPath(); ctx.arc(C, C, R * 0.12, 0, Math.PI * 2); ctx.fillStyle = hub; ctx.fill();
  }
  /** Fait tourner la roue pour que le segment `index` s'arrête sous le pointeur (en haut). */
  spinTo(index, duration = 5200) {
    const n = this.labels.length;
    if (!n || this.spinning) return Promise.resolve();
    this.spinning = true;
    const seg = (Math.PI * 2) / n;
    const jitter = (Math.random() - 0.5) * seg * 0.6;
    const targetMod = (((-Math.PI / 2 - (index + 0.5) * seg + jitter) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const curMod = ((this.rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const delta = ((targetMod - curMod) + Math.PI * 2) % (Math.PI * 2);
    const total = delta + Math.PI * 2 * (5 + Math.floor(Math.random() * 3));
    const start = this.rot, t0 = performance.now();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dur = reduce ? 300 : duration;
    return new Promise((resolve) => {
      const frame = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - p, 4); // décélération progressive
        this.rot = start + total * e;
        this.draw();
        if (p < 1) requestAnimationFrame(frame);
        else { this.spinning = false; resolve(); }
      };
      requestAnimationFrame(frame);
    });
  }
  /** Positionne instantanément la roue sur un index (affichage d'un résultat déjà tiré). */
  setTo(index) {
    const n = this.labels.length;
    if (!n) return;
    const seg = (Math.PI * 2) / n;
    this.rot = -Math.PI / 2 - (index + 0.5) * seg;
    this.draw();
  }
}
