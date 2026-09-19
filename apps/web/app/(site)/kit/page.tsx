import type { Metadata } from "next";
import { boosterKit, type BoosterKitView } from "@factions/roster";
import { KIT_SLOTS, type KitSlot } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { flagImagePath } from "@/src/flag-images";
import { currentSession } from "@/lib/viewer";
import { lookupCopy } from "@/lib/copy-lookup";
import { GROUND_RULES, RESULT_COPY, SLOT_LABELS } from "@/lib/kit-copy";
import { gridRef, gridRefKey } from "@/lib/map-projection";
import { nearestPlace } from "@/lib/map-places";
import { ago } from "@/lib/format";
import {
  Page, PageHead, Body, Panel, PanelBody, Notice, SessionLost,
  btnPrimary, btnSecondary, field, fieldLabel, kicker, link,
} from "@/app/components/ui";
import { saveKit, startPlacement } from "./actions";

export const metadata: Metadata = {
  title: "Clan Wars — your booster kit",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

/** Livonia, metres. The same constants /base uses to speak in grid squares. */
const WORLD = { map: "enoch", size: 12800 };

/** The three sentences the page owes the player, wherever the kit is described. */
function GroundRules() {
  return (
    <ul className="flex flex-col gap-2 text-sm leading-relaxed text-ink-2">
      {GROUND_RULES.map((line) => <li key={line}>{line}</li>)}
    </ul>
  );
}

/**
 * One slot: a select of everything the catalogue allows there, and a Save.
 *
 * Nine separate forms rather than one, because a save is one slot (the write
 * behind it takes one slot too). Each form works with no JavaScript, which is
 * the same bar every other write on this site clears.
 */
function SlotPicker({ slot, current }: { slot: KitSlot; current: string | null }) {
  const options = boosterCatalogue()[slot];
  return (
    <form action={saveKit} className="flex flex-col gap-2 border-t border-rule-2 px-4 py-4 first:border-t-0 lg:px-5">
      <input type="hidden" name="slot" value={slot} />
      <label className={fieldLabel} htmlFor={`slot-${slot}`}>{SLOT_LABELS[slot]}</label>
      <div className="flex flex-wrap items-center gap-3">
        <select id={`slot-${slot}`} name="className" defaultValue={current ?? ""} className={`${field.replace("mt-1 ", "")} max-w-[26rem] flex-1`}>
          <option value="">Nothing in this slot</option>
          {options.map((o) => <option key={o.className} value={o.className}>{o.label}</option>)}
        </select>
        <button type="submit" className={btnSecondary}>Save</button>
      </div>
    </form>
  );
}

/** The kit's spot, as a grid square. It is the viewer's own spot and nobody else's. */
function Spot({ view }: { view: BoosterKitView }) {
  if (!view.spot) {
    return <p className="text-sm leading-relaxed text-ink-2">No spot yet. Draw the sequence below, stand where you want the kit, and perform the emotes.</p>;
  }
  const near = nearestPlace(WORLD.map, view.spot.x, view.spot.z, WORLD.size);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="font-mono text-ink">Grid {gridRef(view.spot.x, view.spot.z)}</span>
      {near && <span className="text-xs text-muted">near {near.name}</span>}
      {view.spot.placedAt && <span className="text-xs text-muted">marked {ago(view.spot.placedAt)}</span>}
      <a className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold underline-offset-4 hover:underline" href={`/map?at=${gridRefKey(view.spot.x, view.spot.z)}`}>Map →</a>
    </div>
  );
}

/** The open sequence, in order. The order is the proof, so this is an ordered list. */
function Sequence({ view }: { view: BoosterKitView }) {
  if (!view.challenge) return null;
  return (
    <>
      <p className="text-sm leading-relaxed text-ink-2">
        Stand exactly where you want the kit. Perform these {view.challenge.steps.length} emotes in this order. Other emotes in between are fine. The spot is taken from where you stand for the last one.
      </p>
      <ol className="mt-3 flex flex-col gap-2">
        {view.challenge.steps.map((s, i) => (
          <li key={s.token} className="flex min-h-[48px] items-center gap-4 border-2 border-rule-2 px-4">
            <span className="font-display text-xl text-dim">{i + 1}</span>
            <span className="font-display text-lg text-ink">{s.label}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">
        Emotes reach us from the server log in batches, so the spot can take a minute to appear here.
      </p>
    </>
  );
}

export default async function KitPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) return <SessionLost next="/kit" />;
  const params = await searchParams;
  // ⚠️ Looked up, never echoed: ?result= is attacker-supplied, including
  // prototype keys like `__proto__`, so the lookup must miss on those.
  const result = typeof params.result === "string" ? lookupCopy(RESULT_COPY, params.result) : undefined;
  const view = await boosterKit(session.sub);

  return (
    <Page>
      <PageHead
        kicker="Booster kit"
        title="Your kit, your spot"
        sub="Nine pieces of clothing, dropped where you marked them, every restart."
      />
      <Body className="flex max-w-[52rem] flex-col gap-4 lg:gap-6">
        {result && <Notice>{result}</Notice>}

        <Panel num="01" title="What this is">
          <PanelBody className="flex flex-col gap-3">
            <p className="text-sm leading-relaxed text-ink-2">
              Boost the Discord and you get a kit. You pick nine pieces of clothing here, then mark a spot in game with a short emote sequence. The kit spawns there every restart for as long as you keep boosting.
            </p>
            <GroundRules />
            <p className="text-sm leading-relaxed text-ink-2">
              Pick your spot with that in mind. Somewhere quiet gets you your clothes back. Somewhere obvious hands them to whoever gets there first, which is a fine thing to do on purpose.
            </p>
          </PanelBody>
        </Panel>

        {!view.boosting && (
          <Panel num="02" title="You are not boosting">
            <PanelBody className="flex flex-col gap-3">
              <p className="text-sm leading-relaxed text-ink-2">
                To boost, open the Discord server, tap the server name at the top, and choose Boosts. Discord charges you, not us. Boosts also raise the whole server, so everyone gets the upload limits and the audio quality.
              </p>
              <p className="text-sm leading-relaxed text-ink-2">
                We check Discord for new boosts on a timer, so your kit turns on at the next check rather than the instant you boost, and the pickers appear on this page then. Stop boosting and the kit stops spawning at the next restart. Your nine picks are kept, so it comes straight back if you boost again.
              </p>
            </PanelBody>
          </Panel>
        )}

        {view.boosting && !view.linked && (
          <Panel num="02" title="Link your character">
            <PanelBody>
              <p className="text-sm leading-relaxed text-ink-2">
                Your boost is on. The spot is marked in game, so we need to know which character is yours first. <a className={link} href="/link">Link your character</a> and come back here.
              </p>
            </PanelBody>
          </Panel>
        )}

        {view.boosting && view.linked && (
          <>
            <Panel num="02" title="The nine pieces" aside={<span className={kicker}>{view.linked.gamertag}</span>}>
              <div className="flex flex-col">
                {KIT_SLOTS.map((slot) => <SlotPicker key={slot} slot={slot} current={view.slots[slot]} />)}
              </div>
              <div className="border-t-2 border-rule-2 px-4 py-4 lg:px-5">
                {view.armband ? (
                  <div className="flex items-center gap-3">
                    <img src={`/${flagImagePath(view.armband.texture)}`} alt="" width={36} height={36} className="h-9 w-9 flex-none object-contain" />
                    <div>
                      <div className={fieldLabel}>Armband</div>
                      <p className="mt-1 text-sm text-ink-2">
                        {view.armband.clanName} [{view.armband.clanTag}]. A tenth piece, added for you. It follows your clan&rsquo;s flag, so it changes when the flag does.
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={fieldLabel}>Armband</div>
                    <p className="mt-1 text-sm text-ink-2">Join a clan and its armband is added to your kit as a tenth piece.</p>
                  </>
                )}
              </div>
            </Panel>

            <Panel num="03" title="Where it lands" tone={view.challenge ? "rust" : "plain"} aside={view.challenge ? <span className={kicker}>Sequence open</span> : undefined}>
              <PanelBody className="flex flex-col gap-3">
                <Spot view={view} />
                <Sequence view={view} />
                <form action={startPlacement} className="border-t border-rule-2 pt-4">
                  <p className="text-sm leading-relaxed text-ink-2">
                    {view.spot
                      ? "Drawing a new sequence leaves the current spot alone until you finish the new one in game."
                      : "Draw a sequence, then go and perform it where you want the kit."}
                  </p>
                  <button type="submit" className={`mt-3 ${btnPrimary}`}>{view.challenge ? "Draw a new sequence" : "Draw the sequence"}</button>
                </form>
              </PanelBody>
            </Panel>
          </>
        )}
      </Body>
    </Page>
  );
}
