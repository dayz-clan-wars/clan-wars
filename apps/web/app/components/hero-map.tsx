/**
 * The landing page's hero ground: a still of the live map with the markers
 * a player would see — their base's watch zone, an intruder inside it, their
 * own reticle, a clanmate. From "Home Redesign.dc.html" (2026-09-09).
 *
 * The glyphs are the map's own (lib/map-icons.ts) transcribed to JSX so a
 * server component can draw them with no Leaflet and no innerHTML. The
 * terrain is one 1500×900 webp, cropped by `object-fit` for each width; the
 * marker cluster is anchored to the RIGHT edge so it stays over the open
 * ground on any desktop width instead of drifting under the headline.
 *
 * ⚠️ Decorative, and marked so: the picture says "live map" — the copy next
 * to it says what the map actually does.
 */
export function HeroMap() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[240px] overflow-hidden border-b-2 border-rule-2 lg:inset-0 lg:h-auto lg:border-b-0">
      <img src="/hero/terrain.webp" alt="" width={1500} height={900} fetchPriority="high" className="h-full w-full object-cover object-[72%_35%] lg:object-center" />
      <div className="hero-fade absolute inset-0" />
      <div className="hero-grid absolute inset-0" />

      {/* Desktop cluster: 420px wide, right-anchored. Offsets are the canvas's minus 860. */}
      <div className="absolute right-0 top-0 hidden h-full w-[420px] lg:block">
        <Zone className="left-[130px] top-[110px] h-[150px] w-[150px]" />
        <Base className="left-[185px] top-[165px]" size={40} />
        <Intruder className="left-[210px] top-[210px]" label="Intruder" />
        <You className="left-0 top-[280px]" label="You · 2 min" size={44} />
        <Mate className="left-[240px] top-[330px]" label="Hollis" />
      </div>
      {/* Phone cluster: 320px wide, right-anchored. Offsets are the canvas's minus 70. */}
      <div className="absolute right-0 top-0 h-full w-[320px] lg:hidden">
        <Zone className="left-[148px] top-[48px] h-[120px] w-[120px]" />
        <Base className="left-[192px] top-[92px]" size={32} />
        <Intruder className="left-[220px] top-[128px]" size={26} />
        <You className="left-0 top-[120px]" label="You · 2 min" size={36} />
      </div>
    </div>
  );
}

const TAG = "font-mono bg-frame px-2 py-1 border text-[13px] whitespace-nowrap";

function Zone({ className }: { className: string }) {
  return <div className={`absolute rounded-full border-[3px] border-dashed border-gold [box-shadow:0_0_0_3px_rgba(11,11,10,.7)] ${className}`} />;
}

function Base({ className, size }: { className: string; size: number }) {
  return (
    <svg className={`absolute ${className}`} width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="#d9a03c" strokeWidth="2" strokeLinecap="square">
      <rect x="1" y="1" width="26" height="26" fill="#0b0b0a" stroke="#0b0b0a" />
      <rect x="5" y="9" width="18" height="14" />
      <path d="M5 9l9-6 9 6M12 23v-7h4v7" />
    </svg>
  );
}

function Intruder({ className, label, size = 32 }: { className: string; label?: string; size?: number }) {
  return (
    <div className={`absolute flex items-center gap-2 ${className}`}>
      <span className="relative flex items-center justify-center" style={{ width: size, height: size }}>
        <span className="absolute -inset-[5px] rotate-45 border-[3px] border-rust" />
        <svg width={size} height={size} viewBox="0 0 28 28"><circle cx="14" cy="14" r="9" fill="#0b0b0a" /><circle cx="14" cy="14" r="5" fill="#d4623a" /></svg>
      </span>
      {label && <span className={`${TAG} border-rust text-rust-2`}>{label}</span>}
    </div>
  );
}

function You({ className, label, size }: { className: string; label: string; size: number }) {
  return (
    <div className={`absolute flex items-center gap-2 ${className}`}>
      <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="#d9a03c" strokeWidth="2" strokeLinecap="square">
        <circle cx="14" cy="14" r="13" fill="#0b0b0a" stroke="#0b0b0a" />
        <circle cx="14" cy="14" r="4" fill="#d9a03c" stroke="none" />
        <circle cx="14" cy="14" r="9" />
        <path d="M14 1v4M14 23v4M1 14h4M23 14h4" />
      </svg>
      <span className={`${TAG} border-rule-2 text-gold`}>{label}</span>
    </div>
  );
}

function Mate({ className, label }: { className: string; label: string }) {
  return (
    <div className={`absolute flex items-center gap-2 ${className}`}>
      <svg width={32} height={32} viewBox="0 0 28 28"><circle cx="14" cy="14" r="9" fill="#0b0b0a" /><circle cx="14" cy="14" r="5" fill="#e8e2d4" /></svg>
      <span className={`${TAG} border-rule-2 text-ink`}>{label}</span>
    </div>
  );
}
