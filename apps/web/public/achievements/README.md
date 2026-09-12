# Achievement badges

128×128 PNG, transparent background, one per key in packages/domain/src/achievements.ts.

- unlocked/<key>.png — group colour (solo #e8e2d4, pve #8fa36a, pvp #d4623a, team #d9a03c), 12% fill tint
- locked/<key>.png — #2a2825 outline, #4a4640 glyph
- svg/<key>.svg — unlocked source; recolour stroke/fill for other states

Progress state is not a PNG: render the SVG inline and draw the shield path twice, the second with pathLength="100" stroke-dasharray="{pct} 100" in the group colour (see Achievements.dc.html §01).

Suggested location: apps/web/public/achievements/{unlocked,locked}/<key>.png
