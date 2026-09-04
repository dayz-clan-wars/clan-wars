"use client";

import { useState } from "react";
import s from "./mobile.module.css";
import { FEED, type FeedScope, flagUrl } from "./fixtures";

const TABS: readonly (readonly [FeedScope, string])[] = [
  ["server", "Server"],
  ["mine", "My faction"],
];

export function FeedScreen() {
  const [scope, setScope] = useState<FeedScope>("server");

  // "Server" is everything, not the complement of "My faction" — your own
  // transitions are part of the server's history and belong in both views.
  const items = scope === "mine" ? FEED.filter((f) => f.scope === "mine") : FEED;

  return (
    <div className={s.screenPad}>
      <div className={s.tabs}>
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`${s.tap} ${s.tab}`}
            aria-pressed={scope === key}
            onClick={() => setScope(key)}
          >
            <span className={`${scope === key ? s.tabOn : s.tabOff} ${s.mono}`}>{label}</span>
          </button>
        ))}
      </div>

      <div className={s.stack}>
        {items.map((f) => (
          <div key={`${f.time}-${f.text}`} className={s.feedRow}>
            <div
              className={`${s.flagTile} ${s.feedFlag}`}
              style={{ backgroundImage: `url(${flagUrl(f.flag)})` }}
            />
            <div className={s.grow}>
              <div className={`${s.feedKind} ${s.mono}`} style={{ color: f.color }}>
                {f.kind}
              </div>
              <div className={s.feedText}>{f.text}</div>
              <div className={`${s.feedTime} ${s.mono}`}>{f.time}</div>
            </div>
          </div>
        ))}

        {/* A faction with no events of its own is an ordinary state on day one,
            and an empty list with no explanation reads as a broken screen. */}
        {items.length === 0 && (
          <div className={`${s.feedEmpty} ${s.mono}`}>
            Nothing yet. Your faction&rsquo;s own transitions appear here as they happen.
          </div>
        )}
      </div>
    </div>
  );
}
