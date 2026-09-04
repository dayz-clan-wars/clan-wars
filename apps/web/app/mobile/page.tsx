"use client";

import { useState } from "react";
import s from "./mobile.module.css";
import { archivo, archivoBlack, spaceMono } from "./fonts";
import { INVITES } from "./fixtures";
import { NAV, TITLES, type Screen, type Tab } from "./types";
import { MapScreen } from "./map-screen";
import { FactionScreen } from "./faction-screen";
import { FeedScreen } from "./feed-screen";
import { DirectoryScreen } from "./directory-screen";
import { MeScreen } from "./me-screen";
import { InvitesScreen } from "./invites-screen";
import { ClaimScreen } from "./claim-screen";
import { RebindScreen } from "./rebind-screen";

/**
 * The mobile shell for dayzclanwars.com, ported from the
 * `Clan Wars Mobile.dc.html` design-canvas screen.
 *
 * ⚠️ Every screen here is driven by `fixtures.ts` and nothing else. This route
 * reads no database, calls no API and has no session — it exists to make the
 * shape of the product arguable before the read model behind it is designed.
 * `apps/web/test/smoke.test.ts` is what keeps that true; the direction it
 * anticipates is `docs/direction/2026-09-02-web-app-and-faction-map.md`, which
 * is explicitly not an approved spec.
 *
 * ⚠️ It is therefore NOT linked from the landing page. A player who found this
 * by following a link would read invented rosters and an invented base marker
 * as their own faction's state.
 */
export default function MobilePage() {
  const [screen, setScreen] = useState<Screen>("map");
  /**
   * ⚠️ The tab is remembered separately from the screen so Back out of a pushed
   * screen returns you to where you were, not to whatever the nav last
   * highlighted. Collapsing these two would send a leader who opened Invites
   * from the map back to the faction tab.
   */
  const [tab, setTab] = useState<Tab>("map");

  const [title, sub] = TITLES[screen];

  const goTab = (next: Tab) => {
    setScreen(next);
    setTab(next);
  };

  return (
    <div className={`${s.page} ${archivo.variable} ${archivoBlack.variable} ${spaceMono.variable}`}>
      <div className={s.frame}>
        <div className={s.topbar}>
          <div className={`${s.mark} ${s.display}`}>CW</div>
          <div className={s.topbarText}>
            <div className={`${s.screenTitle} ${s.display}`}>{title}</div>
            <div className={`${s.screenSub} ${s.mono}`}>{sub}</div>
          </div>
          {/* Hidden on the invites screen itself — a badge that navigates to
              where you already are reads as a dead control. */}
          {screen !== "invites" && (
            <button
              type="button"
              className={`${s.tap} ${s.tapFade} ${s.inviteButton}`}
              onClick={() => setScreen("invites")}
            >
              <span className={`${s.inviteBadge} ${s.mono}`}>{INVITES.length} NEW</span>
            </button>
          )}
        </div>

        {/* ⚠️ The map is a sibling of the scrolling column, not a child of it:
            it is absolutely positioned to fill the region between the two bars
            so terrain reaches every edge. Moving it inside `.scroll` would put
            it under the nav and give it the column's bottom padding. */}
        {screen === "map" && <MapScreen />}

        <div className={s.scroll}>
          {screen === "faction" && <FactionScreen onRebind={() => setScreen("rebind")} />}
          {screen === "feed" && <FeedScreen />}
          {screen === "directory" && <DirectoryScreen />}
          {screen === "me" && <MeScreen onClaim={() => setScreen("claim")} />}
          {screen === "invites" && <InvitesScreen onBack={() => setScreen(tab)} />}
          {screen === "claim" && <ClaimScreen onBack={() => setScreen(tab)} />}
          {screen === "rebind" && <RebindScreen onBack={() => setScreen(tab)} />}
        </div>

        <div className={s.navWrap}>
          <nav className={s.nav} aria-label="Sections">
            {NAV.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`${s.tap} ${s.navItem}`}
                aria-current={tab === key ? "page" : undefined}
                onClick={() => goTab(key)}
              >
                <span className={`${s.navRule} ${tab === key ? s.navRuleOn : ""}`} />
                <span className={`${s.navLabel} ${s.mono} ${tab === key ? s.navLabelOn : ""}`}>
                  {label}
                </span>
              </button>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}
