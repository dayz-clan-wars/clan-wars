"use client";
import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { menuFor, signInHref } from "@/lib/menu";

const item = "flex min-h-[44px] items-center rounded px-3 text-ink hover:bg-frame";
const current = "text-gold";
const quiet = "flex min-h-[44px] w-full items-center rounded px-3 font-mono text-xs uppercase tracking-[0.18em] text-muted hover:bg-frame";

/**
 * The drawer's contents. Client-side for three things the server cannot do:
 * mark the current page, carry the current path into the sign-in link, and
 * close the <details> on Escape or a click outside it. Links are plain <a>
 * — a full navigation closes the drawer by itself.
 */
export function MenuList({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const here = search ? `${pathname}?${search}` : pathname;
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const details = root.current?.closest("details");
    if (!details) return;
    const close = () => details.removeAttribute("open");
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onClick = (e: MouseEvent) => { if (!details.contains(e.target as Node)) close(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("click", onClick); };
  }, []);

  return (
    <div ref={root}>
      <nav aria-label="Site">
        {menuFor(signedIn).map((group, i) => (
          <ul key={i} className={i > 0 ? "mt-2 border-t border-rule-2 pt-2" : undefined}>
            {group.map((m) => {
              const on = pathname === m.href || (m.href !== "/" && pathname.startsWith(`${m.href}/`));
              return (
                <li key={m.href}>
                  <a className={`${item} ${on ? current : ""}`} href={m.href} aria-current={on ? "page" : undefined}>{m.label}</a>
                </li>
              );
            })}
          </ul>
        ))}
      </nav>
      <div className="mt-2 border-t border-rule-2 pt-2">
        {signedIn ? (
          // POST only: the logout route refuses GET (app/api/auth/logout/route.ts).
          <form action="/api/auth/logout" method="post"><button className={quiet} type="submit">Sign out</button></form>
        ) : (
          <a className={quiet} href={signInHref(here)}>Sign in</a>
        )}
      </div>
    </div>
  );
}
