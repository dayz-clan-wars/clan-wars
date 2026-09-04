"use client";

import { useEffect, useRef, useState } from "react";
import s from "./mobile.module.css";
import { BASE, LIVONIA_MAP_SRC, MAP_METRES, MEMBERS, type Member } from "./fixtures";

/**
 * Two markers closer than this drop the second one's caption. 4.5% of the map
 * is ~576m — about where two 9px captions start to overlap at phone width.
 */
const CAPTION_THRESHOLD_M = MAP_METRES * 0.045;

/**
 * ⚠️ One grid cell in metres, and the number the scale bar prints. The grid's
 * 12.5% cell size in `mobile.module.css` is the same fact stated a second time:
 * change one without the other and the bar quietly measures the wrong distance
 * on a map whose whole purpose is telling you how far away your squad is.
 */
const CELL_M = 1600;
const CELL_FRACTION = CELL_M / MAP_METRES;

type Placed = Member & { left: string; top: string; labeled: boolean; short: string };

/**
 * ⚠️ `y` grows north in the game's coordinates and CSS `top` grows south, so
 * the vertical axis is inverted here. Getting this wrong mirrors the entire map
 * and nothing errors — every marker still lands inside the square.
 */
function place(p: { x: number; y: number }) {
  return {
    left: `${((p.x / MAP_METRES) * 100).toFixed(2)}%`,
    top: `${(100 - (p.y / MAP_METRES) * 100).toFixed(2)}%`,
  };
}

/**
 * A marker whose caption would collide with the base plate, or with a caption
 * already placed, loses its caption and keeps its dot. A leader standing at
 * their own base is an ordinary state, not a fixture accident.
 */
function placeMembers(members: readonly Member[]): Placed[] {
  const taken: { x: number; y: number }[] = [{ x: BASE.x, y: BASE.y }];
  return members.map((m) => {
    const crowded = taken.some((p) => Math.hypot(p.x - m.x, p.y - m.y) < CAPTION_THRESHOLD_M);
    taken.push({ x: m.x, y: m.y });
    return {
      ...m,
      ...place(m),
      labeled: !crowded,
      short: m.gamertag.length > 10 ? `${m.gamertag.slice(0, 9)}…` : m.gamertag,
    };
  });
}

const MEMBER_POSITIONS = placeMembers(MEMBERS);
const ONLINE_COUNT = MEMBERS.filter((m) => m.online).length;
const BASE_POSITION = place(BASE);

export function MapScreen() {
  const squareRef = useRef<HTMLDivElement>(null);
  const [squareWidth, setSquareWidth] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);

  /**
   * ⚠️ The scale bar states a real distance, so its width is measured off the
   * square the markers are positioned against — never a fixed pixel width,
   * which would only be truthful at one viewport size. A ResizeObserver rather
   * than a window resize listener because the square is scaled to cover its
   * region: it can change size without the window doing so.
   */
  useEffect(() => {
    const el = squareRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setSquareWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={s.map}>
      <div ref={squareRef} className={s.square}>
        {LIVONIA_MAP_SRC ? (
          // eslint-disable-next-line @next/next/no-img-element -- one static
          // asset sized exactly as it renders; next/image would add a loader
          // and a layout pass for nothing.
          <img className={s.terrain} src={LIVONIA_MAP_SRC} alt="Livonia terrain" />
        ) : (
          <div className={`${s.terrainPlaceholder} ${s.mono}`}>
            Livonia terrain render
            <br />
            not in this repo
          </div>
        )}

        <div className={s.grid} />

        <div className={s.marker} style={BASE_POSITION}>
          <div className={s.basePlate}>
            <span />
          </div>
          <div className={`${s.baseLabel} ${s.mono}`}>Base</div>
        </div>

        {MEMBER_POSITIONS.map((m) => (
          <div key={m.gamertag} className={s.marker} style={{ left: m.left, top: m.top }}>
            <div className={m.online ? s.dotOnline : s.dotOffline} />
            {m.labeled && <div className={`${s.markerLabel} ${s.mono}`}>{m.short}</div>}
          </div>
        ))}
      </div>

      <div className={s.mapStrip}>
        <div className={`${s.mapStripInner} ${s.mono}`}>Last known — one fix every 5 min</div>
      </div>

      <div className={s.scale}>
        <div className={s.scaleRow}>
          <div
            className={s.scaleBar}
            style={{ width: `${(squareWidth * CELL_FRACTION).toFixed(1)}px` }}
          />
          <div className={`${s.scaleText} ${s.mono}`}>{CELL_M} m</div>
        </div>
        <div className={`${s.mapName} ${s.mono}`}>Livonia</div>
      </div>

      <div className={s.mapControls}>
        <button type="button" className={`${s.tap} ${s.mapControl} ${s.mono}`} aria-label="Centre on me">
          ◎
        </button>
        <button
          type="button"
          className={`${s.tap} ${s.rosterToggle}`}
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen((open) => !open)}
        >
          <span className={s.rosterToggleDot} />
          <span className={`${s.rosterToggleLabel} ${s.mono}`}>
            {ONLINE_COUNT} / {MEMBERS.length}
          </span>
        </button>
      </div>

      {sheetOpen && (
        <div className={s.sheet}>
          <div className={s.sheetHead}>
            <div className={`${s.sheetTitle} ${s.mono}`}>Roster positions</div>
            <button
              type="button"
              className={`${s.tap} ${s.tapFade} ${s.sheetClose} ${s.mono}`}
              aria-label="Close roster"
              onClick={() => setSheetOpen(false)}
            >
              ×
            </button>
          </div>
          <div className={s.sheetBody}>
            <div className={s.stack}>
              {MEMBER_POSITIONS.map((m) => (
                <div key={m.gamertag} className={s.sheetRow}>
                  <div className={m.online ? s.sheetDotOnline : s.sheetDotOffline} />
                  <div className={s.grow}>
                    <div className={`${s.name} ${s.display}`}>{m.gamertag}</div>
                    <div className={`${s.meta} ${s.mono}`}>{m.near}</div>
                  </div>
                  <div className={`${s.sheetFix} ${s.mono}`}>{m.fix}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
