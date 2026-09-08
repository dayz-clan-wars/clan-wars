import "./guide.css";
import Contents from "./contents";

/**
 * The guide's chrome: the desktop rail, the phone top bar with its
 * <details> contents menu, and the reading column. Public and static —
 * nothing here depends on who is looking. The chapter pages fill <main>.
 */
export default function GuideLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="guide">
      <header className="topbar">
        <a className="brand" href="/guide"><img src="/guide/logo.png" alt="Clan Wars" width={40} height={40} /><span>Field Guide</span></a>
        <details><summary>Contents</summary><div className="menu"><Contents /></div></details>
      </header>
      <div className="shell">
        <aside className="rail"><div className="rail-inner">
          <a href="/guide"><img src="/guide/logo.png" alt="Clan Wars" width={120} height={120} /></a>
          <p className="kicker">Field Guide · one Xbox server, Livonia</p>
          <Contents />
        </div></aside>
        <main>{children}</main>
      </div>
    </div>
  );
}
